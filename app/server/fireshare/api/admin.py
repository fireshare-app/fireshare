import json
import logging
import os
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path
from queue import Queue, Empty

from flask import current_app, jsonify, request, Response
from flask_login import login_required, current_user
from werkzeug.security import generate_password_hash

from sqlalchemy import func

from .. import db, logger, util
from ..models import Video, VideoInfo, VideoView, GameMetadata, VideoGameLink, VideoTagLink, Image, ImageInfo, ImageGameLink, ImageTagLink, ImageView, TranscodeJob, MediaFolder
from .. import permissions as perms
from . import api
from .helpers import cancel_pending_transcode_jobs, delete_video_files, resolve_media_subfolder
from .transcoding import _is_pid_running
from .scan import _game_scan_state
from .decorators import admin_required, demo_restrict


@api.route('/api/admin/config', methods=["GET", "PUT"])
@admin_required
def get_or_update_config():
    paths = current_app.config['PATHS']
    demo_mode = current_app.config.get('DEMO_MODE', False)
    if request.method == 'GET':
        config_path = paths['data'] / 'config.json'
        file = open(config_path)
        config = json.load(file)
        file.close()
        if config_path.exists():
            # Include transcoding status (from env vars, doesn't change at runtime)
            config['transcoding_status'] = {
                'enabled': current_app.config.get('ENABLE_TRANSCODING', False),
                'gpu_enabled': current_app.config.get('TRANSCODE_GPU', False),
            }
            # Strip sensitive API keys when the demo account is viewing config
            if demo_mode and current_user.username == 'demo':
                config.get('integrations', {}).pop('steamgriddb_api_key', None)
            return config
        else:
            return jsonify({})
    if request.method == 'PUT':
        if demo_mode and current_user.username == 'demo':
            return Response(status=403, response='Settings cannot be changed in demo mode.')
        config = request.json["config"]
        config_path = paths['data'] / 'config.json'
        if not config:
            return Response(status=400, response='A config must be provided.')
        if not config_path.exists():
            return Response(status=500, response='Could not find a config to update.')
        config_path.write_text(json.dumps(config, indent=2))

        # Check if SteamGridDB API key was added and remove warning if present
        steamgrid_api_key = config.get('integrations', {}).get('steamgriddb_api_key', '')
        if steamgrid_api_key:
            steamgridWarning = "SteamGridDB API key not configured. Game metadata features are unavailable. Click here to set it up."
            if steamgridWarning in current_app.config['WARNINGS']:
                current_app.config['WARNINGS'].remove(steamgridWarning)

        return Response(status=200)


@api.route('/api/admin/warnings', methods=["GET"])
@admin_required
def get_warnings():
    warnings = current_app.config['WARNINGS']
    if request.method == 'GET':
        if len(warnings) == 0:
            return jsonify({})
        else:
            return jsonify(warnings)


@api.route('/api/admin/stream')
@login_required
def admin_event_stream():
    # Deliberately not admin-gated: the navbar transcoding and scan indicators
    # subscribe to this for every signed-in user, and it carries progress counts
    # rather than configuration. Same reasoning as /api/admin/transcoding/status.
    """SSE endpoint for real-time admin events (transcoding, etc.)."""

    # Capture config and app before entering generator (Flask context unavailable inside)
    app = current_app._get_current_object()
    paths = current_app.config['PATHS']
    enabled = current_app.config.get('ENABLE_TRANSCODING', False)
    gpu_enabled = current_app.config.get('TRANSCODE_GPU', False)

    # Use a queue to communicate between polling thread and generator
    event_queue = Queue()
    stop_event = threading.Event()

    def poll_status():
        last_transcoding_state = None
        last_game_scan_state = None
        with app.app_context():
            while not stop_event.is_set():
                try:
                    progress = util.read_transcoding_status(paths['data'])
                    pid = progress.get('pid')
                    is_running = progress.get('is_running', False) and (pid is None or _is_pid_running(pid))

                    if progress.get('is_running') and not is_running:
                        util.clear_transcoding_status(paths['data'])
                        progress = {"current": 0, "total": 0, "current_video": None}

                    pending_jobs = TranscodeJob.query.filter_by(status='pending').all()
                    completed_count = TranscodeJob.query.filter_by(status='complete').count()
                    transcoding_state = {
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
                    }

                    if transcoding_state != last_transcoding_state:
                        event_queue.put(f"event: transcoding\ndata: {json.dumps(transcoding_state)}\n\n")
                        last_transcoding_state = transcoding_state.copy()

                    with _game_scan_state['lock']:
                        game_scan_state = {
                            "is_running": _game_scan_state['is_running'],
                            "current": _game_scan_state['current'],
                            "total": _game_scan_state['total'],
                            "suggestions_created": _game_scan_state['suggestions_created'],
                        }

                    if game_scan_state != last_game_scan_state:
                        event_queue.put(f"event: gameScan\ndata: {json.dumps(game_scan_state)}\n\n")
                        last_game_scan_state = game_scan_state.copy()

                    time.sleep(1.5)
                except Exception as e:
                    logger.error(f"SSE poll error: {e}")
                    break

    def generate():
        # Start polling in background thread
        poll_thread = threading.Thread(target=poll_status, daemon=True)
        poll_thread.start()

        last_heartbeat = time.time()
        try:
            while True:
                try:
                    # Wait for events with timeout for heartbeat
                    event = event_queue.get(timeout=10)
                    yield event
                    last_heartbeat = time.time()
                except Empty:
                    # Send heartbeat if no events
                    if time.time() - last_heartbeat >= 30:
                        yield ": heartbeat\n\n"
                        last_heartbeat = time.time()
        except GeneratorExit:
            pass
        finally:
            stop_event.set()

    return Response(generate(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@api.route('/api/admin/reset-database', methods=["POST"])
@admin_required
@demo_restrict
def reset_database():
    """Reset selected video and game data while preserving config and user settings"""
    try:
        paths = current_app.config['PATHS']
        payload = request.get_json(silent=True) or {}

        if isinstance(payload, dict) and isinstance(payload.get("options"), dict):
            options = payload["options"]
        elif isinstance(payload, dict):
            options = payload
        else:
            options = {}

        if not options:
            options = {
                "game_suggestions": True,
                "game_links": True,
                "game_metadata": True,
                "game_assets": True,
                "video_views": True,
                "video_metadata": True,
                "videos": True,
                "processed_files": True,
            }

        reset_videos = bool(options.get("videos"))
        reset_processed = bool(options.get("processed_files")) or reset_videos
        reset_game_metadata = bool(options.get("game_metadata"))
        reset_game_links = bool(options.get("game_links")) or reset_game_metadata or reset_videos
        reset_game_assets = bool(options.get("game_assets")) or reset_game_metadata
        reset_video_views = bool(options.get("video_views")) or reset_videos
        reset_video_metadata = bool(options.get("video_metadata"))
        reset_game_suggestions = bool(options.get("game_suggestions"))

        if reset_game_suggestions:
            suggestions_file = paths['data'] / 'game_suggestions.json'
            if suggestions_file.exists():
                suggestions_file.unlink()
                current_app.logger.info("Deleted game_suggestions.json")

        if reset_game_links:
            VideoGameLink.query.delete()
            current_app.logger.info("Deleted all video-game links")

        if reset_game_metadata:
            GameMetadata.query.delete()
            current_app.logger.info("Deleted all game metadata")

        if reset_video_views:
            VideoView.query.delete()
            current_app.logger.info("Deleted all video views")

        if reset_video_metadata and not reset_videos:
            videos_with_info = Video.query.join(VideoInfo).all()
            for video in videos_with_info:
                title = Path(video.path).stem
                db.session.query(VideoInfo).filter_by(video_id=video.video_id).update({
                    "title": title,
                    "description": "",
                })
            current_app.logger.info("Reset video titles and descriptions")

        if reset_videos:
            VideoInfo.query.delete()
            current_app.logger.info("Deleted all video info")
            Video.query.delete()
            current_app.logger.info("Deleted all videos")

        db.session.commit()

        if reset_processed:
            video_links_dir = paths['processed'] / 'video_links'
            derived_dir = paths['processed'] / 'derived'

            if video_links_dir.exists():
                shutil.rmtree(video_links_dir)
                video_links_dir.mkdir()
                current_app.logger.info("Cleared video_links directory")

            if derived_dir.exists():
                shutil.rmtree(derived_dir)
                derived_dir.mkdir()
                current_app.logger.info("Cleared derived directory")

        if reset_game_assets:
            game_assets_dir = paths['data'] / 'game_assets'
            if game_assets_dir.exists():
                shutil.rmtree(game_assets_dir)
                game_assets_dir.mkdir()
                current_app.logger.info("Cleared game_assets directory")

        current_app.logger.info("Database reset complete")
        return jsonify({
            'message': 'Database reset successfully',
            'reset': {
                'game_suggestions': reset_game_suggestions,
                'game_links': reset_game_links,
                'game_metadata': reset_game_metadata,
                'game_assets': reset_game_assets,
                'video_views': reset_video_views,
                'video_metadata': reset_video_metadata,
                'videos': reset_videos,
                'processed_files': reset_processed,
            },
        }), 200

    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Failed to reset database: {e}")
        return Response(response=f'Failed to reset database: {str(e)}', status=500)


@api.route('/api/admin/files', methods=['GET'])
@login_required
def get_admin_files():
    """Get all videos with file metadata for the bulk file manager (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    paths = current_app.config['PATHS']
    video_path = paths['video']

    videos = Video.query.join(VideoInfo).all()

    # Single query for all game links instead of one per video
    game_links = VideoGameLink.query.join(VideoGameLink.game).filter(
        VideoGameLink.video_id.in_([v.video_id for v in videos])
    ).all()
    game_map = {gl.video_id: gl.game.name for gl in game_links if gl.game}

    # Collect video file sizes in one scandir pass per folder
    size_map = {}
    folders = []
    try:
        for entry in os.scandir(video_path):
            if entry.is_dir() and not entry.name.startswith('.'):
                folders.append(entry.name)
                try:
                    for f in os.scandir(entry.path):
                        if f.is_file():
                            size_map[entry.name + '/' + f.name] = f.stat().st_size
                except Exception:
                    pass
            elif entry.is_file():
                try:
                    size_map[entry.name] = entry.stat().st_size
                except Exception:
                    pass
        folders.sort()
    except Exception:
        pass

    # Collect derived folder sizes in one pass over /processed/derived/{video_id}/
    derived_size_map = {}
    derived_root = paths['processed'] / 'derived'
    try:
        for entry in os.scandir(derived_root):
            if entry.is_dir():
                folder_total = 0
                try:
                    for f in os.scandir(entry.path):
                        if f.is_file():
                            try:
                                folder_total += f.stat(follow_symlinks=False).st_size
                            except OSError:
                                pass
                except OSError:
                    pass
                derived_size_map[entry.name] = folder_total
    except OSError:
        pass

    files = []
    for v in videos:
        parts = v.path.replace('\\', '/').split('/')
        folder = parts[0] if len(parts) > 1 else ''
        filename = parts[-1]
        normalized_path = '/'.join(parts)

        files.append({
            'video_id': v.video_id,
            'filename': filename,
            'folder': folder,
            'path': v.path,
            'extension': v.extension,
            'size': size_map.get(normalized_path),
            'derived_size': derived_size_map.get(v.video_id, 0),
            'title': v.info.title if v.info else None,
            'duration': round(v.info._cropped_duration()) if v.info and v.info.duration else 0,
            'width': v.info.width if v.info else None,
            'height': v.info.height if v.info else None,
            'private': v.info.private if v.info else True,
            'has_480p': v.info.has_480p if v.info else False,
            'has_720p': v.info.has_720p if v.info else False,
            'has_1080p': v.info.has_1080p if v.info else False,
            'has_crop': v.info.has_crop if v.info else False,
            'is_hdr': bool(v.info.is_hdr) if v.info else False,
            'tonemap': v.info.tonemap if v.info else None,
            'has_sdr': bool(v.info.has_sdr) if v.info else False,
            'has_password': bool(v.info.password_hash) if v.info else False,
            'available': v.available,
            'created_at': v.created_at.isoformat() if v.created_at else None,
            'recorded_at': v.recorded_at.isoformat() if v.recorded_at else None,
            'game': game_map.get(v.video_id),
            # Same shape the feeds use, so the file manager can render the byline
            # with UploaderMention. Video.uploader is lazy="joined", so this costs
            # no extra query.
            'uploader': v.uploader.mention_json() if v.uploader else None,
        })

    return jsonify({'files': files, 'folders': folders})


@api.route('/api/admin/files/bulk-delete', methods=['POST'])
@login_required
@demo_restrict
def bulk_delete_files():
    """Delete multiple videos by ID (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    data = request.json
    video_ids = data.get('video_ids', [])
    if not video_ids:
        return Response(status=400, response='No video IDs provided.')

    paths = current_app.config['PATHS']
    results = {'deleted': [], 'errors': []}

    for vid_id in video_ids:
        video = Video.query.filter_by(video_id=vid_id).first()
        if not video:
            results['errors'].append({'video_id': vid_id, 'error': 'Not found'})
            continue

        file_path = paths['video'] / video.path
        link_path = paths['processed'] / 'video_links' / f"{vid_id}{video.extension}"
        derived_path = paths['processed'] / 'derived' / vid_id
        folder_id = video.folder_id

        try:
            cancel_pending_transcode_jobs(vid_id)

            VideoInfo.query.filter_by(video_id=vid_id).delete()
            VideoGameLink.query.filter_by(video_id=vid_id).delete()
            VideoTagLink.query.filter_by(video_id=vid_id).delete()
            VideoView.query.filter_by(video_id=vid_id).delete()
            Video.query.filter_by(video_id=vid_id).delete()
            db.session.commit()

            MediaFolder.cleanup_if_orphaned(folder_id, Video)

            delete_video_files(vid_id, file_path, link_path, derived_path)

            results['deleted'].append(vid_id)
        except Exception as e:
            db.session.rollback()
            results['errors'].append({'video_id': vid_id, 'error': str(e)})

    return jsonify(results)


def _get_or_create_media_folder(dirname, media_type):
    folder = MediaFolder.query.filter_by(path=dirname, media_type=media_type).first()
    if folder:
        return folder
    now = datetime.utcnow()
    folder = MediaFolder(path=dirname, media_type=media_type, private=True, created_at=now, updated_at=now)
    db.session.add(folder)
    db.session.flush()
    return folder


@api.route('/api/admin/files/bulk-move', methods=['POST'])
@login_required
@demo_restrict
def bulk_move_files():
    """Move multiple videos to a target folder (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    data = request.json
    video_ids = data.get('video_ids', [])
    target_folder = (data.get('folder') or '').strip()

    if not video_ids:
        return Response(status=400, response='No video IDs provided.')
    if not target_folder:
        return Response(status=400, response='A target folder must be provided.')

    paths = current_app.config['PATHS']
    video_path = paths['video']
    resolved = resolve_media_subfolder(video_path, target_folder)
    if not resolved:
        return Response(status=400, response=f"Folder '{target_folder}' is not inside the video directory.")
    target_folder_path, target_folder = resolved

    if not target_folder_path.is_dir():
        return Response(status=400, response=f"Folder '{target_folder}' does not exist.")

    results = {'moved': [], 'errors': []}

    for vid_id in video_ids:
        video = Video.query.filter_by(video_id=vid_id).first()
        if not video:
            results['errors'].append({'video_id': vid_id, 'error': 'Not found'})
            continue

        old_file_path = video_path / video.path
        filename = Path(video.path).name
        new_path = f"{target_folder}/{filename}" if target_folder else filename
        new_file_path = video_path / new_path

        if old_file_path.resolve() == new_file_path.resolve():
            results['errors'].append({'video_id': vid_id, 'error': 'Already in that folder'})
            continue

        if new_file_path.exists():
            results['errors'].append({'video_id': vid_id, 'error': f"File '{filename}' already exists in '{target_folder}'"})
            continue

        try:
            shutil.move(str(old_file_path), str(new_file_path))

            link_path = paths['processed'] / 'video_links' / f"{vid_id}{video.extension}"
            if link_path.exists() or link_path.is_symlink():
                link_path.unlink()
            os.symlink(new_file_path.absolute(), link_path)

            video.path = new_path
            # Media sitting directly in the root carries no folder row, matching how
            # the disk scan records it.
            video.folder_id = (
                _get_or_create_media_folder(target_folder.split('/')[0], "video").id
                if target_folder else None
            )

            from ..models import FolderRule
            folder_rule = FolderRule.query.filter_by(folder_path=target_folder).first()
            if folder_rule:
                existing_link = VideoGameLink.query.filter_by(video_id=vid_id).first()
                if existing_link:
                    existing_link.game_id = folder_rule.game_id
                else:
                    db.session.add(VideoGameLink(video_id=vid_id, game_id=folder_rule.game_id, created_at=datetime.utcnow()))

            db.session.commit()
            results['moved'].append(vid_id)
        except Exception as e:
            db.session.rollback()
            results['errors'].append({'video_id': vid_id, 'error': str(e)})

    return jsonify(results)


@api.route('/api/admin/folders/create', methods=['POST'])
@login_required
def create_video_folder():
    """Create a new folder in the /videos root directory (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    data = request.json
    folder_name = (data.get('name') or '').strip()

    if not folder_name:
        return Response(status=400, response='A folder name must be provided.')

    if '/' in folder_name or '\\' in folder_name or folder_name.startswith('.'):
        return Response(status=400, response='Invalid folder name.')

    paths = current_app.config['PATHS']
    video_path = paths['video']
    new_folder_path = video_path / folder_name

    if new_folder_path.exists():
        return Response(status=409, response=f"A folder named '{folder_name}' already exists.")

    try:
        new_folder_path.mkdir()
        logging.info(f"Created folder: {new_folder_path}")
        return Response(status=201)
    except Exception as e:
        logging.error(f"Error creating folder {folder_name}: {e}")
        return Response(status=500, response=str(e))


@api.route('/api/admin/folders/delete', methods=['POST'])
@login_required
def delete_video_folder():
    """Delete empty folders from the /videos root directory (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    data = request.json
    folder_names = data.get('folders', [])

    if not folder_names:
        return Response(status=400, response='No folder names provided.')

    paths = current_app.config['PATHS']
    video_path = paths['video']
    results = {'deleted': [], 'errors': []}

    # Load config to get protected folder names
    try:
        with open(paths['data'] / 'config.json', 'r') as f:
            config = json.load(f)
    except Exception:
        config = {}

    app_config = config.get('app_config', {})
    admin_upload_folder = app_config.get('admin_upload_folder_name', 'uploads').lower()
    public_upload_folder = app_config.get('public_upload_folder_name', 'public uploads').lower()

    for folder_name in folder_names:
        if '/' in folder_name or '\\' in folder_name or folder_name.startswith('.'):
            results['errors'].append({'folder': folder_name, 'error': 'Invalid folder name'})
            continue

        if folder_name.lower() in [admin_upload_folder, public_upload_folder]:
            results['errors'].append({'folder': folder_name, 'error': 'Cannot delete protected folder'})
            continue

        folder_path = video_path / folder_name
        if not folder_path.exists() or not folder_path.is_dir():
            results['errors'].append({'folder': folder_name, 'error': 'Folder not found'})
            continue
        # Only delete if empty
        if any(folder_path.iterdir()):
            results['errors'].append({'folder': folder_name, 'error': 'Folder is not empty'})
            continue
        try:
            folder_path.rmdir()
            results['deleted'].append(folder_name)
            logging.info(f"Deleted empty folder: {folder_path}")
            MediaFolder.query.filter_by(path=folder_name, media_type="video").delete()
        except Exception as e:
            results['errors'].append({'folder': folder_name, 'error': str(e)})

    db.session.commit()
    return jsonify(results)


@api.route('/api/admin/files/bulk-remove-transcodes', methods=['POST'])
@login_required
@demo_restrict
def bulk_remove_transcodes():
    """Remove transcoded files for multiple videos (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    data = request.json
    video_ids = data.get('video_ids', [])
    if not video_ids:
        return Response(status=400, response='No video IDs provided.')

    paths = current_app.config['PATHS']
    results = {'updated': [], 'errors': []}

    for vid_id in video_ids:
        video_info = VideoInfo.query.filter_by(video_id=vid_id).first()
        if not video_info:
            results['errors'].append({'video_id': vid_id, 'error': 'Not found'})
            continue
        try:
            derived_dir = paths['processed'] / 'derived' / vid_id
            for res in ['480p', '720p', '1080p']:
                f = derived_dir / f'{vid_id}-{res}.mp4'
                if f.exists():
                    f.unlink()
            video_info.has_480p = False
            video_info.has_720p = False
            video_info.has_1080p = False
            db.session.commit()
            results['updated'].append(vid_id)
        except Exception as e:
            db.session.rollback()
            results['errors'].append({'video_id': vid_id, 'error': str(e)})

    return jsonify(results)


@api.route('/api/admin/files/bulk-remove-crop', methods=['POST'])
@login_required
def bulk_remove_crop():
    """Remove crop settings for multiple videos (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    data = request.json
    video_ids = data.get('video_ids', [])
    if not video_ids:
        return Response(status=400, response='No video IDs provided.')

    paths = current_app.config['PATHS']
    results = {'updated': [], 'errors': []}

    for vid_id in video_ids:
        video = Video.query.filter_by(video_id=vid_id).first()
        video_info = VideoInfo.query.filter_by(video_id=vid_id).first()
        if not video or not video_info:
            results['errors'].append({'video_id': vid_id, 'error': 'Not found'})
            continue
        try:
            derived_dir = paths['processed'] / 'derived' / vid_id
            for fname in [f'{vid_id}-cropped.mp4', f'{vid_id}-480p.mp4', f'{vid_id}-720p.mp4', f'{vid_id}-1080p.mp4']:
                f = derived_dir / fname
                if f.exists():
                    f.unlink()
            video_info.has_crop = False
            video_info.start_time = None
            video_info.end_time = None
            video_info.has_480p = False
            video_info.has_720p = False
            video_info.has_1080p = False
            db.session.commit()
            results['updated'].append(vid_id)
        except Exception as e:
            db.session.rollback()
            results['errors'].append({'video_id': vid_id, 'error': str(e)})

    return jsonify(results)


@api.route('/api/admin/files/bulk-set-privacy', methods=['POST'])
@login_required
def bulk_set_privacy():
    """Set privacy for multiple videos (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    data = request.json
    video_ids = data.get('video_ids', [])
    private = data.get('private')
    if not video_ids:
        return Response(status=400, response='No video IDs provided.')
    if private is None:
        return Response(status=400, response='A privacy value (private: true/false) must be provided.')

    results = {'updated': [], 'errors': []}

    for vid_id in video_ids:
        video_info = VideoInfo.query.filter_by(video_id=vid_id).first()
        if not video_info:
            results['errors'].append({'video_id': vid_id, 'error': 'Not found'})
            continue
        try:
            video_info.private = bool(private)
            db.session.commit()
            results['updated'].append(vid_id)
        except Exception as e:
            db.session.rollback()
            results['errors'].append({'video_id': vid_id, 'error': str(e)})

    return jsonify(results)


@api.route('/api/admin/files/bulk-set-password', methods=['POST'])
@login_required
def bulk_set_password():
    """Set a password on multiple videos (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    data = request.json
    video_ids = data.get('video_ids', [])
    password = data.get('password', '').strip()
    if not video_ids:
        return Response(status=400, response='No video IDs provided.')
    if not password:
        return Response(status=400, response='A password must be provided.')

    hashed = generate_password_hash(password, method='pbkdf2:sha256')
    results = {'updated': [], 'errors': []}

    for vid_id in video_ids:
        video_info = VideoInfo.query.filter_by(video_id=vid_id).first()
        if not video_info:
            results['errors'].append({'video_id': vid_id, 'error': 'Not found'})
            continue
        try:
            video_info.password_hash = hashed
            db.session.commit()
            results['updated'].append(vid_id)
        except Exception as e:
            db.session.rollback()
            results['errors'].append({'video_id': vid_id, 'error': str(e)})

    return jsonify(results)


@api.route('/api/admin/files/bulk-remove-password', methods=['POST'])
@login_required
def bulk_remove_password():
    """Remove the password from multiple videos (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    data = request.json
    video_ids = data.get('video_ids', [])
    if not video_ids:
        return Response(status=400, response='No video IDs provided.')

    results = {'updated': [], 'errors': []}

    for vid_id in video_ids:
        video_info = VideoInfo.query.filter_by(video_id=vid_id).first()
        if not video_info:
            results['errors'].append({'video_id': vid_id, 'error': 'Not found'})
            continue
        try:
            video_info.password_hash = None
            db.session.commit()
            results['updated'].append(vid_id)
        except Exception as e:
            db.session.rollback()
            results['errors'].append({'video_id': vid_id, 'error': str(e)})

    return jsonify(results)


@api.route('/api/admin/files/bulk-rename', methods=['POST'])
@login_required
def bulk_rename_files():
    """Bulk update titles for multiple videos (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')
    data = request.json
    renames = data.get('renames', [])
    if not renames:
        return Response(status=400, response='No renames provided.')
    results = {'updated': [], 'errors': []}
    for item in renames:
        vid_id = item.get('video_id')
        new_title = (item.get('title') or '').strip()
        if not vid_id:
            continue
        video_info = VideoInfo.query.filter_by(video_id=vid_id).first()
        if not video_info:
            results['errors'].append({'video_id': vid_id, 'error': 'Not found'})
            continue
        try:
            video_info.title = new_title or None
            db.session.commit()
            results['updated'].append(vid_id)
        except Exception as e:
            db.session.rollback()
            results['errors'].append({'video_id': vid_id, 'error': str(e)})
    return jsonify(results)


@api.route('/api/admin/files/orphaned-derived', methods=['GET'])
@login_required
def get_orphaned_derived():
    """Find derived folders with no matching video or image in the DB (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')
    paths = current_app.config['PATHS']
    derived_root = paths['processed'] / 'derived'
    known_video_ids = {v[0] for v in db.session.query(Video.video_id).all()}
    known_image_ids = {i[0] for i in db.session.query(Image.image_id).all()}
    known_ids = known_video_ids | known_image_ids
    orphans = []
    try:
        for entry in os.scandir(derived_root):
            if entry.is_dir() and entry.name not in known_ids:
                size = 0
                try:
                    for f in os.scandir(entry.path):
                        if f.is_file():
                            try:
                                size += f.stat(follow_symlinks=False).st_size
                            except OSError:
                                pass
                except OSError:
                    pass
                orphans.append({'video_id': entry.name, 'size': size})
    except OSError:
        pass
    return jsonify({'orphans': orphans})


@api.route('/api/admin/files/cleanup-orphaned-derived', methods=['POST'])
@login_required
@demo_restrict
def cleanup_orphaned_derived():
    """Delete orphaned derived folders (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')
    paths = current_app.config['PATHS']
    derived_root = paths['processed'] / 'derived'
    known_video_ids = {v[0] for v in db.session.query(Video.video_id).all()}
    known_image_ids = {i[0] for i in db.session.query(Image.image_id).all()}
    known_ids = known_video_ids | known_image_ids
    deleted = []
    errors = []
    try:
        for entry in os.scandir(derived_root):
            if entry.is_dir() and entry.name not in known_ids:
                try:
                    shutil.rmtree(entry.path)
                    deleted.append(entry.name)
                except OSError as e:
                    errors.append({'video_id': entry.name, 'error': str(e)})
    except OSError as e:
        return Response(status=500, response=str(e))
    return jsonify({'deleted': deleted, 'errors': errors})


# ---------------------------------------------------------------------------
# Image File Manager endpoints
# ---------------------------------------------------------------------------

@api.route('/api/admin/image-files', methods=['GET'])
@login_required
def get_admin_image_files():
    """Get all images with file metadata for the image file manager (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    image_directory = current_app.config.get('IMAGE_DIRECTORY')
    if not image_directory:
        return jsonify({'files': [], 'folders': []})

    image_path = Path(image_directory)
    paths = current_app.config['PATHS']

    images = Image.query.outerjoin(ImageInfo).all()

    # Single query for all game links
    game_links = ImageGameLink.query.join(ImageGameLink.game).filter(
        ImageGameLink.image_id.in_([img.image_id for img in images])
    ).all()
    game_map = {gl.image_id: gl.game.name for gl in game_links if gl.game}

    # Collect image file sizes in one scandir pass per folder
    size_map = {}
    folders = []
    try:
        for entry in os.scandir(image_path):
            if entry.is_dir() and not entry.name.startswith('.'):
                folders.append(entry.name)
                try:
                    for f in os.scandir(entry.path):
                        if f.is_file():
                            size_map[entry.name + '/' + f.name] = f.stat().st_size
                except Exception:
                    pass
            elif entry.is_file():
                try:
                    size_map[entry.name] = entry.stat().st_size
                except Exception:
                    pass
        folders.sort()
    except Exception:
        pass

    # Collect derived folder sizes
    derived_size_map = {}
    derived_root = paths['processed'] / 'derived'
    try:
        for entry in os.scandir(derived_root):
            if entry.is_dir():
                folder_total = 0
                try:
                    for f in os.scandir(entry.path):
                        if f.is_file():
                            try:
                                folder_total += f.stat(follow_symlinks=False).st_size
                            except OSError:
                                pass
                except OSError:
                    pass
                derived_size_map[entry.name] = folder_total
    except OSError:
        pass

    files = []
    for img in images:
        parts = img.path.replace('\\', '/').split('/')
        folder = parts[0] if len(parts) > 1 else ''
        filename = parts[-1]
        normalized_path = '/'.join(parts)

        files.append({
            'image_id': img.image_id,
            'filename': filename,
            'folder': folder,
            'path': img.path,
            'extension': img.extension,
            'size': size_map.get(normalized_path) or (img.info.file_size if img.info else None),
            'derived_size': derived_size_map.get(img.image_id, 0),
            'title': img.info.title if img.info else None,
            'width': img.info.width if img.info else None,
            'height': img.info.height if img.info else None,
            'private': img.info.private if img.info else True,
            'has_webp': img.info.has_webp if img.info else False,
            'has_thumbnail': img.info.has_thumbnail if img.info else False,
            'available': img.available,
            'created_at': img.created_at.isoformat() if img.created_at else None,
            'game': game_map.get(img.image_id),
            # See the matching field in get_admin_files.
            'uploader': img.uploader.mention_json() if img.uploader else None,
        })

    return jsonify({'files': files, 'folders': folders})


@api.route('/api/admin/image-files/bulk-delete', methods=['POST'])
@login_required
@demo_restrict
def bulk_delete_images():
    """Delete multiple images by ID (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    data = request.json
    image_ids = data.get('image_ids', [])
    if not image_ids:
        return Response(status=400, response='No image IDs provided.')

    image_directory = current_app.config.get('IMAGE_DIRECTORY')
    paths = current_app.config['PATHS']
    results = {'deleted': [], 'errors': []}

    for img_id in image_ids:
        img = Image.query.filter_by(image_id=img_id).first()
        if not img:
            results['errors'].append({'image_id': img_id, 'error': 'Not found'})
            continue

        folder_id = img.folder_id
        try:
            # Remove files
            if image_directory:
                file_path = Path(image_directory) / img.path
                if file_path.exists():
                    file_path.unlink()
            link_path = paths['processed'] / 'image_links' / f"{img_id}{img.extension}"
            if link_path.exists() or link_path.is_symlink():
                link_path.unlink()
            derived_path = paths['processed'] / 'derived' / img_id
            if derived_path.exists():
                shutil.rmtree(derived_path)

            # Remove DB records
            ImageTagLink.query.filter_by(image_id=img_id).delete()
            ImageGameLink.query.filter_by(image_id=img_id).delete()
            ImageView.query.filter_by(image_id=img_id).delete()
            ImageInfo.query.filter_by(image_id=img_id).delete()
            Image.query.filter_by(image_id=img_id).delete()
            db.session.commit()

            MediaFolder.cleanup_if_orphaned(folder_id, Image)
            results['deleted'].append(img_id)
        except Exception as e:
            db.session.rollback()
            results['errors'].append({'image_id': img_id, 'error': str(e)})

    return jsonify(results)


@api.route('/api/admin/image-files/bulk-move', methods=['POST'])
@login_required
@demo_restrict
def bulk_move_images():
    """Move multiple images to a target folder (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    data = request.json
    image_ids = data.get('image_ids', [])
    target_folder = (data.get('folder') or '').strip()

    if not image_ids:
        return Response(status=400, response='No image IDs provided.')
    if not target_folder:
        return Response(status=400, response='A target folder must be provided.')

    image_directory = current_app.config.get('IMAGE_DIRECTORY')
    if not image_directory:
        return Response(status=503, response='IMAGE_DIRECTORY is not configured.')

    image_path = Path(image_directory)
    resolved = resolve_media_subfolder(image_path, target_folder)
    if not resolved:
        return Response(status=400, response=f"Folder '{target_folder}' is not inside the image directory.")
    target_folder_path, target_folder = resolved
    paths = current_app.config['PATHS']

    if not target_folder_path.is_dir():
        return Response(status=400, response=f"Folder '{target_folder}' does not exist.")

    results = {'moved': [], 'errors': []}

    for img_id in image_ids:
        img = Image.query.filter_by(image_id=img_id).first()
        if not img:
            results['errors'].append({'image_id': img_id, 'error': 'Not found'})
            continue

        old_file_path = image_path / img.path
        filename = Path(img.path).name
        new_path = f"{target_folder}/{filename}" if target_folder else filename
        new_file_path = image_path / new_path

        if old_file_path.resolve() == new_file_path.resolve():
            results['errors'].append({'image_id': img_id, 'error': 'Already in that folder'})
            continue

        if new_file_path.exists():
            results['errors'].append({'image_id': img_id, 'error': f"File '{filename}' already exists in '{target_folder}'"})
            continue

        try:
            shutil.move(str(old_file_path), str(new_file_path))

            link_path = paths['processed'] / 'image_links' / f"{img_id}{img.extension}"
            if link_path.exists() or link_path.is_symlink():
                link_path.unlink()
            os.symlink(new_file_path.absolute(), link_path)

            img.path = new_path
            img.folder_id = (
                _get_or_create_media_folder(target_folder.split('/')[0], "image").id
                if target_folder else None
            )
            db.session.commit()
            results['moved'].append(img_id)
        except Exception as e:
            db.session.rollback()
            results['errors'].append({'image_id': img_id, 'error': str(e)})

    return jsonify(results)


@api.route('/api/admin/image-files/bulk-set-privacy', methods=['POST'])
@login_required
def bulk_set_image_privacy():
    """Set privacy for multiple images (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    data = request.json
    image_ids = data.get('image_ids', [])
    private = data.get('private')
    if not image_ids:
        return Response(status=400, response='No image IDs provided.')
    if private is None:
        return Response(status=400, response='A privacy value (private: true/false) must be provided.')

    results = {'updated': [], 'errors': []}

    for img_id in image_ids:
        image_info = ImageInfo.query.filter_by(image_id=img_id).first()
        if not image_info:
            results['errors'].append({'image_id': img_id, 'error': 'Not found'})
            continue
        try:
            image_info.private = bool(private)
            db.session.commit()
            results['updated'].append(img_id)
        except Exception as e:
            db.session.rollback()
            results['errors'].append({'image_id': img_id, 'error': str(e)})

    return jsonify(results)


@api.route('/api/admin/image-files/bulk-rename', methods=['POST'])
@login_required
def bulk_rename_images():
    """Bulk update titles for multiple images (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')
    data = request.json
    renames = data.get('renames', [])
    if not renames:
        return Response(status=400, response='No renames provided.')
    results = {'updated': [], 'errors': []}
    for item in renames:
        img_id = item.get('image_id')
        new_title = (item.get('title') or '').strip()
        if not img_id:
            continue
        image_info = ImageInfo.query.filter_by(image_id=img_id).first()
        if not image_info:
            results['errors'].append({'image_id': img_id, 'error': 'Not found'})
            continue
        try:
            image_info.title = new_title or None
            db.session.commit()
            results['updated'].append(img_id)
        except Exception as e:
            db.session.rollback()
            results['errors'].append({'image_id': img_id, 'error': str(e)})
    return jsonify(results)


@api.route('/api/admin/image-folders/create', methods=['POST'])
@login_required
def create_image_folder():
    """Create a new folder in the images root directory (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    image_directory = current_app.config.get('IMAGE_DIRECTORY')
    if not image_directory:
        return Response(status=503, response='IMAGE_DIRECTORY is not configured.')

    data = request.json
    folder_name = (data.get('name') or '').strip()

    if not folder_name:
        return Response(status=400, response='A folder name must be provided.')

    if '/' in folder_name or '\\' in folder_name or folder_name.startswith('.'):
        return Response(status=400, response='Invalid folder name.')

    new_folder_path = Path(image_directory) / folder_name

    if new_folder_path.exists():
        return Response(status=409, response=f"A folder named '{folder_name}' already exists.")

    try:
        new_folder_path.mkdir()
        logging.info(f"Created image folder: {new_folder_path}")
        return Response(status=201)
    except Exception as e:
        logging.error(f"Error creating image folder {folder_name}: {e}")
        return Response(status=500, response=str(e))


@api.route('/api/admin/image-folders/delete', methods=['POST'])
@login_required
def delete_image_folder():
    """Delete empty folders from the images root directory (admin only)"""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    image_directory = current_app.config.get('IMAGE_DIRECTORY')
    if not image_directory:
        return Response(status=503, response='IMAGE_DIRECTORY is not configured.')

    data = request.json
    folder_names = data.get('folders', [])

    if not folder_names:
        return Response(status=400, response='No folder names provided.')

    results = {'deleted': [], 'errors': []}

    # Load config to get protected folder names
    paths = current_app.config['PATHS']
    try:
        with open(paths['data'] / 'config.json', 'r') as f:
            config = json.load(f)
    except Exception:
        config = {}

    app_config = config.get('app_config', {})
    admin_upload_folder = app_config.get('admin_upload_folder_name', 'uploads').lower()
    public_upload_folder = app_config.get('public_upload_folder_name', 'public uploads').lower()

    for folder_name in folder_names:
        if '/' in folder_name or '\\' in folder_name or folder_name.startswith('.'):
            results['errors'].append({'folder': folder_name, 'error': 'Invalid folder name'})
            continue

        if folder_name.lower() in [admin_upload_folder, public_upload_folder]:
            results['errors'].append({'folder': folder_name, 'error': 'Cannot delete protected folder'})
            continue

        folder_path = Path(image_directory) / folder_name
        if not folder_path.exists() or not folder_path.is_dir():
            results['errors'].append({'folder': folder_name, 'error': 'Folder not found'})
            continue
        if any(folder_path.iterdir()):
            results['errors'].append({'folder': folder_name, 'error': 'Folder is not empty'})
            continue
        try:
            folder_path.rmdir()
            results['deleted'].append(folder_name)
            logging.info(f"Deleted empty image folder: {folder_path}")
            MediaFolder.query.filter_by(path=folder_name, media_type="image").delete()
        except Exception as e:
            results['errors'].append({'folder': folder_name, 'error': str(e)})

    db.session.commit()
    return jsonify(results)


@api.route('/api/admin/files/bulk-set-uploader', methods=['POST'])
@api.route('/api/admin/image-files/bulk-set-uploader', methods=['POST'])
@login_required
@demo_restrict
def bulk_set_uploader():
    """Attribute videos and/or images to a user, or clear their uploader.

    Exists because everything indexed from disk before ownership was introduced
    carries no uploader, so it appears on nobody's profile and is out of reach of
    the edit_own / delete_own permissions. This is how an administrator adopts
    that back-catalogue.
    """
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    from ..models import User

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return Response(status=400, response='Expected a JSON object body.')

    video_ids = data.get('video_ids') or []
    image_ids = data.get('image_ids') or []
    if not isinstance(video_ids, list) or not isinstance(image_ids, list):
        return Response(status=400, response='video_ids and image_ids must be lists.')
    video_ids = [v for v in video_ids if isinstance(v, str)]
    image_ids = [i for i in image_ids if isinstance(i, str)]
    if not video_ids and not image_ids:
        return Response(status=400, response='No media IDs provided.')

    # An explicit null means "make this unattributed again", which is different
    # from the key being absent.
    if 'username' not in data:
        return Response(status=400, response='A username (or null to clear) must be provided.')

    raw_username = data.get('username')
    user = None
    if raw_username is not None:
        username = perms.normalize_username(raw_username)
        if username is None:
            return Response(status=400, response='That username is not valid.')
        user = User.query.filter(func.lower(User.username) == username.lower()).first()
        if not user:
            return Response(status=404, response='No such user.')
        if user.disabled:
            return Response(status=400, response='That account is disabled.')

    owner_id = user.id if user else None

    updated_videos = 0
    if video_ids:
        updated_videos = (Video.query
                          .filter(Video.video_id.in_(video_ids))
                          .update({'uploaded_by': owner_id}, synchronize_session=False))
    updated_images = 0
    if image_ids:
        updated_images = (Image.query
                          .filter(Image.image_id.in_(image_ids))
                          .update({'uploaded_by': owner_id}, synchronize_session=False))
    db.session.commit()

    target = user.username if user else 'nobody'
    logger.info(
        f"Admin '{current_user.username}' attributed {updated_videos} video(s) and "
        f"{updated_images} image(s) to {target}"
    )

    return jsonify({
        'updated_videos': updated_videos,
        'updated_images': updated_images,
        'username': user.username if user else None,
    })


@api.route('/api/admin/uploaders', methods=['GET'])
@login_required
def list_uploader_candidates():
    """Accounts an administrator can attribute media to, for the File Manager picker."""
    if not current_user.admin and not current_app.config.get('DEMO_MODE'):
        return Response(status=403, response='Admin access required.')

    from ..models import User

    users = User.query.filter(User.disabled == False).order_by(User.username).all()
    unattributed_videos = Video.query.filter(Video.uploaded_by.is_(None)).count()
    unattributed_images = Image.query.filter(Image.uploaded_by.is_(None)).count()

    return jsonify({
        'users': [
            {'username': u.username, 'name': u.name, 'avatar_url': u.avatar_url()}
            for u in users
        ],
        'unattributed_videos': unattributed_videos,
        'unattributed_images': unattributed_images,
    })
