"""Custom games: titles a curator adds by hand, with artwork they upload.

SteamGridDB only lists a game once a moderator has approved it, which can lag a
release by weeks. A custom game sidesteps that. It lives only in this instance,
is stored in the same game_assets/<id>/ layout as every other game, and is told
apart by GameMetadata.is_custom. Its public id is allocated above
CUSTOM_GAME_ID_BASE so it can never collide with a real SteamGridDB id, which is
what lets every existing route, nginx alias and client URL builder work on it
unchanged.

Uploads are never stored as received. Each one is decoded, cropped to the slot's
shape (using the rectangle the client's crop tool sends, or centred when there is
none), scaled down to the slot's recommended size, and re-encoded as webp, so
only pixel data reaches disk.
"""
import io
import json
import os
import shutil
import tempfile
from datetime import datetime
from pathlib import Path

from flask import current_app, jsonify, request
from flask_login import current_user
from sqlalchemy import func

from .. import db, logger
from .. import permissions as P
from ..models import GameMetadata, CUSTOM_GAME_ID_BASE
from . import api
from .decorators import demo_restrict, require_perm

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_DECODED_PIXELS = 50_000_000
NAME_MAX_LENGTH = 256
WEBP_QUALITY = 92

# One entry per slot in game_assets/<id>/. `size` is the stored size of a fixed
# aspect slot, and for the logo the box it is scaled to fit inside. `aspect` None
# means the slot keeps whatever shape the (cropped) upload has. The logo and icon
# keep an alpha channel because both are drawn over other artwork.
ASSET_SPECS = {
    'hero':   {'slot': 'hero_1', 'size': (1920, 620), 'aspect': 1920 / 620, 'mode': 'RGB',  'required': True},
    'banner': {'slot': 'hero_2', 'size': (1920, 620), 'aspect': 1920 / 620, 'mode': 'RGB',  'required': False},
    'logo':   {'slot': 'logo_1', 'size': (1280, 720), 'aspect': None,       'mode': 'RGBA', 'required': True},
    'icon':   {'slot': 'icon_1', 'size': (512, 512),  'aspect': 1.0,        'mode': 'RGBA', 'required': True},
}


class AssetError(ValueError):
    """A problem with one uploaded image, carrying a message safe to show the user."""


def is_custom_game_id(public_id):
    return public_id is not None and public_id >= CUSTOM_GAME_ID_BASE


def find_custom_game(public_id):
    """The custom game with this public id, or None (including for SteamGridDB ids)."""
    if not is_custom_game_id(public_id):
        return None
    return GameMetadata.query.filter_by(steamgriddb_id=public_id, is_custom=True).first()


def _release_date_epoch(value):
    """A stored YYYY-MM-DD release date as epoch seconds, matching SteamGridDB's search results."""
    if not value:
        return None
    try:
        return int(datetime.strptime(value, '%Y-%m-%d').timestamp())
    except ValueError:
        return None


def search_custom_games(query):
    """Custom games whose name contains the query, shaped like SteamGridDB search hits.

    Merged ahead of the upstream results so every game picker on the client sees
    a curator's own games without knowing where they came from.
    """
    needle = (query or '').strip()
    if not needle:
        return []
    escaped = needle.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    games = (
        GameMetadata.query
        .filter(GameMetadata.is_custom.is_(True))
        .filter(GameMetadata.name.ilike(f'%{escaped}%', escape='\\'))
        .order_by(GameMetadata.name)
        .limit(20)
        .all()
    )
    return [
        {
            'id': g.steamgriddb_id,
            'name': g.name,
            'release_date': _release_date_epoch(g.release_date),
            'types': ['custom'],
            'verified': True,
            'custom': True,
        }
        for g in games
    ]


# ---------------------------------------------------------------------------
# Image processing
# ---------------------------------------------------------------------------

def _parse_crop(raw, width, height):
    """A crop rectangle from the client as a PIL box, or None when absent.

    The client sends {"x", "y", "width", "height"} in source pixels. It works
    those out from a scaled preview, so a pixel of drift past an edge is expected
    and clamped rather than rejected.
    """
    if raw in (None, ''):
        return None
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
        x, y, w, h = (int(round(float(data[k]))) for k in ('x', 'y', 'width', 'height'))
    except (TypeError, ValueError, KeyError):
        raise AssetError('Invalid crop rectangle.')
    x = max(0, min(x, width - 1))
    y = max(0, min(y, height - 1))
    w = max(1, min(w, width - x))
    h = max(1, min(h, height - y))
    return (x, y, x + w, y + h)


def _centered_box(width, height, aspect):
    """The largest box of the given aspect that fits the image, centred."""
    if width / height > aspect:
        w, h = int(round(height * aspect)), height
    else:
        w, h = width, int(round(width / aspect))
    left = (width - w) // 2
    top = (height - h) // 2
    return (left, top, left + w, top + h)


def process_asset_upload(file_storage, asset_type, crop_raw, dest_dir):
    """Validate, crop, scale and write one upload as <slot>.webp inside dest_dir.

    Returns the written path. Raises AssetError with a user-facing message.
    """
    spec = ASSET_SPECS[asset_type]
    from PIL import Image as PILImage, ImageOps, UnidentifiedImageError

    raw = file_storage.read(MAX_UPLOAD_BYTES + 1)
    if not raw:
        raise AssetError(f'The {asset_type} image was empty.')
    if len(raw) > MAX_UPLOAD_BYTES:
        raise AssetError(f'The {asset_type} image must be smaller than {MAX_UPLOAD_BYTES // (1024 * 1024)}MB.')

    try:
        with PILImage.open(io.BytesIO(raw)) as probe:
            # Pillow reads dimensions from the header without decoding pixels, so
            # a bomb is caught before any large allocation happens.
            width, height = probe.size
            if width <= 0 or height <= 0:
                raise AssetError(f'The {asset_type} image could not be read.')
            if width * height > MAX_DECODED_PIXELS:
                raise AssetError(f'The {asset_type} image is too large to process.')
            probe.verify()
    except AssetError:
        raise
    except (UnidentifiedImageError, PILImage.DecompressionBombError):
        raise AssetError(f'The {asset_type} file is not a supported image.')
    except Exception:
        raise AssetError(f'The {asset_type} image could not be read.')

    # verify() leaves the file object unusable, so decode from a fresh buffer.
    try:
        with PILImage.open(io.BytesIO(raw)) as img:
            if getattr(img, 'n_frames', 1) > 1:
                img.seek(0)  # animated source: keep the first frame only
            # Browsers show an image already rotated by its EXIF tag, and the crop
            # tool's coordinates are in that rotated space, so rotate first.
            img = ImageOps.exif_transpose(img)
            img = img.convert(spec['mode'])

            crop = _parse_crop(crop_raw, img.width, img.height)
            if crop:
                img = img.crop(crop)
            elif spec['aspect']:
                img = img.crop(_centered_box(img.width, img.height, spec['aspect']))

            if spec['aspect']:
                # Always store the slot's size. A crop smaller than that (a small
                # source, or a tight zoom) is scaled up here rather than left for
                # every page to upscale differently; the client warns when that
                # will look soft.
                img = ImageOps.fit(img, spec['size'], method=PILImage.LANCZOS)
            else:
                # Logo: drop fully transparent borders so the logo itself, not its
                # canvas, is what the page sizes, then fit inside the box.
                if img.mode == 'RGBA':
                    bbox = img.getchannel('A').getbbox()
                    if bbox:
                        img = img.crop(bbox)
                img.thumbnail(spec['size'], PILImage.LANCZOS)

            dest_dir.mkdir(parents=True, exist_ok=True)
            out = dest_dir / f"{spec['slot']}.webp"
            img.save(out, 'WEBP', quality=WEBP_QUALITY, method=6)
            return out
    except AssetError:
        raise
    except PILImage.DecompressionBombError:
        raise AssetError(f'The {asset_type} image is too large to process.')
    except Exception as ex:
        logger.error(f'Failed to process uploaded {asset_type} image: {ex}')
        raise AssetError(f'The {asset_type} image could not be processed.')


# ---------------------------------------------------------------------------
# Request helpers
# ---------------------------------------------------------------------------

def _uploaded(asset_type):
    """The FileStorage for this slot, or None when the part is absent or empty."""
    f = request.files.get(asset_type)
    if f is None or not f.filename:
        return None
    return f


def _parse_release_date(raw):
    """Returns (value, error). An empty field clears the date."""
    if raw is None:
        return None, None
    raw = raw.strip()
    if not raw:
        return None, None
    try:
        datetime.strptime(raw, '%Y-%m-%d')
    except ValueError:
        return None, 'Release date must be YYYY-MM-DD.'
    return raw, None


def _name_taken(name, exclude_id=None):
    q = GameMetadata.query.filter(func.lower(GameMetadata.name) == name.lower())
    if exclude_id is not None:
        q = q.filter(GameMetadata.id != exclude_id)
    return q.first()


def _staging_dir():
    """A scratch directory on the same filesystem as game_assets, so the final
    move into place is a rename rather than a copy."""
    paths = current_app.config['PATHS']
    paths['data'].mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix='.custom-game-', dir=str(paths['data'])))


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@api.route('/api/games/custom', methods=['POST'])
@require_perm(P.MANAGE_GAMES)
@demo_restrict
def create_custom_game():
    """Create a game from a name and uploaded artwork (multipart form).

    Fields: name (required), release_date (optional, YYYY-MM-DD), one file per
    slot in ASSET_SPECS with hero, logo and icon required, and an optional
    <slot>_crop JSON rectangle beside each file.
    """
    name = P.clean_text_field(request.form.get('name'), NAME_MAX_LENGTH)
    if not name:
        return jsonify({'error': 'A game name is required.'}), 400

    release_date, error = _parse_release_date(request.form.get('release_date'))
    if error:
        return jsonify({'error': error}), 400

    missing = [t for t, spec in ASSET_SPECS.items() if spec['required'] and not _uploaded(t)]
    if missing:
        return jsonify({'error': f"A {', '.join(missing)} image is required."}), 400

    existing = _name_taken(name)
    if existing:
        return jsonify({'error': f'A game named "{existing.name}" already exists.'}), 409

    staging = _staging_dir()
    try:
        for asset_type in ASSET_SPECS:
            upload = _uploaded(asset_type)
            if upload is not None:
                process_asset_upload(upload, asset_type, request.form.get(f'{asset_type}_crop'), staging)

        # The game page draws the banner slot behind its header and the card
        # draws the hero, so a game without a banner of its own shows the hero in
        # both places rather than an empty header.
        if not (staging / 'hero_2.webp').exists():
            shutil.copyfile(staging / 'hero_1.webp', staging / 'hero_2.webp')

        now = datetime.utcnow()
        game = GameMetadata(name=name, release_date=release_date, is_custom=True, created_at=now, updated_at=now)
        db.session.add(game)
        db.session.flush()  # assigns game.id
        game.steamgriddb_id = CUSTOM_GAME_ID_BASE + game.id

        paths = current_app.config['PATHS']
        final_dir = paths['data'] / 'game_assets' / str(game.steamgriddb_id)
        if final_dir.exists():
            shutil.rmtree(final_dir)
        final_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(staging), str(final_dir))
        db.session.commit()
    except AssetError as ex:
        db.session.rollback()
        return jsonify({'error': str(ex)}), 400
    except Exception as ex:
        db.session.rollback()
        logger.error(f'Failed to create custom game "{name}": {ex}')
        return jsonify({'error': 'Failed to create the game.'}), 500
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    from .game import game_json_with_assets

    logger.info(f"User '{current_user.username}' created custom game '{name}' (id {game.steamgriddb_id})")
    return jsonify(game_json_with_assets(game)), 201


@api.route('/api/games/custom/<int:public_id>', methods=['PUT'])
@require_perm(P.MANAGE_GAMES)
@demo_restrict
def update_custom_game(public_id):
    """Rename a custom game, change its release date, or replace any of its artwork.

    Same multipart shape as creation; every field is optional. Replacement images
    are all processed before any existing file is touched, so a bad upload leaves
    the game exactly as it was.
    """
    game = find_custom_game(public_id)
    if game is None:
        return jsonify({'error': 'Custom game not found.'}), 404

    name = game.name
    if 'name' in request.form:
        name = P.clean_text_field(request.form.get('name'), NAME_MAX_LENGTH)
        if not name:
            return jsonify({'error': 'A game name is required.'}), 400
        existing = _name_taken(name, exclude_id=game.id)
        if existing:
            return jsonify({'error': f'A game named "{existing.name}" already exists.'}), 409

    release_date = game.release_date
    if 'release_date' in request.form:
        release_date, error = _parse_release_date(request.form.get('release_date'))
        if error:
            return jsonify({'error': error}), 400

    replacing = [t for t in ASSET_SPECS if _uploaded(t) is not None]

    staging = _staging_dir()
    try:
        for asset_type in replacing:
            process_asset_upload(_uploaded(asset_type), asset_type, request.form.get(f'{asset_type}_crop'), staging)

        paths = current_app.config['PATHS']
        asset_dir = paths['data'] / 'game_assets' / str(game.steamgriddb_id)
        asset_dir.mkdir(parents=True, exist_ok=True)
        for asset_type in replacing:
            slot = ASSET_SPECS[asset_type]['slot']
            for old in asset_dir.glob(f'{slot}.*'):
                try:
                    old.unlink()
                except OSError as ex:
                    logger.warning(f'Could not remove old asset {old}: {ex}')
            os.replace(staging / f'{slot}.webp', asset_dir / f'{slot}.webp')

        game.name = name
        game.release_date = release_date
        game.updated_at = datetime.utcnow()
        db.session.commit()
    except AssetError as ex:
        db.session.rollback()
        return jsonify({'error': str(ex)}), 400
    except Exception as ex:
        db.session.rollback()
        logger.error(f'Failed to update custom game {public_id}: {ex}')
        return jsonify({'error': 'Failed to update the game.'}), 500
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    from .game import game_json_with_assets

    logger.info(
        f"User '{current_user.username}' updated custom game '{game.name}' (id {game.steamgriddb_id})"
        + (f", replaced {', '.join(replacing)}" if replacing else '')
    )
    return jsonify(game_json_with_assets(game))
