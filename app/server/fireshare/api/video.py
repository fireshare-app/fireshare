import json
import logging
import os
import posixpath
import random
import re
import secrets
import shutil
import time as _time
import subprocess
import tempfile
import threading
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import unquote

from flask import current_app, jsonify, request, Response, send_file, session
from flask_login import login_required, current_user
from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy import func
from sqlalchemy.sql import text

from .. import db, logger, util
from ..models import Video, VideoInfo, VideoView, VideoGameLink, VideoTagLink, FolderRule, MediaFolder
from .. import permissions as P
from . import api
from .helpers import (
    add_cache_headers,
    add_poster_cache_headers,
    cancel_pending_transcode_jobs,
    delete_video_files,
    get_video_path,
    resolve_media_subfolder,
    viewer_sees_private,
)
from .decorators import demo_restrict, require_perm


def _stream_video_file(video_path):
    """Stream a video file with proper Range request support (RFC 7233).

    Uses Flask's send_file with conditional=True so that:
    - Requests without a Range header receive 200 OK with Accept-Ranges and Content-Length,
      allowing browsers (especially Firefox) to discover range support.
    - Requests with a Range header receive 206 Partial Content with Content-Range.
    """
    return send_file(video_path, mimetype='video/mp4', conditional=True)


def _delete_if_exists(path):
    if path.exists():
        path.unlink()


def _reset_derived_videos(video_id, video_info, derived_dir):
    """Delete the crop, the SDR copy and the transcodes, and mark them all missing."""
    for suffix in ('cropped', 'sdr', '480p', '720p', '1080p'):
        _delete_if_exists(derived_dir / f"{video_id}-{suffix}.mp4")
    # The compare previews are cut from the crop, so a new crop moves their timestamps.
    shutil.rmtree(derived_dir / "tonemap-preview", ignore_errors=True)
    video_info.has_crop = False
    video_info.has_sdr = False
    video_info.has_480p = False
    video_info.has_720p = False
    video_info.has_1080p = False
    db.session.commit()


def _transcoding_settings(paths):
    """The transcoding section of config.json, as the scheduled scan reads it."""
    config_path = paths['data'] / 'config.json'
    if not config_path.exists():
        return {}
    with open(config_path) as f:
        return json.load(f).get('transcoding', {})


def _wanted_heights(video_info, paths, had_480p, had_720p, had_1080p):
    """
    The transcodes to make once a crop is saved or cleared: the ones the video had,
    plus any the scheduled scan would make. A save that lands while an earlier one is
    still being processed finds the flags already reset, so what the video had is not
    enough on its own, and the earlier save's thread stops without making them.
    """
    heights = {h for h, had in ((480, had_480p), (720, had_720p), (1080, had_1080p)) if had}
    if current_app.config.get('ENABLE_TRANSCODING'):
        transcoding = _transcoding_settings(paths)
        if transcoding.get('auto_transcode', True):
            # Same rule as the scan: only heights below the source's, or all of them
            # when its height is unknown.
            heights |= {h for h in (480, 720, 1080)
                        if transcoding.get(f'enable_{h}p', True) and (not video_info.height or video_info.height > h)}
    return sorted(heights)


def _thumbnail_skip():
    thumbnail_skip = current_app.config.get('THUMBNAIL_VIDEO_LOCATION') or 0
    if thumbnail_skip > 0 and thumbnail_skip <= 100:
        return thumbnail_skip / 100
    return 0


def _clear_crop(video, video_info, paths, had_480p, had_720p, had_1080p):
    """Delete all crop-related files and reset DB flags, then re-transcode from original."""
    derived_dir = paths["processed"] / "derived" / video.video_id
    _reset_derived_videos(video.video_id, video_info, derived_dir)

    # The thread also regenerates the thumbnail from the original, and runs even with no
    # transcodes to make, so it removes a crop that was still being made.
    heights = _wanted_heights(video_info, paths, had_480p, had_720p, had_1080p)
    _rebuild_derived_async(video, paths, heights, thumbnail_skip=_thumbnail_skip(), tonemap=video_info.tonemap)


def _apply_crop_async(video, video_info, start_time, end_time, paths):
    """Clear old crop files, then create new crop and re-transcode in a background thread."""
    heights = _wanted_heights(video_info, paths, video_info.has_480p, video_info.has_720p, video_info.has_1080p)

    derived_dir = paths["processed"] / "derived" / video.video_id
    derived_dir.mkdir(parents=True, exist_ok=True)

    # Remove old files and mark flags as pending
    _reset_derived_videos(video.video_id, video_info, derived_dir)

    _rebuild_derived_async(video, paths, heights, start_time, end_time, _thumbnail_skip(), tonemap=video_info.tonemap)


def _rebuild_for_tonemap(video, video_info, paths):
    """Make (or remove) the SDR copy and remake the transcodes from it, keeping the crop."""
    heights = _wanted_heights(video_info, paths, video_info.has_480p, video_info.has_720p, video_info.has_1080p)

    derived_dir = paths["processed"] / "derived" / video.video_id
    derived_dir.mkdir(parents=True, exist_ok=True)

    # The crop is a stream copy and takes seconds, so it is simply made again.
    _reset_derived_videos(video.video_id, video_info, derived_dir)

    _rebuild_derived_async(video, paths, heights, video_info.start_time, video_info.end_time, _thumbnail_skip(),
                           tonemap=video_info.tonemap)


def _rebuild_derived_async(video, paths, heights, start_time=None, end_time=None, thumbnail_skip=0, tonemap=None):
    """
    Make the crop (when start_time or end_time is set), the SDR copy (when tonemap is
    set), the thumbnail, and then the transcodes in heights, each from the previous step's
    output or from the original when there is none, in a background thread.

    The thread holds the video's lock throughout, so the scheduled scan's transcoder
    skips the video instead of writing the same files from the uncropped original, and
    a second save waits for this one instead of racing it. Whichever save is current
    once the lock is free does the work: a thread whose crop has since been changed or
    cleared stops at its next step, and the newer save's thread redoes everything.
    """
    video_id = video.video_id
    derived_dir = paths["processed"] / "derived" / video_id
    original_path = paths["processed"] / "video_links" / f"{video_id}{video.extension}"
    cropped_path = derived_dir / f"{video_id}-cropped.mp4"
    sdr_path = derived_dir / f"{video_id}-sdr.mp4"
    app = current_app._get_current_object()
    # The encoder the scheduled scan uses. These were left at their defaults, so a crop's
    # transcodes always ran on the CPU, even on a server set up for NVENC.
    use_gpu = current_app.config.get('TRANSCODE_GPU', False)
    encoder_preference = _transcoding_settings(paths).get('encoder_preference', 'auto')

    def current_info():
        """The video's info, or None once a newer save has replaced this crop or tone map."""
        vi = VideoInfo.query.filter_by(video_id=video_id).first()
        return vi if vi and (vi.start_time, vi.end_time, vi.tonemap) == (start_time, end_time, tonemap) else None

    def still_current():
        with app.app_context():
            return current_info() is not None

    def run():
        with util.video_lock(video_id):
            with app.app_context():
                vi = current_info()
                if not vi:
                    return
                # Cleared again now that the lock is held: a transcode that was part-way
                # through this video when the save came in has since written its output.
                _reset_derived_videos(video_id, vi, derived_dir)
                duration = vi.duration or 0
                assume_pq = util.stream_needs_pq_assumed(vi.vcodec) if vi.is_hdr else False

            source_path, source_duration = original_path, duration
            if start_time is not None or end_time is not None:
                if not util.create_video_crop(original_path, cropped_path, start_time, end_time):
                    logger.error(f"Crop failed for video {video_id}")
                    return
                with app.app_context():
                    vi = current_info()
                    if not vi:
                        return
                    vi.has_crop = True
                    db.session.commit()
                source_path, source_duration = cropped_path, (end_time or duration) - (start_time or 0)

            if tonemap:
                if not still_current():
                    return
                success, failure_reason = util.create_sdr_video(
                    source_path, sdr_path, tonemap, use_gpu, encoder_preference, assume_pq=assume_pq
                )
                with app.app_context():
                    vi = current_info()
                    if not vi:
                        return
                    if success:
                        vi.has_sdr = True
                        vi.sdr_error = None
                        source_path = sdr_path
                    else:
                        # The transcodes are still made, from the HDR source, so the video
                        # keeps playing; the editor sees why there is no SDR copy.
                        vi.sdr_error = util.sdr_failure_message(failure_reason)
                        logger.error(f"SDR copy of {video_id} failed: {vi.sdr_error}")
                    db.session.commit()

            # Regenerate thumbnail from whichever file now plays
            if not still_current():
                return
            util.create_poster(source_path, derived_dir / "poster.jpg", int(source_duration * thumbnail_skip))

            for height in heights:
                if not still_current():
                    return
                success, _ = util.transcode_video_quality(
                    source_path, derived_dir / f"{video_id}-{height}p.mp4", height, use_gpu, None, encoder_preference
                )
                with app.app_context():
                    vi = current_info()
                    if not vi:
                        return
                    if success:
                        setattr(vi, f'has_{height}p', True)
                        db.session.commit()

    threading.Thread(target=run, daemon=True).start()


@api.route('/api/videos')
@login_required
def get_videos():
    sort = request.args.get('sort')
    # Check that the sort parameter is one of the allowed values
    allowed_sorts = [
        'updated_at desc',
        'updated_at asc',
        'video_info.title desc',
        'video_info.title asc',
        'views desc',
        'views asc'
    ]
    if sort not in allowed_sorts:
        return jsonify({"error": "Invalid sort parameter"}), 400

    query = Video.query.join(VideoInfo)
    if not viewer_sees_private():
        query = query.filter(VideoInfo.private.is_(False))

    if "views" in sort:
        videos = query.all()
    else:
        videos = query.order_by(text(sort)).all()

    videos_json = []
    for v in videos:
        vjson = v.json()
        vjson["view_count"] = VideoView.count(v.video_id)
        vjson["tags"] = [l.tag.json() for l in VideoTagLink.query.filter_by(video_id=v.video_id).all() if l.tag is not None]
        if vjson.get("info", {}).get("has_password"):
            vjson["info"]["session_unlocked"] = _is_session_unlocked(v.video_id)
        videos_json.append(vjson)

    if sort == "views asc":
        videos_json = sorted(videos_json, key=lambda d: d['view_count'])
    if sort == 'views desc':
        videos_json = sorted(videos_json, key=lambda d: d['view_count'], reverse=True)

    return jsonify({"videos": videos_json})


@api.route('/api/video/random')
@login_required
def get_random_video():
    import random
    query = Video.query.join(VideoInfo)
    if not viewer_sees_private():
        query = query.filter(VideoInfo.private.is_(False))
    row_count = query.count()
    if not row_count:
        return Response(status=404, response='No videos available.')
    random_video = query.offset(int(row_count * random.random())).first()
    current_app.logger.info(f"Fetched random video {random_video.video_id}: {random_video.info.title}")
    vjson = random_video.json()
    vjson["view_count"] = VideoView.count(random_video.video_id)
    return jsonify(vjson)


@api.route('/api/video/public/random')
def get_random_public_video():
    import random
    row_count = Video.query.filter(Video.info.has(private=False)).filter_by(available=True).count()
    random_video = Video.query.filter(Video.info.has(private=False)).filter_by(available=True).offset(int(row_count * random.random())).first()
    current_app.logger.info(f"Fetched public random video {random_video.video_id}: {random_video.info.title}")
    vjson = random_video.json()
    vjson["view_count"] = VideoView.count(random_video.video_id)
    return jsonify(vjson)


@api.route('/api/video/suggestions')
def get_video_suggestions():
    import random

    video_id = request.args.get('video_id')
    try:
        count = min(max(int(request.args.get('count', 5)), 1), 10)
    except (TypeError, ValueError):
        count = 5

    if not video_id:
        return Response(status=400, response='video_id is required.')

    current_video = Video.query.filter_by(video_id=video_id).first()
    if not current_video:
        return Response(status=404, response='Video not found.')

    authenticated = viewer_sees_private()

    def base_query():
        query = Video.query.join(VideoInfo).filter(
            Video.video_id != video_id,
            Video.available == True,
        )
        if not authenticated:
            query = query.filter(VideoInfo.private == False)
        return query

    seen = set()
    pool = []

    def with_unseen(query):
        if seen:
            return query.filter(Video.video_id.notin_(list(seen)))
        return query

    def add_candidates(videos, limit):
        added = 0
        for video in videos:
            if video.video_id in seen or added >= limit:
                continue
            seen.add(video.video_id)
            pool.append(video)
            added += 1

    game_link = VideoGameLink.query.filter_by(video_id=video_id).first()
    if game_link:
        same_game_ids = [
            link.video_id
            for link in VideoGameLink.query
            .filter(VideoGameLink.game_id == game_link.game_id, VideoGameLink.video_id != video_id)
            .all()
        ]
        if same_game_ids:
            candidates = (
                base_query()
                .filter(Video.video_id.in_(same_game_ids))
                .order_by(func.random())
                .limit(3)
                .all()
            )
            add_candidates(candidates, 3)
            seen.update(same_game_ids)

    tag_ids = [link.tag_id for link in VideoTagLink.query.filter_by(video_id=video_id).all()]
    if tag_ids and len(pool) < count:
        same_tag_ids = list(set(
            link.video_id
            for link in VideoTagLink.query
            .filter(VideoTagLink.tag_id.in_(tag_ids), VideoTagLink.video_id != video_id)
            .all()
        ))
        if same_tag_ids:
            candidates = (
                with_unseen(base_query())
                .filter(Video.video_id.in_(same_tag_ids))
                .order_by(func.random())
                .limit(3)
                .all()
            )
            add_candidates(candidates, 3)

    if current_video.source_folder and len(pool) < count:
        candidates = (
            with_unseen(base_query())
            .filter(Video.source_folder == current_video.source_folder)
            .order_by(func.random())
            .limit(2)
            .all()
        )
        add_candidates(candidates, 2)

    if current_video.recorded_at and len(pool) < count:
        window_start = current_video.recorded_at - timedelta(days=3)
        window_end = current_video.recorded_at + timedelta(days=3)
        candidates = (
            with_unseen(base_query())
            .filter(
                Video.recorded_at >= window_start,
                Video.recorded_at <= window_end,
            )
            .order_by(func.random())
            .limit(2)
            .all()
        )
        add_candidates(candidates, 2)

    if len(pool) < count:
        needed = count - len(pool)
        candidates = (
            with_unseen(base_query())
            .order_by(func.random())
            .limit(needed)
            .all()
        )
        add_candidates(candidates, needed)

    random.shuffle(pool)

    pool_ids = [video.video_id for video in pool]
    game_links_map = {
        link.video_id: link
        for link in VideoGameLink.query.filter(VideoGameLink.video_id.in_(pool_ids)).all()
    } if pool_ids else {}

    result = []
    for video in pool[:count]:
        video_json = video.json()
        video_json['view_count'] = VideoView.count(video.video_id)
        game_link = game_links_map.get(video.video_id)
        if game_link:
            video_json['game'] = game_link.game.json()
        result.append(video_json)

    return jsonify(result)


@api.route('/api/videos/public')
def get_public_videos():
    sort = request.args.get('sort')

    # Check that the sort parameter is one of the allowed values
    allowed_sorts = [
        'updated_at desc',
        'updated_at asc',
        'video_info.title desc',
        'video_info.title asc',
        'views desc',
        'views asc'
    ]
    if sort not in allowed_sorts:
        return jsonify({"error": "Invalid sort parameter"}), 400

    if "views" in sort:
        videos = Video.query.join(VideoInfo).filter_by(private=False)
    else:
        videos = Video.query.join(VideoInfo).filter_by(private=False).order_by(text(sort))

    videos_json = []
    for v in videos:
        vjson = v.json()
        if (not vjson["available"]):
            continue
        vjson["view_count"] = VideoView.count(v.video_id)
        vjson["tags"] = [l.tag.json() for l in VideoTagLink.query.filter_by(video_id=v.video_id).all() if l.tag is not None]
        if vjson.get("info", {}).get("has_password"):
            vjson["info"]["session_unlocked"] = _is_session_unlocked(v.video_id)
        videos_json.append(vjson)

    if sort == "views asc":
        videos_json = sorted(videos_json, key=lambda d: d['view_count'])
    if sort == 'views desc':
        videos_json = sorted(videos_json, key=lambda d: d['view_count'], reverse=True)

    return jsonify({"videos": videos_json})


@api.route('/api/videos/dates')
def get_video_dates():
    """Get all unique dates that have videos recorded on them"""

    query = db.session.query(func.date(Video.recorded_at)).join(VideoInfo).filter(
        Video.recorded_at.isnot(None),
        Video.available.is_(True)
    )

    if not viewer_sees_private():
        query = query.filter(VideoInfo.private.is_(False))

    dates = query.distinct().order_by(func.date(Video.recorded_at).desc()).all()
    return jsonify([str(d[0]) for d in dates if d[0]])


@api.route('/api/videos/by-date/<date>')
def get_videos_by_date(date):
    """Get all videos recorded on a specific date (YYYY-MM-DD)"""

    try:
        target_date = datetime.strptime(date, '%Y-%m-%d').date()
    except ValueError:
        return jsonify({"error": "Invalid date format. Use YYYY-MM-DD"}), 400

    query = Video.query.join(VideoInfo).filter(
        func.date(Video.recorded_at) == target_date,
        Video.available.is_(True)
    )

    if not viewer_sees_private():
        query = query.filter(VideoInfo.private.is_(False))

    videos = query.order_by(Video.recorded_at.desc()).all()
    videos_json = [{"view_count": VideoView.count(v.video_id), **v.json()} for v in videos]
    return jsonify({"videos": videos_json, "date": date})


@api.route('/api/video/delete/<id>', methods=["DELETE"])
@require_perm(P.DELETE_OWN, P.DELETE_ANY)
@demo_restrict
def delete_video(id):
    video = Video.query.filter_by(video_id=id).first()
    if video and not current_user.can_modify(video, 'delete'):
        return Response(status=403, response='You can only delete your own uploads.')
    if video:
        logging.info(f"Deleting video: {video.video_id}")

        paths = current_app.config['PATHS']
        file_path = paths['video'] / video.path
        link_path = paths['processed'] / 'video_links' / f"{id}{video.extension}"
        derived_path = paths['processed'] / 'derived' / id

        folder_id = video.folder_id

        cancel_pending_transcode_jobs(id)

        VideoInfo.query.filter_by(video_id=id).delete()
        VideoGameLink.query.filter_by(video_id=id).delete()
        VideoTagLink.query.filter_by(video_id=id).delete()
        VideoView.query.filter_by(video_id=id).delete()
        Video.query.filter_by(video_id=id).delete()
        db.session.commit()

        MediaFolder.cleanup_if_orphaned(folder_id, Video)

        delete_video_files(id, file_path, link_path, derived_path)
        return Response(status=200)

    else:
        return Response(status=404, response=f"A video with id: {id}, does not exist.")


@api.route('/api/video/move/<id>', methods=['POST'])
@require_perm(P.EDIT_OWN, P.EDIT_ANY)
@demo_restrict
def move_video(id):
    _mv = Video.query.filter_by(video_id=id).first()
    if _mv and not current_user.can_modify(_mv, 'edit'):
        return Response(status=403, response='You can only move your own uploads.')
    video = Video.query.filter_by(video_id=id).first()
    if not video:
        return Response(status=404, response=f"A video with id: {id}, does not exist.")

    data = request.json
    target_folder = (data.get('folder') or '').strip()
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

    old_file_path = video_path / video.path
    filename = Path(video.path).name
    new_path = f"{target_folder}/{filename}" if target_folder else filename
    new_file_path = video_path / new_path

    if old_file_path.resolve() == new_file_path.resolve():
        return Response(status=400, response='Video is already in that folder.')

    if new_file_path.exists():
        return Response(status=409, response=f"A file named '{filename}' already exists in '{target_folder}'.")

    try:
        shutil.move(str(old_file_path), str(new_file_path))

        link_path = paths['processed'] / 'video_links' / f"{id}{video.extension}"
        if link_path.exists() or link_path.is_symlink():
            link_path.unlink()
        os.symlink(new_file_path.absolute(), link_path)

        video.path = new_path

        folder_rule = FolderRule.query.filter_by(folder_path=target_folder).first()
        if folder_rule:
            existing_link = VideoGameLink.query.filter_by(video_id=id).first()
            if existing_link:
                existing_link.game_id = folder_rule.game_id
            else:
                db.session.add(VideoGameLink(video_id=id, game_id=folder_rule.game_id, created_at=datetime.utcnow()))

        db.session.commit()

        logging.info(f"Moved video {id} from {old_file_path} to {new_file_path}")
        return Response(status=200)
    except Exception as e:
        db.session.rollback()
        logging.error(f"Error moving video {id}: {e}")
        return Response(status=500, response=str(e))


@api.route('/api/video/details/<id>', methods=["GET", "PUT"])
def handle_video_details(id):
    if request.method == 'GET':
        # db lookup and get the details title/views/etc
        video = Video.query.filter_by(video_id=id).first()
        if video:
            vjson = video.json()
            vjson["view_count"] = VideoView.count(video.video_id)
            derived_dir = Path(current_app.config["PROCESSED_DIRECTORY"], "derived", video.video_id)
            vjson["has_custom_poster"] = (derived_dir / "custom_poster.webp").exists()
            if video.info and video.info.password_hash:
                vjson["info"]["session_unlocked"] = (
                    current_user.is_authenticated or _is_session_unlocked(video.video_id)
                )
            return jsonify(vjson)
        else:
            return jsonify({
                'message': 'Video not found'
            }), 404
    if request.method == 'PUT':
        if not current_user.is_authenticated:
            return Response(response='You do not have access to this resource.', status=401)
        # GET stays public (link sharing); only the update path is permission-gated,
        # so the gate lives here rather than on the route decorator.
        video = Video.query.filter_by(video_id=id).first()
        if video and not current_user.can_modify(video, 'edit'):
            return Response(status=403, response='You can only edit your own uploads.')
        video_info = VideoInfo.query.filter_by(video_id=id).first()
        if video_info:
            # Handle recorded_at separately since it's on Video model, not VideoInfo
            data = request.json.copy()
            recorded_at = data.pop('recorded_at', None)

            # Handle password fields — must be popped before the generic update to
            # prevent direct hash manipulation and ensure the hash is always derived
            # from the plain-text password here in the server.
            _UNSET = object()
            new_password   = data.pop('password', _UNSET)
            remove_password = data.pop('remove_password', False)

            # Extract crop fields before the generic VideoInfo update so they don't
            # get written directly (we handle them via the crop pipeline below)
            new_start = data.pop('start_time', _UNSET)
            new_end   = data.pop('end_time',   _UNSET)

            # The tone map operator, or None to remove the SDR copy. Applied below,
            # through the same rebuild as a crop.
            new_tonemap = data.pop('tonemap', _UNSET)
            if new_tonemap is not _UNSET and new_tonemap is not None:
                if new_tonemap not in util.TONEMAP_OPERATORS:
                    return jsonify({'message': f'Unknown tone map operator: {new_tonemap}'}), 400
                if not video_info.is_hdr:
                    return jsonify({'message': 'Only HDR videos can be tone mapped'}), 400

            # Only these are the client's to set. The previous blanket update of
            # whatever remained in the body also reached video_id (which carries no
            # uniqueness constraint, so a row could be repointed at someone else's
            # video) and password_hash (writable as a raw string, side-stepping the
            # hashing directly below).
            editable = {
                field: data[field]
                for field in ('title', 'description', 'private')
                if field in data
            }
            if 'private' in editable:
                editable['private'] = bool(editable['private'])
            if editable:
                db.session.query(VideoInfo).filter_by(video_id=id).update(editable)

            # Handle password changes
            generated_password = None
            if remove_password:
                video_info.password_hash = None
            elif new_password is not _UNSET:
                if new_password == '__autogenerate__':
                    plain = secrets.token_urlsafe(12)
                    generated_password = plain
                else:
                    plain = new_password
                video_info.password_hash = generate_password_hash(plain, method='pbkdf2:sha256')

            # Update Video.recorded_at if provided
            if recorded_at is not None:
                video = Video.query.filter_by(video_id=id).first()
                if video:
                    if recorded_at == '' or recorded_at is None:
                        video.recorded_at = None
                    else:
                        try:
                            # Strip any timezone suffix and store as naive local datetime.
                            # The frontend sends a naive local ISO string; treating it as
                            # UTC (via the old Z→+00:00 replacement) caused a timezone
                            # offset to be baked in on every save.
                            dt = datetime.fromisoformat(recorded_at.replace('Z', '+00:00'))
                            video.recorded_at = dt.replace(tzinfo=None)
                        except (ValueError, AttributeError):
                            video.recorded_at = None

            db.session.commit()

            # A tone map change is persisted first, so a crop saved in the same request
            # rebuilds with it. Re-applying the operator the video already plays with
            # does nothing; re-applying one whose copy failed or is missing retries it.
            tonemap_changed = False
            if new_tonemap is not _UNSET:
                tonemap_changed = new_tonemap != video_info.tonemap or (new_tonemap is not None and not video_info.has_sdr)
                video_info.tonemap = new_tonemap
                video_info.sdr_error = None
                db.session.commit()

            # Handle crop pipeline if start_time / end_time were included in the payload
            crop_changed = new_start is not _UNSET or new_end is not _UNSET
            if crop_changed:
                resolved_start = new_start if new_start is not _UNSET else video_info.start_time
                resolved_end   = new_end   if new_end   is not _UNSET else video_info.end_time

                # Persist the new crop time values
                video_info.start_time = resolved_start
                video_info.end_time   = resolved_end
                db.session.commit()

                paths = current_app.config['PATHS']
                video = Video.query.filter_by(video_id=id).first()

                if resolved_start is None and resolved_end is None:
                    # Clearing the crop — delete crop files and re-transcode from original
                    had_480p  = video_info.has_480p
                    had_720p  = video_info.has_720p
                    had_1080p = video_info.has_1080p
                    _clear_crop(video, video_info, paths, had_480p, had_720p, had_1080p)
                else:
                    # Creating / replacing the crop
                    _apply_crop_async(video, video_info, resolved_start, resolved_end, paths)
            elif tonemap_changed:
                paths = current_app.config['PATHS']
                video = Video.query.filter_by(video_id=id).first()
                _rebuild_for_tonemap(video, video_info, paths)

            if generated_password is not None:
                return jsonify({"generated_password": generated_password}), 201
            return Response(status=201)
        else:
            return jsonify({
                'message': 'Video details not found'
            }), 404


@api.route('/api/video/poster', methods=['GET'])
def get_video_poster():
    video_id = request.args['id']
    derived_dir = Path(current_app.config["PROCESSED_DIRECTORY"], "derived", video_id)
    custom_poster_path = derived_dir / "custom_poster.webp"
    jpg_poster_path = derived_dir / "poster.jpg"

    if request.args.get('animated'):
        mp4_path = derived_dir / "boomerang-preview.mp4"
        webm_path = derived_dir / "boomerang-preview.webm"
        if mp4_path.exists():
            response = send_file(mp4_path, mimetype='video/mp4')
        else:
            response = send_file(webm_path, mimetype='video/webm')
        return add_cache_headers(response, video_id)
    elif custom_poster_path.exists():
        response = send_file(custom_poster_path, mimetype='image/webp')
        return add_poster_cache_headers(response, f'{video_id}-custom')
    else:
        response = send_file(jpg_poster_path, mimetype='image/jpg')
        return add_poster_cache_headers(response, f'{video_id}-generated')


@api.route('/api/video/<video_id>/poster/custom', methods=['POST'])
@require_perm(P.EDIT_OWN, P.EDIT_ANY)
def upload_custom_poster(video_id):
    _v = Video.query.filter_by(video_id=video_id).first()
    if _v and not current_user.can_modify(_v, 'edit'):
        return Response(status=403, response='You can only edit your own uploads.')
    if 'file' not in request.files:
        return jsonify({'message': 'No file provided'}), 400
    file = request.files['file']
    if not file or file.filename == '':
        return jsonify({'message': 'No file selected'}), 400

    allowed_types = {'image/jpeg', 'image/png', 'image/webp'}
    if file.content_type not in allowed_types:
        return jsonify({'message': 'Invalid file type. Allowed: JPEG, PNG, WebP'}), 400

    derived_dir = Path(current_app.config["PROCESSED_DIRECTORY"], "derived", video_id)
    if not derived_dir.exists():
        return jsonify({'message': 'Video derived directory not found'}), 404

    ext_map = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp'}
    suffix = ext_map.get(file.content_type, '.jpg')

    custom_poster_path = derived_dir / "custom_poster.webp"
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    os.close(tmp_fd)
    # Stage the conversion inside derived_dir so a failed ffmpeg run can't leave a
    # corrupt custom_poster.webp behind, and so the swap is an atomic same-filesystem rename.
    out_fd, out_path = tempfile.mkstemp(suffix='.webp', dir=derived_dir)
    os.close(out_fd)
    try:
        file.save(tmp_path)
        cmd = ['ffmpeg', '-y', '-i', tmp_path, out_path]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            current_app.logger.error("ffmpeg failed for custom poster: %s", result.stderr)
            return jsonify({'message': 'Failed to process image'}), 500
        if not os.path.getsize(out_path):
            current_app.logger.error("ffmpeg produced an empty custom poster for %s", video_id)
            return jsonify({'message': 'Failed to process image'}), 500
        # mkstemp creates 0600; nginx serves this file directly and runs as its own user
        os.chmod(out_path, 0o644)
        os.replace(out_path, custom_poster_path)
    finally:
        os.unlink(tmp_path)
        if os.path.exists(out_path):
            os.unlink(out_path)

    return Response(status=200)


@api.route('/api/video/<video_id>/poster/custom', methods=['DELETE'])
@require_perm(P.EDIT_OWN, P.EDIT_ANY)
def delete_custom_poster(video_id):
    _v = Video.query.filter_by(video_id=video_id).first()
    if _v and not current_user.can_modify(_v, 'edit'):
        return Response(status=403, response='You can only edit your own uploads.')
    derived_dir = Path(current_app.config["PROCESSED_DIRECTORY"], "derived", video_id)
    custom_poster_path = derived_dir / "custom_poster.webp"
    if custom_poster_path.exists():
        custom_poster_path.unlink()
    return Response(status=200)


@api.route('/api/video/view', methods=['POST'])
def add_video_view():
    video_id = request.json['video_id']
    if request.headers.getlist("X-Forwarded-For"):
        ip_address = request.headers.getlist("X-Forwarded-For")[0].split(",")[0]
    else:
        ip_address = request.remote_addr
    VideoView.add_view(video_id, ip_address)
    return Response(status=200)


@api.route('/api/video/<video_id>/views', methods=['GET'])
def get_video_views(video_id):
    views = VideoView.count(video_id)
    return str(views)


@api.route('/api/video/original')
def get_original_video():
    """Serves the original unmodified video file, bypassing any crop. Used by the waveform editor."""
    video_id = request.args.get('id')
    subid = request.args.get('subid')
    if not current_user.is_authenticated:
        video_info = VideoInfo.query.filter_by(video_id=video_id).first()
        if video_info and video_info.password_hash and not _is_session_unlocked(video_id):
            return Response(status=403)
    try:
        video_path = get_video_path(video_id, subid, quality=None)
        return send_file(video_path, mimetype='video/mp4', conditional=True)
    except Exception as e:
        logger.error(f"Error serving original video {video_id}: {e}")
        return Response(status=404)


@api.route('/api/video/audio')
def get_video_audio():
    """
    Serves a tiny mono MP3 extract of the original video, used by the waveform editor.
    The extract is created on first request and cached at derived/{id}/{id}-audio.mp3.
    Much smaller than the full video, so WaveSurfer loads and decodes it much faster.
    """
    video_id = request.args.get('id')
    if not video_id:
        return Response(status=400)
    if not current_user.is_authenticated:
        video_info = VideoInfo.query.filter_by(video_id=video_id).first()
        if video_info and video_info.password_hash and not _is_session_unlocked(video_id):
            return Response(status=403)
    try:
        paths = current_app.config['PATHS']
        derived_dir = paths['processed'] / 'derived' / video_id
        audio_path = derived_dir / f'{video_id}-audio.mp3'

        if not audio_path.exists():
            video_path = get_video_path(video_id, subid=None, quality=None)
            derived_dir.mkdir(parents=True, exist_ok=True)
            if not util.create_audio_extract(video_path, audio_path):
                return Response(status=500)

        return send_file(audio_path, mimetype='audio/mpeg', conditional=True)
    except Exception as e:
        logger.error(f"Error serving audio extract for {video_id}: {e}")
        return Response(status=404)


@api.route('/api/video/<video_id>/unlock', methods=['POST'])
def unlock_video(video_id):
    video_info = VideoInfo.query.filter_by(video_id=video_id).first()
    if not video_info or not video_info.password_hash:
        return jsonify({"error": "Video is not password protected"}), 400
    submitted = (request.json or {}).get('password', '')
    if check_password_hash(video_info.password_hash, submitted):
        session.permanent = True
        unlocked = session.get('unlocked_videos', {})
        if not isinstance(unlocked, dict):
            unlocked = {}
        unlocked[video_id] = _time.time()
        session['unlocked_videos'] = unlocked
        return jsonify({"unlocked": True})
    return jsonify({"error": "Incorrect password"}), 403


@api.route('/api/video/nginx-auth-admin')
def nginx_video_auth_admin():
    """Internal endpoint called by nginx auth_request to gate the raw (uncropped) video path.

    /_content/video-raw/ serves the full uncut original, which only the crop
    editor asks for, so this is an editing capability rather than a viewing one.
    The id is resolved from the URI so the answer can honour ownership: a user
    with edit_own gets the raw file for their own uploads and nothing else.
    """
    if not current_user.is_authenticated:
        return '', 403

    video_id = request.headers.get('X-Fireshare-Video-Id')
    if not video_id or not _VIDEO_ID_RE.match(video_id):
        video_id = _video_id_from_original_uri(request.headers.get('X-Original-URI', ''))

    if not video_id:
        # An unresolvable id means the gate cannot do its job, so it must not
        # let the request through — same stance as nginx_video_auth below.
        logger.warning(
            "nginx-auth-admin could not resolve a video id for "
            f"{request.headers.get('X-Original-URI', '')!r}; denying request"
        )
        return '', 403

    video = Video.query.filter_by(video_id=video_id).first()
    if not video:
        return '', 403
    if not current_user.can_modify(video, 'edit'):
        return '', 403
    return '', 200


_VIDEO_ID_RE = re.compile(r'^[\w-]+$')
_CONTENT_VIDEO_RE = re.compile(r'^/_content/video/([\w-]+)\.[a-z0-9]+', re.IGNORECASE)
_CONTENT_VIDEO_RAW_RE = re.compile(r'^/_content/video-raw/([\w-]+)\.[a-z0-9]+', re.IGNORECASE)
_CONTENT_DERIVED_RE = re.compile(r'^/_content/derived/([\w-]+)/', re.IGNORECASE)


def _video_id_from_original_uri(original_uri):
    """
    Resolve the video id from nginx's X-Original-URI.

    nginx matches its location blocks against the decoded, normalized URI but forwards the
    raw one in $request_uri, so the URI seen here has to be decoded and normalized the same
    way before it is parsed — otherwise a request like /_content/vide%6F/<id>.mp4 routes to
    the file on the nginx side while failing to resolve an id on this side.
    """
    path = unquote(original_uri.split('?', 1)[0])
    if not path.startswith('/'):
        return None
    path = posixpath.normpath(path)
    # normpath drops a meaningful trailing slash, which the derived pattern relies on
    if original_uri.split('?', 1)[0].endswith('/') and not path.endswith('/'):
        path += '/'
    for pattern in (_CONTENT_VIDEO_RE, _CONTENT_VIDEO_RAW_RE, _CONTENT_DERIVED_RE):
        m = pattern.match(path)
        if m:
            return m.group(1)
    return None


@api.route('/api/video/nginx-auth')
def nginx_video_auth():
    """
    Internal endpoint called by nginx auth_request to gate password-protected video files.

    Prefers the id nginx already captured from its own location regex (X-Fireshare-Video-Id),
    which is the same value it uses to pick the file, so the two cannot disagree. Falls back
    to parsing the URI, and refuses the request if no id can be resolved — an unresolvable id
    means the gate cannot do its job, so it must not let the request through.
    """
    video_id = request.headers.get('X-Fireshare-Video-Id')
    if not video_id or not _VIDEO_ID_RE.match(video_id):
        video_id = _video_id_from_original_uri(request.headers.get('X-Original-URI', ''))
    if not video_id:
        logger.warning(
            f"nginx-auth could not resolve a video id for "
            f"{request.headers.get('X-Original-URI', '')!r}; denying request"
        )
        return '', 403
    video_info = VideoInfo.query.filter_by(video_id=video_id).first()
    if not video_info or not video_info.password_hash:
        return '', 200
    if current_user.is_authenticated:
        return '', 200
    unlocked = session.get('unlocked_videos', {})
    if isinstance(unlocked, dict):
        ts = unlocked.get(video_id)
        if ts and (_time.time() - ts) < 3600:
            return '', 200
    return '', 403


def _is_session_unlocked(video_id):
    unlocked = session.get('unlocked_videos', {})
    if not isinstance(unlocked, dict):
        return False
    ts = unlocked.get(video_id)
    return bool(ts and (_time.time() - ts) < 3600)


@api.route('/api/video')
def get_video():
    video_id = request.args.get('id')
    subid = request.args.get('subid')
    quality = request.args.get('quality')  # Support quality parameter (720p, 1080p, cropped)
    if not current_user.is_authenticated:
        video_info = VideoInfo.query.filter_by(video_id=video_id).first()
        if video_info and video_info.password_hash:
            if not _is_session_unlocked(video_id):
                return Response(status=403, response="Password required")
    video_path = get_video_path(video_id, subid, quality)
    return _stream_video_file(video_path)


@api.route('/api/videos/corrupt', methods=["GET"])
@require_perm(P.MANAGE_LIBRARY)
def get_corrupt_videos():
    """Get a list of all videos marked as corrupt"""
    from fireshare.cli import get_all_corrupt_videos

    corrupt_video_ids = get_all_corrupt_videos()

    # Get video details for all corrupt videos in a single query
    video_info_map = {}
    if corrupt_video_ids:
        video_infos = VideoInfo.query.filter(VideoInfo.video_id.in_(corrupt_video_ids)).all()
        video_info_map = {vi.video_id: vi for vi in video_infos}

    corrupt_videos = []
    for video_id in corrupt_video_ids:
        vi = video_info_map.get(video_id)
        if vi:
            corrupt_videos.append({
                'video_id': video_id,
                'title': vi.title,
                'path': vi.video.path if vi.video else None
            })
        else:
            # Video may have been deleted but still in corrupt list
            corrupt_videos.append({
                'video_id': video_id,
                'title': None,
                'path': None
            })
    return jsonify(corrupt_videos)


@api.route('/api/videos/<video_id>/corrupt', methods=["DELETE"])
@require_perm(P.MANAGE_LIBRARY)
def clear_corrupt_status(video_id):
    """Clear the corrupt status for a specific video so it can be retried"""
    from fireshare.cli import clear_video_corrupt, is_video_corrupt

    if not is_video_corrupt(video_id):
        return Response(status=400, response="Video is not marked as corrupt")

    clear_video_corrupt(video_id)
    return Response(status=204)


@api.route('/api/videos/corrupt/clear-all', methods=["DELETE"])
@require_perm(P.MANAGE_LIBRARY)
def clear_all_corrupt_status():
    """Clear the corrupt status for all videos so they can be retried"""
    from fireshare.cli import clear_all_corrupt_videos

    count = clear_all_corrupt_videos()
    return jsonify({'cleared': count})


# ---------------------------------------------------------------------------
# HDR tone mapping: what the server can do, and the compare previews
# ---------------------------------------------------------------------------

_PREVIEW_WIDTH = 1280
_PREVIEW_ZOOM = (900, 540)

# One render per (video, time, operator) at a time: the compare modal asks for every
# tile of a frame at once, and a second open must wait for the first rather than render
# the same frame again.
_preview_locks = {}
_preview_locks_guard = threading.Lock()


def _preview_lock(key):
    with _preview_locks_guard:
        lock = _preview_locks.get(key)
        if lock is None:
            lock = _preview_locks[key] = threading.Lock()
        return lock


def _editable_video(video_id):
    """The video and its info when the current user may edit it, else an error response."""
    video = Video.query.filter_by(video_id=video_id).first()
    if not video or not video.info:
        return None, None, (jsonify({'message': 'Video not found'}), 404)
    if not current_user.can_modify(video, 'edit'):
        return None, None, Response(status=403, response='You can only edit your own uploads.')
    return video, video.info, None


@api.route('/api/video/tonemap/capabilities', methods=['GET'])
@login_required
def tonemap_capabilities():
    """Which tone map operators this server's ffmpeg can run, and what `auto` picks."""
    return jsonify(util.tonemap_capabilities())


@api.route('/api/video/<video_id>/tonemap/frames', methods=['GET'])
@require_perm(P.EDIT_OWN, P.EDIT_ANY)
def tonemap_frames(video_id):
    """Random timestamps to compare operators on, spread over the video and clear of
    its first and last few seconds, where captures tend to be menus or fades."""
    video, video_info, error = _editable_video(video_id)
    if error:
        return error
    try:
        count = max(1, min(int(request.args.get('count', 3)), 6))
    except ValueError:
        return jsonify({'message': 'count must be a number'}), 400
    duration = video_info._cropped_duration() or 0
    if duration <= 0:
        return jsonify({'message': 'The video has no known duration'}), 400
    low, high = duration * 0.05, duration * 0.95
    step = (high - low) / count
    frames = sorted(round(low + step * i + random.random() * step, 1) for i in range(count))
    return jsonify({'frames': frames, 'duration': duration})


@api.route('/api/video/<video_id>/tonemap/preview', methods=['GET'])
@require_perm(P.EDIT_OWN, P.EDIT_ANY)
def tonemap_preview(video_id):
    """One frame of the video at ?t= seconds through ?op= (an operator, or `as_stored`),
    as WebP: scaled to the compare tile, or a native-pixel centre crop with ?zoom=1.
    Rendered on first request and kept under the video's derived directory."""
    video, video_info, error = _editable_video(video_id)
    if error:
        return error
    operator = request.args.get('op') or 'as_stored'
    if operator != 'as_stored' and operator not in util.TONEMAP_OPERATORS:
        return jsonify({'message': f'Unknown tone map operator: {operator}'}), 400
    try:
        seconds = float(request.args.get('t', ''))
    except ValueError:
        return jsonify({'message': 't must be a number of seconds'}), 400
    duration = video_info._cropped_duration() or 0
    if seconds < 0 or (duration and seconds > duration):
        return jsonify({'message': 't is outside the video'}), 400

    paths = current_app.config['PATHS']
    derived_dir = paths["processed"] / "derived" / video_id
    cropped_path = derived_dir / f"{video_id}-cropped.mp4"
    source_path = cropped_path if video_info.has_crop and cropped_path.exists() else \
        paths["processed"] / "video_links" / f"{video_id}{video.extension}"
    if not source_path.exists():
        return jsonify({'message': 'The video file is missing'}), 404

    assume_pq = util.stream_needs_pq_assumed(video_info.vcodec)
    with _preview_lock((video_id, round(seconds, 1), operator)):
        rendered = util.render_tonemap_preview(
            source_path, seconds, None if operator == 'as_stored' else operator,
            derived_dir / "tonemap-preview", width=_PREVIEW_WIDTH, zoom=_PREVIEW_ZOOM, assume_pq=assume_pq,
        )
    if not rendered:
        return jsonify({'message': f'ffmpeg could not render the {operator} preview; see the server log'}), 500
    tile, zoom = rendered
    response = send_file(zoom if request.args.get('zoom') == '1' else tile, mimetype='image/webp')
    response.headers['Cache-Control'] = 'private, max-age=3600'
    return response
