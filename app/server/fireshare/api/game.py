import re
import shutil
import tempfile
from datetime import datetime
from pathlib import Path

from flask import current_app, jsonify, request, Response, send_file
from flask_login import login_required, current_user

from .. import db, logger
from ..models import Video, VideoInfo, VideoView, GameMetadata, VideoGameLink, Image, ImageInfo, ImageGameLink, ImageView, CUSTOM_GAME_ID_BASE
from ..steamgrid import SteamGridDBClient
from .. import permissions as P
from . import api
from .decorators import require_perm
from .custom_games import search_custom_games, find_custom_game, is_custom_game_id
from .helpers import (
    cancel_pending_transcode_jobs,
    delete_video_files,
    get_steamgriddb_api_key,
    login_required_unless_public_game_tag,
    viewer_sees_private,
)


def find_asset_with_extensions(asset_dir, base_name):
    """Try to find an asset file with any supported extension."""
    for ext in ['.png', '.jpg', '.jpeg', '.webp']:
        path = asset_dir / f'{base_name}{ext}'
        if path.exists():
            return path
    return None


def game_json_with_assets(game):
    """game.json() with cache-busting query params on whichever assets exist.

    Shared with the per-user games listing so both produce identical URLs, which
    keeps the browser cache working across the two pages.
    """
    data = game.json()
    if not game.steamgriddb_id:
        return data
    paths = current_app.config['PATHS']
    asset_dir = paths['data'] / 'game_assets' / str(game.steamgriddb_id)
    for base, key in [('hero_1', 'hero_url'), ('hero_2', 'banner_url'),
                      ('logo_1', 'logo_url'), ('icon_1', 'icon_url')]:
        asset_path = asset_dir / f'{base}.webp'
        if not asset_path.exists():
            asset_path = find_asset_with_extensions(asset_dir, base)
        if asset_path and asset_path.exists() and data.get(key):
            data[key] = data[key] + f'?v={int(asset_path.stat().st_mtime)}'
    return data


@api.route('/api/steamgrid/search', methods=["GET"])
@login_required
def search_steamgrid():
    query = request.args.get('query')
    if not query:
        return Response(status=400, response='Query parameter is required.')

    # A curator's own games come first. They are the ones SteamGridDB does not
    # have yet, and they are still searchable when no API key is configured.
    custom = search_custom_games(query)

    api_key = get_steamgriddb_api_key()
    if not api_key:
        return jsonify(custom)

    client = SteamGridDBClient(api_key)

    results = client.search_games(query)
    return jsonify(custom + results)


@api.route('/api/steamgrid/game/<int:game_id>/assets', methods=["GET"])
@login_required
def get_steamgrid_assets(game_id):
    custom = find_custom_game(game_id)
    if custom:
        data = game_json_with_assets(custom)
        return jsonify({k: data.get(k) for k in ('hero_url', 'logo_url', 'icon_url')})

    api_key = get_steamgriddb_api_key()
    if not api_key:
        return Response(status=503, response='SteamGridDB API key not configured.')

    client = SteamGridDBClient(api_key)

    assets = client.get_game_assets(game_id)
    return jsonify(assets)


@api.route('/api/steamgrid/game/<int:game_id>/assets/options', methods=["GET"])
@login_required
def get_steamgrid_asset_options(game_id):
    if is_custom_game_id(game_id):
        # Custom artwork is uploaded, not picked from a pool.
        return jsonify({'heroes': [], 'logos': [], 'icons': []})

    api_key = get_steamgriddb_api_key()
    if not api_key:
        return Response(status=503, response='SteamGridDB API key not configured.')

    client = SteamGridDBClient(api_key)
    options = client.get_all_asset_options(game_id)
    return jsonify(options)


@api.route('/api/games/<int:steamgriddb_id>/assets', methods=["PUT"])
@require_perm(P.MANAGE_GAMES)
def update_game_asset(steamgriddb_id):
    import tempfile

    data = request.get_json()
    if not data:
        return Response(status=400, response='Request body required.')

    asset_type = data.get('asset_type')
    url = data.get('url')

    if asset_type not in ('hero', 'banner', 'logo', 'icon'):
        return Response(status=400, response='asset_type must be hero, banner, logo, or icon.')
    if not url:
        return Response(status=400, response='url is required.')

    # Validate with urllib3's parser (the one requests uses to connect), not
    # urllib.parse — the two disagree on backslash handling, which lets a URL
    # like https://127.0.0.1\@cdn.steamgriddb.com pass an urlparse hostname
    # check while requests actually connects to 127.0.0.1 (SSRF).
    from urllib3.util import parse_url
    _ALLOWED_STEAMGRIDDB_HOSTS = {
        'cdn2.steamgriddb.com',
        'cdn.steamgriddb.com',
        'steamgriddb.com',
    }
    try:
        parsed = parse_url(url)
        if parsed.scheme not in ('https',) or parsed.host not in _ALLOWED_STEAMGRIDDB_HOSTS:
            return Response(status=400, response='url must be a SteamGridDB asset URL.')
    except Exception:
        return Response(status=400, response='Invalid url.')

    game = GameMetadata.query.filter_by(steamgriddb_id=steamgriddb_id).first()
    if not game:
        return Response(status=404, response='Game not found.')

    api_key = get_steamgriddb_api_key()
    if not api_key:
        return Response(status=503, response='SteamGridDB API key not configured.')

    client = SteamGridDBClient(api_key)
    ext = client._get_extension_from_url(url)
    slot_map = {'hero': 'hero_1', 'banner': 'hero_2', 'logo': 'logo_1', 'icon': 'icon_1'}
    base_name = slot_map[asset_type]

    paths = current_app.config['PATHS']
    asset_dir = paths['data'] / 'game_assets' / str(steamgriddb_id)
    asset_dir.mkdir(parents=True, exist_ok=True)

    dest_path = asset_dir / f'{base_name}.webp'

    # Download to temp file first — do NOT remove the old asset until success
    import shutil
    temp_dir = Path(tempfile.mkdtemp())
    try:
        temp_path = temp_dir / f'{base_name}{ext}'
        success = client._download_asset(url, temp_path)
        if not success:
            return Response(status=502, response='Failed to download asset from SteamGridDB.')
        # Convert to webp if needed
        webp_temp = temp_dir / f'{base_name}.webp'
        if ext != '.webp' and not client._convert_to_webp(temp_path, webp_temp):
            return Response(status=500, response='Failed to convert asset to webp.')
        final_temp = webp_temp if ext != '.webp' else temp_path
        # Atomically replace: remove all old variants, move new webp into place
        for existing in asset_dir.glob(f'{base_name}.*'):
            try:
                existing.unlink()
            except OSError as e:
                current_app.logger.warning(f'Could not remove old asset {existing}: {e}')
        shutil.move(str(final_temp), str(dest_path))
        game.updated_at = datetime.utcnow()
        db.session.commit()
    finally:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)

    return Response(status=200)


@api.route('/api/games', methods=["GET"])
def get_games():
    from sqlalchemy import or_, exists

    # Sub-queries to check for linked videos / images
    has_video = exists().where(VideoGameLink.game_id == GameMetadata.id).where(
        VideoGameLink.video_id == Video.video_id
    )
    has_image = exists().where(ImageGameLink.game_id == GameMetadata.id).where(
        ImageGameLink.image_id == Image.image_id
    )

    if viewer_sees_private():
        # Show games that have at least one linked video OR image. Custom games
        # are always listed: someone just added one by hand, and it has to be
        # visible to link media to, and to edit or delete.
        games = (
            db.session.query(GameMetadata)
            .filter(or_(has_video, has_image, GameMetadata.is_custom.is_(True)))
            .distinct()
            .order_by(GameMetadata.name)
            .all()
        )
    else:
        # For public users, only show games that have at least one public video OR image
        has_public_video = (
            exists()
            .where(VideoGameLink.game_id == GameMetadata.id)
            .where(VideoGameLink.video_id == Video.video_id)
            .where(Video.video_id == VideoInfo.video_id)
            .where(Video.available.is_(True))
            .where(VideoInfo.private.is_(False))
        )
        has_public_image = (
            exists()
            .where(ImageGameLink.game_id == GameMetadata.id)
            .where(ImageGameLink.image_id == Image.image_id)
            .where(Image.image_id == ImageInfo.image_id)
            .where(Image.available.is_(True))
            .where(ImageInfo.private.is_(False))
        )
        games = (
            db.session.query(GameMetadata)
            .filter(or_(has_public_video, has_public_image))
            .distinct()
            .order_by(GameMetadata.name)
            .all()
        )

    result = [game_json_with_assets(game) for game in games]
    resp = jsonify(result)
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@api.route('/api/games', methods=["POST"])
@login_required_unless_public_game_tag
def create_game():
    data = request.json

    if not data or not data.get('name'):
        return Response(status=400, response='Game name is required.')

    if not data.get('steamgriddb_id'):
        return Response(status=400, response='SteamGridDB ID is required.')

    existing_game = GameMetadata.query.filter_by(steamgriddb_id=data['steamgriddb_id']).first()
    if existing_game:
        updated = False
        if data.get('name') and data['name'] != existing_game.name:
            existing_game.name = data['name']
            updated = True
        if data.get('release_date') and data.get('release_date') != existing_game.release_date:
            existing_game.release_date = data['release_date']
            updated = True
        if updated:
            existing_game.updated_at = datetime.utcnow()
            db.session.commit()
        return jsonify(existing_game.json()), 200

    if is_custom_game_id(data['steamgriddb_id']):
        # The id is in the custom range but no such game exists any more, so there
        # is nothing upstream to fetch it from.
        return Response(status=404, response='Custom game not found.')

    # Get API key and initialize client
    api_key = get_steamgriddb_api_key()
    if not api_key:
        return Response(status=503, response='SteamGridDB API key not configured.')

    client = SteamGridDBClient(api_key)

    # Download and save assets
    paths = current_app.config['PATHS']
    game_assets_dir = paths['data'] / 'game_assets'

    result = client.download_and_save_assets(data['steamgriddb_id'], game_assets_dir)

    if not result['success']:
        current_app.logger.error(f"Failed to download assets for game {data['name']}: {result['error']}")
        return Response(
            status=500,
            response=f"Failed to download game assets: {result['error']}"
        )

    # Re-check for existing game after asset download (handles race condition)
    existing_game = GameMetadata.query.filter_by(steamgriddb_id=data['steamgriddb_id']).first()
    if existing_game:
        current_app.logger.info(f"Game {data['name']} was created by another request, returning existing")
        return jsonify(existing_game.json()), 200

    game = GameMetadata(
        steamgriddb_id=data['steamgriddb_id'],
        name=data['name'],
        release_date=data.get('release_date'),
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow()
    )

    db.session.add(game)
    db.session.commit()

    current_app.logger.info(f"Created game {data['name']} with assets: {result['assets']}")

    response_data = game.json()
    missing = [k for k, v in result['assets'].items() if v == 0]
    if missing:
        response_data['missing_assets'] = missing

    return jsonify(response_data), 201


@api.route('/api/videos/<video_id>/game', methods=["POST"])
@login_required_unless_public_game_tag
def link_video_to_game(video_id):
    data = request.json

    if not data or not data.get('game_id'):
        return Response(status=400, response='Game ID is required.')

    video = Video.query.filter_by(video_id=video_id).first()
    if not video:
        return Response(status=404, response='Video not found.')

    game = db.session.get(GameMetadata, data['game_id'])
    if not game:
        return Response(status=404, response='Game not found.')

    existing_link = VideoGameLink.query.filter_by(video_id=video_id).first()
    if existing_link:
        existing_link.game_id = data['game_id']
        existing_link.created_at = datetime.utcnow()
    else:
        link = VideoGameLink(
            video_id=video_id,
            game_id=data['game_id'],
            created_at=datetime.utcnow()
        )
        db.session.add(link)

    db.session.commit()

    return jsonify({"video_id": video_id, "game_id": data['game_id']}), 201


@api.route('/api/videos/<video_id>/game', methods=["GET"])
def get_video_game(video_id):
    link = VideoGameLink.query.filter_by(video_id=video_id).first()
    if not link:
        return jsonify(None)
    data = link.game.json()
    if link.game.steamgriddb_id:
        paths = current_app.config['PATHS']
        asset_dir = paths['data'] / 'game_assets' / str(link.game.steamgriddb_id)
        for base, key in [('hero_1', 'hero_url'), ('hero_2', 'banner_url'), ('logo_1', 'logo_url'), ('icon_1', 'icon_url')]:
            asset_path = asset_dir / f'{base}.webp'
            if not asset_path.exists():
                asset_path = find_asset_with_extensions(asset_dir, base)
            if asset_path and asset_path.exists() and data.get(key):
                data[key] = data[key] + f'?v={int(asset_path.stat().st_mtime)}'
    resp = jsonify(data)
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@api.route('/api/videos/<video_id>/game', methods=["DELETE"])
@login_required_unless_public_game_tag
def unlink_video_from_game(video_id):
    link = VideoGameLink.query.filter_by(video_id=video_id).first()
    if not link:
        return Response(status=404, response='Video is not linked to any game.')

    db.session.delete(link)
    db.session.commit()

    return Response(status=204)


@api.route('/api/game/assets/<int:steamgriddb_id>/<filename>')
def get_game_asset(steamgriddb_id, filename):
    # Validate filename to prevent path traversal
    if not re.match(r'^(hero_[12]|logo_1|icon_1)\.(png|jpg|jpeg|webp)$', filename):
        return Response(status=400, response='Invalid filename.')

    paths = current_app.config['PATHS']
    asset_dir = paths['data'] / 'game_assets' / str(steamgriddb_id)
    base_name = filename.rsplit('.', 1)[0]

    # Optional fallback parameter (e.g., ?fallback=hero_1)
    fallback = request.args.get('fallback')
    if fallback and not re.match(r'^(hero_[12]|logo_1|icon_1)$', fallback):
        fallback = None  # Invalid fallback, ignore it

    asset_path = paths['data'] / 'game_assets' / str(steamgriddb_id) / filename

    # Try exact filename first
    if not asset_path.exists():
        # Try other extensions for the requested asset
        if asset_dir.exists():
            found = find_asset_with_extensions(asset_dir, base_name)
            if found:
                asset_path = found

    # If still not found and fallback is specified, try the fallback asset
    if not asset_path.exists() and fallback:
        logger.info(f"{base_name} not found for game {steamgriddb_id}, trying fallback: {fallback}")
        if asset_dir.exists():
            found = find_asset_with_extensions(asset_dir, fallback)
            if found:
                asset_path = found

    # If asset still doesn't exist, try to re-download from SteamGridDB. A custom
    # game's art only ever existed here, so there is nothing to fetch for it.
    if not asset_path.exists() and is_custom_game_id(steamgriddb_id):
        return Response(status=404, response='Asset not found.')
    if not asset_path.exists():
        logger.warning(f"{filename} missing for game {steamgriddb_id}")
        api_key = get_steamgriddb_api_key()
        if api_key:
            client = SteamGridDBClient(api_key)
            game_assets_dir = paths['data'] / 'game_assets'

            logger.info(f"Downloading assets for game {steamgriddb_id}")
            result = client.download_and_save_assets(steamgriddb_id, game_assets_dir)

            if result.get('success'):
                logger.info(f"Assets downloaded for game {steamgriddb_id}: {result.get('assets')}")
                # Try to find the requested file after re-download
                found = find_asset_with_extensions(asset_dir, base_name)
                if found:
                    asset_path = found
                    logger.info(f"Found {asset_path.name}")
                # If still not found, try fallback after re-download
                elif fallback:
                    found = find_asset_with_extensions(asset_dir, fallback)
                    if found:
                        asset_path = found
                        logger.info(f"Found fallback {asset_path.name}")
            else:
                logger.error(f"Download failed for game {steamgriddb_id}: {result.get('error')}")
        else:
            logger.warning(f"Download failed for game {steamgriddb_id}: No SteamGridDB API key configured")

    if not asset_path.exists():
        return Response(status=404, response='Asset not found.')

    # Determine MIME type from extension
    ext = asset_path.suffix.lower()
    mime_types = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp'
    }
    mime_type = mime_types.get(ext, 'image/png')

    response = send_file(asset_path, mimetype=mime_type)
    stat = asset_path.stat()
    etag = f"{steamgriddb_id}-{filename}-{int(stat.st_mtime)}-{stat.st_size}"
    response.headers['Cache-Control'] = 'public, max-age=3600'
    response.headers['ETag'] = f'"{etag}"'
    return response


@api.route('/api/games/<int:steamgriddb_id>/videos', methods=["GET"])
def get_game_videos(steamgriddb_id):

    game = GameMetadata.query.filter_by(steamgriddb_id=steamgriddb_id).first()
    if not game:
        return Response(status=404, response='Game not found.')

    videos_json = []
    for link in game.videos:
        if not link.video:
            continue

        if not viewer_sees_private():
            # Only show available, non-private videos to public users
            if not link.video.available:
                continue
            if not link.video.info or link.video.info.private:
                continue

        vjson = link.video.json()
        vjson["view_count"] = VideoView.count(link.video_id)
        videos_json.append(vjson)

    return jsonify(videos_json)


@api.route('/api/games/<int:steamgriddb_id>/images', methods=["GET"])
def get_game_images(steamgriddb_id):
    game = GameMetadata.query.filter_by(steamgriddb_id=steamgriddb_id).first()
    if not game:
        return Response(status=404, response='Game not found.')

    game_json = game.json()
    images_json = []
    for link in ImageGameLink.query.filter_by(game_id=game.id).all():
        if not link.image:
            continue
        if not viewer_sees_private():
            if not link.image.available:
                continue
            if not link.image.info or link.image.info.private:
                continue
        ijson = link.image.json()
        ijson["view_count"] = ImageView.count(link.image_id)
        ijson["game"] = game_json
        images_json.append(ijson)
    return jsonify(images_json)


@api.route('/api/games/<int:steamgriddb_id>', methods=["DELETE"])
@require_perm(P.MANAGE_GAMES)
def delete_game(steamgriddb_id):
    """
    Delete a game and optionally all associated videos.
    Query param: delete_videos (boolean) - if true, also delete all videos linked to this game
    """
    game = GameMetadata.query.filter_by(steamgriddb_id=steamgriddb_id).first()
    if not game:
        return Response(status=404, response='Game not found.')

    delete_videos = request.args.get('delete_videos', 'false').lower() == 'true'

    logger.info(f"Deleting game {game.name} (steamgriddb_id: {steamgriddb_id}), delete_videos={delete_videos}")

    # Get all video links for this game
    video_links = VideoGameLink.query.filter_by(game_id=game.id).all()

    if delete_videos and video_links:
        # Delete all associated videos
        paths = current_app.config['PATHS']
        from ..models import VideoInfo, VideoView, VideoTagLink, MediaFolder
        orphaned_folder_ids = set()
        for link in video_links:
            video = link.video
            if video is None:
                # Orphaned link - just delete it
                db.session.delete(link)
                continue
            logger.info(f"Deleting video: {video.video_id}")

            if video.folder_id is not None:
                orphaned_folder_ids.add(video.folder_id)

            file_path = paths['video'] / video.path
            link_path = paths['processed'] / 'video_links' / f"{video.video_id}{video.extension}"
            derived_path = paths['processed'] / 'derived' / video.video_id

            cancel_pending_transcode_jobs(video.video_id)

            # Delete from database
            VideoGameLink.query.filter_by(video_id=video.video_id).delete()
            VideoView.query.filter_by(video_id=video.video_id).delete()
            VideoInfo.query.filter_by(video_id=video.video_id).delete()
            Video.query.filter_by(video_id=video.video_id).delete()

            delete_video_files(video.video_id, file_path, link_path, derived_path)
    else:
        # Just unlink videos from the game
        for link in video_links:
            db.session.delete(link)

    # Delete game assets
    paths = current_app.config['PATHS']
    game_assets_dir = paths['data'] / 'game_assets' / str(steamgriddb_id)
    if game_assets_dir.exists():
        try:
            shutil.rmtree(game_assets_dir)
            logger.info(f"Deleted game assets directory: {game_assets_dir}")
        except OSError as e:
            logger.error(f"Error deleting game assets for {steamgriddb_id}: {e}")

    # Delete game from database
    db.session.delete(game)
    db.session.commit()

    if delete_videos and video_links:
        for folder_id in orphaned_folder_ids:
            MediaFolder.cleanup_if_orphaned(folder_id, Video)

    logger.info(f"Successfully deleted game {game.name}")
    return Response(status=200)


@api.route('/api/videos/<video_id>/game/suggestion', methods=["GET"])
def get_video_game_suggestion(video_id):
    """Get automatic game detection suggestion for a video"""
    from fireshare.cli import get_game_suggestion

    # Check if video is already linked to a game
    existing_link = VideoGameLink.query.filter_by(video_id=video_id).first()
    if existing_link:
        return jsonify(None)

    suggestion = get_game_suggestion(video_id)
    if not suggestion:
        return jsonify(None)

    return jsonify({
        'video_id': video_id,
        'game_id': suggestion.get('game_id'),
        'game_name': suggestion.get('game_name'),
        'steamgriddb_id': suggestion.get('steamgriddb_id'),
        'confidence': suggestion.get('confidence'),
        'source': suggestion.get('source')
    })


@api.route('/api/videos/<video_id>/game/suggestion', methods=["DELETE"])
@login_required_unless_public_game_tag
def reject_game_suggestion(video_id):
    """User rejected the game suggestion - remove from storage"""
    from fireshare.cli import delete_game_suggestion

    if delete_game_suggestion(video_id):
        logger.info(f"User rejected game suggestion for video {video_id}")

    return Response(status=204)
