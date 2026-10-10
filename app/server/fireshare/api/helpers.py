import json
import os
import re
import secrets
import shutil
import time
from functools import wraps
from pathlib import Path
from flask import current_app
from .. import db, logger
from ..models import TranscodeJob, Video


def secure_filename(filename):
    clean = re.sub(r"[/\\?%*:|\"<>\x7F\x00-\x1F\s]", "-", filename)
    return clean


# Path separators and control characters are never valid in a folder name. Spaces
# and punctuation are, because auto-sorted uploads are filed under the game's name
# ("Zenless Zone Zero"), and rejecting those would silently drop the upload back
# into the default folder.
_INVALID_FOLDER_CHARS = re.compile(r"[/\\\x00-\x1F\x7F]")


def sanitize_upload_folder(name):
    """Reduce a user-supplied upload folder to a safe single-level directory name.

    Returns the cleaned name, or None when nothing usable is left and the caller
    should fall back to the configured default folder.
    """
    folder = _INVALID_FOLDER_CHARS.sub('-', name or '').strip()
    # Leading dots would both escape the media root ("..") and hide the folder from
    # the upload folder listing, which skips dotfiles.
    folder = folder.lstrip('.').strip()
    return folder or None


def resolve_media_subfolder(root, folder):
    """Join a client-supplied folder onto a media root without letting it escape.

    The move endpoints accept nested folders, so the single-level
    sanitize_upload_folder() above is too strict for them; what has to hold is only
    that the result stays inside the root. Both ways out need closing: pathlib's `/`
    operator discards the root entirely when the right-hand side is absolute
    ("/etc"), and a relative "../" walks out of it just as effectively.

    The comparison is deliberately lexical. Resolving symlinks would also reject a
    folder the operator symlinked into their media directory, which is a supported
    way to lay a library out, and nothing reachable over the API can create a
    symlink inside the root for an attacker to aim at.

    Returns (absolute_path, folder_relative_to_root) with the folder normalised, or
    None when it escapes the root.
    """
    if folder is None:
        return None
    root_str = os.path.normpath(str(root))
    candidate = os.path.normpath(os.path.join(root_str, str(folder)))
    if candidate != root_str and not candidate.startswith(root_str + os.sep):
        return None
    relative = os.path.relpath(candidate, root_str)
    return Path(candidate), ('' if relative == '.' else Path(relative).as_posix())


def remove_derived_dir(derived_path, attempts=4, delay=0.25):
    """Remove a derived/<id> directory, tolerating jobs that are still writing into it.

    Poster generation and ffmpeg transcodes create files under derived/<id> while a
    delete is in flight, so a plain rmtree can lose the race between its final rmdir
    and a file created just after the directory was listed, failing with ENOTEMPTY.
    Retry a few times, then move the tree aside so the original path is freed either
    way. Anything left behind is reported by the orphaned-derived cleanup in the
    admin file manager.

    Returns None on success, or an error string when the directory could not be
    removed or moved aside.
    """
    if not derived_path.exists():
        return None

    last_error = None
    for attempt in range(attempts):
        try:
            shutil.rmtree(derived_path)
            return None
        except OSError as e:
            last_error = e
            if attempt < attempts - 1:
                time.sleep(delay)

    staged_path = derived_path.with_name(f"{derived_path.name}.deleting-{secrets.token_hex(4)}")
    try:
        derived_path.rename(staged_path)
    except OSError as e:
        return f"derived directory {derived_path}: {last_error or e}"

    shutil.rmtree(staged_path, ignore_errors=True)
    if staged_path.exists():
        logger.warning(
            f"Derived directory {derived_path} was still being written to ({last_error}); "
            f"moved it to {staged_path}, which can be removed via the orphaned derived cleanup"
        )
    return None


def delete_video_files(video_id, file_path, link_path, derived_path):
    """Remove every on-disk artifact for a video.

    Each target is deleted independently so that a failure on one - most often the
    derived directory, which background jobs may still be writing into - does not
    skip the others. Returns a list of error strings (empty when everything was
    removed).
    """
    errors = []

    try:
        if file_path.exists():
            file_path.unlink()
            logger.info(f"Deleted video file: {file_path}")
    except OSError as e:
        errors.append(f"video file {file_path}: {e}")

    try:
        if link_path.exists() or link_path.is_symlink():
            link_path.unlink()
            logger.info(f"Deleted link file: {link_path}")
    except OSError as e:
        errors.append(f"link file {link_path}: {e}")

    had_derived = derived_path.exists()
    derived_error = remove_derived_dir(derived_path)
    if derived_error:
        errors.append(derived_error)
    elif had_derived:
        logger.info(f"Deleted derived directory: {derived_path}")

    for error in errors:
        logger.error(f"Error deleting files for video {video_id}: {error}")
    return errors


def cancel_pending_transcode_jobs(video_id):
    """Drop any queued transcode job for a video that is being deleted.

    A job left in the queue would start ffmpeg for a video that no longer exists,
    recreating the derived directory we just removed. Left uncommitted so it lands
    with the caller's own delete transaction.
    """
    removed = TranscodeJob.query.filter(
        TranscodeJob.video_id == video_id,
        TranscodeJob.status == 'pending',
    ).delete(synchronize_session=False)
    if removed:
        logger.info(f"Clearing {removed} queued transcode job(s) for deleted video {video_id}")


def add_cache_headers(response, cache_key, max_age=604800):
    """Add cache headers for static assets (default: 7 days)."""
    response.headers['Cache-Control'] = f'public, max-age={max_age}, must-revalidate'
    response.headers['ETag'] = f'"{cache_key}"'
    return response


def add_poster_cache_headers(response, etag):
    """Add cache headers for poster images: always revalidate so custom/generated switches are picked up."""
    response.headers['Cache-Control'] = 'no-cache, must-revalidate'
    response.headers['ETag'] = f'"{etag}"'
    return response


def get_steamgriddb_api_key():
    """
    Get SteamGridDB API key from config.json first, then fall back to environment variable.
    """
    # First check config.json
    paths = current_app.config['PATHS']
    config_path = paths['data'] / 'config.json'
    if config_path.exists():
        try:
            with open(config_path, 'r') as configfile:
                config = json.load(configfile)
                api_key = config.get('integrations', {}).get('steamgriddb_api_key', '')
                if api_key:
                    return api_key
        except:
            pass

    # Fall back to environment variable
    return os.environ.get('STEAMGRIDDB_API_KEY', '')


def login_required_unless_public_game_tag(func):
    """
    Decorator that requires login unless public game tagging is enabled in config.
    """
    from flask_login import current_user

    @wraps(func)
    def decorated_view(*args, **kwargs):
        paths = current_app.config['PATHS']
        config_path = paths['data'] / 'config.json'
        allow_public = False
        if config_path.exists():
            try:
                with open(config_path, 'r') as configfile:
                    config = json.load(configfile)
                    allow_public = config.get('app_config', {}).get('allow_public_game_tag', False)
            except:
                pass
        if not current_user.is_authenticated and not allow_public:
            return current_app.login_manager.unauthorized()
        return func(*args, **kwargs)
    return decorated_view


def get_video_path(id, subid=None, quality=None):
    video = Video.query.filter_by(video_id=id).first()
    if not video:
        raise Exception(f"No video found for {id}")
    paths = current_app.config['PATHS']

    # The tone-mapped SDR copy stands in for the source the way a crop does. When it
    # is missing, the crop (if any) is the next best thing.
    if quality == 'sdr':
        sdr_path = paths["processed"] / "derived" / id / f"{id}-sdr.mp4"
        if sdr_path.exists():
            return str(sdr_path)
        logger.warning(f"Requested SDR version for video {id} not found, falling back")
        quality = 'cropped'

    # Handle cropped source quality
    if quality == 'cropped':
        cropped_path = paths["processed"] / "derived" / id / f"{id}-cropped.mp4"
        if cropped_path.exists():
            return str(cropped_path)
        # Fall back to original if crop file doesn't exist yet
        logger.warning(f"Requested cropped version for video {id} not found, falling back to original")

    # Handle quality variants (480p, 720p, 1080p)
    if quality and quality in ['480p', '720p', '1080p']:
        # Check if the transcoded version exists
        derived_path = paths["processed"] / "derived" / id / f"{id}-{quality}.mp4"
        if derived_path.exists():
            return str(derived_path)
        # Fall back to original if quality doesn't exist
        logger.warning(f"Requested quality {quality} for video {id} not found, falling back to original")

    subid_suffix = f"-{subid}" if subid else ""
    ext = ".mp4" if subid else video.extension
    video_path = paths["processed"] / "video_links" / f"{id}{subid_suffix}{ext}"
    return str(video_path)


def viewer_sees_private():
    """Whether the current requester may see private media in listings.

    This governs *discovery* — feeds, folder and tag listings, game pages, and
    profiles. Direct access by id is deliberately not gated on it: "private" in
    Fireshare means link-only, so anyone holding a share link can still open that
    one item. Without the view_private permission a signed-in account simply sees
    the same listings an anonymous visitor does.
    """
    from flask_login import current_user
    from .. import permissions as P

    return current_user.is_authenticated and current_user.can(P.VIEW_PRIVATE)
