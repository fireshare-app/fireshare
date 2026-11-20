import os
from flask import Blueprint, Response

from .. import logger

templates_path = os.environ.get('TEMPLATE_PATH') or 'templates'
api = Blueprint('api', __name__, template_folder=templates_path)


@api.errorhandler(PermissionError)
def _filesystem_permission_denied(e):
    # Almost always a mounted folder the container's PUID/PGID cannot write to,
    # such as a fresh Docker named volume. Uncaught, it reached the client as a
    # bare 500 and the uploader saw only "An error occurred". Flask does not log
    # exceptions a handler takes, so log it here to keep the traceback.
    logger.exception(f"Permission denied: {e}")
    return Response(
        status=500,
        response="The server was denied access to a file or folder. "
                 "Fireshare's mounted folders must be writable by the container's PUID/PGID.",
    )


from . import transcoding, scan, misc, admin, video, upload, game, custom_games, tag, image, folder, profile, users, relink, upload_tokens  # noqa: E402,F401
