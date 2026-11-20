import json
import os
import signal
import subprocess
import threading
from datetime import datetime

import sqlalchemy as sa
from flask import current_app, jsonify, Response
from flask_login import login_required

from .. import db, logger, util
from ..models import TranscodeJob, VideoInfo
from .. import permissions as P
from . import api
from .decorators import demo_restrict, require_perm


# Per-worker drain thread reference and lock to protect it.
# The actual job queue lives in the database so all workers share it.
_transcoding_process = None
_queue_lock = threading.Lock()
_queue_thread = None


def _count_expected_tasks(video_id, data_path):
    """Estimate transcode task count for a video (requires app context)."""
    if video_id is None:
        return 0  # bulk: unknown until CLI starts; status.total takes over once running
    config_path = data_path / 'config.json'
    resolutions = []
    if config_path.exists():
        with open(config_path) as f:
            tc = json.load(f).get('transcoding', {})
        if tc.get('enable_1080p', True): resolutions.append(1080)
        if tc.get('enable_720p', True): resolutions.append(720)
        if tc.get('enable_480p', True): resolutions.append(480)
    else:
        resolutions = [1080, 720, 480]
    vi = VideoInfo.query.filter_by(video_id=video_id).first()
    original_height = vi.height or 0 if vi else 0
    count = sum(1 for h in resolutions if original_height > h)
    return count if count > 0 else len(resolutions)


def _recover_stale_jobs(data_path):
    """Reset any 'running' jobs whose subprocess is no longer alive back to 'pending'.
    Called once when the drain thread starts, before processing any jobs."""
    _TRANSCODE_LOCK = "fireshare_transcode.lock"
    if not util.lock_exists(data_path, _TRANSCODE_LOCK):
        stale = TranscodeJob.query.filter_by(status='running').all()
        if stale:
            for job in stale:
                job.status = 'pending'
                job.started_at = None
            db.session.commit()
            logger.info(f"Reset {len(stale)} stale transcode job(s) to pending")


def _drain_queue(app, data_path):
    """Background thread: claim and process DB-queued transcode jobs one at a time.

    Uses an optimistic UPDATE WHERE status='pending' to atomically claim each job,
    so multiple workers' drain threads can safely race without double-processing.
    """
    global _transcoding_process, _queue_thread

    with app.app_context():
        _recover_stale_jobs(data_path)

        while True:
            # Find the oldest pending job
            job = (TranscodeJob.query
                   .filter_by(status='pending')
                   .order_by(TranscodeJob.created_at)
                   .first())

            if job is None:
                # Queue is empty — purge completed/failed rows so counts start
                # fresh next time rather than accumulating across sessions.
                TranscodeJob.query.filter(
                    TranscodeJob.status.in_(['complete', 'failed'])
                ).delete()
                db.session.commit()
                with _queue_lock:
                    _queue_thread = None
                    _transcoding_process = None
                break

            # Atomically claim it — if another worker's drain thread beats us, rowcount == 0
            result = db.session.execute(
                sa.update(TranscodeJob)
                .where(sa.and_(TranscodeJob.id == job.id, TranscodeJob.status == 'pending'))
                .values(status='running', started_at=datetime.utcnow())
            )
            db.session.commit()

            if result.rowcount == 0:
                continue  # Another worker claimed it; loop to find the next one

            try:
                cmd = ['fireshare', 'transcode-videos']
                if job.video_id is not None:
                    cmd += ['--video', job.video_id]
                _transcoding_process = subprocess.Popen(cmd, env=os.environ.copy(), start_new_session=True)
                util.write_transcoding_status(data_path, 0, 0, None, _transcoding_process.pid)
                returncode = _transcoding_process.wait()
                job.status = 'complete' if returncode == 0 else 'failed'
                job.completed_at = datetime.utcnow()
                db.session.commit()
            except Exception as e:
                logger.error(f'Transcoding drain failed for job {job.id} (video_id={job.video_id}): {e}')
                try:
                    job.status = 'failed'
                    job.completed_at = datetime.utcnow()
                    db.session.commit()
                except Exception:
                    pass


def _ensure_drain_running(app, data_path):
    """Start the drain thread if there are pending jobs and it isn't already running.
    Called at startup after stale jobs are reset to pending."""
    global _queue_thread
    has_pending = TranscodeJob.query.filter_by(status='pending').first() is not None
    if not has_pending:
        return
    with _queue_lock:
        if _queue_thread is None or not _queue_thread.is_alive():
            _queue_thread = threading.Thread(
                target=_drain_queue, args=(app, data_path), daemon=True
            )
            _queue_thread.start()


def _enqueue_transcode(video_id, data_path):
    """Insert a job into the DB queue and ensure the drain thread is running."""
    global _queue_thread

    # Dedup: don't queue if an identical job is already pending or running
    existing = TranscodeJob.query.filter(
        TranscodeJob.video_id == video_id,
        TranscodeJob.status.in_(['pending', 'running'])
    ).first()
    if existing:
        return 'already_queued'

    task_count = _count_expected_tasks(video_id, data_path)
    job = TranscodeJob(video_id=video_id, task_count=task_count)
    db.session.add(job)
    db.session.commit()

    app = current_app._get_current_object()
    with _queue_lock:
        if _queue_thread is None or not _queue_thread.is_alive():
            _queue_thread = threading.Thread(
                target=_drain_queue, args=(app, data_path), daemon=True
            )
            _queue_thread.start()
            return 'started'
    return 'queued'


def _is_pid_running(pid):
    """Check if a process with the given PID is still running."""
    if pid is None:
        return False
    try:
        pid = int(pid)
        if pid <= 0:
            return False
    except (TypeError, ValueError):
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


@api.route('/api/admin/transcoding/status', methods=["GET"])
@login_required
def get_transcoding_status():
    """Get transcoding status and queue depth."""
    global _transcoding_process

    enabled = current_app.config.get('ENABLE_TRANSCODING', False)
    gpu_enabled = current_app.config.get('TRANSCODE_GPU', False)
    paths = current_app.config['PATHS']

    subprocess_running = _transcoding_process is not None and _transcoding_process.poll() is None
    progress = util.read_transcoding_status(paths['data'])

    pid_alive = _is_pid_running(progress.get('pid'))
    is_running = subprocess_running or (progress.get('is_running', False) and pid_alive)

    if progress.get('is_running') and not is_running:
        util.clear_transcoding_status(paths['data'])
        progress = {"current": 0, "total": 0, "current_video": None}

    if not subprocess_running and _transcoding_process is not None:
        _transcoding_process = None

    pending_jobs = TranscodeJob.query.filter_by(status='pending').all()
    completed_count = TranscodeJob.query.filter_by(status='complete').count()

    return jsonify({
        "enabled": enabled,
        "gpu_enabled": gpu_enabled,
        "is_running": is_running,
        "current": progress.get('current', 0),
        "total": progress.get('total', 0),
        "current_video": progress.get('current_video'),
        "percent": progress.get('percent'),
        "eta_seconds": progress.get('eta_seconds'),
        "resolution": progress.get('resolution'),
        "queue_tasks": sum(j.task_count for j in pending_jobs),
        "completed_tasks": completed_count,
    })


@api.route('/api/admin/transcoding/start', methods=["POST"])
@require_perm(P.TRANSCODE)
@demo_restrict
def start_transcoding():
    """Start bulk transcoding of all videos, or queue it if already running."""
    if not current_app.config.get('ENABLE_TRANSCODING', False):
        return Response(status=400, response='Transcoding is not enabled')
    paths = current_app.config['PATHS']
    status = _enqueue_transcode(None, paths['data'])
    return jsonify({"status": status})


@api.route('/api/admin/transcoding/start/<video_id>', methods=["POST"])
@require_perm(P.TRANSCODE)
@demo_restrict
def start_transcoding_video(video_id):
    """Start transcoding for a single video, or queue it if already running."""
    if not current_app.config.get('ENABLE_TRANSCODING', False):
        return Response(status=400, response='Transcoding is not enabled')
    paths = current_app.config['PATHS']
    status = _enqueue_transcode(video_id, paths['data'])
    return jsonify({"status": status})


@api.route('/api/admin/transcoding/cancel', methods=["POST"])
@require_perm(P.TRANSCODE)
@demo_restrict
def cancel_transcoding():
    """Cancel the running transcode and clear all pending jobs from the queue."""
    global _transcoding_process

    paths = current_app.config['PATHS']
    pid_to_kill = None

    if _transcoding_process is not None:
        if _transcoding_process.poll() is not None:
            _transcoding_process = None
        else:
            pid_to_kill = _transcoding_process.pid

    if pid_to_kill is None:
        status = util.read_transcoding_status(paths['data'])
        pid_to_kill = status.get('pid')
        if not status.get('is_running', False):
            # No active process — still clear any pending jobs
            TranscodeJob.query.filter(TranscodeJob.status.in_(['pending', 'running'])).delete()
            db.session.commit()
            return Response(status=400, response='No transcoding in progress')

    if pid_to_kill is not None:
        try:
            target_pgid = os.getpgid(pid_to_kill)
            my_pgid = os.getpgid(os.getpid())
            if target_pgid != my_pgid:
                os.killpg(target_pgid, signal.SIGTERM)
            else:
                os.kill(pid_to_kill, signal.SIGTERM)
            if _transcoding_process is not None:
                _transcoding_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            if target_pgid != my_pgid:
                os.killpg(target_pgid, signal.SIGKILL)
            else:
                os.kill(pid_to_kill, signal.SIGKILL)
        except (ProcessLookupError, OSError):
            pass

    # Clear all pending and running jobs from the queue
    TranscodeJob.query.filter(TranscodeJob.status.in_(['pending', 'running'])).delete()
    db.session.commit()
    util.clear_transcoding_status(paths['data'])
    _transcoding_process = None
    return jsonify({"status": "cancelled"})
