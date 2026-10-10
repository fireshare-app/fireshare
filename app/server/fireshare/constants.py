DEFAULT_CONFIG = {
  "app_config": {
    "video_defaults": {
      "private": True
    },
    "image_defaults": {
      "private": True
    },
    "allow_public_upload": True,
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
    "generic_webhook_url": "",
    "generic_webhook_payload": {},
    "steamgriddb_api_key": "",
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

SUPPORTED_FILE_TYPES = ['mp4', 'm4v', 'mov', 'webm']
SUPPORTED_FILE_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm']

# HDR -> SDR tone map operators, in the order the UI lists them. bt2390 runs through
# libplacebo; the rest through the built-in tonemap filter (which needs zscale/libzimg).
TONEMAP_OPERATORS = ('bt2390', 'hable', 'mobius', 'reinhard')
# Stored in VideoInfo.tonemap when the tone map was removed on purpose, so the
# automatic scan does not put the default back. NULL means nothing was ever chosen.
TONEMAP_OFF = 'none'
