import json
import os
import random
import re
import string
import threading
from pathlib import Path
from subprocess import Popen

from flask import current_app, jsonify, request, Response
from flask_login import login_required, current_user

from .. import logger, util
from ..constants import SUPPORTED_FILE_TYPES
from ..models import Video
from .. import permissions as P
from . import api
from .decorators import require_perm
from .helpers import parse_client_mtime, sanitize_upload_folder, secure_filename
from . import transcoding as _transcoding_mod


def _check_upload_size(file_size_bytes):
    """Return a 413 Response if the file exceeds DEMO_UPLOAD_LIMIT_MB, else None."""
    if not current_app.config.get('DEMO_MODE'):
        return None
    limit_mb = current_app.config.get('DEMO_UPLOAD_LIMIT_MB', 0)
    if limit_mb and limit_mb > 0:
        if file_size_bytes > limit_mb * 1024 * 1024:
            return Response(
                status=413,
                response=f'File exceeds the {limit_mb} MB upload limit for this demo.',
            )
    return None


# A cap on totalChunks. Every chunk is one request and one file on disk, and the
# completeness check stats every part up to totalChunks, so an unbounded value
# lets a single request hold a worker thread for hours. 20000 chunks is still
# 1.8 TB at the browser's 90 MB chunk size.
MAX_CHUNKS = 20000


def _positive_int(value, maximum=None):
    """A positive int from form input, or None when it is missing, malformed, or out of range."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    if parsed < 1 or (maximum is not None and parsed > maximum):
        return None
    return parsed


def _parse_chunk_numbers():
    """(chunkPart, totalChunks, None) from the request form, or (None, None, a 400 Response).

    Every chunked upload route goes through this, so none of them loops over a
    client's totalChunks without the cap.
    """
    total_chunks = _positive_int(request.form.get('totalChunks'), MAX_CHUNKS)
    if not total_chunks:
        return None, None, Response(status=400, response=f'totalChunks must be between 1 and {MAX_CHUNKS}.')
    chunk_part = _positive_int(request.form.get('chunkPart'), total_chunks)
    if not chunk_part:
        return None, None, Response(status=400, response='chunkPart must be between 1 and totalChunks.')
    return chunk_part, total_chunks, None


def _parse_upload_metadata():
    """Return (tag_ids, game_id, title) parsed from current request form data."""
    tag_ids_raw = request.form.get('tag_ids', '')
    tag_ids = [int(t) for t in tag_ids_raw.split(',') if t.strip().isdigit()] or None
    game_id_raw = request.form.get('game_id', '')
    game_id = int(game_id_raw) if game_id_raw.strip().isdigit() else None
    title = request.form.get('title', '').strip() or None
    return tag_ids, game_id, title


def _current_uploader_id():
    """The id to attribute an upload to, or None for an anonymous public upload."""
    return current_user.id if current_user.is_authenticated else None


def _reject_duplicate(save_path):
    """
    If the file just written to save_path has the same content hash as a video
    already in the library, delete it and return a 409 response pointing at the
    existing video. Returns None when the upload is genuinely new.

    A row whose own file is missing from disk does not count: that upload is a
    restore, and scan-video flips the row back to available. Nor does the row
    whose path *is* save_path, which is the same restore landing exactly where
    the missing original used to live.
    """
    paths = current_app.config['PATHS']
    try:
        video_id = util.video_id(Path(save_path))
    except OSError as e:
        logger.warning(f"Could not hash upload {save_path} for duplicate check: {e}")
        return None
    existing = Video.query.filter_by(video_id=video_id).first()
    if not existing:
        return None
    existing_file = paths['video'] / existing.path
    if not existing_file.is_file() or existing_file.resolve() == Path(save_path).resolve():
        return None
    try:
        os.remove(save_path)
    except OSError as e:
        logger.warning(f"Could not remove duplicate upload {save_path}: {e}")
    title = existing.info.title if existing.info and existing.info.title else Path(existing.path).stem
    logger.info(f"Rejected duplicate upload {save_path}: identical to video {video_id} at {existing.path}")
    resp = jsonify({
        'error': 'duplicate',
        'message': 'This video is already in the library.',
        'video_id': video_id,
        'title': title,
        'url': f'/w/{video_id}',
    })
    resp.status_code = 409
    return resp


def _launch_scan_video(save_path, config, tag_ids=None, game_id=None, title=None, uploaded_by=None,
                       client_mtime=None):
    """
    Launch scan-video and publish an initial transcoding-running status when
    auto-transcode is enabled so SSE subscribers can reflect upload-triggered work.
    Optionally apply tag_ids and game_id to the video after the scan completes.
    client_mtime is the uploader's original modified time (see
    helpers.parse_client_mtime), the recorded date when the file has none.
    """
    paths = current_app.config['PATHS']
    data_path = paths['data']
    videos_path = paths['video']
    app = current_app._get_current_object()
    cmd = ["fireshare", "scan-video", f"--path={save_path}"]
    if tag_ids:
        cmd.append(f"--tag-ids={','.join(str(t) for t in tag_ids)}")
    if game_id:
        cmd.append(f"--game-id={game_id}")
    if title:
        cmd.append(f"--title={title}")
    if uploaded_by is not None:
        cmd.append(f"--uploaded-by={int(uploaded_by)}")
    if client_mtime is not None:
        cmd.append(f"--client-mtime={float(client_mtime)}")
    scan_proc = Popen(cmd, shell=False, start_new_session=True)

    def reap_and_cleanup():
        try:
            scan_proc.wait()
            status = util.read_transcoding_status(data_path)
            if status.get('pid') == scan_proc.pid:
                util.clear_transcoding_status(data_path)
        except Exception as e:
            logger.debug(f"Scan process cleanup skipped: {e}")

    threading.Thread(target=reap_and_cleanup, daemon=True).start()

    transcoding_enabled = current_app.config.get('ENABLE_TRANSCODING', False)
    auto_transcode = config.get('transcoding', {}).get('auto_transcode', True)
    transcode_already_running = _transcoding_mod._transcoding_process is not None and _transcoding_mod._transcoding_process.poll() is None
    if transcoding_enabled and auto_transcode and not transcode_already_running:
        try:
            util.write_transcoding_status(data_path, 0, 0, None, scan_proc.pid)
        except Exception as e:
            logger.warning(f"Failed to write initial upload transcoding status: {e}")

    return scan_proc


@api.route('/api/upload/public', methods=['POST'])
def public_upload_video():
    paths = current_app.config['PATHS']
    with open(paths['data'] / 'config.json', 'r') as configfile:
        try:
            config = json.load(configfile)
        except:
            logger.error("Invalid or corrupt config file")
            return Response(status=400)
        configfile.close()

    if not config['app_config']['allow_public_upload']:
        logger.warning("A public upload attempt was made but public uploading is disabled")
        return Response(status=401)

    upload_folder = config['app_config']['public_upload_folder_name']
    if config['app_config'].get('allow_public_folder_selection', False):
        requested_folder = sanitize_upload_folder(request.form.get('folder'))
        if requested_folder:
            upload_folder = requested_folder

    if 'file' not in request.files:
        return Response(status=400)
    file = request.files['file']
    if file.filename == '':
        return Response(status=400)
    filename = secure_filename(file.filename)
    if not filename:
        return Response(status=400)
    filetype = filename.split('.')[-1]
    if filetype.lower() not in SUPPORTED_FILE_TYPES:
        return Response(status=400)
    file.seek(0, 2)
    size_err = _check_upload_size(file.tell())
    file.seek(0)
    if size_err:
        return size_err
    upload_directory = paths['video'] / upload_folder
    os.makedirs(upload_directory, exist_ok=True)
    save_path = os.path.join(upload_directory, filename)
    if (os.path.exists(save_path)):
        name_no_type = ".".join(filename.split('.')[0:-1])
        uid = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
        save_path = os.path.join(paths['video'], upload_folder, f"{name_no_type}-{uid}.{filetype}")
    file.save(save_path)
    duplicate = _reject_duplicate(save_path)
    if duplicate:
        return duplicate
    _launch_scan_video(save_path, config, *_parse_upload_metadata(),
                       uploaded_by=_current_uploader_id(),
                       client_mtime=parse_client_mtime(request.form.get('lastModified')))
    return Response(status=201)


@api.route('/api/uploadChunked/public', methods=['POST'])
def public_upload_videoChunked():
    paths = current_app.config['PATHS']
    with open(paths['data'] / 'config.json', 'r') as configfile:
        try:
            config = json.load(configfile)
        except:
            logger.error("Invalid or corrupt config file")
            return Response(status=400)
        configfile.close()

    if not config['app_config']['allow_public_upload']:
        logger.warning("A public upload attempt was made but public uploading is disabled")
        return Response(status=401)

    upload_folder = config['app_config']['public_upload_folder_name']

    required_files = ['blob']
    required_form_fields = ['chunkPart', 'totalChunks', 'checkSum', 'fileSize']
    if not all(key in request.files for key in required_files) or not all(key in request.form for key in required_form_fields):
        return Response(status=400)
    blob = request.files.get('blob')
    chunkPart, totalChunks, chunk_error = _parse_chunk_numbers()
    if chunk_error:
        return chunk_error
    checkSum = re.sub(r'[^a-zA-Z0-9_-]', '', request.form.get('checkSum'))
    fileSize = int(request.form.get('fileSize'))
    if not checkSum:
        return Response(status=400)
    if not blob.filename or blob.filename.strip() == '' or blob.filename == 'blob':
        return Response(status=400)
    filename = secure_filename(blob.filename)
    if not filename:
        return Response(status=400)
    filetype = filename.split('.')[-1]  # TODO, probe filetype with fmpeg instead and remux to supporrted
    if filetype.lower() not in SUPPORTED_FILE_TYPES:
        return Response(status=400)
    size_err = _check_upload_size(fileSize)
    if size_err:
        return size_err

    if config['app_config'].get('allow_public_folder_selection', False):
        requested_folder = sanitize_upload_folder(request.form.get('folder'))
        if requested_folder:
            upload_folder = requested_folder

    upload_directory = paths['video'] / upload_folder
    os.makedirs(upload_directory, exist_ok=True)

    tempPath = os.path.join(upload_directory, f"{checkSum}.part{chunkPart:04d}")
    # Guard against path traversal: ensure the resolved path stays within upload_directory
    if not os.path.realpath(tempPath).startswith(os.path.realpath(upload_directory) + os.sep):
        return Response(status=400)

    with open(tempPath, 'wb') as f:
        f.write(blob.read())

    # Check if we have all chunks
    chunk_files = []
    for i in range(1, totalChunks + 1):
        chunk_path = os.path.join(upload_directory, f"{checkSum}.part{i:04d}")
        if os.path.exists(chunk_path):
            chunk_files.append(chunk_path)

    if len(chunk_files) != totalChunks:
        return Response(status=202)

    save_path = os.path.join(upload_directory, filename)

    if os.path.exists(save_path):
        name_no_type = ".".join(filename.split('.')[0:-1])
        uid = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
        save_path = os.path.join(paths['video'], upload_folder, f"{name_no_type}-{uid}.{filetype}")

    try:
        with open(save_path, 'wb') as output_file:
            for i in range(1, totalChunks + 1):
                chunk_path = os.path.join(upload_directory, f"{checkSum}.part{i:04d}")
                with open(chunk_path, 'rb') as chunk_file:
                    output_file.write(chunk_file.read())
                os.remove(chunk_path)

        if os.path.getsize(save_path) != fileSize:
            os.remove(save_path)
            return Response(status=500, response="File size mismatch after reassembly")

    except Exception as e:
        for chunk_path in chunk_files:
            if os.path.exists(chunk_path):
                os.remove(chunk_path)
        if os.path.exists(save_path):
            os.remove(save_path)
        if isinstance(e, PermissionError):
            raise  # the API's PermissionError handler logs it and explains the cause
        logger.exception(f"Could not reassemble upload {save_path}: {e}")
        return Response(status=500, response="Error reassembling file")

    duplicate = _reject_duplicate(save_path)
    if duplicate:
        return duplicate
    _launch_scan_video(save_path, config, *_parse_upload_metadata(),
                       uploaded_by=_current_uploader_id(),
                       client_mtime=parse_client_mtime(request.form.get('lastModified')))
    return Response(status=201)


@api.route('/api/upload-folders', methods=['GET'])
@login_required
def get_upload_folders():
    paths = current_app.config['PATHS']
    video_path = paths['video']
    folders = []
    try:
        for entry in os.scandir(video_path):
            if entry.is_dir() and not entry.name.startswith('.'):
                folders.append(entry.name)
        folders.sort()
    except Exception:
        pass
    default_folder = None
    try:
        with open(paths['data'] / 'config.json', 'r') as configfile:
            config = json.load(configfile)
        default_folder = config['app_config']['admin_upload_folder_name']
    except Exception:
        pass
    if default_folder and default_folder not in folders:
        folders.append(default_folder)
        folders.sort()
    return jsonify({'folders': folders, 'default_folder': default_folder})


@api.route('/api/upload-folders/public', methods=['GET'])
def get_public_upload_folders():
    paths = current_app.config['PATHS']
    try:
        with open(paths['data'] / 'config.json', 'r') as configfile:
            config = json.load(configfile)
    except Exception:
        return jsonify({'folders': [], 'default_folder': None})

    if not config.get('app_config', {}).get('allow_public_folder_selection', False):
        return Response(status=403)

    video_path = paths['video']
    folders = []
    try:
        for entry in os.scandir(video_path):
            if entry.is_dir() and not entry.name.startswith('.'):
                folders.append(entry.name)
        folders.sort()
    except Exception:
        pass

    default_folder = config['app_config'].get('public_upload_folder_name')
    if default_folder and default_folder not in folders:
        folders.append(default_folder)
        folders.sort()
    return jsonify({'folders': folders, 'default_folder': default_folder})


@api.route('/api/upload', methods=['POST'])
@require_perm(P.UPLOAD)
def upload_video():
    paths = current_app.config['PATHS']
    with open(paths['data'] / 'config.json', 'r') as configfile:
        try:
            config = json.load(configfile)
        except:
            return Response(status=500, response="Invalid or corrupt config file")
        configfile.close()

    upload_folder = config['app_config']['admin_upload_folder_name']
    requested_folder = sanitize_upload_folder(request.form.get('folder'))
    if requested_folder:
        upload_folder = requested_folder

    if 'file' not in request.files:
        return Response(status=400)
    file = request.files['file']
    if file.filename == '':
        return Response(status=400)
    filename = secure_filename(file.filename)
    if not filename:
        return Response(status=400)
    filetype = filename.split('.')[-1]
    if filetype.lower() not in SUPPORTED_FILE_TYPES:
        return Response(status=400)
    file.seek(0, 2)
    size_err = _check_upload_size(file.tell())
    file.seek(0)
    if size_err:
        return size_err
    upload_directory = paths['video'] / upload_folder
    os.makedirs(upload_directory, exist_ok=True)
    save_path = os.path.join(upload_directory, filename)
    if (os.path.exists(save_path)):
        name_no_type = ".".join(filename.split('.')[0:-1])
        uid = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
        save_path = os.path.join(paths['video'], upload_folder, f"{name_no_type}-{uid}.{filetype}")
    file.save(save_path)
    duplicate = _reject_duplicate(save_path)
    if duplicate:
        return duplicate
    _launch_scan_video(save_path, config, *_parse_upload_metadata(),
                       uploaded_by=_current_uploader_id(),
                       client_mtime=parse_client_mtime(request.form.get('lastModified')))
    return Response(status=201)


@api.route('/api/uploadChunked', methods=['POST'])
@require_perm(P.UPLOAD)
def upload_videoChunked():
    paths = current_app.config['PATHS']
    with open(paths['data'] / 'config.json', 'r') as configfile:
        try:
            config = json.load(configfile)
        except:
            return Response(status=500, response="Invalid or corrupt config file")
        configfile.close()

    upload_folder = config['app_config']['admin_upload_folder_name']
    requested_folder = sanitize_upload_folder(request.form.get('folder'))
    if requested_folder:
        upload_folder = requested_folder

    required_files = ['blob']
    required_form_fields = ['chunkPart', 'totalChunks', 'checkSum', 'fileName', 'fileSize']

    if not all(key in request.files for key in required_files) or not all(key in request.form for key in required_form_fields):
        return Response(status=400)

    blob = request.files.get('blob')
    chunkPart, totalChunks, chunk_error = _parse_chunk_numbers()
    if chunk_error:
        return chunk_error
    checkSum = re.sub(r'[^a-zA-Z0-9_-]', '', request.form.get('checkSum'))
    fileName = secure_filename(request.form.get('fileName'))
    fileSize = int(request.form.get('fileSize'))

    if not checkSum:
        return Response(status=400)

    if not fileName:
        return Response(status=400)

    filetype = fileName.split('.')[-1]
    if filetype.lower() not in SUPPORTED_FILE_TYPES:
        return Response(status=400)

    size_err = _check_upload_size(fileSize)
    if size_err:
        return size_err

    upload_directory = paths['video'] / upload_folder
    os.makedirs(upload_directory, exist_ok=True)

    # Store chunks with part number to ensure proper ordering
    tempPath = os.path.join(upload_directory, f"{checkSum}.part{chunkPart:04d}")
    # Guard against path traversal: ensure the resolved path stays within upload_directory
    if not os.path.realpath(tempPath).startswith(os.path.realpath(upload_directory) + os.sep):
        return Response(status=400)

    # Write this specific chunk
    with open(tempPath, 'wb') as f:
        f.write(blob.read())

    # Check if we have all chunks
    chunk_files = []
    for i in range(1, totalChunks + 1):
        chunk_path = os.path.join(upload_directory, f"{checkSum}.part{i:04d}")
        if os.path.exists(chunk_path):
            chunk_files.append(chunk_path)

    # If we don't have all chunks yet, return 202
    if len(chunk_files) != totalChunks:
        return Response(status=202)

    # All chunks received, reassemble the file
    save_path = os.path.join(upload_directory, fileName)

    if os.path.exists(save_path):
        name_no_type = ".".join(fileName.split('.')[0:-1])
        uid = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
        save_path = os.path.join(upload_directory, f"{name_no_type}-{uid}.{filetype}")

    # Reassemble chunks in correct order
    try:
        with open(save_path, 'wb') as output_file:
            for i in range(1, totalChunks + 1):
                chunk_path = os.path.join(upload_directory, f"{checkSum}.part{i:04d}")
                with open(chunk_path, 'rb') as chunk_file:
                    output_file.write(chunk_file.read())
                # Clean up chunk file
                os.remove(chunk_path)

        # Verify file size
        if os.path.getsize(save_path) != fileSize:
            os.remove(save_path)
            return Response(status=500, response="File size mismatch after reassembly")

    except Exception as e:
        # Clean up on error
        for chunk_path in chunk_files:
            if os.path.exists(chunk_path):
                os.remove(chunk_path)
        if os.path.exists(save_path):
            os.remove(save_path)
        if isinstance(e, PermissionError):
            raise  # the API's PermissionError handler logs it and explains the cause
        logger.exception(f"Could not reassemble upload {save_path}: {e}")
        return Response(status=500, response="Error reassembling file")

    duplicate = _reject_duplicate(save_path)
    if duplicate:
        return duplicate
    _launch_scan_video(save_path, config, *_parse_upload_metadata(),
                       uploaded_by=_current_uploader_id(),
                       client_mtime=parse_client_mtime(request.form.get('lastModified')))
    return Response(status=201)
