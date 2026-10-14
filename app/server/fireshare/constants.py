DEFAULT_CONFIG = {
  "app_config": {
    "video_defaults": {
      "private": True
    },
    "image_defaults": {
      "private": True
    },
    "allow_public_upload": False,
    "allow_public_folder_selection": True,
    "allow_public_game_tag": True,
    "public_upload_folder_name": "public uploads",
    "admin_upload_folder_name": "uploads"
  },
  "ui_config": {
    "shareable_link_domain": "",
    "show_admin_upload": True,
    "show_folder_dropdown": True,
    "show_games": True,
    "show_my_videos": True,
    "show_public_upload": False,
    "show_public_videos": True,
    "show_images": True,
    "autoplay": False,
    "show_suggestions": True
  },
  "integrations": {
    "discord_webhook_url": "",
    "discord_tag_mentions": {},
    "discord_ping_on_tag_add": True,
    "discord_attach_preview": True,
    "discord_upload_limit_mb": 20,
    "generic_webhook_url": "",
    "generic_webhook_payload": {},
    "steamgriddb_api_key": "",
    "discord_login_enabled": False,
    "discord_login_guild_id": "",
    "discord_login_required_role_id": "",
    "discord_login_default_preset": "contributor",
    "discord_login_disable_on_leave": False,
  },
  "rss_config": {
    "title": "Fireshare Feed",
    "description": "Latest videos from Fireshare"
  },
  "transcoding": {
    "encoder_preference": "auto",
    "auto_transcode": True,
    "enable_480p": True,
    "enable_720p": True,
    "enable_1080p": True,
    # HDR -> SDR tone mapping. "auto" is bt.2390 on a GPU and hable otherwise; the
    # automatic conversion of every HDR video stays off until an admin turns it on.
    "tonemap_default": "auto",
    "auto_tonemap": False,
  }
}

PUBLIC_UPLOAD_WARNING = (
    "Public uploads are enabled: anyone who can reach this server can upload without "
    "signing in. Turn off \"Allow Public Upload\" in Settings if that is not intended."
)
DISCORD_LOGIN_WARNING = (
    "Discord login is enabled in settings but DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET "
    "or DISCORD_REDIRECT_URI (or DOMAIN) is not set, so the button is hidden."
)

SUPPORTED_FILE_TYPES = ['mp4', 'm4v', 'mov', 'webm']
SUPPORTED_FILE_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm']

# HDR -> SDR tone map operators, in the order the UI lists them. All run through
# libplacebo when it has a GPU; hable, mobius and reinhard can also run through the
# built-in tonemap filter (which needs zscale/libzimg) on the CPU.
TONEMAP_OPERATORS = ('bt2390', 'spline', 'bt2446a', 'hable', 'mobius', 'reinhard')
# The curves only libplacebo has; the rest also exist in the built-in tonemap filter.
TONEMAP_PLACEBO_ONLY = ('bt2390', 'spline', 'bt2446a')
# Stored in VideoInfo.tonemap when the tone map was removed on purpose, so the
# automatic scan does not put the default back. NULL means nothing was ever chosen.
TONEMAP_OFF = 'none'
