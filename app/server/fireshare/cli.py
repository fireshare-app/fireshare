#!/usr/bin/env python3
import os
import json
import signal
import sys
import click
from datetime import datetime
from flask import current_app, request
from fireshare import create_app, db, util, logger, permissions
from fireshare.models import User, Video, VideoInfo, FolderRule, VideoGameLink, VideoTagLink, Image, ImageInfo, ImageGameLink, ImageTagLink, ImageFolderRule, MediaFolder
from werkzeug.security import generate_password_hash
from pathlib import Path
from sqlalchemy import func
from sqlalchemy.exc import InvalidRequestError
import time
import requests
import re

from .constants import SUPPORTED_FILE_EXTENSIONS

# Helper functions for persistent game suggestions storage
def _get_suggestions_file():
    """Get path to the suggestions JSON file"""
    from flask import current_app
    data_dir = Path(current_app.config.get('DATA_DIRECTORY', '/data'))
    return data_dir / 'game_suggestions.json'

def _load_suggestions():
    """Load suggestions from JSON file"""
    suggestions_file = _get_suggestions_file()
    if suggestions_file.exists():
        try:
            with open(suggestions_file, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return {}
    return {}

def _save_suggestions(suggestions):
    """Save suggestions to JSON file"""
    suggestions_file = _get_suggestions_file()
    suggestions_file.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(suggestions_file, 'w') as f:
            json.dump(suggestions, f)
    except IOError as e:
        logger.error(f"Failed to save game suggestions: {e}")

def get_game_suggestion(video_id):
    """Get a game suggestion for a video"""
    suggestions = _load_suggestions()
    return suggestions.get(video_id)

def save_game_suggestion(video_id, suggestion):
    """Save a game suggestion for a video"""
    suggestions = _load_suggestions()
    suggestions[video_id] = suggestion
    _save_suggestions(suggestions)

def save_game_suggestions_batch(new_suggestions):
    """Save multiple game suggestions at once"""
    if not new_suggestions:
        return
    suggestions = _load_suggestions()
    suggestions.update(new_suggestions)
    _save_suggestions(suggestions)

def delete_game_suggestion(video_id):
    """Delete a game suggestion for a video"""
    suggestions = _load_suggestions()
    if video_id in suggestions:
        del suggestions[video_id]
        _save_suggestions(suggestions)
        return True
    return False

# Helper functions for persistent corrupt video tracking
def _get_corrupt_videos_file():
    """Get path to the corrupt videos JSON file"""
    from flask import current_app
    data_dir = Path(current_app.config.get('DATA_DIRECTORY', '/data'))
    return data_dir / 'corrupt_videos.json'

def _load_corrupt_videos():
    """Load corrupt videos list from JSON file"""
    corrupt_file = _get_corrupt_videos_file()
    if corrupt_file.exists():
        try:
            with open(corrupt_file, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return []
    return []

def _save_corrupt_videos(corrupt_list):
    """Save corrupt videos list to JSON file"""
    corrupt_file = _get_corrupt_videos_file()
    corrupt_file.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(corrupt_file, 'w') as f:
            json.dump(corrupt_list, f)
    except IOError as e:
        logger.error(f"Failed to save corrupt videos list: {e}")

def is_video_corrupt(video_id):
    """Check if a video is marked as corrupt"""
    corrupt_list = _load_corrupt_videos()
    return video_id in corrupt_list

def mark_video_corrupt(video_id):
    """Mark a video as corrupt"""
    corrupt_list = _load_corrupt_videos()
    if video_id not in corrupt_list:
        corrupt_list.append(video_id)
        _save_corrupt_videos(corrupt_list)
        logger.info(f"Marked video {video_id} as corrupt")

def clear_video_corrupt(video_id):
    """Clear the corrupt status for a video"""
    corrupt_list = _load_corrupt_videos()
    if video_id in corrupt_list:
        corrupt_list.remove(video_id)
        _save_corrupt_videos(corrupt_list)
        logger.info(f"Cleared corrupt status for video {video_id}")
        return True
    return False

def get_all_corrupt_videos():
    """Get list of all corrupt video IDs"""
    return _load_corrupt_videos()

def clear_all_corrupt_videos():
    """Clear all corrupt video statuses"""
    count = len(_load_corrupt_videos())
    _save_corrupt_videos([])
    logger.info(f"Cleared corrupt status for {count} video(s)")
    return count

def send_discord_webhook(webhook_url=None, video_url=None):
    payload = {
        "content": video_url,
        "username": "Fireshare",
        "avatar_url": "https://github.com/fireshare-app/fireshare/raw/develop/app/client/src/assets/logo_square.png",
    }
    try:
        response = requests.post(webhook_url, json=payload)
        response.raise_for_status()
        print("Webhook sent successfully.")
        return {"status": "success", "message": "Webhook sent successfully."} 
    except requests.exceptions.RequestException as e:
        print(f"Failed to send webhook: {e}")
        return {"status": "error", "message": str(e)}

def send_generic_webhook(webhook_url, video_url=None, custom_payload=None):
    payload = custom_payload if custom_payload is not None else {}
    if not payload and video_url:
        payload["content"] = video_url
    try:
        response = requests.post(webhook_url, json=payload)     
        response.raise_for_status()
        return {"status": "success", "code": response.status_code}  
    except requests.exceptions.RequestException as e:
        return {"status": "error", "message": str(e)}

def get_public_watch_url(video_id, config, host):
    shareable_link_domain = config.get("ui_config", {}).get("shareable_link_domain", "")
    if shareable_link_domain:
        if not shareable_link_domain.startswith("https://") and not shareable_link_domain.startswith("http://"):
            shareable_link_domain = f"https://{shareable_link_domain}"
        return f"{shareable_link_domain}/w/{video_id}"
    elif host:
        if not host.startswith("https://") and not host.startswith("http://"):
            host = f"https://{host}"
        return f"{host}/w/{video_id}"
    else:
        return print("--Unable to post to Discord--\nPlease check that your DOMAIN env variable is set correctly or that you have a shareable link domain set in your Admin settings.")
    
def _get_or_create_media_folder(folder_cache, dirname, media_type):
    """Get or create a MediaFolder for (dirname, media_type), using folder_cache to avoid duplicate queries/inserts."""
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
        logger.info(f"Created MediaFolder '{dirname}' (media_type={media_type})")
    elif not folder.available:
        # A folder emptied by a previous scan is marked unavailable and never
        # revived elsewhere, which would hide it again as soon as new media lands in it.
        folder.available = True
        folder.updated_at = datetime.utcnow()
        db.session.flush()
        logger.info(f"Reactivated MediaFolder '{dirname}' (media_type={media_type})")
    folder_cache[key] = folder
    return folder


def _reconcile_media_folders(media_type, model, snapshot):
    """
    Reconcile MediaFolder records after a scan.

    snapshot: dict mapping row id -> previous folder_id (before this scan's reassignments)
    """
    folders = MediaFolder.query.filter_by(media_type=media_type).all()
    folders_by_id = {f.id: f for f in folders}

    for folder in folders:
        has_available_member = db.session.query(model.id).filter(
            model.folder_id == folder.id, model.available == True  # noqa: E712
        ).first() is not None
        if has_available_member:
            continue

        # Folder lost all available members. Determine where its previous members went.
        prev_member_ids = [rid for rid, prev_fid in snapshot.items() if prev_fid == folder.id]
        if not prev_member_ids:
            folder.available = False
            folder.updated_at = datetime.utcnow()
            continue

        new_folder_ids = set()
        for rid in prev_member_ids:
            row = model.query.get(rid)
            if row is None:
                continue
            if row.folder_id is not None and row.folder_id != folder.id:
                new_folder_ids.add(row.folder_id)

        if len(new_folder_ids) == 1:
            new_folder_id = next(iter(new_folder_ids))
            new_folder = folders_by_id.get(new_folder_id)
            if new_folder and new_folder.id != folder.id:
                # Re-point all rows currently pointing at the new folder to the old folder
                model.query.filter_by(folder_id=new_folder.id).update({"folder_id": folder.id})
                folder.path = new_folder.path
                folder.updated_at = datetime.utcnow()
                db.session.flush()
                db.session.delete(new_folder)
                folders_by_id.pop(new_folder_id, None)
                continue

        # Zero or multiple destination folders, or couldn't resolve - mark unavailable
        folder.available = False
        folder.updated_at = datetime.utcnow()


def _resolve_uploader(user_id):
    """Validate an --uploaded-by id against the user table.

    The value originates server-side from current_user.id, but this runs as its
    own process, so a stale or bogus id is checked rather than trusted: writing
    an unknown id would leave media pointing at an account that never existed.
    """
    if user_id is None:
        return None
    try:
        user_id = int(user_id)
    except (TypeError, ValueError):
        return None
    exists = db.session.query(User.id).filter(User.id == user_id).first()
    if not exists:
        logger.warning(f"Ignoring --uploaded-by={user_id}: no such user")
        return None
    return user_id


def _root_admin():
    """The account that adopts media a library scan finds on disk.

    A file that appeared in the media directory was put there by whoever runs
    the server, so it is attributed to the bootstrap administrator: the
    env-managed account, or on an install that predates that pin the lowest-id
    local administrator, mirroring how create_app identifies it. None when no
    administrator exists yet, in which case the media stays unowned and can be
    adopted later from File Manager -> Uploader.
    """
    admin = User.query.filter_by(env_managed=True).first()
    if not admin:
        admin = (User.query
                 .filter(User.admin.is_(True), User.password.isnot(None))
                 .order_by(User.id)
                 .first())
    return admin


@click.group()
def cli():
    pass

@cli.command()
def init_db():
    with create_app().app_context():
        db.create_all()
        logger.info(f"Created database file at {current_app.config['SQLALCHEMY_DATABASE_URI']}")

@cli.command()
@click.option("--username", "-u", help="Username", required=True)
@click.option("--password", "-p", help="Password", prompt=True, hide_input=True)
@click.option("--admin", is_flag=True, default=False, help="Create the account as an administrator.")
@click.option("--preset", type=click.Choice(sorted(permissions.PRESETS)), default='contributor',
              show_default=True, help="Permission preset for a non-admin account.")
@click.option("--permissions", "permission_keys", default=None,
              help="Comma-separated permission keys, overriding --preset. "
                   f"Available: {', '.join(permissions.GRANTABLE_PERMISSIONS)}")
def add_user(username, password, admin, preset, permission_keys):
    """Create a local user account.

    Accounts are non-admin by default. Prior to permissions being introduced this
    command created administrators, because User.admin defaulted to True.
    """
    with create_app().app_context():
        error = permissions.username_error(username)
        if error:
            click.echo(f"Error: {error}", err=True)
            raise SystemExit(1)
        username = permissions.normalize_username(username)

        error = permissions.password_error(password)
        if error:
            click.echo(f"Error: {error}", err=True)
            raise SystemExit(1)

        if User.query.filter(func.lower(User.username) == username.lower()).first():
            click.echo(f"Error: a user named {username} already exists.", err=True)
            raise SystemExit(1)

        if admin:
            granted = []
        elif permission_keys is not None:
            requested = [k.strip() for k in permission_keys.split(',') if k.strip()]
            granted = permissions.clean_permissions(requested)
            unknown = sorted(set(requested) - set(granted))
            if unknown:
                click.echo(f"Error: unknown permission(s): {', '.join(unknown)}", err=True)
                raise SystemExit(1)
        else:
            granted = list(permissions.PRESETS[preset])

        new_user = User(
            username=username,
            password=generate_password_hash(password, method='pbkdf2:sha256'),
            admin=admin,
            permissions=permissions.serialize_permissions(granted),
            created_at=datetime.utcnow(),
        )
        db.session.add(new_user)
        db.session.commit()
        summary = 'administrator' if admin else permissions.describe_permissions(False, granted)
        click.echo(f"Created user {username} ({summary})")


@cli.command()
def list_users():
    """List local and directory accounts with their access level."""
    with create_app().app_context():
        users = User.query.order_by(User.id).all()
        if not users:
            click.echo("No users found.")
            return
        width = max(len(u.username or '') for u in users)
        for u in users:
            flags = []
            if u.disabled:
                flags.append('disabled')
            if u.env_managed:
                flags.append('env-managed')
            if u.mfa_enabled:
                flags.append('mfa')
            if u.invite_token_hash:
                flags.append('invite pending')
            suffix = f"  [{', '.join(flags)}]" if flags else ''
            access = permissions.describe_permissions(u.admin, u.granted_permissions)
            click.echo(f"{(u.username or ''):<{width}}  {access}{suffix}")

@cli.command()
@click.option("--username", "-u", help="Username", required=True)
def disable_mfa(username):
    """Disable two-factor authentication for a user (lockout recovery)."""
    with create_app().app_context():
        user = User.query.filter_by(username=username).first()
        if not user:
            click.echo(f"No user found with username {username}")
            return
        user.totp_secret = None
        user.mfa_enabled = False
        user.totp_last_used = None
        db.session.commit()
        click.echo(f"Disabled two-factor authentication for {username}")

@cli.command()
@click.option("--root", "-r", help="root video path to scan", required=False)
def scan_videos(root):
    with create_app().app_context():
        paths = current_app.config['PATHS']
        domain = current_app.config['DOMAIN']
        videos_path = paths["video"]
        video_links = paths["processed"] / "video_links"

        config_file = open(paths["data"] / "config.json")
        config = json.load(config_file)
        video_config = config["app_config"]["video_defaults"]
        discord_webhook_url = config["integrations"]["discord_webhook_url"]
        generic_webhook_url = config["integrations"]["generic_webhook_url"]
        generic_webhook_payload = config["integrations"]["generic_webhook_payload"]
        config_file.close()
        
        if not video_links.is_dir():
            video_links.mkdir()

        logger.info(f"Scanning {str(videos_path)} for {', '.join(SUPPORTED_FILE_EXTENSIONS)} video files")
        CHUNK_FILE_PATTERN = re.compile(r'\.part\d{4}$')
        TRANSCODE_PATTERN = re.compile(r'-(?:720p|1080p)\.mp4$', re.IGNORECASE)
        
        # Collect all video files and filter out transcoded versions
        all_files = [f for f in (videos_path / root if root else videos_path).glob('**/*') 
                     if f.is_file() and f.suffix.lower() in SUPPORTED_FILE_EXTENSIONS]
        
        video_files = []
        skipped_count = 0
        for f in all_files:
            if CHUNK_FILE_PATTERN.search(f.name):
                continue  # Skip chunk files silently
            elif f.name.startswith('._'):
                continue  # Skip macOS sidecar files silently
            elif TRANSCODE_PATTERN.search(f.name):
                logger.debug(f"Skipping transcoded file: {f.name}")
                skipped_count += 1
            else:
                video_files.append(f)
        
        if skipped_count > 0:
            logger.info(f"Skipped {skipped_count} transcoded video file(s)")
        
        video_rows = Video.query.all()
        owner = _root_admin()

        # Snapshot existing folder assignments before reassigning, for reconciliation
        folder_snapshot = {vr.id: vr.folder_id for vr in video_rows}
        folder_cache = {}

        new_videos = []
        for vf in video_files:
            path = str(vf.relative_to(videos_path))
            video_id = util.video_id(vf)
            dirname = os.path.dirname(path)
            top_level = dirname.split(os.sep)[0] if dirname else None
            existing = next((vr for vr in video_rows if vr.video_id == video_id), None)
            duplicate = next((dvr for dvr in new_videos if dvr.video_id == video_id), None)
            if duplicate:
                logger.debug(f"Found duplicate video {video_id} as {str(path)}, skipping...")
            elif existing:
                if path == existing.path:
                    folder = _get_or_create_media_folder(folder_cache, top_level, "video") if top_level else None
                    folder_id = folder.id if folder else None
                    if existing.folder_id != folder_id:
                        db.session.query(Video).filter_by(video_id=existing.video_id).update({ "folder_id": folder_id })
                if not existing.available:
                    logger.debug(f"Updating Video {video_id}, available=True")
                    db.session.query(Video).filter_by(video_id=existing.video_id).update({ "available": True })
                if not existing.created_at:
                    created_at = datetime.fromtimestamp(os.path.getmtime(f"{videos_path}/{path}"))
                    logger.debug(f"Updating Video {video_id}, created_at={created_at}")
                    db.session.query(Video).filter_by(video_id=existing.video_id).update({ "created_at": created_at })
                if not existing.updated_at:
                    updated_at = datetime.fromtimestamp(os.path.getmtime(f"{videos_path}/{path}"))
                    logger.debug(f"Updating Video {video_id}, updated_at={updated_at}")
                    db.session.query(Video).filter_by(video_id=existing.video_id).update({ "updated_at": updated_at })
            else:
                folder = _get_or_create_media_folder(folder_cache, top_level, "video") if top_level else None
                created_at = datetime.fromtimestamp(os.path.getmtime(f"{videos_path}/{path}"))
                updated_at = datetime.fromtimestamp(os.path.getmtime(f"{videos_path}/{path}"))
                recorded_at = util.extract_date_from_file(vf)
                v = Video(video_id=video_id, extension=vf.suffix, path=path, available=True, created_at=created_at, updated_at=updated_at, recorded_at=recorded_at, folder_id=folder.id if folder else None, uploaded_by=owner.id if owner else None)
                logger.info(f"Adding new Video {video_id} at {str(path)} (created {created_at.isoformat()}, updated {updated_at.isoformat()}, recorded {recorded_at.isoformat() if recorded_at else 'N/A'})")
                new_videos.append(v)

        if new_videos:
            db.session.add_all(new_videos)
            if owner:
                logger.info(f"Attributed {len(new_videos)} newly indexed video(s) to '{owner.username}'")
        else:
            logger.info(f"No new videos found, checked {len(video_files)} files.")
        db.session.commit()

        fd = os.open(str(video_links.absolute()), os.O_DIRECTORY)
        for nv in new_videos:
            src = Path((paths["video"] / nv.path).absolute())
            dst = Path(paths["processed"] / "video_links" / (nv.video_id + nv.extension))
            common_root = Path(*os.path.commonprefix([src.parts, dst.parts]))
            num_up = len(dst.parts)-1 - len(common_root.parts)
            prefix = "../" * num_up
            rel_src = Path(prefix + str(src).replace(str(common_root), ''))
            if not dst.exists():
                logger.debug(f"Linking {str(rel_src)} --> {str(dst)}")
                try:
                    os.symlink(src, dst, dir_fd=fd)
                except FileExistsError:
                    logger.info(f"{dst} exists already")
            info = VideoInfo(video_id=nv.video_id, title=Path(nv.path).stem, private=video_config["private"])
            db.session.add(info)
        db.session.commit()

        # Generate metadata and posters for new videos, then fire webhooks
        thumbnail_skip = current_app.config['THUMBNAIL_VIDEO_LOCATION'] or 0
        if thumbnail_skip > 0 and thumbnail_skip <= 100:
            thumbnail_skip = thumbnail_skip / 100
        else:
            thumbnail_skip = 0
        processed_root = Path(current_app.config['PROCESSED_DIRECTORY'])
        for nv in new_videos:
            video_link_path = video_links / (nv.video_id + nv.extension)
            if not video_link_path.exists():
                continue
            nv_info = VideoInfo.query.filter_by(video_id=nv.video_id).first()
            if nv_info and not nv_info.duration:
                media_info = util.get_media_info(video_link_path)
                if media_info:
                    video_codecs = [s for s in media_info if s.get('codec_type') == 'video']
                    if video_codecs:
                        vc = video_codecs[0]
                        nv_info.width = int(vc.get('width', 0)) or None
                        nv_info.height = int(vc.get('height', 0)) or None
                        duration = 0
                        if 'duration' in vc:
                            duration = float(vc['duration'])
                        elif 'tags' in vc and 'DURATION' in vc['tags']:
                            duration = util.dur_string_to_seconds(vc['tags']['DURATION'])
                        nv_info.duration = duration or None
                        db.session.commit()
            derived_path = processed_root / "derived" / nv.video_id
            poster_path = derived_path / "poster.jpg"
            if not poster_path.exists():
                if not derived_path.exists():
                    derived_path.mkdir(parents=True)
                duration = nv_info.duration if nv_info else 0
                poster_time = int((duration or 0) * thumbnail_skip)
                util.create_poster(video_link_path, poster_path, poster_time)
            poster_ready = poster_path.exists() and poster_path.stat().st_size > 0
            if not poster_ready:
                logger.warning(f"Skipping webhook for {nv.video_id}: poster not ready")
                continue
            video_url = get_public_watch_url(nv.video_id, config, domain)
            if discord_webhook_url:
                logger.info(f"Posting to Discord webhook for {nv.video_id}")
                send_discord_webhook(webhook_url=discord_webhook_url, video_url=video_url)
            if generic_webhook_url:
                logger.info(f"Posting to Generic webhook for {nv.video_id}")
                payload_str = json.dumps(generic_webhook_payload)
                processed_payload_str = payload_str.replace("[[video_url]]", video_url or "")
                final_payload = json.loads(processed_payload_str)
                send_generic_webhook(
                    webhook_url=generic_webhook_url,
                    video_url=video_url,
                    custom_payload=final_payload
                )


        # Auto-tag new videos based on folder rules
        auto_tagged = set()
        if new_videos:
            folder_rules = {rule.folder_path: rule.game_id for rule in FolderRule.query.all()}
            if folder_rules:
                logger.info(f"Checking {len(new_videos)} new video(s) against {len(folder_rules)} folder rule(s)")
            for nv in new_videos:
                parts = nv.path.split('/')
                if len(parts) > 1:
                    folder = parts[0]
                    if folder in folder_rules:
                        game_id = folder_rules[folder]
                        existing = VideoGameLink.query.filter_by(video_id=nv.video_id, game_id=game_id).first()
                        if not existing:
                            link = VideoGameLink(video_id=nv.video_id, game_id=game_id, created_at=datetime.utcnow())
                            db.session.add(link)
                        auto_tagged.add(nv.video_id)
                        logger.info(f"[Folder Rule] Auto-tagged {nv.video_id} to game {game_id} (folder: {folder})")
            if auto_tagged:
                db.session.commit()
                logger.info(f"Auto-tagged {len(auto_tagged)} video(s) via folder rules")

        # Automatic game detection for new videos (skip already tagged)
        steamgriddb_api_key = config.get("integrations", {}).get("steamgriddb_api_key")
        if new_videos:
            videos_needing_detection = [nv for nv in new_videos if nv.video_id not in auto_tagged]
            logger.info(f"Running game detection for {len(videos_needing_detection)} new video(s)...")
            pending_suggestions = {}
            for nv in videos_needing_detection:
                filename = Path(nv.path).stem
                logger.debug(f"[Game Detection] Video: {nv.video_id}, Path: {nv.path}, Filename: {filename}")
                detected_game = util.detect_game_from_filename(filename, steamgriddb_api_key, path=nv.path)

                if detected_game:
                    logger.debug(f"[Game Detection] Result: {detected_game['game_name']} (confidence: {detected_game['confidence']:.2f}, source: {detected_game['source']})")
                    if detected_game['confidence'] >= 0.65:
                        pending_suggestions[nv.video_id] = detected_game
                        logger.debug(f"[Game Detection] Queued suggestion for {nv.video_id}")
                    else:
                        logger.debug(f"[Game Detection] Confidence too low, skipping suggestion")
                else:
                    logger.debug(f"[Game Detection] No match found for {nv.video_id}")
            # Batch save all suggestions at once
            if pending_suggestions:
                save_game_suggestions_batch(pending_suggestions)
                logger.info(f"[Game Detection] Saved {len(pending_suggestions)} suggestion(s) in batch")

        existing_videos = Video.query.filter_by(available=True).all()
        logger.debug(f"Verifying {len(existing_videos):,} video files still exist...")
        for ev in existing_videos:
            file_path = Path((paths["video"] / ev.path).absolute())
            logger.debug(f"Verifying video {ev.video_id} at {file_path} is available")
            if not file_path.exists():
                logger.warning(f"Video {ev.video_id} at {file_path} was not found")
                db.session.query(Video).filter_by(video_id=ev.video_id).update({ "available": False})
        db.session.commit()

        # Reconcile MediaFolder records (handle renamed/moved/removed folders)
        _reconcile_media_folders("video", Video, folder_snapshot)
        db.session.commit()

@cli.command()
@click.pass_context
@click.option("--path", "-p", help="path to video to scan", required=False)
@click.option("--tag-ids", help="comma-separated custom tag IDs to apply", required=False, default=None)
@click.option("--game-id", type=int, help="game ID to apply", required=False, default=None)
@click.option("--title", help="initial title for the video (defaults to filename stem)", required=False, default=None)
@click.option("--uploaded-by", type=int, help="id of the user who uploaded this video", required=False, default=None)
def scan_video(ctx, path, tag_ids, game_id, title, uploaded_by):
    with create_app().app_context():
        paths = current_app.config['PATHS']
        domain = current_app.config['DOMAIN']
        videos_path = paths["video"]
        video_links = paths["processed"] / "video_links"
        thumbnail_skip = current_app.config['THUMBNAIL_VIDEO_LOCATION'] or 0
        if thumbnail_skip > 0 and thumbnail_skip <= 100:
            thumbnail_skip = thumbnail_skip / 100
        else:
            thumbnail_skip = 0
        
        config_file = open(paths["data"] / "config.json")
        config = json.load(config_file)
        video_config = config["app_config"]["video_defaults"]
        discord_webhook_url = config["integrations"]["discord_webhook_url"]
        generic_webhook_url = config["integrations"]["generic_webhook_url"]
        generic_webhook_payload = config["integrations"]["generic_webhook_payload"]

        config_file.close()
        
        if not video_links.is_dir():
            video_links.mkdir()
        
        CHUNK_FILE_PATTERN = re.compile(r'\.part\d{4}$')
        TRANSCODE_PATTERN = re.compile(r'-(?:720p|1080p)\.mp4$', re.IGNORECASE)
        
        # Check if the file is a transcoded version and skip it
        if (videos_path / path).is_file() and TRANSCODE_PATTERN.search((videos_path / path).name):
            logger.warning(f"Skipping transcoded file: {path}. Transcoded files should not be scanned.")
            return
        
        video_file = ((videos_path / path) if (videos_path / path).is_file()
                     and (videos_path / path).suffix.lower() in SUPPORTED_FILE_EXTENSIONS
                     and not CHUNK_FILE_PATTERN.search((videos_path / path).name)
                     and not TRANSCODE_PATTERN.search((videos_path / path).name)
                     and not (videos_path / path).name.startswith('._') else None)
        if video_file:
            video_rows = Video.query.all()
            logger.info(f"Scanning {str(video_file)}")

            path = str(video_file.relative_to(videos_path)) 
            video_id = util.video_id(video_file)
            existing = next((vr for vr in video_rows if vr.video_id == video_id), None)
            if existing:
                if not existing.available:
                    logger.debug(f"Updating Video {video_id}, available=True")
                    db.session.query(Video).filter_by(video_id=existing.video_id).update({ "available": True })
                if not existing.created_at:
                    created_at = datetime.fromtimestamp(os.path.getmtime(f"{videos_path}/{path}"))
                    logger.debug(f"Updating Video {video_id}, created_at={created_at}")
                    db.session.query(Video).filter_by(video_id=existing.video_id).update({ "created_at": created_at })
                if not existing.updated_at:
                    updated_at = datetime.fromtimestamp(os.path.getmtime(f"{videos_path}/{path}"))
                    logger.debug(f"Updating Video {video_id}, updated_at={updated_at}")
                    db.session.query(Video).filter_by(video_id=existing.video_id).update({ "updated_at": updated_at })
                db.session.commit()
            else:
                created_at = datetime.fromtimestamp(os.path.getmtime(f"{videos_path}/{path}"))
                updated_at = datetime.fromtimestamp(os.path.getmtime(f"{videos_path}/{path}"))
                recorded_at = util.extract_date_from_file(video_file)
                # Assign the containing folder the same way scan_videos does, so an
                # upload sorted into a game folder shows up under that folder right
                # away instead of waiting for the next full scan.
                dirname = os.path.dirname(path)
                top_level = dirname.split(os.sep)[0] if dirname else None
                folder = _get_or_create_media_folder({}, top_level, "video") if top_level else None
                v = Video(video_id=video_id, extension=video_file.suffix, path=path, available=True, created_at=created_at, updated_at=updated_at, recorded_at=recorded_at, folder_id=folder.id if folder else None, uploaded_by=_resolve_uploader(uploaded_by))
                logger.info(f"Adding new Video {video_id} at {str(path)} (created {created_at.isoformat()}, updated {updated_at.isoformat()}, recorded {recorded_at.isoformat() if recorded_at else 'N/A'})")
                db.session.add(v)
                fd = os.open(str(video_links.absolute()), os.O_DIRECTORY)
                src = Path((paths["video"] / v.path).absolute())
                dst = Path(paths["processed"] / "video_links" / (video_id + video_file.suffix))
                common_root = Path(*os.path.commonprefix([src.parts, dst.parts]))
                num_up = len(dst.parts)-1 - len(common_root.parts)
                prefix = "../" * num_up
                rel_src = Path(prefix + str(src).replace(str(common_root), ''))
                if not dst.exists():
                    logger.debug(f"Linking {str(rel_src)} --> {str(dst)}")
                    try:
                        os.symlink(src, dst, dir_fd=fd)
                    except FileExistsError:
                        logger.debug(f"{dst} exists already")
                info = VideoInfo(video_id=v.video_id, title=title or Path(v.path).stem, private=video_config["private"])
                db.session.add(info)
                db.session.commit()

                # Apply pre-upload metadata (tags and game) passed from the upload endpoint
                if tag_ids:
                    for tid in [int(t) for t in tag_ids.split(',') if t.strip().isdigit()]:
                        if not VideoTagLink.query.filter_by(video_id=v.video_id, tag_id=tid).first():
                            db.session.add(VideoTagLink(video_id=v.video_id, tag_id=tid, created_at=datetime.utcnow()))
                    db.session.commit()
                if game_id and not VideoGameLink.query.filter_by(video_id=v.video_id).first():
                    db.session.add(VideoGameLink(video_id=v.video_id, game_id=game_id, created_at=datetime.utcnow()))
                    db.session.commit()

                # Check folder rules for auto-tagging
                auto_tagged = False
                parts = v.path.split('/')
                if len(parts) > 1:
                    folder = parts[0]
                    folder_rule = FolderRule.query.filter_by(folder_path=folder).first()
                    if folder_rule:
                        existing = VideoGameLink.query.filter_by(video_id=v.video_id, game_id=folder_rule.game_id).first()
                        if not existing:
                            link = VideoGameLink(video_id=v.video_id, game_id=folder_rule.game_id, created_at=datetime.utcnow())
                            db.session.add(link)
                            db.session.commit()
                        auto_tagged = True
                        logger.info(f"[Folder Rule] Auto-tagged {v.video_id} to game {folder_rule.game_id} (folder: {folder})")

                # Automatic game detection (skip if already auto-tagged)
                if not auto_tagged:
                    logger.debug("Attempting automatic game detection...")
                    steamgriddb_api_key = config.get("integrations", {}).get("steamgriddb_api_key")
                    filename = Path(v.path).stem
                    detected_game = util.detect_game_from_filename(filename, steamgriddb_api_key, path=v.path)

                    if detected_game and detected_game['confidence'] >= 0.65:
                        save_game_suggestion(v.video_id, detected_game)
                        logger.info(f"Created game suggestion for video {v.video_id}: {detected_game['game_name']} (confidence: {detected_game['confidence']:.2f}, source: {detected_game['source']})")
                    else:
                        logger.debug(f"No confident game match found for video {v.video_id}")

                logger.debug("Syncing metadata")
                ctx.invoke(sync_metadata, video=video_id)
                info = VideoInfo.query.filter(VideoInfo.video_id==video_id).one()

                processed_root = Path(current_app.config['PROCESSED_DIRECTORY'])
                logger.debug(f"Checking for videos with missing posters...")
                derived_path = Path(processed_root, "derived", info.video_id)
                video_path = Path(processed_root, "video_links", info.video_id + video_file.suffix)
                if video_path.exists():
                    
                    poster_path = Path(derived_path, "poster.jpg")
                    should_create_poster = not poster_path.exists()
                    if should_create_poster:
                        if not derived_path.exists():
                            derived_path.mkdir(parents=True)
                        poster_time = int((info.duration or 0) * thumbnail_skip)
                        poster_ok = util.create_poster(video_path, derived_path / "poster.jpg", poster_time)
                        if not poster_ok:
                            logger.warning(f"Could not generate poster for video {info.video_id}")
                    else:
                        logger.debug(f"Skipping creation of poster for video {info.video_id} because it exists at {str(poster_path)}")
                    db.session.commit()

                    if tag_ids:
                        boomerang_path = derived_path / "boomerang-preview.mp4"
                        if not boomerang_path.exists():
                            util.create_boomerang_preview(video_path, boomerang_path)

                    poster_ready = poster_path.exists() and poster_path.stat().st_size > 0
                    if discord_webhook_url and poster_ready:
                        logger.info(f"Posting to Discord webhook")
                        video_url = get_public_watch_url(video_id, config, domain)
                        send_discord_webhook(webhook_url=discord_webhook_url, video_url=video_url)
                    elif discord_webhook_url and not poster_ready:
                        logger.warning(f"Skipping Discord webhook for {video_id}: poster not ready")

                    if generic_webhook_url and poster_ready:
                        logger.info(f"Posting to Generic webhook")
                        video_url = get_public_watch_url(video_id, config, domain)
                        payload_str = json.dumps(generic_webhook_payload)
                        #Replaces plain text json [[video_url]] with the real video_url python var
                        processed_payload_str = payload_str.replace("[[video_url]]", video_url or "")
                        final_payload = json.loads(processed_payload_str)
                        send_generic_webhook(
                            webhook_url=generic_webhook_url,
                            video_url=video_url,
                            custom_payload=final_payload
                        )

                    if current_app.config.get('ENABLE_TRANSCODING'):
                        auto_transcode = config.get('transcoding', {}).get('auto_transcode', True)
                        if auto_transcode:
                            logger.info(f"Auto-transcoding uploaded video {video_id}")
                            ctx.invoke(transcode_videos, video=video_id)
                else:
                    logger.warning(f"Skipping creation of poster for video {info.video_id} because the video at {str(video_path)} does not exist or is not accessible")
        else:
            logger.info(f"Invalid video file, unable to scan: {str(videos_path / path)}")

@cli.command()
def repair_symlinks():
    with create_app().app_context():
        paths = current_app.config['PATHS']
        video_links = paths["processed"] / "video_links"

        if not video_links.is_dir():
            video_links.mkdir()

        fd = os.open(str(video_links.absolute()), os.O_DIRECTORY)
        all_videos = Video.query.all()
        for nv in all_videos:
            src = Path((paths["video"] / nv.path).absolute())
            dst = Path(paths["processed"] / "video_links" / (nv.video_id + nv.extension))
            common_root = Path(*os.path.commonprefix([src.parts, dst.parts]))
            num_up = len(dst.parts)-1 - len(common_root.parts)
            prefix = "../" * num_up
            rel_src = Path(prefix + str(src).replace(str(common_root), ''))
            if not dst.exists():
                logger.debug(f"Linking {str(rel_src)} --> {str(dst)}")
                try:
                    os.symlink(src, dst, dir_fd=fd)
                except FileExistsError:
                    logger.info(f"{dst} exists already")

@cli.command()
@click.option("--video", "-v", help="The video to sync metadata from", default=None)
def sync_metadata(video):
    with create_app().app_context():
        paths = current_app.config['PATHS']
        videos = VideoInfo.query.filter(VideoInfo.video_id==video).all() if video else VideoInfo.query.filter(VideoInfo.info==None).all()
        logger.info(f'Found {len(videos):,} videos without metadata')
        for v in videos:
            vpath = paths["processed"] / "video_links" / str(v.video_id + v.video.extension)
            if Path(vpath).is_file():
                info = None
                while info == None:
                    info = util.get_media_info(vpath)
                    if info == None:
                        corruptVideoWarning = "There may be a corrupt video in your video Directory. See your logs for more info!"
                        if not corruptVideoWarning in current_app.config['WARNINGS']:
                            current_app.config['WARNINGS'].append(corruptVideoWarning)
                        logger.warning(f"[{v.video.path}] - There may be a corrupt file in your video directory. Or, you may be recording to the video directory and haven't finished yet.")
                        logger.warning(f"For more info and to find the offending file, run this command in your container: \"stat {vpath}\"")
                        logger.warning("I'll try to process this file again in 60 seconds...")
                        time.sleep(60)
                
                corruptVideoWarning = "There may be a corrupt video in your video Directory. See your logs for more info!"
                if corruptVideoWarning in current_app.config['WARNINGS']:
                    position = current_app.config['WARNINGS'].index(corruptVideoWarning)
                    current_app.config['WARNINGS'].pop(position)

                video_codecs = [i for i in info if i['codec_type'] == 'video']
                if not video_codecs:
                    logger.warning(f"No video stream found in {v.video.path} (video_id={v.video_id}). Skipping metadata sync.")
                    mark_video_corrupt(v.video_id)
                    continue
                vcodec = video_codecs[0]
                duration = 0
                if 'duration' in vcodec:
                    duration = float(vcodec['duration'])
                elif 'tags' in vcodec:
                    if 'DURATION' in vcodec['tags']:
                        duration = util.dur_string_to_seconds(vcodec['tags']['DURATION'])
                    else:
                        duration = 0
                width, height = int(vcodec['width']), int(vcodec['height'])
                logger.debug(f'Scanned {v.video_id} duration={duration}s, resolution={width}x{height}: {v.video.path}')
                v.info = json.dumps(info)
                v.duration = duration
                v.width = width
                v.height = height
                v.is_hdr = util.is_hdr_stream(vcodec)
                db.session.add(v)
                db.session.commit()
            else:
                logger.warning(f"Missing or invalid symlink at {vpath} to video {v.video_id} (original location: {v.video.path})")

@cli.command()
@click.option("--all", "all_videos", is_flag=True, help="Re-check every video, not only those never checked")
def detect_hdr(all_videos):
    """Flag HDR videos from the colour tags sync-metadata already stored."""
    with create_app().app_context():
        query = VideoInfo.query.filter(VideoInfo.info != None)
        if not all_videos:
            query = query.filter(VideoInfo.is_hdr == None)
        videos = query.all()
        flagged = 0
        for v in videos:
            try:
                v.is_hdr = util.is_hdr_stream(v.vcodec)
            except (IndexError, TypeError, ValueError):
                v.is_hdr = False
            flagged += 1 if v.is_hdr else 0
        if videos:
            db.session.commit()
            logger.info(f"Checked {len(videos):,} video(s) for HDR, {flagged:,} flagged")

@cli.command()
def create_web_videos():
    with create_app().app_context():
        paths = current_app.config['PATHS']
        video_links = paths["processed"] / "video_links"
        videos = Video.query.filter(func.lower(Video.extension)=='.mkv').all()
        fd = os.open(str(video_links.absolute()), os.O_DIRECTORY)
        for v in videos:
            vpath = paths["processed"] / "video_links" / str(v.video_id + v.extension)
            if Path(vpath).is_file():
                logger.info(f"Found mkv video to process {v.video_id}: {v.path}")
                out_mp4_fn = paths["processed"] / "derived" / v.video_id / f"{v.video_id}-1.mp4"
                if not out_mp4_fn.exists():
                    # TODO check video codec and if it's h264 already, just do a simple ffmpeg -i input.mkv -c copy output.mp4
                    # Otherwise, transcode it
                    util.transcode_video(vpath, out_mp4_fn)

                    dst = Path(paths["processed"] / "video_links" / f"{v.video_id}-1.mp4")
                    common_root = Path(*os.path.commonprefix([out_mp4_fn.parts, dst.parts]))
                    num_up = len(dst.parts)-1 - len(common_root.parts)
                    prefix = "../" * num_up
                    rel_src = Path(prefix + str(out_mp4_fn).replace(str(common_root), ''))
                    if not dst.exists():
                        logger.debug(f"Linking {str(rel_src)} --> {str(dst)}")
                        try:
                            os.symlink(out_mp4_fn, dst, dir_fd=fd)
                        except FileExistsError:
                            logger.debug(f"{dst} exists already")
                else:
                    logger.debug(f"Skipping {v.video_id} because {str(out_mp4_fn)} already exists")

            else:
                logger.warning(f"Missing or invalid symlink at {vpath} to video {v.video_id} (original location: {v.video.path})")
        

@cli.command()
@click.option("--regenerate", "-r", help="Overwrite existing posters", is_flag=True)
@click.option("--skip", "-s", help="Amount to skip into the video before extracting a poster image, as a %, e.g. 0.05 for 5%", type=float, default=0)
def create_posters(regenerate, skip):
    with create_app().app_context():
        processed_root = Path(current_app.config['PROCESSED_DIRECTORY'])
        vinfos = VideoInfo.query.all()
        logger.debug(f"Checking for videos with missing posters...")
        for vi in vinfos:
            derived_path = Path(processed_root, "derived", vi.video_id)
            video_path = Path(processed_root, "video_links", vi.video_id + vi.video.extension)
            if not video_path.exists():
                logger.warning(f"Skipping creation of poster for video {vi.video_id} because the video at {str(video_path)} does not exist or is not accessible")
                continue
            poster_path = Path(derived_path, "poster.jpg")
            should_create_poster = (not poster_path.exists() or regenerate)
            if should_create_poster:
                if not derived_path.exists():
                    derived_path.mkdir(parents=True)
                poster_time = int((vi.duration or 0) * skip)
                util.create_poster(video_path, derived_path / "poster.jpg", poster_time)
            else:
                logger.debug(f"Skipping creation of poster for video {vi.video_id} because it exists at {str(poster_path)}")

@cli.command()
@click.option("--regenerate", "-r", help="Overwrite existing posters", is_flag=True)
def create_boomerang_posters(regenerate):
    with create_app().app_context():
        processed_root = Path(current_app.config['PROCESSED_DIRECTORY'])
        vinfos = (
            VideoInfo.query
            .join(VideoTagLink, VideoTagLink.video_id == VideoInfo.video_id)
            .distinct()
            .all()
        )
        for vi in vinfos:
            derived_path = Path(processed_root, "derived", vi.video_id)
            video_path = Path(processed_root, "video_links", vi.video_id + vi.video.extension)
            if not video_path.exists():
                logger.info(f"Skipping creation of boomerang poster for video {vi.video_id} because the video at {str(video_path)} does not exist or is not accessible")
                continue
            poster_path = Path(derived_path, "boomerang-preview.mp4")
            should_create_poster = (not poster_path.exists() or regenerate)
            if should_create_poster:
                if not derived_path.exists():
                    derived_path.mkdir(parents=True)
                util.create_boomerang_preview(video_path, poster_path)
            else:
                logger.debug(f"Skipping creation of boomerang poster for video {vi.video_id} because it already exists")

@cli.command()
@click.option("--regenerate", "-r", help="Overwrite existing transcoded videos", is_flag=True)
@click.option("--video", "-v", help="Transcode a specific video by id", default=None)
@click.option("--include-corrupt", help="Include videos previously marked as corrupt", is_flag=True)
def transcode_videos(regenerate, video, include_corrupt):
    """Transcode videos to enabled resolution variants (1080p, 720p, 480p)"""

    _TRANSCODE_LOCK = "fireshare_transcode.lock"

    # Store data_path for signal handler access
    _transcode_state = {'data_path': None}

    def handle_cancel(signum, frame):
        logger.info("Transcoding cancelled by user")
        if _transcode_state['data_path']:
            util.clear_transcoding_status(_transcode_state['data_path'])
            util.remove_lock(_transcode_state['data_path'], _TRANSCODE_LOCK)
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle_cancel)

    with create_app().app_context():
        if not current_app.config.get('ENABLE_TRANSCODING'):
            logger.info("Transcoding is disabled. Set ENABLE_TRANSCODING=true to enable.")
            return

        paths = current_app.config['PATHS']
        _transcode_state['data_path'] = paths['data']

        if util.lock_exists(paths['data'], _TRANSCODE_LOCK):
            logger.info("A transcode process is already running. Aborting.")
            return
        util.create_lock(paths['data'], _TRANSCODE_LOCK)
        try:
            processed_root = Path(current_app.config['PROCESSED_DIRECTORY'])
            use_gpu = current_app.config.get('TRANSCODE_GPU', False)
            base_timeout = current_app.config.get('TRANSCODE_TIMEOUT', 7200)

            # Read transcoding settings from config
            config_path = paths['data'] / 'config.json'
            transcoding_config = {}
            if config_path.exists():
                with open(config_path, 'r') as f:
                    config = json.load(f)
                    transcoding_config = config.get('transcoding', {})

            encoder_preference = transcoding_config.get('encoder_preference', 'auto')

            # Build list of enabled resolutions (highest to lowest)
            resolutions = []
            if transcoding_config.get('enable_1080p', True):
                resolutions.append(1080)
            if transcoding_config.get('enable_720p', True):
                resolutions.append(720)
            if transcoding_config.get('enable_480p', True):
                resolutions.append(480)

            # Get videos to transcode
            vinfos = VideoInfo.query.filter(VideoInfo.video_id==video).all() if video else VideoInfo.query.all()

            # Filter out corrupt videos unless explicitly included
            corrupt_videos = set(get_all_corrupt_videos())
            if not include_corrupt and not video:
                original_count = len(vinfos)
                vinfos = [vi for vi in vinfos if vi.video_id not in corrupt_videos]
                skipped_count = original_count - len(vinfos)
                if skipped_count > 0:
                    logger.info(f"Skipping {skipped_count} video(s) previously marked as corrupt. Use --include-corrupt to retry them.")

            # HDR videos get their SDR copy first, and the transcodes are then made from
            # it: one with an operator chosen but no copy yet (an interrupted save, or a
            # server that lacked the filters at the time), and, with automatic tone
            # mapping on, any HDR video nothing has been chosen for yet.
            auto_tonemap = transcoding_config.get('auto_tonemap', False)
            tonemap_default = None
            if auto_tonemap:
                tonemap_default = util.resolve_tonemap_default(transcoding_config.get('tonemap_default', 'auto'))
                if not tonemap_default:
                    logger.warning("Automatic tone mapping is on, but this ffmpeg build has no tone map filters")
            sdr_items = []
            for vi in vinfos:
                if not vi.is_hdr:
                    continue
                video_path = Path(processed_root, "video_links", vi.video_id + vi.video.extension)
                if not video_path.exists():
                    continue
                derived_path = Path(processed_root, "derived", vi.video_id)
                sdr_path = derived_path / f"{vi.video_id}-sdr.mp4"
                if vi.tonemap_operator:
                    if sdr_path.exists():
                        if not vi.has_sdr:
                            vi.has_sdr = True
                            db.session.commit()
                        continue
                    if vi.sdr_error and not regenerate:
                        continue  # failed before; saving the video again retries it
                    sdr_items.append((vi, video_path, derived_path, sdr_path))
                elif tonemap_default and vi.tonemap is None and not vi.has_sdr and not vi.sdr_error:
                    # Never chosen for this video. A tone map removed on purpose is stored
                    # as an explicit 'none' and is left alone.
                    vi.tonemap = tonemap_default
                    db.session.commit()
                    sdr_items.append((vi, video_path, derived_path, sdr_path))
            for idx, (vi, video_path, derived_path, sdr_path) in enumerate(sdr_items, 1):
                util.write_transcoding_status(paths['data'], idx, len(sdr_items), vi.title, resolution='SDR')
                derived_path.mkdir(parents=True, exist_ok=True)
                with util.video_lock(vi.video_id, wait=False) as locked:
                    if not locked:
                        logger.info(f"Skipping SDR copy of {vi.video_id} - the video is being edited")
                        continue
                    try:
                        db.session.refresh(vi)
                    except InvalidRequestError:
                        continue
                    if not vi.tonemap_operator or sdr_path.exists():
                        continue
                    cropped_path = derived_path / f"{vi.video_id}-cropped.mp4"
                    source_path = cropped_path if vi.has_crop and cropped_path.exists() else video_path
                    logger.info(f"[{idx}/{len(sdr_items)}] Tone mapping {vi.video_id} to SDR with {vi.tonemap_operator} ({vi.video.path})")
                    success, failure_reason = util.create_sdr_video(
                        source_path, sdr_path, vi.tonemap_operator, use_gpu, encoder_preference,
                        data_path=paths['data'], assume_pq=util.stream_needs_pq_assumed(vi.vcodec),
                    )
                    if success:
                        vi.has_sdr = True
                        vi.sdr_error = None
                        # Whatever transcodes exist were made from the HDR source; they
                        # are remade from the SDR copy below.
                        for height in resolutions:
                            transcode_path = derived_path / f"{vi.video_id}-{height}p.mp4"
                            if transcode_path.exists():
                                transcode_path.unlink()
                            setattr(vi, f'has_{height}p', False)
                    else:
                        vi.sdr_error = util.sdr_failure_message(failure_reason)
                        logger.warning(f"SDR copy of {vi.video_id} failed: {vi.sdr_error}")
                    db.session.add(vi)
                    db.session.commit()

            # Build work queue: list of (video_info, height) tuples that actually need transcoding
            # Also reconcile has_* flags if outputs already exist on disk.
            work_items = []
            skipped_missing_source = 0
            skipped_source_too_small = 0
            skipped_existing_output = 0
            reconciled_flag_updates = 0
            reconciled_videos = set()
            for vi in vinfos:
                video_path = Path(processed_root, "video_links", vi.video_id + vi.video.extension)
                if not video_path.exists():
                    skipped_missing_source += 1
                    if video:
                        logger.warning(f"Skipping video {vi.video_id}: source file not found at {video_path}")
                    continue
                derived_path = Path(processed_root, "derived", vi.video_id)
                original_height = vi.height or 0
                for height in resolutions:
                    if original_height > 0 and original_height <= height:
                        skipped_source_too_small += 1
                        if video:
                            logger.debug(
                                f"Skipping {vi.video_id} {height}p: source height ({original_height}p) "
                                f"is not greater than target"
                            )
                        continue
                    transcode_path = derived_path / f"{vi.video_id}-{height}p.mp4"
                    has_attr = f'has_{height}p'
                    output_exists = transcode_path.exists()

                    if output_exists and getattr(vi, has_attr, False) is not True:
                        setattr(vi, has_attr, True)
                        reconciled_flag_updates += 1
                        reconciled_videos.add(vi.video_id)
                        if video:
                            logger.debug(f"Detected existing {height}p output on disk; updating {has_attr}=True for {vi.video_id}")

                    if output_exists and not regenerate:
                        skipped_existing_output += 1
                        if video:
                            logger.debug(f"Skipping {vi.video_id} {height}p: output already exists at {transcode_path}")
                        continue

                    work_items.append((vi, height, video_path, derived_path, transcode_path))

            if reconciled_flag_updates > 0:
                db.session.commit()
                logger.info(
                    f"Reconciled transcode flags from disk for {len(reconciled_videos)} video(s), "
                    f"updated {reconciled_flag_updates} flag value(s)."
                )

            total_jobs = len(work_items)
            logger.info(f'Processing {total_jobs:,} transcode job(s) (GPU: {use_gpu}, Encoder: {encoder_preference})')

            # Claim ownership of the status file immediately so the SSE poller has a
            # stable is_running=True signal to detect regardless of how we were invoked
            # (upload auto-transcode, bulk-import, or manual queue).  We overwrite any
            # earlier placeholder written by _launch_scan_video or bulk_import so that
            # our own PID is authoritative for the duration of this function.
            util.write_transcoding_status(paths['data'], 0, total_jobs, pid=os.getpid())

            if total_jobs == 0:
                if video:
                    vi = vinfos[0] if vinfos else None
                    logger.info(
                        f"Single-video planner summary for {video}: "
                        f"found_video_info={bool(vi)}, source_height={vi.height if vi else None}, "
                        f"enabled_targets={','.join(f'{h}p' for h in resolutions) if resolutions else 'none'}, "
                        f"regenerate={regenerate}, include_corrupt={include_corrupt}"
                    )
                    logger.info(
                        "Single-video planner breakdown: "
                        f"missing_source={skipped_missing_source}, "
                        f"source_too_small={skipped_source_too_small}, "
                        f"already_exists={skipped_existing_output}"
                    )
                logger.info("No videos need transcoding")
                util.clear_transcoding_status(paths['data'])
                return

            # Remove any leftover *.tmp.mp4 files from a previous run that crashed
            # before the temp file could be renamed to its final location. One whose
            # video is locked is a crop or transcode being written right now.
            derived_root = Path(processed_root, "derived")
            if derived_root.exists():
                for tmp_file in derived_root.glob('**/*.tmp.mp4'):
                    with util.video_lock(tmp_file.parent.name, wait=False) as locked:
                        if not locked:
                            continue
                        try:
                            tmp_file.unlink()
                            logger.info(f"Removed stale temp transcode file: {tmp_file}")
                        except OSError as ex:
                            logger.warning(f"Could not remove stale temp file {tmp_file}: {ex}")

            # Track corrupt videos to skip remaining heights for that video
            corrupt_video_ids = set()

            for idx, (vi, height, video_path, derived_path, transcode_path) in enumerate(work_items, 1):
                # Skip if this video was marked corrupt during this run
                if vi.video_id in corrupt_video_ids:
                    continue

                # Update transcoding progress
                util.write_transcoding_status(paths['data'], idx, total_jobs, vi.title, resolution=f"{height}p")

                if not derived_path.exists():
                    derived_path.mkdir(parents=True)

                has_attr = f'has_{height}p'

                with util.video_lock(vi.video_id, wait=False) as locked:
                    if not locked:
                        # Its crop is being saved, which makes its own transcodes. Anything
                        # still missing afterwards is picked up by the next run.
                        logger.info(f"[{idx}/{total_jobs}] Skipping {vi.video_id} {height}p - its crop is being processed")
                        continue

                    # Re-read now the lock is held: a crop may have been saved, and its
                    # transcodes made, since the work list was built.
                    try:
                        db.session.refresh(vi)
                    except InvalidRequestError:
                        continue  # deleted since the work list was built
                    if transcode_path.exists() and not regenerate:
                        continue
                    # A cropped video's transcodes are made from the crop, as the crop
                    # pipeline makes them. From the original they would play the whole
                    # uncut video to anyone moved down to a lower quality.
                    # Likewise a tone-mapped video's transcodes come from its SDR copy,
                    # or every quality but the source would still play washed out.
                    sdr_path = derived_path / f"{vi.video_id}-sdr.mp4"
                    cropped_path = derived_path / f"{vi.video_id}-cropped.mp4"
                    if vi.has_sdr and sdr_path.exists():
                        source_path = sdr_path
                    elif vi.has_crop and cropped_path.exists():
                        source_path = cropped_path
                    else:
                        source_path = video_path

                    logger.info(f"[{idx}/{total_jobs}] Transcoding {vi.video_id} to {height}p ({vi.video.path})")
                    success, failure_reason = util.transcode_video_quality(
                        source_path, transcode_path, height, use_gpu, None, encoder_preference,
                        data_path=paths['data']
                    )
                    if success:
                        setattr(vi, has_attr, True)
                        if is_video_corrupt(vi.video_id):
                            clear_video_corrupt(vi.video_id)
                        db.session.add(vi)
                        db.session.commit()
                    elif failure_reason == 'corruption':
                        logger.warning(f"Skipping video {vi.video_id} {height}p transcode - source file appears corrupt")
                        mark_video_corrupt(vi.video_id)
                        corrupt_video_ids.add(vi.video_id)
                    else:
                        logger.warning(f"Skipping video {vi.video_id} {height}p transcode - all encoders failed")

            util.clear_transcoding_status(paths['data'])
            logger.info("Transcoding complete")
        finally:
            util.remove_lock(paths['data'], _TRANSCODE_LOCK)

@cli.command()
@click.pass_context
@click.option("--root", "-r", help="root video path to scan", required=False)
def bulk_import(ctx, root):
    with create_app().app_context():
        paths = current_app.config['PATHS']
        if util.lock_exists(paths["data"]):
            logger.info(f"A scan process is currently active... Aborting. (Remove {paths['data']/'fireshare.lock'} to continue anyway)")
            return
        util.create_lock(paths["data"])

        thumbnail_skip = current_app.config['THUMBNAIL_VIDEO_LOCATION'] or 0
        if thumbnail_skip > 0 and thumbnail_skip <= 100:
            thumbnail_skip = thumbnail_skip / 100
        else:
            thumbnail_skip = 0

        timing = {}
        s = time.time()
        ctx.invoke(scan_videos, root=root)
        timing['scan_videos'] = time.time() - s
        s = time.time()
        ctx.invoke(sync_metadata)
        timing['sync_metadata'] = time.time() - s
        s = time.time()
        ctx.invoke(detect_hdr)
        timing['detect_hdr'] = time.time() - s
        s = time.time()
        ctx.invoke(create_posters, skip=thumbnail_skip)
        timing['create_posters'] = time.time() - s
        
        # Release the scan lock before transcoding — scanning and transcoding are
        # independent, and holding the lock across a long transcode would cause
        # every scheduled scan during that window to abort unnecessarily.
        util.remove_lock(paths["data"])

        # Transcode videos if transcoding is enabled and auto_transcode is on
        if current_app.config.get('ENABLE_TRANSCODING'):
            # Check if auto_transcode is enabled in config.json
            config_path = paths['data'] / 'config.json'
            auto_transcode = True  # Default to True
            if config_path.exists():
                with open(config_path, 'r') as f:
                    config = json.load(f)
                    auto_transcode = config.get('transcoding', {}).get('auto_transcode', True)

            if auto_transcode:
                util.write_transcoding_status(paths['data'], 0, 0, None, os.getpid())
                s = time.time()
                ctx.invoke(transcode_videos)
                timing['transcode_videos'] = time.time() - s
            else:
                logger.info("Skipping automatic transcoding (auto_transcode is disabled in settings)")

        logger.info(f"Finished bulk import. Timing info: {json.dumps(timing)}")
        util.clear_transcoding_status(paths['data'])

@cli.command()
@click.option("--root", "-r", help="subdirectory of IMAGE_DIRECTORY to scan", required=False)
def scan_images(root):
    """Scan IMAGE_DIRECTORY for new image files and index them."""
    with create_app().app_context():
        image_directory = current_app.config.get('IMAGE_DIRECTORY')
        if not image_directory:
            logger.error("IMAGE_DIRECTORY is not configured. Set the IMAGE_DIRECTORY environment variable.")
            return
        images_path = Path(image_directory)
        if not images_path.is_dir():
            logger.error(f"IMAGE_DIRECTORY does not exist: {images_path}")
            return

        paths = current_app.config['PATHS']
        image_links = paths["processed"] / "image_links"
        if not image_links.is_dir():
            image_links.mkdir(parents=True)

        config_file = open(paths["data"] / "config.json")
        config = json.load(config_file)
        image_config = config["app_config"].get("image_defaults", {"private": True})
        config_file.close()

        search_root = images_path / root if root else images_path
        logger.info(f"Scanning {search_root} for image files")

        image_files = [
            f for f in search_root.glob('**/*')
            if f.is_file() and util.is_image_file(f) and not f.name.startswith('._')
        ]
        logger.info(f"Found {len(image_files)} image file(s)")

        image_rows = Image.query.all()
        owner = _root_admin()

        # Snapshot existing folder assignments before reassigning, for reconciliation
        folder_snapshot = {ir.id: ir.folder_id for ir in image_rows}
        folder_cache = {}

        new_images = []
        for img_file in image_files:
            rel_path = str(img_file.relative_to(images_path))
            iid = util.image_id(img_file)
            dirname = os.path.dirname(rel_path)
            top_level = dirname.split(os.sep)[0] if dirname else None
            folder = _get_or_create_media_folder(folder_cache, top_level, "image") if top_level else None
            folder_id = folder.id if folder else None
            existing = next((ir for ir in image_rows if ir.image_id == iid), None)
            duplicate = next((ni for ni in new_images if ni.image_id == iid), None)
            if duplicate:
                logger.debug(f"Found duplicate image {iid} at {rel_path}, skipping...")
            elif existing:
                if not existing.available:
                    db.session.query(Image).filter_by(image_id=iid).update({"available": True})
                if existing.folder_id != folder_id:
                    db.session.query(Image).filter_by(image_id=iid).update({"folder_id": folder_id})
                # Regenerate missing WebP/thumbnail for existing images
                info = ImageInfo.query.filter_by(image_id=iid).first()
                if info and (not info.has_webp or not info.has_thumbnail):
                    derived_path = Path(current_app.config['PROCESSED_DIRECTORY']) / "derived" / iid
                    if not derived_path.exists():
                        derived_path.mkdir(parents=True)
                    src = images_path / rel_path
                    webp_path = derived_path / "image.webp"
                    thumb_path = derived_path / "thumbnail.webp"
                    if not webp_path.exists():
                        ok = util.create_image_webp(src, webp_path)
                        if ok:
                            info.has_webp = True
                    if not thumb_path.exists():
                        ok = util.create_image_thumbnail(src, thumb_path)
                        if ok:
                            info.has_thumbnail = True
                    if not info.width or not info.height:
                        w, h = util.get_image_dimensions(src)
                        info.width = w
                        info.height = h
                    if not info.file_size:
                        info.file_size = src.stat().st_size
                    db.session.commit()
                    logger.debug(f"Regenerated derived data for existing image {iid}")
            else:
                created_at = util.extract_date_from_image_file(img_file)
                updated_at = datetime.fromtimestamp(os.path.getmtime(str(img_file)))
                source_folder = rel_path.split('/')[0] if '/' in rel_path else None
                img = Image(image_id=iid, extension=img_file.suffix, path=rel_path,
                            available=True, created_at=created_at, updated_at=updated_at,
                            source_folder=source_folder, folder_id=folder_id,
                            uploaded_by=owner.id if owner else None)
                logger.info(f"Adding new Image {iid} at {rel_path}")
                new_images.append(img)

        if new_images:
            db.session.add_all(new_images)
            if owner:
                logger.info(f"Attributed {len(new_images)} newly indexed image(s) to '{owner.username}'")
        db.session.commit()

        fd = os.open(str(image_links.absolute()), os.O_DIRECTORY)
        for ni in new_images:
            src = Path((images_path / ni.path).absolute())
            dst = image_links / (ni.image_id + ni.extension)
            if not dst.exists():
                logger.debug(f"Linking {src} --> {dst}")
                try:
                    os.symlink(src, dst, dir_fd=fd)
                except FileExistsError:
                    logger.debug(f"{dst} exists already")
            info = ImageInfo(image_id=ni.image_id, title=Path(ni.path).stem,
                             private=image_config.get("private", True))
            db.session.add(info)
        db.session.commit()

        # Auto-tag new images based on image folder rules
        if new_images:
            img_folder_rules = {rule.folder_path: rule.game_id for rule in ImageFolderRule.query.all()}
            if img_folder_rules:
                logger.info(f"Checking {len(new_images)} new image(s) against {len(img_folder_rules)} image folder rule(s)")
                auto_tagged = 0
                for ni in new_images:
                    parts = ni.path.split('/')
                    if len(parts) > 1:
                        folder = parts[0]
                        if folder in img_folder_rules:
                            game_id = img_folder_rules[folder]
                            link = ImageGameLink(image_id=ni.image_id, game_id=game_id, created_at=datetime.utcnow())
                            db.session.add(link)
                            auto_tagged += 1
                            logger.debug(f"[Image Folder Rule] Auto-tagged {ni.image_id} to game {game_id} (folder: {folder})")
                if auto_tagged:
                    db.session.commit()
                    logger.info(f"Auto-tagged {auto_tagged} image(s) via image folder rules")

        # Generate derived data (webp + thumbnail) for new images
        processed_root = Path(current_app.config['PROCESSED_DIRECTORY'])
        for ni in new_images:
            derived_path = processed_root / "derived" / ni.image_id
            if not derived_path.exists():
                derived_path.mkdir(parents=True)
            src = images_path / ni.path
            webp_path = derived_path / "image.webp"
            thumb_path = derived_path / "thumbnail.webp"
            info = ImageInfo.query.filter_by(image_id=ni.image_id).first()
            if not webp_path.exists():
                ok = util.create_image_webp(src, webp_path)
                if ok and info:
                    info.has_webp = True
            if not thumb_path.exists():
                ok = util.create_image_thumbnail(src, thumb_path)
                if ok and info:
                    info.has_thumbnail = True
            if info:
                w, h = util.get_image_dimensions(src)
                info.width = w
                info.height = h
                info.file_size = src.stat().st_size
        db.session.commit()

        # Verify existing images still exist
        for ei in Image.query.filter_by(available=True).all():
            file_path = images_path / ei.path
            if not file_path.exists():
                logger.warning(f"Image {ei.image_id} at {file_path} not found, marking unavailable")
                db.session.query(Image).filter_by(image_id=ei.image_id).update({"available": False})
        db.session.commit()

        # Reconcile MediaFolder records (handle renamed/moved/removed folders)
        _reconcile_media_folders("image", Image, folder_snapshot)
        db.session.commit()

        logger.info("Image scan complete")


@cli.command()
@click.pass_context
@click.option("--path", "-p", help="Path to image file (relative to IMAGE_DIRECTORY)", required=True)
@click.option("--game-id", type=int, help="Game ID to apply", required=False, default=None)
@click.option("--tag-ids", help="Comma-separated custom tag IDs to apply", required=False, default=None)
@click.option("--title", help="Initial title for the image", required=False, default=None)
@click.option("--uploaded-by", type=int, help="id of the user who uploaded this image", required=False, default=None)
def scan_image(ctx, path, game_id, tag_ids, title, uploaded_by):
    """Scan a single image file and index it."""
    with create_app().app_context():
        image_directory = current_app.config.get('IMAGE_DIRECTORY')
        if not image_directory:
            logger.error("IMAGE_DIRECTORY is not configured.")
            return
        images_path = Path(image_directory)
        img_file = images_path / path
        if not img_file.is_file() or not util.is_image_file(img_file):
            logger.error(f"Invalid image file: {img_file}")
            return

        paths = current_app.config['PATHS']
        image_links = paths["processed"] / "image_links"
        if not image_links.is_dir():
            image_links.mkdir(parents=True)

        config_file = open(paths["data"] / "config.json")
        config = json.load(config_file)
        image_config = config["app_config"].get("image_defaults", {"private": True})
        config_file.close()

        rel_path = str(img_file.relative_to(images_path))
        iid = util.image_id(img_file)

        existing = Image.query.filter_by(image_id=iid).first()
        if existing:
            if not existing.available:
                db.session.query(Image).filter_by(image_id=iid).update({"available": True})
                db.session.commit()
            # Regenerate missing WebP/thumbnail for existing images
            info = ImageInfo.query.filter_by(image_id=iid).first()
            if info and (not info.has_webp or not info.has_thumbnail):
                processed_root = Path(current_app.config['PROCESSED_DIRECTORY'])
                derived_path = processed_root / "derived" / iid
                if not derived_path.exists():
                    derived_path.mkdir(parents=True)
                src = images_path / rel_path
                webp_path = derived_path / "image.webp"
                thumb_path = derived_path / "thumbnail.webp"
                if not webp_path.exists():
                    ok = util.create_image_webp(src, webp_path)
                    if ok:
                        info.has_webp = True
                if not thumb_path.exists():
                    ok = util.create_image_thumbnail(src, thumb_path)
                    if ok:
                        info.has_thumbnail = True
                if not info.width or not info.height:
                    w, h = util.get_image_dimensions(src)
                    info.width = w
                    info.height = h
                if not info.file_size:
                    info.file_size = src.stat().st_size
                db.session.commit()
                logger.info(f"Regenerated derived data for existing image {iid}")
            else:
                logger.debug(f"Image {iid} already indexed")
        else:
            created_at = util.extract_date_from_image_file(img_file)
            updated_at = created_at
            source_folder = rel_path.split('/')[0] if '/' in rel_path else None
            img = Image(image_id=iid, extension=img_file.suffix, path=rel_path,
                        available=True, created_at=created_at, updated_at=updated_at,
                        source_folder=source_folder, uploaded_by=_resolve_uploader(uploaded_by))
            db.session.add(img)
            db.session.commit()

            src = images_path / rel_path
            dst = image_links / (iid + img_file.suffix)
            if not dst.exists():
                try:
                    os.symlink(src.absolute(), dst)
                except FileExistsError:
                    pass

            info = ImageInfo(image_id=iid, title=title or Path(rel_path).stem,
                             private=image_config.get("private", True))
            db.session.add(info)
            db.session.commit()

            # Apply tags and game
            if tag_ids:
                for tid in [int(t) for t in tag_ids.split(',') if t.strip().isdigit()]:
                    if not ImageTagLink.query.filter_by(image_id=iid, tag_id=tid).first():
                        db.session.add(ImageTagLink(image_id=iid, tag_id=tid, created_at=datetime.utcnow()))
                db.session.commit()
            if game_id and not ImageGameLink.query.filter_by(image_id=iid).first():
                db.session.add(ImageGameLink(image_id=iid, game_id=game_id, created_at=datetime.utcnow()))
                db.session.commit()

            # Generate derived data
            processed_root = Path(current_app.config['PROCESSED_DIRECTORY'])
            derived_path = processed_root / "derived" / iid
            if not derived_path.exists():
                derived_path.mkdir(parents=True)
            webp_path = derived_path / "image.webp"
            thumb_path = derived_path / "thumbnail.webp"
            info = ImageInfo.query.filter_by(image_id=iid).first()
            if not webp_path.exists():
                ok = util.create_image_webp(src, webp_path)
                if ok and info:
                    info.has_webp = True
            if not thumb_path.exists():
                ok = util.create_image_thumbnail(src, thumb_path)
                if ok and info:
                    info.has_thumbnail = True
            w, h = util.get_image_dimensions(src)
            if info:
                info.width = w
                info.height = h
                info.file_size = src.stat().st_size
            db.session.commit()
            logger.info(f"Image {iid} indexed successfully")


@cli.command()
def migrate_game_assets():
    """Convert any non-webp game assets to webp at 100% quality."""
    from PIL import Image as PILImage

    _ASSET_SLOTS = ['hero_1', 'hero_2', 'logo_1', 'icon_1']
    _NON_WEBP_EXTENSIONS = ['.png', '.jpg', '.jpeg']

    with create_app().app_context():
        paths = current_app.config['PATHS']
        game_assets_base = paths['data'] / 'game_assets'

        if not game_assets_base.exists():
            logger.info("migrate-game-assets: no game_assets directory found, nothing to do")
            return

        converted = 0
        skipped = 0
        errors = 0

        for game_dir in sorted(game_assets_base.iterdir()):
            if not game_dir.is_dir():
                continue
            for slot in _ASSET_SLOTS:
                webp_path = game_dir / f'{slot}.webp'
                if webp_path.exists():
                    skipped += 1
                    continue
                for ext in _NON_WEBP_EXTENSIONS:
                    src = game_dir / f'{slot}{ext}'
                    if src.exists():
                        try:
                            with PILImage.open(src) as img:
                                img.save(webp_path, 'WEBP', quality=100, method=6)
                            src.unlink()
                            logger.info(f"migrate-game-assets: converted {src.name} -> {webp_path.name} in {game_dir.name}")
                            converted += 1
                        except Exception as e:
                            logger.error(f"migrate-game-assets: failed to convert {src}: {e}")
                            errors += 1
                        break

        logger.info(f"migrate-game-assets: complete — {converted} converted, {skipped} already webp, {errors} errors")


if __name__=="__main__":
    cli()
