"""Upload tokens: long-lived credentials that let external tools upload media.

The shape of the feature, and why:

* A token is a bearer credential owned by exactly one user. It grants nothing on
  its own — every request re-reads the owner's account, so revoking `upload`,
  disabling the account, or deleting it stops the token on the very next call.
  That is what keeps the token route as tight as the session-authenticated ones
  rather than becoming a way around the permission system.
* Only the sha256 of the secret is stored. A database copy cannot be replayed
  against the API, and a mislaid token can be replaced but never recovered. The
  raw value exists in exactly one response: the one that created or regenerated
  it.
* Tokens never expire. They are ended by deleting or regenerating them, which is
  what an unattended tool needs — an expiry would silently break automation.
* The credential is read from a header only. Query strings land in access logs
  and browser history, so a token in one would leak somewhere the owner cannot
  clean up.

The upload route itself deliberately reuses the helpers behind `/api/upload` and
`/api/upload/image` rather than reimplementing them, so the filename sanitising,
extension allowlist, folder containment, demo size cap, duplicate rejection, and
uploader attribution are all literally the same code paths the browser uses.
"""
import hashlib
import json
import os
import random
import re
import secrets
import shutil
import string
import threading
import time
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

from flask import current_app, jsonify, request, Response
from flask_login import current_user

from .. import db, logger
from .. import permissions as P
from ..constants import SUPPORTED_FILE_TYPES
from ..ip_whitelist import get_client_ip
from ..models import (CustomTag, FolderRule, GameMetadata, Image, ImageFolderRule, ImageInfo,
                      ImageTagLink, UploadToken, User, Video, VideoInfo, VideoTagLink)
from . import api
from .decorators import json_body, require_perm
from .helpers import parse_client_mtime, sanitize_upload_folder, secure_filename
from .image import SUPPORTED_IMAGE_TYPES, _launch_scan_image
from .upload import (_check_upload_size, _launch_scan_video, _parse_chunk_numbers, _parse_upload_metadata,
                     _positive_int, _reject_duplicate)

# Identifies a Fireshare upload token on sight, the way `ghp_` does for GitHub.
# Secret scanners and log filters can key on it, and a user who pastes the wrong
# credential into a config file can tell at a glance.
TOKEN_PREFIX = 'fsk_'

# Bytes of randomness behind the prefix: 256 bits, so guessing is not a threat
# model and the throttle below only exists to stop somebody making us do the work.
TOKEN_ENTROPY_BYTES = 32

# How much of the token the UI may show. This is the leading fragment of the real
# secret, which is how the owner recognises it in a config file; the remaining
# ~200 bits are what actually authenticates.
PREFIX_DISPLAY_LENGTH = len(TOKEN_PREFIX) + 8

TOKEN_NAME_MAX_LENGTH = 64
MAX_TOKENS_PER_USER = 20

# Writing last_used_at on every call would mean a database write per upload
# request for a field nobody reads at that resolution.
LAST_USED_WRITE_INTERVAL = 60


# ---------------------------------------------------------------------------
# Failed-token throttle
#
# Kept separate from login_throttle on purpose: sharing its per-IP bucket would
# let a tool looping on a stale token lock real people out of signing in from the
# same address. Counters live in process memory, exactly like the login ones, and
# an attacker cannot force the reset that restarting would give them.
# ---------------------------------------------------------------------------

_THROTTLE_WINDOW_SECONDS = 300
_THROTTLE_MAX_FAILURES = 30
_THROTTLE_MAX_TRACKED_IPS = 4096

_throttle_lock = threading.Lock()
_throttle_failures = {}


def _throttle_recent(ip, now):
    stamps = [t for t in _throttle_failures.get(ip, ()) if t > now - _THROTTLE_WINDOW_SECONDS]
    if stamps:
        _throttle_failures[ip] = stamps
    else:
        _throttle_failures.pop(ip, None)
    return stamps


def _throttle_retry_after(ip):
    """Seconds this address must wait before another token will be checked."""
    now = time.time()
    with _throttle_lock:
        stamps = _throttle_recent(ip, now)
        if len(stamps) >= _THROTTLE_MAX_FAILURES:
            return int(stamps[0] + _THROTTLE_WINDOW_SECONDS - now) + 1
        return 0


def _throttle_record_failure(ip):
    now = time.time()
    with _throttle_lock:
        stamps = _throttle_recent(ip, now)
        stamps.append(now)
        del stamps[: max(0, len(stamps) - _THROTTLE_MAX_FAILURES)]
        _throttle_failures[ip] = stamps
        for key in [k for k in _throttle_failures
                    if not any(t > now - _THROTTLE_WINDOW_SECONDS for t in _throttle_failures[k])]:
            del _throttle_failures[key]
        if len(_throttle_failures) > _THROTTLE_MAX_TRACKED_IPS:
            stale = sorted(_throttle_failures, key=lambda k: _throttle_failures[k][-1])
            for key in stale[: len(_throttle_failures) - _THROTTLE_MAX_TRACKED_IPS]:
                del _throttle_failures[key]


def _throttle_clear(ip):
    with _throttle_lock:
        _throttle_failures.pop(ip, None)


# ---------------------------------------------------------------------------
# Token helpers
# ---------------------------------------------------------------------------

def _now():
    """Naive UTC, matching the DateTime columns elsewhere in the schema."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _generate_token():
    return TOKEN_PREFIX + secrets.token_urlsafe(TOKEN_ENTROPY_BYTES)


def _hash_token(raw):
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def _clean_token_name(value):
    """Reduce a caller-supplied token name to something safe to store and render.

    Control characters are stripped for the same reason as in the profile fields:
    a name containing them would render as something other than what it says.
    """
    if not isinstance(value, str):
        return None
    cleaned = ''.join(ch for ch in value if ch.isprintable()).strip()
    return cleaned[:TOKEN_NAME_MAX_LENGTH] or None


def _token_from_request():
    """The raw token presented by the caller, or None.

    Headers only. A token in a query string would be written to the access log of
    every proxy in front of Fireshare and to the caller's shell history.
    """
    header = request.headers.get('Authorization', '')
    if header[:7].lower() == 'bearer ':
        candidate = header[7:].strip()
        if candidate:
            return candidate
    return (request.headers.get('X-Fireshare-Token') or '').strip() or None


def _resolve_token(raw):
    """Return (token, user) for a presented secret, or (None, None).

    The lookup is by hash, so nothing here compares secrets byte by byte, and an
    unknown token costs one indexed read.
    """
    if not raw or len(raw) > 512:
        return None, None
    token = UploadToken.query.filter_by(token_hash=_hash_token(raw)).first()
    if not token:
        return None, None
    user = db.session.get(User, token.user_id)
    if not user or user.disabled or not user.can(P.UPLOAD):
        return None, None
    return token, user


def _note_token_use(token):
    now = _now()
    if token.last_used_at and (now - token.last_used_at).total_seconds() < LAST_USED_WRITE_INTERVAL:
        return
    token.last_used_at = now
    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        logger.warning(f"Could not record use of upload token {token.id}: {e}")


def upload_token_required(f):
    """Authenticate the caller by upload token, or reject with 401.

    The decorated view receives `token_user` as a keyword argument. It is the live
    User row, re-read on every request, so the owner's current permissions govern
    the call rather than whatever they held when the token was minted.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        client_ip = get_client_ip()
        wait = _throttle_retry_after(client_ip)
        if wait:
            return Response(
                status=429,
                response='Too many invalid upload tokens. Try again later.',
                headers={'Retry-After': str(wait)},
            )

        raw = _token_from_request()
        if not raw:
            return Response(
                status=401,
                response='An upload token is required. Send it as "Authorization: Bearer <token>".',
                headers={'WWW-Authenticate': 'Bearer realm="fireshare-upload"'},
            )

        token, user = _resolve_token(raw)
        if not user:
            # One message for an unknown token, a revoked permission, and a
            # disabled account alike: the difference is not the caller's business
            # and telling them would confirm which tokens exist.
            _throttle_record_failure(client_ip)
            logger.warning(f"Rejected an upload token presented from {client_ip}")
            return Response(status=401, response='Invalid upload token.')

        _throttle_clear(client_ip)
        _note_token_use(token)
        kwargs['token_user'] = user
        return f(*args, **kwargs)
    return decorated


# ---------------------------------------------------------------------------
# Token management (session-authenticated, owner-scoped)
# ---------------------------------------------------------------------------

def _owned_token_or_404(token_id):
    """A token belonging to the signed-in user, or a 404 response.

    Scoped by owner rather than looked up and then checked, so another account's
    token id is indistinguishable from one that does not exist.
    """
    token = UploadToken.query.filter_by(id=token_id, user_id=current_user.id).first()
    if not token:
        return None, (jsonify({'error': 'Upload token not found.'}), 404)
    return token, None


@api.route('/api/account/upload-tokens', methods=['GET'])
@require_perm(P.UPLOAD)
def list_upload_tokens():
    tokens = (UploadToken.query
              .filter_by(user_id=current_user.id)
              .order_by(UploadToken.created_at.desc(), UploadToken.id.desc())
              .all())
    return jsonify({'tokens': [t.json() for t in tokens], 'max_tokens': MAX_TOKENS_PER_USER})


@api.route('/api/account/upload-tokens', methods=['POST'])
@require_perm(P.UPLOAD)
@json_body
def create_upload_token():
    name = _clean_token_name(request.json_body.get('name')) or 'Upload token'

    if UploadToken.query.filter_by(user_id=current_user.id).count() >= MAX_TOKENS_PER_USER:
        return jsonify({
            'error': f'You already have {MAX_TOKENS_PER_USER} upload tokens. '
                     'Delete one before creating another.'
        }), 400

    raw = _generate_token()
    token = UploadToken(
        user_id=current_user.id,
        name=name,
        token_hash=_hash_token(raw),
        prefix=raw[:PREFIX_DISPLAY_LENGTH],
        created_at=_now(),
    )
    db.session.add(token)
    db.session.commit()
    logger.info(f"User '{current_user.username}' created upload token {token.prefix}")

    # The only time the raw token is ever returned.
    return jsonify({'token': {**token.json(), 'secret': raw}}), 201


@api.route('/api/account/upload-tokens/<int:token_id>', methods=['PUT'])
@require_perm(P.UPLOAD)
@json_body
def rename_upload_token(token_id):
    token, error = _owned_token_or_404(token_id)
    if error:
        return error
    name = _clean_token_name(request.json_body.get('name'))
    if not name:
        return jsonify({'error': 'A name is required.'}), 400
    token.name = name
    db.session.commit()
    return jsonify({'token': token.json()})


@api.route('/api/account/upload-tokens/<int:token_id>/regenerate', methods=['POST'])
@require_perm(P.UPLOAD)
def regenerate_upload_token(token_id):
    token, error = _owned_token_or_404(token_id)
    if error:
        return error

    raw = _generate_token()
    token.token_hash = _hash_token(raw)
    token.prefix = raw[:PREFIX_DISPLAY_LENGTH]
    token.created_at = _now()
    # The old secret is gone, so anything it had done is no longer this token's
    # history. Clearing this keeps "last used" honest about the new one.
    token.last_used_at = None
    db.session.commit()
    logger.info(f"User '{current_user.username}' regenerated upload token {token.id} as {token.prefix}")

    return jsonify({'token': {**token.json(), 'secret': raw}})


@api.route('/api/account/upload-tokens/<int:token_id>', methods=['DELETE'])
@require_perm(P.UPLOAD)
def delete_upload_token(token_id):
    token, error = _owned_token_or_404(token_id)
    if error:
        return error
    prefix = token.prefix
    db.session.delete(token)
    db.session.commit()
    logger.info(f"User '{current_user.username}' deleted upload token {prefix}")
    return jsonify({'deleted': True})


# ---------------------------------------------------------------------------
# Token-authenticated upload
#
# Both routes funnel through _prepare_upload / _finish_upload so a chunked
# upload and a single-shot one cannot drift apart in what they accept, where
# they file it, or how they attribute it.
# ---------------------------------------------------------------------------

def _resolve_game_id(game_id):
    """The game to link the upload to, from `game_id` or a `game` name.

    A machine usually knows the game as a name, not as a Fireshare row id, so the
    name is accepted as well. It only ever resolves an existing game — creating
    one from an upload would let a token fill the library with typos.
    """
    if game_id is not None:
        return game_id, None
    name = (request.form.get('game') or '').strip()
    if not name:
        return None, None
    game = GameMetadata.query.filter(db.func.lower(GameMetadata.name) == name.lower()).first()
    if not game:
        return None, jsonify({
            'error': 'unknown_game',
            'message': f'No game named "{name}" exists in this library. Add it first, '
                       'or pass game_id.',
        })
    return game.id, None


def _unique_save_path(directory, filename, filetype):
    """A path under `directory` for `filename`, suffixed if something is there."""
    save_path = os.path.join(directory, filename)
    if os.path.exists(save_path):
        stem = '.'.join(filename.split('.')[:-1])
        uid = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
        save_path = os.path.join(directory, f"{stem}-{uid}.{filetype}")
    return save_path


def _media_type_for(filetype):
    if filetype in SUPPORTED_FILE_TYPES:
        return 'video'
    if filetype in SUPPORTED_IMAGE_TYPES:
        return 'image'
    return None


def _supported_types_message():
    supported = ', '.join(sorted(set(SUPPORTED_FILE_TYPES) | SUPPORTED_IMAGE_TYPES))
    return f'Unsupported file type. Supported: {supported}.'


def _prepare_upload(raw_filename, file_size):
    """Validate a token upload and work out where it belongs.

    Returns (plan, error_response). The plan carries everything both routes need
    after this point; the destination directory exists by the time it is handed
    back, because the chunked route writes its parts into it.
    """
    paths = current_app.config['PATHS']
    try:
        with open(paths['data'] / 'config.json', 'r') as configfile:
            config = json.load(configfile)
    except Exception:
        logger.error("Invalid or corrupt config file")
        return None, Response(status=500, response='Invalid or corrupt config file.')

    filename = secure_filename(raw_filename or '')
    if not filename:
        return None, Response(status=400, response='The uploaded file has no usable name.')
    filetype = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    media_type = _media_type_for(filetype)
    if not media_type:
        return None, Response(status=400, response=_supported_types_message())

    size_err = _check_upload_size(file_size)
    if size_err:
        return None, size_err

    tag_ids, game_id, title = _parse_upload_metadata()
    game_id, game_err = _resolve_game_id(game_id)
    if game_err:
        return None, (game_err, 400)

    # Same default as /api/upload and /api/upload/image: a token belongs to a real
    # account with the upload permission, so it files media where that account's
    # own uploads go, not into the public drop folder.
    upload_folder = config['app_config'].get('admin_upload_folder_name', 'uploads')
    requested_folder = sanitize_upload_folder(request.form.get('folder'))
    if requested_folder:
        upload_folder = requested_folder

    if media_type == 'image':
        image_directory = current_app.config.get('IMAGE_DIRECTORY')
        if not image_directory:
            return None, Response(status=503, response='IMAGE_DIRECTORY is not configured.')
        upload_directory = Path(image_directory) / upload_folder
    else:
        upload_directory = paths['video'] / upload_folder
    upload_directory.mkdir(parents=True, exist_ok=True)

    return {
        'config': config,
        'filename': filename,
        'filetype': filetype,
        'media_type': media_type,
        'upload_folder': upload_folder,
        'upload_directory': str(upload_directory),
        'tag_ids': tag_ids,
        'game_id': game_id,
        'title': title,
        # The chunked route sends this with every part, so the final one has it.
        'client_mtime': parse_client_mtime(request.form.get('lastModified')),
    }, None


def _finish_upload(plan, save_path, token_user):
    """Hand a fully written upload to the background scan and answer the caller."""
    if plan['media_type'] == 'image':
        _launch_scan_image(save_path, plan['config'], game_id=plan['game_id'],
                           tag_ids=plan['tag_ids'], title=plan['title'],
                           uploaded_by=token_user.id, client_mtime=plan['client_mtime'])
    else:
        duplicate = _reject_duplicate(save_path)
        if duplicate:
            return duplicate
        _launch_scan_video(save_path, plan['config'], plan['tag_ids'], plan['game_id'],
                           plan['title'], uploaded_by=token_user.id,
                           client_mtime=plan['client_mtime'])

    logger.info(
        f"Token upload: {plan['media_type']} '{os.path.basename(save_path)}' into "
        f"'{plan['upload_folder']}' as '{token_user.username}'"
    )
    return jsonify({
        'status': 'accepted',
        'media_type': plan['media_type'],
        'filename': os.path.basename(save_path),
        'folder': plan['upload_folder'],
    }), 201


@api.route('/api/upload/token', methods=['POST'])
@upload_token_required
def token_upload(token_user):
    """Upload one video or image as the token's owner, in a single request.

    multipart/form-data:
      file      the media (required); the extension decides video or image
      title     optional title for the item
      folder    optional destination folder under the media root
      game_id   optional Fireshare game id, or
      game      optional game name, resolved against existing games
      tag_ids   optional comma-separated tag ids
      lastModified  optional original modified time, ms since the epoch; the
                    item's date when the file carries none of its own
    """
    if 'file' not in request.files:
        return Response(status=400, response='A "file" part is required.')
    file = request.files['file']
    if not file.filename:
        return Response(status=400, response='The uploaded file has no name.')

    file.seek(0, 2)
    file_size = file.tell()
    file.seek(0)

    plan, error = _prepare_upload(file.filename, file_size)
    if error:
        return error

    save_path = _unique_save_path(plan['upload_directory'], plan['filename'], plan['filetype'])
    file.save(save_path)
    return _finish_upload(plan, save_path, token_user)


@api.route('/api/upload/token/chunked', methods=['POST'])
@upload_token_required
def token_upload_chunked(token_user):
    """Upload one video or image in chunks, for files too large to send at once.

    Send each chunk as its own request, in any order, with the same checkSum
    throughout. Every request but the last answers 202; the one that completes
    the set reassembles the file and answers 201 exactly as /api/upload/token
    does, including a 409 when the finished video is already in the library.

    multipart/form-data:
      blob         this chunk's bytes (required)
      chunkPart    1-based index of this chunk (required)
      totalChunks  how many chunks make up the file (required)
      checkSum     caller-chosen id grouping the chunks, [A-Za-z0-9_-] (required)
      fileName     the finished file's name; its extension picks video or image (required)
      fileSize     the finished file's size in bytes, verified after reassembly (required)
      title / folder / game_id / game / tag_ids / lastModified as for /api/upload/token
    """
    if 'blob' not in request.files:
        return Response(status=400, response='A "blob" part is required.')
    blob = request.files['blob']

    chunk_part, total_chunks, chunk_error = _parse_chunk_numbers()
    if chunk_error:
        return chunk_error
    file_size = _positive_int(request.form.get('fileSize'))
    if file_size is None:
        return Response(status=400, response='fileSize must be a positive integer.')

    check_sum = re.sub(r'[^a-zA-Z0-9_-]', '', request.form.get('checkSum') or '')
    if not check_sum:
        return Response(status=400, response='A checkSum grouping the chunks is required.')

    plan, error = _prepare_upload(request.form.get('fileName'), file_size)
    if error:
        return error
    upload_directory = plan['upload_directory']

    temp_path = os.path.join(upload_directory, f"{check_sum}.part{chunk_part:04d}")
    # The checkSum is already reduced to [A-Za-z0-9_-], so this cannot currently
    # escape; kept because it is the guarantee that matters, not the regex.
    if not os.path.realpath(temp_path).startswith(os.path.realpath(upload_directory) + os.sep):
        return Response(status=400)

    with open(temp_path, 'wb') as f:
        f.write(blob.read())

    chunk_paths = [os.path.join(upload_directory, f"{check_sum}.part{i:04d}")
                   for i in range(1, total_chunks + 1)]
    held = sum(1 for p in chunk_paths if os.path.exists(p))
    if held != total_chunks:
        # How many parts are really here, rather than a bare "not yet". A caller
        # that believes it has sent more than this has lost its set — the startup
        # sweep ran, or the media directory was cleared underneath it — and must
        # start the file over instead of sending its remaining chunks into a set
        # that can never complete. Without this number the upload sits at 202
        # forever with nothing to distinguish it from ordinary progress.
        return jsonify({
            'status': 'partial',
            'received': held,
            'total': total_chunks,
        }), 202

    # Reassemble under a staging name and rename into place. A crash partway
    # through the copy would otherwise leave a truncated file under a real media
    # extension, and the scheduled bulk-import picks such a file up within minutes
    # and ingests it as a genuine video. os.rename is atomic within a filesystem,
    # and the staging file sits in the destination directory precisely so that
    # holds.
    staging_path = os.path.join(upload_directory, f"{check_sum}.assembling")
    save_path = None
    try:
        with open(staging_path, 'wb') as output_file:
            for chunk_path in chunk_paths:
                with open(chunk_path, 'rb') as chunk_file:
                    shutil.copyfileobj(chunk_file, output_file)
                os.remove(chunk_path)

        if os.path.getsize(staging_path) != file_size:
            os.remove(staging_path)
            return Response(status=500, response='File size mismatch after reassembly.')

        # Claimed as late as possible, so the window in which a concurrent upload
        # could take the same name is as short as it can be made.
        save_path = _unique_save_path(upload_directory, plan['filename'], plan['filetype'])
        os.rename(staging_path, save_path)
    except Exception as e:
        logger.warning(f"Failed to reassemble token upload {check_sum}: {e}")
        leftovers = chunk_paths + [staging_path]
        if save_path:
            leftovers.append(save_path)
        for leftover in leftovers:
            try:
                if os.path.exists(leftover):
                    os.remove(leftover)
            except OSError:
                pass
        return Response(status=500, response='Error reassembling file.')

    return _finish_upload(plan, save_path, token_user)


# ---------------------------------------------------------------------------
# Token-authenticated discovery
# ---------------------------------------------------------------------------

def _list_subfolders(root):
    """Visible immediate subdirectories of a media root, sorted."""
    folders = []
    try:
        for entry in os.scandir(root):
            if entry.is_dir() and not entry.name.startswith('.'):
                folders.append(entry.name)
    except Exception:
        return []
    folders.sort()
    return folders


@api.route('/api/upload/token', methods=['GET'])
@upload_token_required
def token_upload_check(token_user):
    """Confirm a token works, and report what it may do, without uploading.

    Integrations need a way to validate their configuration that does not involve
    putting a file in somebody's library. Deliberately cheap — the folder and game
    listings live on /api/upload/token/options.
    """
    paths = current_app.config['PATHS']
    try:
        with open(paths['data'] / 'config.json', 'r') as configfile:
            config = json.load(configfile)
        default_folder = config['app_config'].get('admin_upload_folder_name', 'uploads')
    except Exception:
        default_folder = None

    return jsonify({
        'ok': True,
        'username': token_user.username,
        'default_folder': default_folder,
        'images_enabled': bool(current_app.config.get('IMAGE_DIRECTORY')),
        'supported_video_types': sorted(SUPPORTED_FILE_TYPES),
        'supported_image_types': sorted(SUPPORTED_IMAGE_TYPES),
    })


def _offerable_tags(user):
    """The tags an upload from this account may be offered, by name.

    /api/tags cannot serve an upload tool. It does not recognise upload tokens,
    so it answers them as it would an anonymous visitor: only tags already on a
    public video. A tag created a moment ago is on nothing yet, and it is
    exactly the one somebody setting up a folder has come to choose.

    So this keeps /api/tags' rule about who may see what, and changes only what
    it gets wrong for an uploader. An account that can view private media sees
    every tag, as it would in the browser. Any other account sees the tags that
    are on something public, plus the ones on nothing at all — an unused tag
    gives away nothing about private media. What stays hidden is only what
    /api/tags hides as well: a tag that appears solely on private media.
    """
    tags = CustomTag.query.order_by(CustomTag.name).all()
    if user.can(P.VIEW_PRIVATE):
        return tags

    public_videos = (
        db.session.query(VideoTagLink.tag_id)
        .join(Video, Video.video_id == VideoTagLink.video_id)
        .join(VideoInfo, VideoInfo.video_id == VideoTagLink.video_id)
        .filter(Video.available.is_(True), VideoInfo.private.is_(False))
    )
    public_images = (
        db.session.query(ImageTagLink.tag_id)
        .join(Image, Image.image_id == ImageTagLink.image_id)
        .join(ImageInfo, ImageInfo.image_id == ImageTagLink.image_id)
        .filter(Image.available.is_(True), ImageInfo.private.is_(False))
    )
    on_something_public = {tag_id for (tag_id,) in public_videos.union(public_images)}
    on_anything = {
        tag_id
        for (tag_id,) in db.session.query(VideoTagLink.tag_id).union(
            db.session.query(ImageTagLink.tag_id)
        )
    }
    return [t for t in tags if t.id in on_something_public or t.id not in on_anything]


@api.route('/api/upload/token/options', methods=['GET'])
@upload_token_required
def token_upload_options(token_user):
    """The folders, games and tags an upload may name, so a tool can offer real choices.

    Games are listed in full rather than through /api/games, which hides games
    with nothing linked to them yet: those are exactly the ones an upload might
    be the first to use, and `game` name resolution already accepts them. Tags
    are listed here for the same reason; see _offerable_tags for which.
    """
    paths = current_app.config['PATHS']
    try:
        with open(paths['data'] / 'config.json', 'r') as configfile:
            config = json.load(configfile)
        default_folder = config['app_config'].get('admin_upload_folder_name', 'uploads')
    except Exception:
        default_folder = None

    video_folders = _list_subfolders(paths['video'])
    image_directory = current_app.config.get('IMAGE_DIRECTORY')
    image_folders = _list_subfolders(image_directory) if image_directory else []

    # The default is offerable whether or not it has been created on disk yet.
    for folders in (video_folders, image_folders):
        if default_folder and default_folder not in folders:
            folders.append(default_folder)
            folders.sort()

    games = GameMetadata.query.order_by(GameMetadata.name).all()

    # Which folder each game's media lives in. Fireshare reads these the other
    # way round -- anything scanned in a folder is tagged with that folder's
    # game -- but a tool deciding where to *put* an upload needs the same
    # mapping, and filing a clip in the folder its game already owns is how it
    # ends up tagged without the tool having to ask for a tag at all. Rules
    # without a game are left out: they describe nothing a caller can act on.
    def rules_json(rules):
        return [
            {'folder': r.folder_path, 'game_id': r.game_id, 'game': r.game.name}
            for r in rules
            if r.game
        ]

    return jsonify({
        'default_folder': default_folder,
        'folders': {
            'video': video_folders,
            'image': image_folders,
        },
        'folder_rules': {
            'video': rules_json(FolderRule.query.all()),
            'image': rules_json(ImageFolderRule.query.all()),
        },
        'games': [
            {'id': g.id, 'name': g.name, 'steamgriddb_id': g.steamgriddb_id}
            for g in games
        ],
        'tags': [t.json() for t in _offerable_tags(token_user)],
    })


@api.route('/api/upload/token/exists', methods=['GET'])
@upload_token_required
def token_upload_exists(token_user):
    """Whether a file is already in the library, before anything is uploaded.

    Pass exactly one of `video_id` or `image_id`. Both are the same identity the
    rest of Fireshare uses: an xxh3_128 hexdigest of the first 16 MB of the file,
    as `util.video_id` and `util.image_id` compute it — so a tool that can hash
    its own file locally can ask first and skip the transfer entirely.

    That saving is worth more than it looks, and differs by media type:

    * For a video, the duplicate rejection on the upload routes only fires once
      the file is on disk, which for a chunked upload means the whole thing has
      crossed the network before the 409 comes back.
    * For an image there is no rejection at all. The upload is accepted and the
      scan quietly folds it into the existing row, so the client is never told —
      it simply pays for the transfer and sees a success.

    Either way, re-scanning a folder that was already uploaded should not mean
    re-sending it.
    """
    video_id = (request.args.get('video_id') or '').strip().lower()
    image_id = (request.args.get('image_id') or '').strip().lower()

    if bool(video_id) == bool(image_id):
        return jsonify({
            'error': 'bad_request',
            'message': 'Pass exactly one of video_id or image_id.',
        }), 400

    kind = 'video' if video_id else 'image'
    media_id = video_id or image_id
    if not re.fullmatch(r'[0-9a-f]{32}', media_id):
        return jsonify({
            'error': f'bad_{kind}_id',
            'message': f'{kind}_id must be a 32-character xxh3_128 hex digest.',
        }), 400

    if kind == 'video':
        existing = Video.query.filter_by(video_id=media_id).first()
        root = current_app.config['PATHS']['video']
        viewer = 'w'
    else:
        image_directory = current_app.config.get('IMAGE_DIRECTORY')
        if not image_directory:
            return jsonify({
                'error': 'images_disabled',
                'message': 'This instance is not configured for images.',
            }), 503
        existing = Image.query.filter_by(image_id=media_id).first()
        root = Path(image_directory)
        viewer = 'i'

    # A row whose own file is missing from disk does not count, exactly as in
    # _reject_duplicate: that upload is a restore, and the scan flips the row
    # back to available once it lands.
    if existing and not (root / existing.path).is_file():
        existing = None

    if not existing:
        return jsonify({'exists': False})

    title = existing.info.title if existing.info and existing.info.title else Path(existing.path).stem
    return jsonify({
        'exists': True,
        f'{kind}_id': media_id,
        'title': title,
        'url': f'/{viewer}/{media_id}',
    })
