import fcntl
import json
import os
import tempfile
import threading
import time
from collections import Counter
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from subprocess import Popen

from flask import current_app, jsonify, request, Response
from flask_login import login_required, current_user

from .. import db, logger, util
from ..constants import DEFAULT_CONFIG
from ..models import Video, VideoInfo, VideoGameLink, GameMetadata, FolderRule, Image, ImageGameLink, ImageFolderRule, MediaFolder
from .. import permissions as P
from . import api
from .helpers import get_steamgriddb_api_key
from .decorators import demo_restrict, require_perm


# Cache for folder-size endpoint — recomputed at most once per minute
_folder_size_cache = {'result': None, 'expires_at': 0}
_FOLDER_SIZE_TTL = 60  # seconds

# The game scan runs in a thread of whichever gunicorn worker took the start
# request, but the status poll and the admin SSE stream can reach any worker. Its
# progress used to live in a dict in that one worker, so the others reported no
# scan (or the last one they ran) and could start a second scan alongside it.
# Every worker reads this file instead. It sits in shared memory under a
# fireshare_ name, which gunicorn.conf.py's on_starting clears with the
# sentinels, so a scan never outlives the server that ran it.
_SHM_DIR = "/dev/shm" if os.path.isdir("/dev/shm") else tempfile.gettempdir()
_GAME_SCAN_STATE_PATH = os.path.join(_SHM_DIR, "fireshare_game_scan_state.json")
_GAME_SCAN_LOCK_PATH = os.path.join(_SHM_DIR, "fireshare_game_scan_state.lock")

_GAME_SCAN_DEFAULT_STATE = {
    'is_running': False,
    'current': 0,
    'total': 0,
    'suggestions_created': 0,
    'pid': None,
}

# Matching a filename is quick, so progress is written at most this often (in seconds).
_GAME_SCAN_PROGRESS_INTERVAL = 0.25


@contextmanager
def _game_scan_lock():
    """Serialise read-modify-write of the game scan state across workers."""
    fd = os.open(_GAME_SCAN_LOCK_PATH, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)  # releases the lock


def _process_alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _read_game_scan_state():
    try:
        with open(_GAME_SCAN_STATE_PATH) as f:
            state = {**_GAME_SCAN_DEFAULT_STATE, **json.load(f)}
    except (OSError, ValueError):
        return dict(_GAME_SCAN_DEFAULT_STATE)
    if state['is_running'] and not _process_alive(state['pid']):
        # The worker running the scan was recycled or died, and the thread with it.
        state['is_running'] = False
    return state


def _write_game_scan_state(state):
    tmp = f"{_GAME_SCAN_STATE_PATH}.{os.getpid()}.tmp"
    with open(tmp, 'w') as f:
        json.dump(state, f)
    os.replace(tmp, _GAME_SCAN_STATE_PATH)  # readers never see half a file


def _update_game_scan_state(**fields):
    with _game_scan_lock():
        state = _read_game_scan_state()
        state.update(fields)
        _write_game_scan_state(state)


def game_scan_progress():
    """Progress of the current or last game scan, the same from every worker."""
    state = _read_game_scan_state()
    return {k: state[k] for k in ('is_running', 'current', 'total', 'suggestions_created')}


def get_folder_size(*folder_paths):
    """Return combined byte size of one or more folders using a fast iterative scandir walk."""
    total = 0
    for folder_path in folder_paths:
        try:
            stack = [folder_path]
            while stack:
                directory = stack.pop()
                try:
                    with os.scandir(directory) as it:
                        for entry in it:
                            try:
                                if entry.is_dir(follow_symlinks=False):
                                    stack.append(entry.path)
                                else:
                                    total += entry.stat(follow_symlinks=False).st_size
                            except OSError:
                                pass
                except OSError:
                    pass
        except OSError:
            pass
    return total


@api.route('/api/folder-size', methods=['GET'])
@login_required
def folder_size():
    if time.time() < _folder_size_cache['expires_at']:
        return jsonify(_folder_size_cache['result'])

    paths = current_app.config['PATHS']
    video_path = str(paths['video'])
    derived_path = str(paths['processed'] / 'derived')
    image_path = str(paths['images']) if 'images' in paths else None
    size_bytes = get_folder_size(video_path, derived_path, *([image_path] if image_path else []))
    size_mb = size_bytes / (1024 * 1024)

    if size_mb < 1024:
        rounded_mb = round(size_mb)
        size_pretty = f"{rounded_mb} MB"
    elif size_mb < 1024 * 1024:
        size_gb = size_mb / 1024
        size_pretty = f"{round(size_gb, 1)} GB"
    else:
        size_tb = size_mb / (1024 * 1024)
        size_pretty = f"{round(size_tb, 1)} TB"

    result = {"folders": [video_path, derived_path, image_path], "size_bytes": size_bytes, "size_pretty": size_pretty}
    _folder_size_cache['result'] = result
    _folder_size_cache['expires_at'] = time.time() + _FOLDER_SIZE_TTL
    return jsonify(result)


@api.route('/api/manual/scan')
@require_perm(P.MANAGE_LIBRARY)
@demo_restrict
def manual_scan():
    current_app.logger.info(f"Executed manual scan")
    Popen(["fireshare", "bulk-import"], shell=False, start_new_session=True)
    return Response(status=200)


@api.route('/api/manual/scan-images')
@require_perm(P.MANAGE_LIBRARY)
@demo_restrict
def manual_scan_images():
    current_app.logger.info(f"Executed manual image scan")
    Popen(["fireshare", "scan-images"], shell=False, start_new_session=True)
    return Response(status=200)


@api.route('/api/manual/scan-dates')
@require_perm(P.MANAGE_LIBRARY)
@demo_restrict
def manual_scan_dates():
    """Extract recording dates from filenames for videos missing recorded_at"""
    try:
        videos = Video.query.filter(Video.recorded_at.is_(None)).all()
        dates_extracted = 0
        paths = current_app.config['PATHS']
        videos_path = paths["video"]

        for video in videos:
            video_file_path = videos_path / video.path
            recorded_at = util.extract_date_from_file(video_file_path)
            if recorded_at:
                video.recorded_at = recorded_at
                dates_extracted += 1
                logger.info(f"Extracted date {recorded_at.isoformat()} for video {video.video_id}")

        db.session.commit()

        return jsonify({
            'success': True,
            'videos_scanned': len(videos),
            'dates_extracted': dates_extracted
        }), 200

    except Exception as e:
        logger.error(f"Error scanning for dates: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@api.route('/api/manual/rescan-dates')
@require_perm(P.MANAGE_LIBRARY)
@demo_restrict
def manual_rescan_dates():
    """Re-extract and overwrite recorded_at for all videos and created_at for all images."""
    app = current_app._get_current_object()

    def run_rescan():
        with app.app_context():
            try:
                paths = app.config['PATHS']
                videos_path = paths["video"]
                images_path = paths.get("images")

                videos = Video.query.all()
                video_dates_updated = 0
                for video in videos:
                    recorded_at = util.extract_date_from_file(videos_path / video.path)
                    if recorded_at:
                        video.recorded_at = recorded_at
                        video_dates_updated += 1

                images = Image.query.all() if images_path else []
                image_dates_updated = 0
                for image in images:
                    created_at = util.extract_date_from_image_file(images_path / image.path)
                    if created_at:
                        image.created_at = created_at
                        image_dates_updated += 1

                db.session.commit()
                logger.info(f"Rescan dates complete: {video_dates_updated}/{len(videos)} videos, {image_dates_updated}/{len(images)} images updated")
            except Exception as e:
                logger.error(f"Error rescanning dates: {e}")

    thread = threading.Thread(target=run_rescan)
    thread.daemon = True
    thread.start()

    return jsonify({'success': True, 'message': 'Date rescan started in background'}), 200


def _get_or_create_media_folder(folder_cache, dirname, media_type):
    key = (dirname, media_type)
    folder = folder_cache.get(key)
    if folder:
        return folder
    folder = MediaFolder.query.filter_by(path=dirname, media_type=media_type).first()
    if not folder:
        now = datetime.utcnow()
        folder = MediaFolder(path=dirname, media_type=media_type, private=True, available=True,
                              created_at=now, updated_at=now)
        db.session.add(folder)
        db.session.flush()
    folder_cache[key] = folder
    return folder


@api.route('/api/manual/scan-folders')
@require_perm(P.MANAGE_LIBRARY)
@demo_restrict
def manual_scan_folders():
    """Re-derive top-level folder assignments for all videos/images and clean up orphaned folders."""
    try:
        folder_cache = {}
        reassigned = 0

        for video in Video.query.filter_by(available=True).all():
            dirname = os.path.dirname(video.path)
            top_level = dirname.split(os.sep)[0] if dirname else None
            folder = _get_or_create_media_folder(folder_cache, top_level, "video") if top_level else None
            folder_id = folder.id if folder else None
            if video.folder_id != folder_id:
                video.folder_id = folder_id
                reassigned += 1

        for image in Image.query.filter_by(available=True).all():
            dirname = os.path.dirname(image.path)
            top_level = dirname.split(os.sep)[0] if dirname else None
            folder = _get_or_create_media_folder(folder_cache, top_level, "image") if top_level else None
            folder_id = folder.id if folder else None
            if image.folder_id != folder_id:
                image.folder_id = folder_id
                reassigned += 1

        db.session.commit()

        removed = 0
        for folder in MediaFolder.query.all():
            model = Video if folder.media_type == "video" else Image
            if model.query.filter_by(folder_id=folder.id).count() == 0:
                MediaFolder.query.filter_by(id=folder.id).delete()
                removed += 1
        db.session.commit()

        return jsonify({
            'success': True,
            'reassigned': reassigned,
            'folders_removed': removed,
        }), 200

    except Exception as e:
        db.session.rollback()
        logger.error(f"Error scanning folders: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@api.route('/api/scan-games/status')
@login_required
def get_game_scan_status():
    """Return current game scan progress"""
    return jsonify(game_scan_progress())


@api.route('/api/folder-suggestions')
@login_required
def get_folder_suggestions():
    """Get all pending folder suggestions"""
    from fireshare.cli import _load_suggestions
    suggestions = _load_suggestions()
    logger.info(f"Loaded suggestions file, keys: {len(suggestions.keys())}")
    folders = suggestions.get('_folders', {})
    logger.info(f"Returning {len(folders)} folder suggestions: {list(folders.keys())}")
    return jsonify(folders)


@api.route('/api/folder-suggestions/<path:folder_name>/dismiss', methods=['POST'])
@require_perm(P.MANAGE_GAMES)
def dismiss_folder_suggestion(folder_name):
    """Dismiss a folder suggestion"""
    from fireshare.cli import _load_suggestions, _save_suggestions

    suggestions = _load_suggestions()
    folder_suggestions = suggestions.get('_folders', {})

    if folder_name not in folder_suggestions:
        logger.warning(f"Folder suggestion not found: {folder_name}")
        return jsonify({'error': 'Folder suggestion not found'}), 404

    video_count = len(folder_suggestions[folder_name].get('video_ids', []))
    del folder_suggestions[folder_name]
    suggestions['_folders'] = folder_suggestions
    _save_suggestions(suggestions)

    logger.info(f"Dismissed folder suggestion: {folder_name} ({video_count} videos)")
    return jsonify({'dismissed': True})


@api.route('/api/folder-rules')
@login_required
def get_folder_rules():
    """Get all folders with their rules and suggested games based on linked videos"""

    # Skip upload folders
    upload_folders = {
        DEFAULT_CONFIG['app_config']['admin_upload_folder_name'].lower(),
        DEFAULT_CONFIG['app_config']['public_upload_folder_name'].lower(),
    }

    # Get existing rules keyed by folder
    rules = {rule.folder_path: rule for rule in FolderRule.query.all()}

    # Build folder -> video_ids and video -> game_id maps
    folders = {}
    video_to_game = {link.video_id: link.game_id for link in VideoGameLink.query.all()}
    games = {g.id: g for g in GameMetadata.query.all()}

    for video in Video.query.all():
        parts = video.path.replace('\\', '/').split('/')
        if len(parts) > 1:
            folder = parts[0]
            if folder.lower() in upload_folders:
                continue
            if folder not in folders:
                folders[folder] = []
            folders[folder].append(video.video_id)

    result = []
    for folder in sorted(folders.keys()):
        video_ids = folders[folder]
        rule = rules.get(folder)

        # Find most common game among linked videos in this folder
        game_counts = Counter(video_to_game[vid] for vid in video_ids if vid in video_to_game)
        suggested_game = None
        if game_counts:
            top_game = games.get(game_counts.most_common(1)[0][0])
            if top_game:
                suggested_game = top_game.json()

        result.append({
            'folder_path': folder,
            'rule': rule.json() if rule else None,
            'suggested_game': suggested_game,
            'video_count': len(video_ids)
        })

    return jsonify(result)


@api.route('/api/folder-rules', methods=['POST'])
@require_perm(P.MANAGE_GAMES)
@demo_restrict
def create_folder_rule():
    """Create a folder rule and backfill existing untagged videos"""
    from ..cli import _load_suggestions, _save_suggestions
    data = request.get_json()

    if not data or not data.get('folder_path') or not data.get('game_id'):
        return jsonify({'error': 'folder_path and game_id are required'}), 400

    folder_path = data['folder_path']
    game_id = data['game_id']

    # Check if rule already exists for this folder
    existing = FolderRule.query.filter_by(folder_path=folder_path).first()
    if existing:
        existing.game_id = game_id
        db.session.commit()
        logger.info(f"Updated folder rule: {folder_path} -> game {game_id}")
        rule = existing
        is_new = False
    else:
        rule = FolderRule(
            folder_path=folder_path,
            game_id=game_id
        )
        db.session.add(rule)
        db.session.commit()
        logger.info(f"Created folder rule: {folder_path} -> game {game_id}")
        is_new = True

    # Tag ALL videos in this folder to the new game (update existing + create new)
    videos_in_folder = Video.query.filter(Video.path.like(f"{folder_path}/%")).all()
    video_ids = [v.video_id for v in videos_in_folder]
    existing_links = {link.video_id: link for link in VideoGameLink.query.filter(VideoGameLink.video_id.in_(video_ids)).all()}

    updated = 0
    created = 0

    for video in videos_in_folder:
        if video.video_id in existing_links:
            # Update existing link to new game
            existing_links[video.video_id].game_id = game_id
            updated += 1
        else:
            # Create new link
            link = VideoGameLink(
                video_id=video.video_id,
                game_id=game_id,
                created_at=datetime.utcnow()
            )
            db.session.add(link)
            created += 1

    if updated or created:
        db.session.commit()
        logger.info(f"Folder '{folder_path}': updated {updated}, created {created} link(s) to game {game_id}")

    # Clear individual suggestions for videos in this folder only
    suggestions = _load_suggestions()
    cleared_suggestions = 0
    video_ids_in_folder = {v.video_id for v in videos_in_folder}
    for video_id in list(suggestions.keys()):
        if video_id in video_ids_in_folder and video_id != '_folders':
            del suggestions[video_id]
            cleared_suggestions += 1
            logger.info(f"[Backfill] Cleared suggestion for {video_id}")
    if cleared_suggestions:
        _save_suggestions(suggestions)
        logger.info(f"Cleared {cleared_suggestions} individual suggestion(s) for folder '{folder_path}'")

    response = rule.json()
    response['backfilled'] = updated + created
    response['cleared_suggestions'] = cleared_suggestions
    return jsonify(response), 201 if is_new else 200


@api.route('/api/folder-rules/<int:rule_id>', methods=['DELETE'])
@require_perm(P.MANAGE_GAMES)
@demo_restrict
def delete_folder_rule(rule_id):
    """Delete a folder rule, optionally unlinking videos"""
    rule = db.session.get(FolderRule, rule_id)
    if not rule:
        return jsonify({'error': 'Folder rule not found'}), 404

    unlink_videos = request.args.get('unlink_videos', 'false').lower() == 'true'
    unlinked_count = 0

    if unlink_videos:
        # Batch query: get only video IDs in folder, then delete matching links in one query
        video_ids = [v[0] for v in db.session.query(Video.video_id).filter(Video.path.like(f"{rule.folder_path}/%")).all()]
        if video_ids:
            unlinked_count = VideoGameLink.query.filter(
                VideoGameLink.video_id.in_(video_ids),
                VideoGameLink.game_id == rule.game_id
            ).delete(synchronize_session=False)

    folder_path = rule.folder_path
    db.session.delete(rule)
    db.session.commit()

    logger.info(f"Deleted folder rule: {folder_path} (unlinked {unlinked_count} videos)")
    return jsonify({'deleted': True, 'unlinked_count': unlinked_count})


# ── Image Folder Rules ──────────────────────────────────────────────────────

@api.route('/api/image-folder-rules')
@login_required
def get_image_folder_rules():
    """Get all image folders with their rules and suggested games based on linked images"""

    upload_folders = {
        DEFAULT_CONFIG['app_config']['admin_upload_folder_name'].lower(),
        DEFAULT_CONFIG['app_config']['public_upload_folder_name'].lower(),
    }

    rules = {rule.folder_path: rule for rule in ImageFolderRule.query.all()}

    folders = {}
    image_to_game = {link.image_id: link.game_id for link in ImageGameLink.query.all()}
    games = {g.id: g for g in GameMetadata.query.all()}

    for image in Image.query.all():
        parts = image.path.replace('\\', '/').split('/')
        if len(parts) > 1:
            folder = parts[0]
            if folder.lower() in upload_folders:
                continue
            if folder not in folders:
                folders[folder] = []
            folders[folder].append(image.image_id)

    result = []
    for folder in sorted(folders.keys()):
        image_ids = folders[folder]
        rule = rules.get(folder)

        game_counts = Counter(image_to_game[iid] for iid in image_ids if iid in image_to_game)
        suggested_game = None
        if game_counts:
            top_game = games.get(game_counts.most_common(1)[0][0])
            if top_game:
                suggested_game = top_game.json()

        result.append({
            'folder_path': folder,
            'rule': rule.json() if rule else None,
            'suggested_game': suggested_game,
            'image_count': len(image_ids)
        })

    return jsonify(result)


@api.route('/api/image-folder-rules', methods=['POST'])
@require_perm(P.MANAGE_GAMES)
@demo_restrict
def create_image_folder_rule():
    """Create an image folder rule and backfill existing untagged images"""
    data = request.get_json()

    if not data or not data.get('folder_path') or not data.get('game_id'):
        return jsonify({'error': 'folder_path and game_id are required'}), 400

    folder_path = data['folder_path']
    game_id = data['game_id']

    existing = ImageFolderRule.query.filter_by(folder_path=folder_path).first()
    if existing:
        existing.game_id = game_id
        db.session.commit()
        logger.info(f"Updated image folder rule: {folder_path} -> game {game_id}")
        rule = existing
        is_new = False
    else:
        rule = ImageFolderRule(folder_path=folder_path, game_id=game_id)
        db.session.add(rule)
        db.session.commit()
        logger.info(f"Created image folder rule: {folder_path} -> game {game_id}")
        is_new = True

    images_in_folder = Image.query.filter(Image.path.like(f"{folder_path}/%")).all()
    image_ids = [img.image_id for img in images_in_folder]
    existing_links = {link.image_id: link for link in ImageGameLink.query.filter(ImageGameLink.image_id.in_(image_ids)).all()}

    updated = 0
    created = 0

    for img in images_in_folder:
        if img.image_id in existing_links:
            existing_links[img.image_id].game_id = game_id
            updated += 1
        else:
            link = ImageGameLink(image_id=img.image_id, game_id=game_id, created_at=datetime.utcnow())
            db.session.add(link)
            created += 1

    if updated or created:
        db.session.commit()
        logger.info(f"Image folder '{folder_path}': updated {updated}, created {created} link(s) to game {game_id}")

    response = rule.json()
    response['backfilled'] = updated + created
    return jsonify(response), 201 if is_new else 200


@api.route('/api/image-folder-rules/<int:rule_id>', methods=['DELETE'])
@require_perm(P.MANAGE_GAMES)
@demo_restrict
def delete_image_folder_rule(rule_id):
    """Delete an image folder rule, optionally unlinking images"""
    rule = db.session.get(ImageFolderRule, rule_id)
    if not rule:
        return jsonify({'error': 'Image folder rule not found'}), 404

    unlink_images = request.args.get('unlink_images', 'false').lower() == 'true'
    unlinked_count = 0

    if unlink_images:
        image_ids = [i[0] for i in db.session.query(Image.image_id).filter(Image.path.like(f"{rule.folder_path}/%")).all()]
        if image_ids:
            unlinked_count = ImageGameLink.query.filter(
                ImageGameLink.image_id.in_(image_ids),
                ImageGameLink.game_id == rule.game_id
            ).delete(synchronize_session=False)

    folder_path = rule.folder_path
    db.session.delete(rule)
    db.session.commit()

    logger.info(f"Deleted image folder rule: {folder_path} (unlinked {unlinked_count} images)")
    return jsonify({'deleted': True, 'unlinked_count': unlinked_count})


@api.route('/api/manual/scan-games')
@require_perm(P.MANAGE_GAMES)
@demo_restrict
def manual_scan_games():
    """Start game scan in background thread"""
    from fireshare.cli import save_game_suggestions_batch, _load_suggestions

    # Check if already running, in any worker
    with _game_scan_lock():
        if _read_game_scan_state()['is_running']:
            return jsonify({'already_running': True}), 409
        _write_game_scan_state({**_GAME_SCAN_DEFAULT_STATE, 'is_running': True, 'pid': os.getpid()})

    # Get app context for background thread
    app = current_app._get_current_object()

    def run_scan():
        progress = {'current': 0, 'total': 0, 'suggestions_created': 0}
        reported_at = 0.0

        def report(force=False):
            nonlocal reported_at
            if force or time.monotonic() - reported_at >= _GAME_SCAN_PROGRESS_INTERVAL:
                reported_at = time.monotonic()
                _update_game_scan_state(**progress)

        with app.app_context():
            try:
                steamgriddb_api_key = get_steamgriddb_api_key()
                logger.info(f"Starting game scan, API key configured: {bool(steamgriddb_api_key)}")

                # Get all videos
                videos = Video.query.join(VideoInfo).all()
                logger.info(f"Found {len(videos)} total videos in database")

                # Load existing suggestions and linked videos upfront (single queries)
                existing_suggestions = _load_suggestions()
                linked_video_ids = {link.video_id for link in VideoGameLink.query.all()}
                existing_folder_suggestions = existing_suggestions.get('_folders', {})
                logger.info(f"Existing suggestions: {len(existing_suggestions) - 1 if '_folders' in existing_suggestions else len(existing_suggestions)} individual, {len(existing_folder_suggestions)} folders")
                logger.info(f"Already linked videos: {len(linked_video_ids)}")

                # Get all unlinked videos for folder grouping
                unlinked_videos = [v for v in videos if v.video_id not in linked_video_ids]
                logger.info(f"Unlinked videos for folder grouping: {len(unlinked_videos)}")

                # Videos needing individual suggestions (not linked and no existing suggestion)
                videos_needing_suggestions = [
                    video for video in unlinked_videos
                    if video.video_id not in existing_suggestions
                ]
                logger.info(f"Videos needing individual suggestions: {len(videos_needing_suggestions)}")

                # Set total for progress tracking
                progress['total'] = len(unlinked_videos)
                report(force=True)

                # If nothing unlinked, we're done
                if not unlinked_videos:
                    logger.info("Game scan complete: no unlinked videos to process")
                    return
                suggestions_created = 0

                # Group ALL unlinked videos by folder (not just those without suggestions)
                folder_videos = {}
                for video in unlinked_videos:
                    normalized_path = video.path.replace('\\', '/')
                    parts = [part for part in normalized_path.split('/') if part]
                    folder = parts[0] if len(parts) > 1 else None
                    if folder:
                        if folder not in folder_videos:
                            folder_videos[folder] = []
                        folder_videos[folder].append(video)

                logger.info(f"Grouped videos into {len(folder_videos)} folders")
                for folder, vids in folder_videos.items():
                    logger.info(f"  Folder '{folder}': {len(vids)} videos")

                # Process folder suggestions (folders with 2+ videos)
                folder_suggestions = existing_suggestions.get('_folders', {})
                processed_video_ids = set()

                # Skip upload folders
                upload_folders = {
                    DEFAULT_CONFIG['app_config']['admin_upload_folder_name'].lower(),
                    DEFAULT_CONFIG['app_config']['public_upload_folder_name'].lower(),
                }

                for folder, folder_vids in folder_videos.items():
                    # Skip upload folders
                    if folder.lower() in upload_folders:
                        logger.info(f"Skipping upload folder '{folder}' for game detection")
                        continue
                    logger.info(f"Processing folder '{folder}': {len(folder_vids)} videos, already in suggestions: {folder in folder_suggestions}")
                    if len(folder_vids) >= 2 and folder not in folder_suggestions:
                        logger.info(f"Attempting game detection for folder: '{folder}'")
                        detected_game = util.detect_game_from_filename(folder, steamgriddb_api_key, path=f"{folder}/")

                        if detected_game:
                            logger.info(f"Detection result for '{folder}': {detected_game['game_name']} (confidence: {detected_game['confidence']:.2f})")
                        else:
                            logger.info(f"No game detected for folder '{folder}'")

                        if detected_game and detected_game['confidence'] >= 0.65:
                            video_ids = [v.video_id for v in folder_vids]
                            folder_suggestions[folder] = {
                                'game_name': detected_game['game_name'],
                                'steamgriddb_id': detected_game.get('steamgriddb_id'),
                                'game_id': detected_game.get('game_id'),
                                'confidence': detected_game['confidence'],
                                'source': detected_game['source'],
                                'video_ids': video_ids,
                                'video_count': len(video_ids)
                            }
                            processed_video_ids.update(video_ids)
                            suggestions_created += 1
                            progress['suggestions_created'] = suggestions_created
                            report()
                            logger.info(f"Created folder suggestion: {folder} -> {detected_game['game_name']} ({len(video_ids)} videos)")
                        elif detected_game:
                            logger.info(f"Skipping folder '{folder}' - confidence {detected_game['confidence']:.2f} below threshold 0.65")

                # Save folder suggestions
                if folder_suggestions:
                    existing_suggestions['_folders'] = folder_suggestions
                    from fireshare.cli import _save_suggestions
                    _save_suggestions(existing_suggestions)

                # Process remaining individual videos (not in folder suggestions and no existing suggestion)
                pending_suggestions = {}
                for i, video in enumerate(videos_needing_suggestions):
                    progress['current'] = i + 1
                    report()

                    if video.video_id in processed_video_ids:
                        continue

                    filename = Path(video.path).stem
                    detected_game = util.detect_game_from_filename(filename, steamgriddb_api_key, path=video.path)

                    if detected_game and detected_game['confidence'] >= 0.65:
                        pending_suggestions[video.video_id] = detected_game
                        suggestions_created += 1
                        progress['suggestions_created'] = suggestions_created
                        logger.info(f"Queued game suggestion for video {video.video_id}: {detected_game['game_name']} (confidence: {detected_game['confidence']:.2f}, source: {detected_game['source']})")

                # Batch save all suggestions at once
                if pending_suggestions:
                    save_game_suggestions_batch(pending_suggestions)
                    logger.info(f"Saved {len(pending_suggestions)} suggestion(s) in batch")

                logger.info(f"Game scan complete: {suggestions_created} suggestions created from {len(unlinked_videos)} unlinked videos")

            except Exception as e:
                logger.error(f"Error scanning videos for games: {e}")
            finally:
                report(force=True)
                # Brief delay so frontend can display the completed status before hiding
                time.sleep(2)
                _update_game_scan_state(is_running=False)

    thread = threading.Thread(target=run_scan)
    thread.daemon = True
    thread.start()

    return jsonify({'started': True}), 202
