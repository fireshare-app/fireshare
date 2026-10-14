import os
from flask import Blueprint

templates_path = os.environ.get('TEMPLATE_PATH') or 'templates'
api = Blueprint('api', __name__, template_folder=templates_path)

from . import transcoding, scan, misc, admin, video, upload, game, custom_games, tag, image, folder, profile, users, relink, upload_tokens  # noqa: E402,F401
