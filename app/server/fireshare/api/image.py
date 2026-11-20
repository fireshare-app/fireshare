import json
import logging
import os
import random
import re
import string
from datetime import datetime
from pathlib import Path
from subprocess import Popen
import threading

from flask import current_app, jsonify, request, Response, send_file, render_template, redirect
from flask_login import login_required, current_user
from sqlalchemy.sql import text

from .. import db, logger, util
from ..models import Image, ImageInfo, ImageView, ImageGameLink, ImageTagLink, GameMetadata, MediaFolder
from .. import permissions as P
from . import api
from .helpers import (
    MoveRefused,
    move_image_file,
    parse_client_mtime,
    resolve_media_subfolder,
    sanitize_upload_folder,
    secure_filename,
    viewer_sees_private,
)
from .decorators import demo_restrict, require_perm


SUPPORTED_IMAGE_TYPES = {'jpg', 'jpeg', 'png', 'webp', 'gif'}


def _launch_scan_image(save_path, config, game_id=None, tag_ids=None, title=None, uploaded_by=None,
                       client_mtime=None):
    """Launch scan-image in the background after an image upload. client_mtime is
    the uploader's original modified time (see helpers.parse_client_mtime)."""
    image_directory = current_app.config.get('IMAGE_DIRECTORY')
    if not image_directory:
        return None
    rel_path = os.path.relpath(save_path, image_directory)
    cmd = ["fireshare", "scan-image", f"--path={rel_path}"]
    if game_id:
        cmd.append(f"--game-id={game_id}")
    if tag_ids:
        cmd.append(f"--tag-ids={','.join(str(t) for t in tag_ids)}")
    if title:
        cmd.append(f"--title={title}")
    if uploaded_by is not None:
        cmd.append(f"--uploaded-by={int(uploaded_by)}")
    if client_mtime is not None:
        cmd.append(f"--client-mtime={float(client_mtime)}")
    proc = Popen(cmd, shell=False, start_new_session=True)
    threading.Thread(target=proc.wait, daemon=True).start()
    return proc


def _client_mtimes(files):
    """The uploader's original modified time for each uploaded file, in order, from
    the lastModified values sent with them. When the counts do not line up the
    values cannot be matched to files, so none are used."""
    values = request.form.getlist('lastModified')
    if len(values) != len(files):
        return [None] * len(files)
    return [parse_client_mtime(v) for v in values]


# ---------------------------------------------------------------------------
# Upload endpoints
# ---------------------------------------------------------------------------

@api.route('/api/upload/image', methods=['POST'])
@require_perm(P.UPLOAD)
def upload_image():
    paths = current_app.config['PATHS']
    image_directory = current_app.config.get('IMAGE_DIRECTORY')
    if not image_directory:
        return Response(status=503, response='IMAGE_DIRECTORY is not configured.')

    try:
        with open(paths['data'] / 'config.json', 'r') as f:
            config = json.load(f)
    except Exception:
        return Response(status=500, response='Invalid config file.')

    upload_folder = config['app_config'].get('admin_upload_folder_name', 'uploads')
    requested_folder = sanitize_upload_folder(request.form.get('folder'))
    if requested_folder:
        upload_folder = requested_folder

    if 'file' not in request.files:
        return Response(status=400)
    files = request.files.getlist('file')
    if not files:
        return Response(status=400)

    tag_ids_raw = request.form.get('tag_ids', '')
    tag_ids = [int(t) for t in tag_ids_raw.split(',') if t.strip().isdigit()] or None
    game_id_raw = request.form.get('game_id', '')
    game_id = int(game_id_raw) if game_id_raw.strip().isdigit() else None
    title = request.form.get('title', '').strip() or None

    upload_dir = Path(image_directory) / upload_folder
    upload_dir.mkdir(parents=True, exist_ok=True)

    saved = 0
    for file, last_modified in zip(files, _client_mtimes(files)):
        if not file.filename:
            continue
        filename = secure_filename(file.filename)
        if not filename:
            continue
        filetype = filename.rsplit('.', 1)[-1].lower()
        if filetype not in SUPPORTED_IMAGE_TYPES:
            continue
        save_path = str(upload_dir / filename)
        if os.path.exists(save_path):
            stem = '.'.join(filename.split('.')[:-1])
            uid = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
            save_path = str(upload_dir / f"{stem}-{uid}.{filetype}")
        file.save(save_path)
        _launch_scan_image(save_path, config, game_id=game_id, tag_ids=tag_ids,
                           title=title if len(files) == 1 else None,
                           uploaded_by=current_user.id if current_user.is_authenticated else None,
                           client_mtime=last_modified)
        saved += 1

    if saved == 0:
        return Response(status=400, response='No valid image files provided.')
    return Response(status=201)


@api.route('/api/upload/image/public', methods=['POST'])
def upload_image_public():
    paths = current_app.config['PATHS']
    image_directory = current_app.config.get('IMAGE_DIRECTORY')
    if not image_directory:
        return Response(status=503, response='IMAGE_DIRECTORY is not configured.')

    try:
        with open(paths['data'] / 'config.json', 'r') as f:
            config = json.load(f)
    except Exception:
        return Response(status=500, response='Invalid config file.')

    if not config['app_config'].get('allow_public_upload', False):
        return Response(status=401)

    upload_folder = config['app_config'].get('public_upload_folder_name', 'public uploads')
    if config['app_config'].get('allow_public_folder_selection', False):
        requested_folder = sanitize_upload_folder(request.form.get('folder'))
        if requested_folder:
            upload_folder = requested_folder

    if 'file' not in request.files:
        return Response(status=400)
    files = request.files.getlist('file')
    if not files:
        return Response(status=400)

    tag_ids_raw = request.form.get('tag_ids', '')
    tag_ids = [int(t) for t in tag_ids_raw.split(',') if t.strip().isdigit()] or None
    game_id_raw = request.form.get('game_id', '')
    game_id = int(game_id_raw) if game_id_raw.strip().isdigit() else None

    upload_dir = Path(image_directory) / upload_folder
    upload_dir.mkdir(parents=True, exist_ok=True)

    saved = 0
    for file, last_modified in zip(files, _client_mtimes(files)):
        if not file.filename:
            continue
        filename = secure_filename(file.filename)
        if not filename:
            continue
        filetype = filename.rsplit('.', 1)[-1].lower()
        if filetype not in SUPPORTED_IMAGE_TYPES:
            continue
        save_path = str(upload_dir / filename)
        if os.path.exists(save_path):
            stem = '.'.join(filename.split('.')[:-1])
            uid = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
            save_path = str(upload_dir / f"{stem}-{uid}.{filetype}")
        file.save(save_path)
        # Public endpoint: attributed only when the caller happens to be signed in.
        _launch_scan_image(save_path, config, game_id=game_id, tag_ids=tag_ids,
                           uploaded_by=current_user.id if current_user.is_authenticated else None,
                           client_mtime=last_modified)
        saved += 1

    if saved == 0:
        return Response(status=400, response='No valid image files provided.')
    return Response(status=201)


# ---------------------------------------------------------------------------
# Upload folder listing
# ---------------------------------------------------------------------------

@api.route('/api/upload/image/folders', methods=['GET'])
@login_required
def get_image_upload_folders():
    paths = current_app.config['PATHS']
    image_directory = current_app.config.get('IMAGE_DIRECTORY')
    if not image_directory:
        return jsonify({'folders': [], 'default_folder': None})
    folders = []
    try:
        for entry in os.scandir(image_directory):
            if entry.is_dir() and not entry.name.startswith('.'):
                folders.append(entry.name)
        folders.sort()
    except Exception:
        pass
    default_folder = None
    try:
        with open(paths['data'] / 'config.json', 'r') as f:
            config = json.load(f)
        default_folder = config['app_config'].get('admin_upload_folder_name', 'uploads')
    except Exception:
        pass
    if default_folder and default_folder not in folders:
        folders.append(default_folder)
        folders.sort()
    return jsonify({'folders': folders, 'default_folder': default_folder})


@api.route('/api/upload/image-folders/public', methods=['GET'])
def get_public_image_upload_folders():
    paths = current_app.config['PATHS']
    image_directory = current_app.config.get('IMAGE_DIRECTORY')
    try:
        with open(paths['data'] / 'config.json', 'r') as f:
            config = json.load(f)
    except Exception:
        return jsonify({'folders': [], 'default_folder': None})

    if not config.get('app_config', {}).get('allow_public_folder_selection', False):
        return Response(status=403)

    folders = []
    if image_directory:
        try:
            for entry in os.scandir(image_directory):
                if entry.is_dir() and not entry.name.startswith('.'):
                    folders.append(entry.name)
            folders.sort()
        except Exception:
            pass

    default_folder = config['app_config'].get('public_upload_folder_name', 'public uploads')
    if default_folder and default_folder not in folders:
        folders.append(default_folder)
        folders.sort()
    return jsonify({'folders': folders, 'default_folder': default_folder})


# ---------------------------------------------------------------------------
# List endpoints
# ---------------------------------------------------------------------------

@api.route('/api/images')
@login_required
def get_images():
    sort = request.args.get('sort', 'updated_at desc')
    allowed_sorts = ['updated_at desc', 'updated_at asc', 'image_info.title desc', 'image_info.title asc']
    if sort not in allowed_sorts:
        return jsonify({"error": "Invalid sort parameter"}), 400

    query = Image.query.join(ImageInfo).filter(Image.available == True)
    if not viewer_sees_private():
        query = query.filter(ImageInfo.private == False)
    images = query.order_by(text(sort)).all()
    result = []
    for img in images:
        j = img.json()
        j['view_count'] = ImageView.count(img.image_id)
        j['tags'] = [l.tag.json() for l in ImageTagLink.query.filter_by(image_id=img.image_id).all() if l.tag]
        game_link = ImageGameLink.query.filter_by(image_id=img.image_id).first()
        j['game'] = game_link.game.json() if game_link and game_link.game else None
        result.append(j)
    return jsonify({"images": result})


@api.route('/api/images/public')
def get_public_images():
    sort = request.args.get('sort', 'updated_at desc')
    allowed_sorts = ['updated_at desc', 'updated_at asc', 'image_info.title desc', 'image_info.title asc']
    if sort not in allowed_sorts:
        return jsonify({"error": "Invalid sort parameter"}), 400

    images = (Image.query.join(ImageInfo)
              .filter(Image.available == True, ImageInfo.private == False)
              .order_by(text(sort)).all())
    result = []
    for img in images:
        j = img.json()
        j['view_count'] = ImageView.count(img.image_id)
        j['tags'] = [l.tag.json() for l in ImageTagLink.query.filter_by(image_id=img.image_id).all() if l.tag]
        game_link = ImageGameLink.query.filter_by(image_id=img.image_id).first()
        j['game'] = game_link.game.json() if game_link and game_link.game else None
        result.append(j)
    return jsonify({"images": result})


# ---------------------------------------------------------------------------
# Detail / update / delete
# ---------------------------------------------------------------------------

@api.route('/api/image/details/<image_id>', methods=['GET'])
def get_image_details(image_id):
    img = Image.query.filter_by(image_id=image_id).first()
    if not img:
        return Response(status=404)
    if img.info and img.info.private and not current_user.is_authenticated:
        return Response(status=401)
    j = img.json()
    j['view_count'] = ImageView.count(image_id)
    j['tags'] = [l.tag.json() for l in ImageTagLink.query.filter_by(image_id=image_id).all() if l.tag]
    game_link = ImageGameLink.query.filter_by(image_id=image_id).first()
    j['game'] = game_link.game.json() if game_link and game_link.game else None
    return jsonify(j)


@api.route('/api/image/details/<image_id>', methods=['PUT'])
@require_perm(P.EDIT_OWN, P.EDIT_ANY)
def update_image_details(image_id):
    _img = Image.query.filter_by(image_id=image_id).first()
    if _img and not current_user.can_modify(_img, 'edit'):
        return Response(status=403, response='You can only edit your own uploads.')
    img = Image.query.filter_by(image_id=image_id).first()
    if not img or not img.info:
        return Response(status=404)
    data = request.get_json() or {}
    if 'title' in data:
        img.info.title = data['title']
    if 'description' in data:
        img.info.description = data['description']
    if 'private' in data:
        img.info.private = bool(data['private'])
    if 'created_at' in data:
        created_at = data['created_at']
        if not created_at:
            img.created_at = None
        else:
            try:
                # Strip any timezone suffix and store as naive local datetime,
                # matching how video recorded_at is persisted.
                dt = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
                img.created_at = dt.replace(tzinfo=None)
            except (ValueError, AttributeError):
                pass
    db.session.commit()
    return Response(status=200)


@api.route('/api/image/delete/<image_id>', methods=['DELETE'])
@require_perm(P.DELETE_OWN, P.DELETE_ANY)
@demo_restrict
def delete_image(image_id):
    img = Image.query.filter_by(image_id=image_id).first()
    if not img:
        return Response(status=404)
    if not current_user.can_modify(img, 'delete'):
        return Response(status=403, response='You can only delete your own uploads.')

    folder_id = img.folder_id
    paths = current_app.config['PATHS']

    # Remove original image file
    image_directory = current_app.config.get('IMAGE_DIRECTORY')
    if image_directory:
        original_path = Path(image_directory) / img.path
        if original_path.exists():
            original_path.unlink()

    # Remove symlink
    link_path = paths['processed'] / 'image_links' / f"{image_id}{img.extension}"
    if link_path.exists() or link_path.is_symlink():
        link_path.unlink()

    # Remove derived data
    derived_path = paths['processed'] / 'derived' / image_id
    if derived_path.exists():
        import shutil
        shutil.rmtree(derived_path)

    # Remove DB records
    ImageTagLink.query.filter_by(image_id=image_id).delete()
    ImageGameLink.query.filter_by(image_id=image_id).delete()
    ImageView.query.filter_by(image_id=image_id).delete()
    ImageInfo.query.filter_by(image_id=image_id).delete()
    Image.query.filter_by(image_id=image_id).delete()
    db.session.commit()

    MediaFolder.cleanup_if_orphaned(folder_id, Image)
    return Response(status=200)


@api.route('/api/image/move/<image_id>', methods=['POST'])
@require_perm(P.EDIT_OWN, P.EDIT_ANY)
@demo_restrict
def move_image(image_id):
    img = Image.query.filter_by(image_id=image_id).first()
    if not img:
        return Response(status=404, response=f"An image with id: {image_id}, does not exist.")
    if not current_user.can_modify(img, 'edit'):
        return Response(status=403, response='You can only move your own uploads.')

    target_folder = ((request.get_json(silent=True) or {}).get('folder') or '').strip()
    if not target_folder:
        return Response(status=400, response='A target folder must be provided.')

    image_directory = current_app.config.get('IMAGE_DIRECTORY')
    if not image_directory:
        return Response(status=503, response='IMAGE_DIRECTORY is not configured.')
    resolved = resolve_media_subfolder(Path(image_directory), target_folder)
    if not resolved:
        return Response(status=400, response=f"Folder '{target_folder}' is not inside the image directory.")
    target_folder_path, target_folder = resolved
    if not target_folder_path.is_dir():
        return Response(status=400, response=f"Folder '{target_folder}' does not exist.")

    old_folder_id = img.folder_id
    try:
        move_image_file(img, image_directory, target_folder_path, target_folder, current_app.config['PATHS']['processed'])
        db.session.commit()
    except MoveRefused as e:
        db.session.rollback()
        return Response(status=e.status, response=str(e))
    except Exception as e:
        db.session.rollback()
        logger.error(f"Error moving image {image_id}: {e}")
        return Response(status=500, response=str(e))

    if old_folder_id != img.folder_id:
        MediaFolder.cleanup_if_orphaned(old_folder_id, Image)
    logger.info(f"Moved image {image_id} to '{target_folder}'")
    return jsonify({'path': img.path})


# ---------------------------------------------------------------------------
# Serve image files
# ---------------------------------------------------------------------------

@api.route('/api/image')
def serve_image():
    image_id = request.args.get('id')
    if not image_id:
        return Response(status=400)
    img = Image.query.filter_by(image_id=image_id).first()
    if not img:
        return Response(status=404)
    if img.info and img.info.private and not current_user.is_authenticated:
        return Response(status=401)

    paths = current_app.config['PATHS']
    # Prefer full-quality WebP, fall back to original symlink
    webp_path = paths['processed'] / 'derived' / image_id / 'image.webp'
    if webp_path.exists():
        return send_file(str(webp_path), mimetype='image/webp')
    orig_path = paths['processed'] / 'image_links' / f"{image_id}{img.extension}"
    if orig_path.exists():
        return send_file(str(orig_path))
    return Response(status=404)


@api.route('/api/image/original')
def serve_image_original():
    image_id = request.args.get('id')
    if not image_id:
        return Response(status=400)
    img = Image.query.filter_by(image_id=image_id).first()
    if not img:
        return Response(status=404)
    if img.info and img.info.private and not current_user.is_authenticated:
        return Response(status=401)

    paths = current_app.config['PATHS']
    orig_path = paths['processed'] / 'image_links' / f"{image_id}{img.extension}"
    if orig_path.exists():
        # Saved under its title, like a downloaded video, falling back to its id.
        title = secure_filename((img.info.title or '').strip()) if img.info else ''
        filename = f"{title or image_id}{img.extension}"
        return send_file(str(orig_path), as_attachment=True, download_name=filename)
    return Response(status=404)


@api.route('/api/image/thumbnail')
def serve_image_thumbnail():
    image_id = request.args.get('id')
    if not image_id:
        return Response(status=400)
    img = Image.query.filter_by(image_id=image_id).first()
    if not img:
        return Response(status=404)
    if img.info and img.info.private and not current_user.is_authenticated:
        return Response(status=401)

    paths = current_app.config['PATHS']
    thumb_path = paths['processed'] / 'derived' / image_id / 'thumbnail.webp'
    if thumb_path.exists():
        return send_file(str(thumb_path), mimetype='image/webp')
    webp_path = paths['processed'] / 'derived' / image_id / 'image.webp'
    if webp_path.exists():
        return send_file(str(webp_path), mimetype='image/webp')
    orig_path = paths['processed'] / 'image_links' / f"{image_id}{img.extension}"
    if orig_path.exists():
        return send_file(str(orig_path))
    return Response(status=404)


# ---------------------------------------------------------------------------
# View tracking
# ---------------------------------------------------------------------------

@api.route('/api/image/view', methods=['POST'])
def add_image_view():
    data = request.get_json() or {}
    image_id = data.get('image_id')
    if not image_id:
        return Response(status=400)
    img = Image.query.filter_by(image_id=image_id).first()
    if not img:
        return Response(status=404)
    ip = request.headers.get('X-Forwarded-For', request.remote_addr)
    ImageView.add_view(image_id, ip)
    return Response(status=200)


@api.route('/api/image/<image_id>/views')
def get_image_views(image_id):
    return jsonify({"count": ImageView.count(image_id)})


# ---------------------------------------------------------------------------
# Game association
# ---------------------------------------------------------------------------

@api.route('/api/images/<image_id>/game', methods=['POST'])
@require_perm(P.MANAGE_GAMES)
def link_image_game(image_id):
    img = Image.query.filter_by(image_id=image_id).first()
    if not img:
        return Response(status=404)
    data = request.get_json() or {}
    game_id = data.get('game_id')
    if not game_id:
        return Response(status=400)
    game = GameMetadata.query.get(game_id)
    if not game:
        return Response(status=404)
    existing = ImageGameLink.query.filter_by(image_id=image_id).first()
    if existing:
        existing.game_id = game_id
    else:
        db.session.add(ImageGameLink(image_id=image_id, game_id=game_id, created_at=datetime.utcnow()))
    db.session.commit()
    return Response(status=200)


@api.route('/api/images/<image_id>/game', methods=['GET'])
def get_image_game(image_id):
    link = ImageGameLink.query.filter_by(image_id=image_id).first()
    if not link:
        return jsonify(None)
    return jsonify(link.json())


@api.route('/api/images/<image_id>/game', methods=['DELETE'])
@require_perm(P.MANAGE_GAMES)
def unlink_image_game(image_id):
    ImageGameLink.query.filter_by(image_id=image_id).delete()
    db.session.commit()
    return Response(status=200)


# ---------------------------------------------------------------------------
# Tag association
# ---------------------------------------------------------------------------

@api.route('/api/images/<image_id>/tags', methods=['POST'])
@require_perm(P.MANAGE_TAGS)
def add_image_tag(image_id):
    img = Image.query.filter_by(image_id=image_id).first()
    if not img:
        return Response(status=404)
    data = request.get_json() or {}
    tag_id = data.get('tag_id')
    if not tag_id:
        return Response(status=400)
    if not ImageTagLink.query.filter_by(image_id=image_id, tag_id=tag_id).first():
        db.session.add(ImageTagLink(image_id=image_id, tag_id=tag_id, created_at=datetime.utcnow()))
        db.session.commit()
    return Response(status=200)


@api.route('/api/images/<image_id>/tags/<int:tag_id>', methods=['DELETE'])
@require_perm(P.MANAGE_TAGS)
def remove_image_tag(image_id, tag_id):
    ImageTagLink.query.filter_by(image_id=image_id, tag_id=tag_id).delete()
    db.session.commit()
    return Response(status=200)


# ---------------------------------------------------------------------------
# OpenGraph share page
# ---------------------------------------------------------------------------

@api.route('/i/<image_id>')
def image_metadata(image_id):
    img = Image.query.filter_by(image_id=image_id).first()
    domain = f"https://{current_app.config['DOMAIN']}" if current_app.config.get('DOMAIN') else ""
    if img:
        game_link = ImageGameLink.query.filter_by(image_id=image_id).first()
        game = game_link.game if game_link else None
        return render_template(
            'image_metadata.html',
            image=img.json(),
            domain=domain,
            game=game.json() if game else None,
        )
    return redirect(f'{domain}/images/{image_id}', code=302)
