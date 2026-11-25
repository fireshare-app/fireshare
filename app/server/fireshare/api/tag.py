import threading
from datetime import datetime
from pathlib import Path

from flask import current_app, jsonify, request, Response
from flask_login import login_required, current_user
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from .. import db, logger, util
from ..models import Video, VideoInfo, VideoView, VideoGameLink, VideoTagLink, CustomTag
from .. import permissions as P
from . import api
from .decorators import require_perm
from .helpers import (
    cancel_pending_transcode_jobs,
    delete_video_files,
    refuse_unless_can_delete_all,
    viewer_sees_private,
)


def _regenerate_boomerang_bg(video_id, extension, processed_directory):
    video_path = Path(processed_directory, "video_links", video_id + extension)
    derived_path = Path(processed_directory, "derived", video_id)
    out_path = derived_path / "boomerang-preview.mp4"
    def run():
        if not video_path.exists():
            return
        if not derived_path.exists():
            derived_path.mkdir(parents=True)
        util.create_boomerang_preview(video_path, out_path)
    threading.Thread(target=run, daemon=True).start()


@api.route('/api/tags', methods=["GET"])
def get_tags():
    if viewer_sees_private():
        tags = CustomTag.query.order_by(CustomTag.name).all()
    else:
        tags = (
            db.session.query(CustomTag)
            .join(VideoTagLink)
            .join(Video)
            .join(VideoInfo)
            .filter(
                Video.available.is_(True),
                VideoInfo.private.is_(False),
            )
            .distinct()
            .order_by(CustomTag.name)
            .all()
        )

    result = []
    for tag in tags:
        t = tag.json()
        links = (
            db.session.query(VideoTagLink)
            .join(Video, Video.video_id == VideoTagLink.video_id)
            .filter(VideoTagLink.tag_id == tag.id, Video.available.is_(True))
        )
        if not viewer_sees_private():
            links = links.join(VideoInfo, VideoInfo.video_id == VideoTagLink.video_id).filter(VideoInfo.private.is_(False))
        t["video_count"] = links.count()
        random_link = links.order_by(func.random()).first()
        t["preview_video_id"] = random_link.video_id if random_link else None
        result.append(t)
    return jsonify(result)


@api.route('/api/tags', methods=["POST"])
@require_perm(P.MANAGE_TAGS)
def create_tag():
    data = request.json
    if not data or not data.get('name'):
        return Response(status=400, response='Tag name is required.')

    name = data['name'].strip().replace(' ', '_')
    if len(name) > 12:
        return Response(status=400, response='Tag name must be 12 characters or fewer.')

    existing = CustomTag.query.filter_by(name=name).first()
    if existing:
        return jsonify(existing.json()), 409

    tag = CustomTag(
        name=name,
        color=data.get('color'),
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.session.add(tag)
    try:
        db.session.commit()
    except IntegrityError:
        # Another request made a tag by this name after the check above, as when the
        # same name is sent twice at once. Answer as if it had been there all along.
        db.session.rollback()
        existing = CustomTag.query.filter_by(name=name).first()
        if not existing:
            raise
        return jsonify(existing.json()), 409
    return jsonify(tag.json()), 201


@api.route('/api/tags/<int:tag_id>', methods=["PUT"])
@require_perm(P.MANAGE_TAGS)
def update_tag(tag_id):
    tag = db.session.get(CustomTag, tag_id)
    if not tag:
        return Response(status=404, response='Tag not found.')

    data = request.json or {}
    if 'name' in data:
        new_name = data['name'].strip().replace(' ', '_')
        if len(new_name) > 12:
            return Response(status=400, response='Tag name must be 12 characters or fewer.')
        conflict = CustomTag.query.filter(CustomTag.name == new_name, CustomTag.id != tag_id).first()
        if conflict:
            return Response(status=409, response='Tag name already exists.')
        tag.name = new_name
    if 'color' in data:
        tag.color = data['color']
    tag.updated_at = datetime.utcnow()
    db.session.commit()
    return jsonify(tag.json())


@api.route('/api/tags/<int:tag_id>', methods=["DELETE"])
@require_perm(P.MANAGE_TAGS)
def delete_tag(tag_id):
    tag = db.session.get(CustomTag, tag_id)
    if not tag:
        return Response(status=404, response='Tag not found.')

    delete_videos = request.args.get('delete_videos', 'false').lower() == 'true'

    video_links = VideoTagLink.query.filter_by(tag_id=tag_id).all()

    orphaned_folder_ids = set()
    if delete_videos:
        refusal = refuse_unless_can_delete_all(
            [link.video for link in video_links if link.video is not None], 'tag'
        )
        if refusal:
            return refusal
        paths = current_app.config['PATHS']
        for link in video_links:
            video = link.video
            if video is None:
                db.session.delete(link)
                continue
            if video.folder_id is not None:
                orphaned_folder_ids.add(video.folder_id)
            file_path = paths['video'] / video.path
            link_path = paths['processed'] / 'video_links' / f"{video.video_id}{video.extension}"
            derived_path = paths['processed'] / 'derived' / video.video_id
            cancel_pending_transcode_jobs(video.video_id)
            VideoTagLink.query.filter_by(video_id=video.video_id).delete()
            VideoGameLink.query.filter_by(video_id=video.video_id).delete()
            VideoView.query.filter_by(video_id=video.video_id).delete()
            VideoInfo.query.filter_by(video_id=video.video_id).delete()
            Video.query.filter_by(video_id=video.video_id).delete()
            delete_video_files(video.video_id, file_path, link_path, derived_path)
    else:
        for link in video_links:
            db.session.delete(link)

    db.session.delete(tag)
    db.session.commit()

    if delete_videos:
        from ..models import MediaFolder
        for folder_id in orphaned_folder_ids:
            MediaFolder.cleanup_if_orphaned(folder_id, Video)

    return Response(status=200)


@api.route('/api/tags/<int:tag_id>/videos', methods=["GET"])
def get_tag_videos(tag_id):
    tag = db.session.get(CustomTag, tag_id)
    if not tag:
        return Response(status=404, response='Tag not found.')

    videos_json = []
    for link in tag.videos:
        if not link.video:
            continue
        if not viewer_sees_private():
            if not link.video.available:
                continue
            if not link.video.info or link.video.info.private:
                continue
        vjson = link.video.json()
        vjson["view_count"] = VideoView.count(link.video_id)
        vjson["tags"] = [l.tag.json() for l in VideoTagLink.query.filter_by(video_id=link.video_id).all() if l.tag is not None]
        videos_json.append(vjson)

    return jsonify(videos_json)


@api.route('/api/videos/<video_id>/tags', methods=["GET"])
def get_video_tags(video_id):
    links = VideoTagLink.query.filter_by(video_id=video_id).all()
    return jsonify([l.tag.json() for l in links])


@api.route('/api/videos/<video_id>/tags', methods=["POST"])
@require_perm(P.MANAGE_TAGS)
def add_tag_to_video(video_id):
    data = request.json
    if not data or not data.get('tag_id'):
        return Response(status=400, response='tag_id is required.')

    video = Video.query.filter_by(video_id=video_id).first()
    if not video:
        return Response(status=404, response='Video not found.')

    tag = db.session.get(CustomTag, data['tag_id'])
    if not tag:
        return Response(status=404, response='Tag not found.')

    existing = VideoTagLink.query.filter_by(video_id=video_id, tag_id=data['tag_id']).first()
    if existing:
        return jsonify(existing.json()), 200

    link = VideoTagLink(
        video_id=video_id,
        tag_id=data['tag_id'],
        created_at=datetime.utcnow(),
    )
    db.session.add(link)
    try:
        db.session.commit()
    except IntegrityError:
        # A request sent at the same time linked it first; that one redraws the
        # background.
        db.session.rollback()
        existing = VideoTagLink.query.filter_by(video_id=video_id, tag_id=data['tag_id']).first()
        if not existing:
            raise
        return jsonify(existing.json()), 200
    _regenerate_boomerang_bg(video.video_id, video.extension, current_app.config["PROCESSED_DIRECTORY"])
    return jsonify(link.json()), 201


@api.route('/api/videos/<video_id>/tags/<int:tag_id>', methods=["DELETE"])
@require_perm(P.MANAGE_TAGS)
def remove_tag_from_video(video_id, tag_id):
    link = VideoTagLink.query.filter_by(video_id=video_id, tag_id=tag_id).first()
    if not link:
        return Response(status=404, response='Tag link not found.')
    db.session.delete(link)
    db.session.commit()
    return Response(status=204)


@api.route('/api/tags/bulk-assign', methods=["POST"])
@require_perm(P.MANAGE_TAGS)
def bulk_assign_tag():
    data = request.json
    if not data or not data.get('tag_id') or not data.get('video_ids'):
        return Response(status=400, response='tag_id and video_ids are required.')

    tag = db.session.get(CustomTag, data['tag_id'])
    if not tag:
        return Response(status=404, response='Tag not found.')

    created = 0
    new_video_ids = []
    for video_id in data['video_ids']:
        existing = VideoTagLink.query.filter_by(video_id=video_id, tag_id=data['tag_id']).first()
        if not existing:
            link = VideoTagLink(
                video_id=video_id,
                tag_id=data['tag_id'],
                created_at=datetime.utcnow(),
            )
            db.session.add(link)
            created += 1
            new_video_ids.append(video_id)

    db.session.commit()
    processed_dir = current_app.config["PROCESSED_DIRECTORY"]
    for video_id in new_video_ids:
        v = Video.query.filter_by(video_id=video_id).first()
        if v:
            _regenerate_boomerang_bg(v.video_id, v.extension, processed_dir)
    return jsonify({"created": created, "skipped": len(data['video_ids']) - created}), 200


@api.route('/api/tags/bulk-remove', methods=["POST"])
@require_perm(P.MANAGE_TAGS)
def bulk_remove_tag():
    data = request.json
    if not data or not data.get('tag_id') or not data.get('video_ids'):
        return Response(status=400, response='tag_id and video_ids are required.')

    removed = VideoTagLink.query.filter(
        VideoTagLink.tag_id == data['tag_id'],
        VideoTagLink.video_id.in_(data['video_ids'])
    ).delete(synchronize_session=False)

    db.session.commit()
    return jsonify({"removed": removed}), 200
