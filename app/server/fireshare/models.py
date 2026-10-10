import json
import uuid as uuid_lib
from datetime import datetime
from flask_login import UserMixin
from . import db
from . import permissions as perms
from . import media_codecs

class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(100), unique=True)
    password = db.Column(db.String(256), nullable=True)
    # Defaults to False: a user created without an explicit admin flag must not
    # inherit administrator rights (the old default=True silently minted admins
    # through /api/signup and `fireshare add-user`). Left nullable to match the
    # existing column — forcing NOT NULL would rebuild this table on upgrade, and
    # the migration normalizes the NULLs that older rows could carry.
    admin = db.Column(db.Boolean, default=False)
    last_seen_version = db.Column(db.String(32), nullable=True)
    totp_secret = db.Column(db.String(64), nullable=True)
    mfa_enabled = db.Column(db.Boolean, nullable=False, default=False, server_default='0')
    totp_last_used = db.Column(db.Integer, nullable=True)  # last accepted 30s TOTP timestep, blocks code replay

    # Granted capability keys as a JSON array. Ignored entirely when admin is set.
    permissions = db.Column(db.Text, nullable=True)
    disabled = db.Column(db.Boolean, nullable=False, default=False, server_default='0')
    # Marks the account whose username/password are re-asserted from ADMIN_USERNAME /
    # ADMIN_PASSWORD on every boot. Pinning it to a specific row keeps that logic from
    # rewriting an arbitrary administrator once more than one exists.
    env_managed = db.Column(db.Boolean, nullable=False, default=False, server_default='0')
    must_change_password = db.Column(db.Boolean, nullable=False, default=False, server_default='0')
    invite_token_hash = db.Column(db.String(64), nullable=True, index=True)  # sha256 hex, never the raw token
    invite_expires_at = db.Column(db.DateTime(), nullable=True)
    created_at = db.Column(db.DateTime(), nullable=True)
    last_login_at = db.Column(db.DateTime(), nullable=True)

    # Profile
    display_name = db.Column(db.String(64), nullable=True)
    bio = db.Column(db.String(280), nullable=True)
    profile_public = db.Column(db.Boolean, nullable=False, default=True, server_default='1')
    # 0 = no avatar uploaded. Bumped on each upload so clients can cache the file
    # forever and still pick up a change.
    avatar_version = db.Column(db.Integer, nullable=False, default=0, server_default='0')
    # 0 = no uploaded banner, so the profile falls back to the most-uploaded
    # game's art and then to a generated gradient.
    banner_version = db.Column(db.Integer, nullable=False, default=0, server_default='0')

    # Long-lived credentials for machine uploads. Deleted with the account: a
    # token outliving its owner would authenticate as a user that no longer exists.
    upload_tokens = db.relationship(
        "UploadToken", back_populates="user", cascade="all, delete-orphan", lazy="select"
    )

    @property
    def granted_permissions(self):
        """The set of grantable keys this user holds (empty for admins, who bypass)."""
        return perms.parse_permissions(self.permissions)

    def can(self, permission):
        """Whether this user may perform the named capability."""
        if self.disabled:
            return False
        if self.admin:
            return True
        if permission not in perms.GRANTABLE_PERMISSIONS:
            return False  # admin-only capability, never grantable
        return permission in self.granted_permissions

    def can_modify(self, media, action):
        """Whether this user may 'edit' or 'delete' a specific Video or Image.

        Ownership is only honoured for media that actually has an uploader: legacy
        rows scanned off disk carry uploaded_by=None, and `None == None` would
        otherwise hand every one of them to any user holding *_own.
        """
        if action not in ('edit', 'delete'):
            raise ValueError(f"unknown action {action!r}")
        if self.can(f'{action}_any'):
            return True
        owner_id = getattr(media, 'uploaded_by', None)
        return (
            self.can(f'{action}_own')
            and owner_id is not None
            and owner_id == self.id
        )

    @property
    def has_avatar(self):
        return bool(self.avatar_version)

    @property
    def has_banner(self):
        return bool(self.banner_version)

    @property
    def name(self):
        """The name to show for this user anywhere in the UI."""
        return self.display_name or self.username

    def avatar_url(self):
        if not self.has_avatar:
            return None
        return f"/api/users/{self.username}/avatar?v={self.avatar_version}"

    def banner_url(self):
        if not self.has_banner:
            return None
        return f"/api/users/{self.username}/banner?v={self.banner_version}"

    def mention_json(self):
        """The compact uploader reference embedded in video and image payloads."""
        return {
            "username": self.username,
            "display_name": self.display_name,
            "name": self.name,
            "avatar_url": self.avatar_url(),
        }

    def profile_json(self):
        """The public-facing profile payload."""
        return {
            "username": self.username,
            "display_name": self.display_name,
            "name": self.name,
            "bio": self.bio,
            "avatar_url": self.avatar_url(),
            "has_avatar": self.has_avatar,
            "banner_url": self.banner_url(),
            "has_banner": self.has_banner,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }

    def admin_json(self):
        """The privileged payload for the admin user list. Never leaves an admin route."""
        granted = sorted(self.granted_permissions)
        if self.invite_token_hash:
            status = 'invited'
        elif self.disabled:
            status = 'disabled'
        else:
            status = 'active'
        return {
            "id": self.id,
            "username": self.username,
            "display_name": self.display_name,
            "name": self.name,
            "admin": bool(self.admin),
            "permissions": granted,
            "permissions_label": perms.describe_permissions(self.admin, granted),
            "preset": perms.preset_for(granted) if not self.admin else 'admin',
            "disabled": bool(self.disabled),
            "env_managed": bool(self.env_managed),
            "mfa_enabled": bool(self.mfa_enabled),
            "must_change_password": bool(self.must_change_password),
            "profile_public": bool(self.profile_public),
            "avatar_url": self.avatar_url(),
            "status": status,
            "invite_expires_at": self.invite_expires_at.isoformat() if self.invite_expires_at else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "last_login_at": self.last_login_at.isoformat() if self.last_login_at else None,
        }

    def __repr__(self):
        return "<User {} {}>".format(self.id, self.username)

class Video(db.Model):
    __tablename__ = "video"

    id        = db.Column(db.Integer, primary_key=True)
    video_id  = db.Column(db.String(32), index=True, nullable=False)
    extension = db.Column(db.String(8), nullable=False)
    path      = db.Column(db.String(2048), index=True, nullable=False)
    available = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime())
    updated_at = db.Column(db.DateTime())
    recorded_at = db.Column(db.DateTime(), nullable=True)  # Extracted from filename
    source_folder = db.Column(db.String(256), nullable=True)  # Original folder name for game detection
    folder_id = db.Column(db.Integer, db.ForeignKey("media_folder.id"), nullable=True)
    # None for anonymous public uploads and for anything scanned off disk before
    # profiles existed. Cleared (never cascaded) when the uploader is deleted.
    uploaded_by = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True, index=True)

    info      = db.relationship("VideoInfo", back_populates="video", uselist=False, lazy="joined")
    uploader  = db.relationship("User", lazy="joined", foreign_keys=[uploaded_by])

    def json(self):
        j = {
            "video_id": self.video_id,
            "extension": self.extension,
            "path": self.path,
            "available": self.available,
            "recorded_at": self.recorded_at.isoformat() if self.recorded_at else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "info": self.info.json(),
            "uploader": self.uploader.mention_json() if self.uploader else None,
        }
        return j

    def __repr__(self):
        return "<Video {}>".format(self.video_id)

class VideoInfo(db.Model):
    __tablename__ = "video_info"

    id          = db.Column(db.Integer, primary_key=True)
    video_id    = db.Column(db.String(32), db.ForeignKey("video.video_id"), nullable=False)
    title       = db.Column(db.String(256), index=True)
    description = db.Column(db.String(2048))
    info        = db.Column(db.Text)
    duration    = db.Column(db.Float)
    width       = db.Column(db.Integer)
    height      = db.Column(db.Integer)
    private     = db.Column(db.Boolean, default=True)
    has_480p    = db.Column(db.Boolean, default=False)
    has_720p    = db.Column(db.Boolean, default=False)
    has_1080p   = db.Column(db.Boolean, default=False)
    start_time    = db.Column(db.Float, nullable=True)
    end_time      = db.Column(db.Float, nullable=True)
    has_crop      = db.Column(db.Boolean, default=False)
    # HDR sources. is_hdr is None until the stored stream tags have been checked.
    # tonemap is the operator the SDR copy is made with (None: none wanted), has_sdr
    # says the copy is in place, and sdr_error keeps the last failure for the editor.
    is_hdr        = db.Column(db.Boolean, nullable=True)
    tonemap       = db.Column(db.String(16), nullable=True)
    has_sdr       = db.Column(db.Boolean, default=False)
    sdr_error     = db.Column(db.String(512), nullable=True)
    password_hash = db.Column(db.String(256), nullable=True)

    video       = db.relationship("Video", back_populates="info", uselist=False, lazy="joined")

    @property
    def vcodec(self):
        info = json.loads(self.info) if self.info else None
        vcodec = [i for i in info if i["codec_type"] == "video"][0] if info else None
        return vcodec

    @property
    def hdr_format(self):
        """'pq' or 'hlg' for an HDR source (an untagged one is taken as PQ), else None."""
        if not self.is_hdr:
            return None
        try:
            transfer = (self.vcodec or {}).get('color_transfer') or ''
        except (IndexError, TypeError, ValueError):
            transfer = ''
        return 'hlg' if transfer.lower() == 'arib-std-b67' else 'pq'

    @property
    def framerate(self):
        if self.vcodec:
            frn, frd = self.vcodec.get("r_frame_rate", "").split("/")
            return round(float(frn)/float(frd))
        else:
            return None

    def _cropped_duration(self):
        """Return the effective duration, accounting for crop start/end times."""
        if not self.has_crop:
            return self.duration
        start = self.start_time or 0
        end = self.end_time if self.end_time is not None else self.duration
        return end - start

    def json(self):
        stream = self.vcodec
        return {
            "title": self.title,
            "description": self.description,
            "private": self.private,
            "width": self.width,
            "height": self.height,
            "duration": round(self._cropped_duration()) if self.duration else 0,
            "framerate": self.framerate,
            # What the player needs to ask the browser whether the source will
            # play smoothly, before choosing it over a transcode.
            "codec": media_codecs.codec_string(stream),
            "bitrate": media_codecs.stream_bitrate(stream),
            "has_480p": self.has_480p,
            "has_720p": self.has_720p,
            "has_1080p": self.has_1080p,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "has_crop": self.has_crop or False,
            "is_hdr": bool(self.is_hdr),
            "hdr_format": self.hdr_format,
            "tonemap": self.tonemap,
            "has_sdr": self.has_sdr or False,
            "sdr_error": self.sdr_error,
            "has_password": bool(self.password_hash),
        }

    def __repr__(self):
        return "<VideoInfo {} {}>".format(self.video_id, self.title)

class GameMetadata(db.Model):
    __tablename__ = "game_metadata"

    id                  = db.Column(db.Integer, primary_key=True)
    steamgriddb_id      = db.Column(db.Integer, index=True, nullable=True)
    name                = db.Column(db.String(256), index=True, nullable=False)
    release_date        = db.Column(db.String(64), nullable=True)
    hero_url            = db.Column(db.String(2048), nullable=True)
    logo_url            = db.Column(db.String(2048), nullable=True)
    icon_url            = db.Column(db.String(2048), nullable=True)
    created_at          = db.Column(db.DateTime())
    updated_at          = db.Column(db.DateTime())

    videos              = db.relationship("VideoGameLink", back_populates="game")

    def json(self):
        from flask import current_app

        hero_url = None
        banner_url = None
        logo_url = None
        icon_url = None

        if self.steamgriddb_id:
            if current_app.config.get('SERVE_GAME_ASSETS_NGINX'):
                domain = f"https://{current_app.config['DOMAIN']}" if current_app.config.get('DOMAIN') else ""
                base = f"{domain}/_content/game_assets/{self.steamgriddb_id}"
            else:
                base = f"/api/game/assets/{self.steamgriddb_id}"
            hero_url   = f"{base}/hero_1.webp"
            banner_url = f"{base}/hero_2.webp"
            logo_url   = f"{base}/logo_1.webp"
            icon_url   = f"{base}/icon_1.webp"

        return {
            "id": self.id,
            "steamgriddb_id": self.steamgriddb_id,
            "name": self.name,
            "release_date": self.release_date,
            "hero_url": hero_url,
            "banner_url": banner_url,
            "logo_url": logo_url,
            "icon_url": icon_url,
        }

    def __repr__(self):
        return "<GameMetadata {} {}>".format(self.id, self.name)

class VideoGameLink(db.Model):
    __tablename__ = "video_game_link"
    __table_args__ = (db.UniqueConstraint("video_id", "game_id"),)

    id          = db.Column(db.Integer, primary_key=True)
    video_id    = db.Column(db.String(32), db.ForeignKey("video.video_id"), nullable=False)
    game_id     = db.Column(db.Integer, db.ForeignKey("game_metadata.id"), nullable=False)
    created_at  = db.Column(db.DateTime())

    video       = db.relationship("Video")
    game        = db.relationship("GameMetadata", back_populates="videos")

    def json(self):
        return {
            "video_id": self.video_id,
            "game_id": self.game_id,
            "game": self.game.json() if self.game else None,
        }

    def __repr__(self):
        return "<VideoGameLink video:{} game:{}>".format(self.video_id, self.game_id)

class FolderRule(db.Model):
    __tablename__ = "folder_rule"

    id          = db.Column(db.Integer, primary_key=True)
    folder_path = db.Column(db.String(2048), unique=True, nullable=False)
    game_id     = db.Column(db.Integer, db.ForeignKey("game_metadata.id"), nullable=False)

    game        = db.relationship("GameMetadata")

    def json(self):
        return {
            "id": self.id,
            "folder_path": self.folder_path,
            "game_id": self.game_id,
            "game": self.game.json() if self.game else None,
        }

    def __repr__(self):
        return "<FolderRule {} -> game:{}>".format(self.folder_path, self.game_id)


class ImageFolderRule(db.Model):
    __tablename__ = "image_folder_rule"

    id          = db.Column(db.Integer, primary_key=True)
    folder_path = db.Column(db.String(2048), unique=True, nullable=False)
    game_id     = db.Column(db.Integer, db.ForeignKey("game_metadata.id"), nullable=False)

    game        = db.relationship("GameMetadata")

    def json(self):
        return {
            "id": self.id,
            "folder_path": self.folder_path,
            "game_id": self.game_id,
            "game": self.game.json() if self.game else None,
        }

    def __repr__(self):
        return "<ImageFolderRule {} -> game:{}>".format(self.folder_path, self.game_id)


class CustomTag(db.Model):
    __tablename__ = "custom_tag"

    id         = db.Column(db.Integer, primary_key=True)
    name       = db.Column(db.String(256), unique=True, nullable=False, index=True)
    color      = db.Column(db.String(7), nullable=True)   # hex, e.g. "#FF5733"
    created_at = db.Column(db.DateTime())
    updated_at = db.Column(db.DateTime())

    videos     = db.relationship("VideoTagLink", back_populates="tag")

    def json(self):
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
        }

    def __repr__(self):
        return "<CustomTag {} {}>".format(self.id, self.name)


class VideoTagLink(db.Model):
    __tablename__ = "video_tag_link"
    __table_args__ = (db.UniqueConstraint("video_id", "tag_id"),)

    id         = db.Column(db.Integer, primary_key=True)
    video_id   = db.Column(db.String(32), db.ForeignKey("video.video_id"), nullable=False)
    tag_id     = db.Column(db.Integer, db.ForeignKey("custom_tag.id"), nullable=False)
    created_at = db.Column(db.DateTime())

    video      = db.relationship("Video")
    tag        = db.relationship("CustomTag", back_populates="videos")

    def json(self):
        return {
            "video_id": self.video_id,
            "tag_id": self.tag_id,
            "tag": self.tag.json() if self.tag else None,
        }

    def __repr__(self):
        return "<VideoTagLink video:{} tag:{}>".format(self.video_id, self.tag_id)


class VideoView(db.Model):
    __tablename__ = "video_view"
    __table_args__ = (
        db.UniqueConstraint('video_id', 'ip_address'),
    )

    id          = db.Column(db.Integer, primary_key=True)
    video_id    = db.Column(db.String(32), db.ForeignKey("video.video_id"), nullable=False)
    ip_address  = db.Column(db.String(256), nullable=False)

    def json(self):
        return {
            "video_id": self.video_id,
            "ip_address": self.ip_address,
        }

    @classmethod
    def count(cls, video_id):
        return cls.query.filter_by(video_id=video_id).count()

    @classmethod
    def add_view(cls, video_id, ip_address):
        exists = cls.query.filter_by(video_id=video_id, ip_address=ip_address).first()
        if not exists:
            db.session.add(cls(video_id=video_id, ip_address=ip_address))
            db.session.commit()

    def __repr__(self):
        return "<VideoViews {} {}>".format(self.video_id, self.ip_address)


# ---------------------------------------------------------------------------
# Image models
# ---------------------------------------------------------------------------

class Image(db.Model):
    __tablename__ = "image"

    id            = db.Column(db.Integer, primary_key=True)
    image_id      = db.Column(db.String(32), index=True, nullable=False)
    extension     = db.Column(db.String(8), nullable=False)
    path          = db.Column(db.String(2048), index=True, nullable=False)
    available     = db.Column(db.Boolean, default=True)
    created_at    = db.Column(db.DateTime())
    updated_at    = db.Column(db.DateTime())
    source_folder = db.Column(db.String(256), nullable=True)
    folder_id     = db.Column(db.Integer, db.ForeignKey("media_folder.id"), nullable=True)
    # See Video.uploaded_by.
    uploaded_by   = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True, index=True)

    info          = db.relationship("ImageInfo", back_populates="image", uselist=False, lazy="joined")
    uploader      = db.relationship("User", lazy="joined", foreign_keys=[uploaded_by])

    def json(self):
        return {
            "image_id": self.image_id,
            "extension": self.extension,
            "path": self.path,
            "available": self.available,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "info": self.info.json() if self.info else {},
            "uploader": self.uploader.mention_json() if self.uploader else None,
        }

    def __repr__(self):
        return "<Image {}>".format(self.image_id)


class ImageInfo(db.Model):
    __tablename__ = "image_info"

    id            = db.Column(db.Integer, primary_key=True)
    image_id      = db.Column(db.String(32), db.ForeignKey("image.image_id"), nullable=False)
    title         = db.Column(db.String(256), index=True)
    description   = db.Column(db.String(2048))
    width         = db.Column(db.Integer)
    height        = db.Column(db.Integer)
    file_size     = db.Column(db.Integer)
    private       = db.Column(db.Boolean, default=True)
    has_webp      = db.Column(db.Boolean, default=False)
    has_thumbnail = db.Column(db.Boolean, default=False)

    image         = db.relationship("Image", back_populates="info", uselist=False, lazy="joined")

    def json(self):
        return {
            "title": self.title,
            "description": self.description,
            "private": self.private,
            "width": self.width,
            "height": self.height,
            "file_size": self.file_size,
            "has_webp": self.has_webp,
            "has_thumbnail": self.has_thumbnail,
        }

    def __repr__(self):
        return "<ImageInfo {} {}>".format(self.image_id, self.title)


class ImageGameLink(db.Model):
    __tablename__ = "image_game_link"
    __table_args__ = (db.UniqueConstraint("image_id", "game_id"),)

    id         = db.Column(db.Integer, primary_key=True)
    image_id   = db.Column(db.String(32), db.ForeignKey("image.image_id"), nullable=False)
    game_id    = db.Column(db.Integer, db.ForeignKey("game_metadata.id"), nullable=False)
    created_at = db.Column(db.DateTime())

    image      = db.relationship("Image")
    game       = db.relationship("GameMetadata")

    def json(self):
        return {
            "image_id": self.image_id,
            "game_id": self.game_id,
            "game": self.game.json() if self.game else None,
        }

    def __repr__(self):
        return "<ImageGameLink image:{} game:{}>".format(self.image_id, self.game_id)


class ImageTagLink(db.Model):
    __tablename__ = "image_tag_link"
    __table_args__ = (db.UniqueConstraint("image_id", "tag_id"),)

    id         = db.Column(db.Integer, primary_key=True)
    image_id   = db.Column(db.String(32), db.ForeignKey("image.image_id"), nullable=False)
    tag_id     = db.Column(db.Integer, db.ForeignKey("custom_tag.id"), nullable=False)
    created_at = db.Column(db.DateTime())

    image      = db.relationship("Image")
    tag        = db.relationship("CustomTag")

    def json(self):
        return {
            "image_id": self.image_id,
            "tag_id": self.tag_id,
            "tag": self.tag.json() if self.tag else None,
        }

    def __repr__(self):
        return "<ImageTagLink image:{} tag:{}>".format(self.image_id, self.tag_id)


class ImageView(db.Model):
    __tablename__ = "image_view"
    __table_args__ = (db.UniqueConstraint("image_id", "ip_address"),)

    id         = db.Column(db.Integer, primary_key=True)
    image_id   = db.Column(db.String(32), db.ForeignKey("image.image_id"), nullable=False)
    ip_address = db.Column(db.String(256), nullable=False)

    def json(self):
        return {
            "image_id": self.image_id,
            "ip_address": self.ip_address,
        }

    @classmethod
    def count(cls, image_id):
        return cls.query.filter_by(image_id=image_id).count()

    @classmethod
    def add_view(cls, image_id, ip_address):
        exists = cls.query.filter_by(image_id=image_id, ip_address=ip_address).first()
        if not exists:
            db.session.add(cls(image_id=image_id, ip_address=ip_address))
            db.session.commit()

    def __repr__(self):
        return "<ImageView {} {}>".format(self.image_id, self.ip_address)


class MediaFolder(db.Model):
    __tablename__ = "media_folder"
    __table_args__ = (
        db.UniqueConstraint("path", "media_type", name="uq_media_folder_path_media_type"),
    )

    id         = db.Column(db.Integer, primary_key=True)
    uuid       = db.Column(db.String(32), unique=True, index=True, nullable=False, default=lambda: uuid_lib.uuid4().hex)
    path       = db.Column(db.String(2048), index=True, nullable=False)
    media_type = db.Column(db.String(16), nullable=False)
    private    = db.Column(db.Boolean, default=True)
    available  = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime())
    updated_at = db.Column(db.DateTime())

    def json(self):
        import os
        name = os.path.basename(self.path.rstrip('/')) or self.path
        return {
            "uuid": self.uuid,
            "name": name,
            "media_type": self.media_type,
            "private": self.private,
            "available": self.available,
        }

    @staticmethod
    def cleanup_if_orphaned(folder_id, model):
        """Delete a MediaFolder if it has no remaining members of the given model (Video or Image)."""
        if folder_id is None:
            return
        remaining = model.query.filter_by(folder_id=folder_id).count()
        if remaining == 0:
            MediaFolder.query.filter_by(id=folder_id).delete()
            db.session.commit()

    def __repr__(self):
        return "<MediaFolder {} {} ({})>".format(self.uuid, self.path, self.media_type)


class TranscodeJob(db.Model):
    __tablename__ = "transcode_job"

    id           = db.Column(db.Integer, primary_key=True)
    video_id     = db.Column(db.String(64), nullable=True, index=True)  # None = bulk
    status       = db.Column(db.String(16), nullable=False, default='pending', index=True)
    task_count   = db.Column(db.Integer, nullable=False, default=0)
    created_at   = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    started_at   = db.Column(db.DateTime, nullable=True)
    completed_at = db.Column(db.DateTime, nullable=True)

    def __repr__(self):
        return "<TranscodeJob id={} video_id={} status={}>".format(self.id, self.video_id, self.status)



class UploadToken(db.Model):
    """A long-lived bearer credential that lets an external tool upload as its owner.

    Only the sha256 of the secret is stored, so a database copy cannot be replayed
    against the API and a lost token can only be replaced, never recovered. The
    token carries no permissions of its own: every request re-reads the owner's
    account, so revoking `upload` or disabling the user stops it immediately.
    """
    __tablename__ = "upload_token"

    id           = db.Column(db.Integer, primary_key=True)
    user_id      = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    name         = db.Column(db.String(64), nullable=False)
    # sha256 hex of the raw token. Unique so a hash collision cannot silently
    # shadow another user's credential.
    token_hash   = db.Column(db.String(64), unique=True, index=True, nullable=False)
    # The leading, non-secret part of the token, shown in the UI so an owner can
    # tell two tokens apart without the server ever holding the rest.
    prefix       = db.Column(db.String(24), nullable=False)
    created_at   = db.Column(db.DateTime(), nullable=True)
    last_used_at = db.Column(db.DateTime(), nullable=True)

    user         = db.relationship("User", back_populates="upload_tokens")

    def json(self):
        return {
            "id": self.id,
            "name": self.name,
            "prefix": self.prefix,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "last_used_at": self.last_used_at.isoformat() if self.last_used_at else None,
        }

    def __repr__(self):
        return "<UploadToken {} {} user:{}>".format(self.id, self.prefix, self.user_id)
