import os
import fcntl
import tempfile
from contextlib import contextmanager
from pathlib import Path
import json
import subprocess as sp
import xxhash
from fireshare import logger
import time
import glob
import shutil
import re
import threading
from datetime import datetime

# Corruption indicators to detect during video validation
# These are ffmpeg error messages that indicate file corruption
VIDEO_CORRUPTION_INDICATORS = [
    "Corrupt frame detected",
    "No sequence header",
    "Error submitting packet to decoder",
    "Invalid data found when processing input",
    "Decode error rate",
    "moov atom not found",
    "Invalid NAL unit size",
    "non-existing PPS",
    "Could not find codec parameters",
]

# Corruption indicators that are known false positives for AV1 files
# These warnings can occur during initial frame decoding of valid AV1 files
# and should be ignored if the decode test succeeds (returncode 0)
# Note: Values are lowercase for consistent case-insensitive matching
AV1_FALSE_POSITIVE_INDICATORS = frozenset([
    "corrupt frame detected",
    "no sequence header",
    "error submitting packet to decoder",
    "decode error rate",
    "invalid nal unit size",
    "non-existing pps",
])

# Known AV1 codec names as reported by ffprobe (lowercase for matching)
# These are used to detect AV1-encoded source files for special handling
AV1_CODEC_NAMES = frozenset([
    'av1',
    'libaom-av1',
    'libsvtav1',
    'av1_nvenc',
    'av1_qsv',
])

def lock_exists(path: Path, filename: str = "fireshare.lock"):
    """
    Checks if a lockfile exists and the owning process is still alive.
    Automatically removes stale locks left by crashed processes.
    """
    lockfile = path / filename
    if not lockfile.exists():
        return False
    try:
        with open(lockfile, 'r') as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)  # signal 0 just checks liveness, sends nothing
        return True
    except (ValueError, ProcessLookupError, OSError):
        logger.debug(f"Removing stale lockfile at {str(lockfile)}")
        try:
            os.remove(lockfile)
        except Exception:
            pass
        return False

def create_lock(path: Path, filename: str = "fireshare.lock"):
    """
    Creates the lock file, writing the current PID so stale locks can be detected.
    """
    lockfile = path / filename
    if not lockfile.exists():
        logger.debug(f"A lockfile has been created at {str(lockfile)}")
        with open(lockfile, 'w') as f:
            f.write(str(os.getpid()))

def remove_lock(path: Path, filename: str = "fireshare.lock"):
    """
    Deletes the lock file
    """
    lockfile = path / filename
    if lockfile.exists():
        logger.debug(f"A lockfile has been removed at {str(lockfile)}")
        os.remove(lockfile)


_VIDEO_LOCK_DIR = Path(tempfile.gettempdir()) / "fireshare-video-locks"

def _open_video_lock_file(video_id):
    # The web process and a `fireshare` command run by hand through `docker exec` are
    # different users, so the directory is left open to everyone, like /tmp itself.
    try:
        _VIDEO_LOCK_DIR.mkdir()
        os.chmod(_VIDEO_LOCK_DIR, 0o1777)
    except FileExistsError:
        pass
    path = _VIDEO_LOCK_DIR / f"{video_id}.lock"
    # Read-only is enough for flock. O_CREAT only ever runs with O_EXCL, because Linux
    # refuses O_CREAT on another user's file in a sticky directory (protected_regular).
    try:
        return os.open(path, os.O_RDONLY)
    except FileNotFoundError:
        pass
    try:
        return os.open(path, os.O_RDONLY | os.O_CREAT | os.O_EXCL, 0o644)
    except FileExistsError:
        return os.open(path, os.O_RDONLY)

@contextmanager
def video_lock(video_id, wait=True):
    """
    Hold the lock on one video's crop and transcodes for the length of the block.

    Saving a crop rebuilds them in a thread of the web process while the scheduled
    scan transcodes in a process of its own, and the two used to write the same files
    at once. Yields True once the lock is held, or False straight away when wait is
    False and someone else holds it. flock is released by the kernel when its holder
    exits, so a crash can never leave a video locked. The files live in the local
    temp dir because every process that takes the lock runs in the same container.
    """
    try:
        fd = _open_video_lock_file(video_id)
    except OSError as ex:
        logger.warning(f"Could not open the lock for video {video_id}, continuing without it: {ex}")
        yield True
        return
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            held = False
        else:
            held = True
        yield held
    finally:
        os.close(fd)  # releases the lock


# Transcoding status file functions
TRANSCODING_STATUS_FILE = "transcoding_status.json"

def write_transcoding_status(data_path: Path, current: int, total: int, current_video: str = None, pid: int = None, percent: float = None, eta_seconds: float = None, resolution: str = None):
    """
    Writes the current transcoding progress to a status file.
    Called by the CLI during transcoding to report progress.
    If pid is provided, it will be included. Otherwise, uses the current process PID.
    percent and eta_seconds are optional per-video progress info from ffmpeg.
    resolution is the target resolution (e.g., "1080p").
    """
    status_file = data_path / TRANSCODING_STATUS_FILE

    # Always include a concrete PID for liveness checks in SSE/API consumers.
    # CLI calls omit pid, so stamp the current process PID in that case.
    if pid is None:
        pid = os.getpid()

    status = {
        "is_running": True,
        "current": current,
        "total": total,
        "current_video": current_video,
        "pid": pid
    }
    # Include progress data if available
    if percent is not None:
        status["percent"] = round(percent, 1)
    if eta_seconds is not None:
        status["eta_seconds"] = round(eta_seconds)
    if resolution is not None:
        status["resolution"] = resolution
    tmp_file = status_file.with_suffix(f"{status_file.suffix}.tmp")
    try:
        with open(tmp_file, 'w') as f:
            json.dump(status, f)
        # Atomic replace prevents readers from seeing partial JSON.
        os.replace(tmp_file, status_file)
    except Exception as e:
        logger.warning(f"Failed to write transcoding status: {e}")
        try:
            if tmp_file.exists():
                os.remove(tmp_file)
        except Exception:
            pass

def read_transcoding_status(data_path: Path) -> dict:
    """
    Reads the current transcoding progress from the status file.
    Returns default values if file doesn't exist or is invalid.
    """
    status_file = data_path / TRANSCODING_STATUS_FILE
    default_status = {"is_running": False, "current": 0, "total": 0, "current_video": None, "pid": None}

    if not status_file.exists():
        return default_status

    try:
        with open(status_file, 'r') as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"Failed to read transcoding status: {e}")
        return default_status

def clear_transcoding_status(data_path: Path):
    """
    Removes the transcoding status file when transcoding completes or is cancelled.
    """
    status_file = data_path / TRANSCODING_STATUS_FILE
    if status_file.exists():
        try:
            os.remove(status_file)
        except Exception as e:
            logger.warning(f"Failed to remove transcoding status file: {e}")


def video_id(path: Path, mb=16):
    """
    Calculates the id of a video by using xxhash on the first 16mb (or the whole file if it's less than that)
    """
    with path.open('rb', 0) as f:
        file_header = f.read(int(1024*1024*mb))
    return xxhash.xxh3_128_hexdigest(file_header)

def get_media_info(path):
    try:
        cmd = ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_entries', 'stream', str(path)]
        logger.debug(f"$ {' '.join(cmd)}")
        data = json.loads(sp.check_output(cmd).decode('utf-8'))
        return data['streams']
    except Exception as ex:
        logger.warning('Could not extract video info')
        return None

def get_video_duration(path):
    """
    Get the duration of a video file in seconds.
    
    Args:
        path: Path to the video file
    
    Returns:
        float: Duration in seconds, or None if unable to determine
    """
    try:
        cmd = ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_entries', 'format=duration', str(path)]
        logger.debug(f"$ {' '.join(cmd)}")
        data = json.loads(sp.check_output(cmd).decode('utf-8'))
        if 'format' in data and 'duration' in data['format']:
            return float(data['format']['duration'])
    except Exception as ex:
        logger.debug(f'Could not extract video duration: {ex}')
    return None

def get_video_framerate(path):
    """
    Get the average frame rate of a video file's first video stream.

    Returns:
        float: Frames per second, or None if unable to determine
    """
    try:
        cmd = ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-select_streams', 'v:0',
               '-show_entries', 'stream=avg_frame_rate,r_frame_rate', str(path)]
        logger.debug(f"$ {' '.join(cmd)}")
        stream = json.loads(sp.check_output(cmd).decode('utf-8'))['streams'][0]
        for key in ('avg_frame_rate', 'r_frame_rate'):
            num, _, den = stream.get(key, '').partition('/')
            if num and den and float(den) > 0 and float(num) > 0:
                return float(num) / float(den)
    except Exception as ex:
        logger.debug(f'Could not extract video frame rate: {ex}')
    return None

def validate_video_file(path, timeout=30):
    """
    Validate that a video file is not corrupt and can be decoded.
    
    This function performs a quick decode test on the first few seconds of the video
    to detect corruption issues like missing sequence headers, corrupt frames, etc.
    
    For AV1 files, validation is more lenient as some AV1 encoders produce files
    that generate warnings during initial frame decoding but play back correctly.
    
    Args:
        path: Path to the video file
        timeout: Maximum time in seconds to wait for validation (default: 30)
    
    Returns:
        tuple: (is_valid: bool, error_message: str or None, preferred_decoder: str or None)
            - (True, None, None) if the video is valid with the default decoder
            - (True, None, 'libdav1d') if valid only with the dav1d fallback decoder
            - (False, error_message, None) if the video is corrupt or unreadable
    """
    # Check if ffprobe and ffmpeg are available using shutil.which
    if not shutil.which('ffprobe'):
        return False, "ffprobe command not found - ensure ffmpeg is installed", None
    if not shutil.which('ffmpeg'):
        return False, "ffmpeg command not found - ensure ffmpeg is installed", None

    try:
        # First, check if ffprobe can read the stream information
        probe_cmd = [
            'ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name,width,height',
            '-of', 'json', str(path)
        ]
        logger.debug(f"Validating video file: {' '.join(probe_cmd)}")

        probe_result = sp.run(probe_cmd, capture_output=True, text=True, timeout=timeout)

        if probe_result.returncode != 0:
            error_msg = probe_result.stderr.strip() if probe_result.stderr else "Unknown error reading video metadata"
            return False, f"ffprobe failed: {error_msg}", None

        # Check if we got valid stream data
        # Note: -select_streams v:0 in probe_cmd ensures only video streams are returned
        try:
            probe_data = json.loads(probe_result.stdout)
            streams = probe_data.get('streams', [])
            if not streams:
                return False, "No video streams found in file", None
        except json.JSONDecodeError:
            return False, "Failed to parse video metadata", None

        # Get the codec name from the video stream
        # Safe to access streams[0] because we checked for empty streams above
        video_stream = streams[0]
        codec_name = video_stream.get('codec_name', '').lower()

        # Detect if the source file is AV1-encoded
        # AV1 files may produce false positive corruption warnings during initial frame decoding
        is_av1_source = codec_name in AV1_CODEC_NAMES

        def _run_decode_test(decoder=None):
            """Run the 2-second decode test, optionally with an explicit input decoder."""
            cmd = ['ffmpeg', '-v', 'error', '-t', '2']
            if decoder:
                cmd.extend(['-c:v', decoder])
            cmd.extend(['-i', str(path), '-f', 'null', '-'])
            logger.debug(f"Decode test: {' '.join(cmd)}")
            return sp.run(cmd, capture_output=True, text=True, timeout=timeout)

        decode_result = _run_decode_test()

        # Check for decode errors - only treat as error if return code is non-zero
        # or if stderr contains known corruption indicators
        stderr = decode_result.stderr.strip() if decode_result.stderr else ""
        stderr_lower = stderr.lower()

        # For AV1 files, be more lenient about certain error messages
        # Some AV1 encoders produce files that generate warnings/errors during initial
        # frame decoding (e.g., "Corrupt frame detected", "No sequence header") but
        # play back correctly. This is especially common with files that use temporal
        # scalability or have non-standard sequence header placement.
        if is_av1_source:
            # Check if the only errors are known false positives for AV1
            found_real_error = False
            found_false_positive = False
            libaom_unsupported = False

            for indicator in VIDEO_CORRUPTION_INDICATORS:
                indicator_lower = indicator.lower()
                if indicator_lower in stderr_lower:
                    if indicator_lower in AV1_FALSE_POSITIVE_INDICATORS:
                        found_false_positive = True
                    else:
                        found_real_error = True
                        if indicator_lower == "invalid data found when processing input":
                            libaom_unsupported = True
                        else:
                            return False, f"Video file appears to be corrupt: {indicator}", None

            # If libaom can't handle this bitstream, try dav1d as a fallback
            if libaom_unsupported:
                if check_dav1d_available():
                    logger.debug("libaom cannot decode this AV1 bitstream, retrying with dav1d...")
                    dav1d_result = _run_decode_test(decoder='libdav1d')
                    if dav1d_result.returncode == 0:
                        logger.debug("AV1 file validated successfully with dav1d decoder")
                        return True, None, 'libdav1d'
                    dav1d_stderr = dav1d_result.stderr.strip() if dav1d_result.stderr else ""
                    return False, f"AV1 decode failed with both libaom and dav1d: {dav1d_stderr[:200]}", None
                return False, "AV1 file uses features unsupported by the libaom decoder (dav1d not available)", None

            # If we only found false positives (no real errors), the file is valid
            if found_false_positive and not found_real_error:
                logger.debug(f"AV1 file had known false positive warnings during validation (ignoring): {stderr[:200]}")
                return True, None, None

            # If returncode is non-zero, fail (either with stderr message or generic failure)
            if decode_result.returncode != 0:
                if stderr:
                    return False, f"Decode test failed: {stderr[:200]}", None
                else:
                    return False, "Decode test failed with no error message", None

            return True, None, None
        else:
            # For non-AV1 files, use strict validation
            if decode_result.returncode != 0:
                # Decode failed - check for specific corruption indicators
                for indicator in VIDEO_CORRUPTION_INDICATORS:
                    if indicator.lower() in stderr_lower:
                        return False, f"Video file appears to be corrupt: {indicator}", None
                # Generic decode failure
                return False, f"Decode test failed: {stderr[:200] if stderr else 'Unknown error'}", None

            # Return code is 0 (success), but check for corruption indicators in warnings
            for indicator in VIDEO_CORRUPTION_INDICATORS:
                if indicator.lower() in stderr_lower:
                    return False, f"Video file appears to be corrupt: {indicator}", None

        return True, None, None

    except sp.TimeoutExpired:
        return False, f"Validation timed out after {timeout} seconds", None
    except FileNotFoundError:
        return False, "Video file not found", None
    except Exception as ex:
        return False, f"Validation error: {str(ex)}", None


def calculate_transcode_timeout(video_path, base_timeout=7200):
    """
    Calculate a smart timeout for video transcoding based on video duration.
    
    For CPU encoding, a reasonable estimate is:
    - Real-time encoding takes duration * 1x
    - Slow CPU encoding can take 10-20x the duration
    - We add a safety margin of 3x on top
    
    Args:
        video_path: Path to the video file
        base_timeout: Base timeout in seconds (used if duration can't be determined)
    
    Returns:
        int: Timeout in seconds
    """
    duration = get_video_duration(video_path)
    
    if duration:
        # Use 60x the video duration as timeout (assumes worst case 20x encoding + 3x safety margin)
        # Minimum of 600 seconds (10 minutes) for very short videos
        calculated_timeout = max(int(duration * 60), 600)
        # Cap at 8 hours to prevent truly stuck processes
        calculated_timeout = min(calculated_timeout, 28800)
        logger.debug(f"Calculated transcode timeout: {calculated_timeout}s for video duration {duration}s")
        return calculated_timeout
    else:
        logger.debug(f"Could not determine video duration, using base timeout: {base_timeout}s")
        return base_timeout

def create_video_crop(source_path, out_path, start_time=None, end_time=None):
    """
    Stream-copy a segment of source_path into out_path using FFmpeg.
    start_time / end_time are in seconds (float). None means file start/end.
    Uses -c copy (no re-encode) so this is fast even for large files.
    Returns True on success, False on failure.
    """
    out_path = Path(out_path)
    # Written beside the final path and renamed in on success. nginx serves the crop in
    # place of the original as soon as it exists, and +faststart rewrites the whole file
    # in a second pass, so a crop still being written must never appear under its name.
    tmp_path = out_path.parent / (out_path.stem + '.tmp.mp4')
    cmd = ['ffmpeg', '-y']
    if start_time:
        cmd += ['-ss', str(start_time)]
    if end_time:
        cmd += ['-to', str(end_time)]
    cmd += ['-i', str(source_path), '-c', 'copy', '-movflags', '+faststart', str(tmp_path)]
    logger.debug(f"$ {' '.join(cmd)}")
    result = sp.call(cmd)
    if result == 0:
        os.replace(tmp_path, out_path)
        logger.info(f'Created crop {str(out_path)} (start={start_time}, end={end_time})')
    else:
        tmp_path.unlink(missing_ok=True)
        logger.error(f'Failed to create crop {str(out_path)} (exit code {result})')
    return result == 0


def create_audio_extract(source_path, out_path):
    """
    Extract a tiny mono audio-only MP3 from source_path for waveform display.
    Low bitrate + mono keeps the file small so WaveSurfer loads/decodes quickly.
    Returns True on success, False on failure.
    """
    cmd = [
        'ffmpeg', '-v', 'quiet', '-y',
        '-i', str(source_path),
        '-vn',           # drop video
        '-ac', '1',      # mono
        '-ar', '22050',  # 22 kHz sample rate (plenty for a waveform visual)
        '-b:a', '32k',   # 32 kbps — keeps file tiny
        str(out_path),
    ]
    logger.debug(f"$ {' '.join(cmd)}")
    result = sp.call(cmd)
    if result == 0:
        logger.info(f'Created audio extract {str(out_path)}')
    else:
        logger.error(f'Failed to create audio extract {str(out_path)} (exit code {result})')
    return result == 0


def create_poster(video_path, out_path, second=0):
    s = time.time()
    out_path = Path(out_path)
    # Rendered beside the final path and renamed in, so a request for the poster never
    # reads one ffmpeg is still writing, and a failed attempt leaves the old one in place.
    tmp_path = out_path.parent / (out_path.stem + '.tmp' + out_path.suffix)
    # -ss before -i uses fast keyframe seek, reliable even for large high-bitrate files
    cmd = ['ffmpeg', '-v', 'quiet', '-y', '-ss', str(second), '-i', str(video_path), '-vframes', '1', '-vf', 'scale=iw:ih:force_original_aspect_ratio=decrease', str(tmp_path)]
    logger.debug(f"$ {' '.join(cmd)}")
    ret = sp.call(cmd)
    e = time.time()
    success = ret == 0 and tmp_path.exists() and tmp_path.stat().st_size > 0
    if not success and second != 0:
        # Fall back to first frame if the seek position failed
        logger.warning(f"Poster generation failed at {second}s (exit {ret}), retrying with first frame")
        cmd[3] = '0'
        ret = sp.call(cmd)
        success = ret == 0 and tmp_path.exists() and tmp_path.stat().st_size > 0
    if success:
        os.replace(tmp_path, out_path)
    else:
        tmp_path.unlink(missing_ok=True)
    logger.debug(f'Generated poster {str(out_path)} in {e-s}s (success={success})')
    return success


# ---------------------------------------------------------------------------
# Image utilities
# ---------------------------------------------------------------------------

SUPPORTED_IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.gif'}


def is_image_file(path: Path) -> bool:
    return path.suffix.lower() in SUPPORTED_IMAGE_EXTENSIONS


def image_id(path: Path, mb: int = 16) -> str:
    """Calculate a unique ID for an image using xxhash on the first 16 MB."""
    with path.open('rb', 0) as f:
        file_header = f.read(int(1024 * 1024 * mb))
    return xxhash.xxh3_128_hexdigest(file_header)


def create_image_webp(src_path: Path, out_path: Path, quality: int = 90) -> bool:
    """Convert an image to full-quality WebP for the detail/viewer page."""
    try:
        from PIL import Image as PILImage
        s = time.time()
        with PILImage.open(str(src_path)) as img:
            # Handle animated GIFs — use first frame only
            if hasattr(img, 'n_frames') and img.n_frames > 1:
                img.seek(0)
            img = img.convert('RGBA') if img.mode in ('RGBA', 'LA', 'P') else img.convert('RGB')
            img.save(str(out_path), 'WEBP', quality=quality, method=4)
        e = time.time()
        logger.debug(f'Created full-quality WebP {str(out_path)} in {e - s:.2f}s')
        return True
    except Exception as ex:
        logger.error(f'Failed to create WebP {str(out_path)}: {ex}')
        return False


def create_image_thumbnail(src_path: Path, out_path: Path, max_width: int = 400, quality: int = 75) -> bool:
    """Create a low-resolution WebP thumbnail for card display."""
    try:
        from PIL import Image as PILImage
        s = time.time()
        with PILImage.open(str(src_path)) as img:
            if hasattr(img, 'n_frames') and img.n_frames > 1:
                img.seek(0)
            img = img.convert('RGBA') if img.mode in ('RGBA', 'LA', 'P') else img.convert('RGB')
            if img.width > max_width:
                ratio = max_width / img.width
                new_height = int(img.height * ratio)
                img = img.resize((max_width, new_height))
            img.save(str(out_path), 'WEBP', quality=quality, method=4)
        e = time.time()
        logger.debug(f'Created thumbnail {str(out_path)} in {e - s:.2f}s')
        return True
    except Exception as ex:
        logger.error(f'Failed to create thumbnail {str(out_path)}: {ex}')
        return False


def get_image_dimensions(path: Path):
    """Return (width, height) of an image, or (None, None) on failure."""
    try:
        from PIL import Image as PILImage
        with PILImage.open(str(path)) as img:
            return img.width, img.height
    except Exception as ex:
        logger.warning(f'Could not get image dimensions for {path}: {ex}')
        return None, None


# Cache for NVENC availability check to avoid repeated subprocess calls
_nvenc_availability_cache = {}

# Cache for dav1d decoder availability (None = unchecked, True/False = result)
_dav1d_available_cache = None

def check_dav1d_available():
    """Check if the libdav1d AV1 decoder is available in ffmpeg. Result is cached."""
    global _dav1d_available_cache
    if _dav1d_available_cache is not None:
        return _dav1d_available_cache
    try:
        result = sp.run(
            ['ffmpeg', '-hide_banner', '-decoders'],
            capture_output=True, text=True, timeout=10
        )
        _dav1d_available_cache = 'libdav1d' in result.stdout
    except Exception:
        _dav1d_available_cache = False
    return _dav1d_available_cache

# Cache for the working encoder to avoid trying failed encoders repeatedly
# Format: {'gpu': encoder_dict, 'cpu': encoder_dict}
# where encoder_dict contains 'name', 'video_codec', 'audio_codec', 'extra_args'
_working_encoder_cache = {'gpu': None, 'cpu': None}

def clear_nvenc_cache():
    """Clear the NVENC availability cache to force a re-check."""
    global _nvenc_availability_cache
    _nvenc_availability_cache = {}

def clear_encoder_cache():
    """Clear the working encoder cache to force encoder re-detection."""
    global _working_encoder_cache
    _working_encoder_cache = {'gpu': None, 'cpu': None}
    logger.info("Encoder cache cleared - will re-detect working encoders on next transcode")

def diagnose_nvenc_setup():
    """
    Diagnose NVENC setup issues and log helpful information.
    Returns diagnostic information about the NVENC setup.
    """
    diagnostics = {
        'nvidia_smi_available': False,
        'libnvidia_encode_found': False,
        'library_paths': [],
        'ffmpeg_has_nvenc': False,
        'driver_capabilities': os.environ.get('NVIDIA_DRIVER_CAPABILITIES', ''),
        'driver_capabilities_has_video': False,
    }
    
    # The NVIDIA Container Toolkit only mounts libnvidia-encode.so.1 (NVENC) when the
    # 'video' driver capability is requested, or when the value is 'all'. An unset
    # variable falls back to the toolkit default of 'utility,compute', which has no video.
    caps = {c.strip() for c in diagnostics['driver_capabilities'].split(',') if c.strip()}
    diagnostics['driver_capabilities_has_video'] = bool(caps & {'all', 'video'})
    logger.debug(f"NVIDIA_DRIVER_CAPABILITIES: {diagnostics['driver_capabilities'] or '(unset)'}")
    
    # Check if nvidia-smi is available
    try:
        result = sp.run(['nvidia-smi'], capture_output=True, timeout=5)
        diagnostics['nvidia_smi_available'] = result.returncode == 0
        if result.returncode == 0:
            logger.debug("nvidia-smi is available - GPU is accessible")
    except Exception:
        logger.debug("nvidia-smi not available")
    
    # Check for libnvidia-encode.so.1
    search_paths = [
        '/usr/lib/x86_64-linux-gnu',
        '/usr/lib64',
        '/usr/local/nvidia/lib',
        '/usr/local/nvidia/lib64',
        '/usr/lib',
    ]
    
    for path in search_paths:
        matches = glob.glob(f"{path}/*nvidia-encode*.so*")
        if matches:
            diagnostics['libnvidia_encode_found'] = True
            diagnostics['library_paths'].extend(matches)
    
    # Check current LD_LIBRARY_PATH
    ld_path = os.environ.get('LD_LIBRARY_PATH', '')
    logger.debug(f"LD_LIBRARY_PATH: {ld_path}")
    
    # Check if ffmpeg has nvenc
    try:
        result = sp.run(
            ['ffmpeg', '-hide_banner', '-encoders'],
            capture_output=True,
            text=True,
            timeout=5
        )
        if result.returncode == 0:
            diagnostics['ffmpeg_has_nvenc'] = 'h264_nvenc' in result.stdout
    except Exception:
        pass
    
    return diagnostics

def check_nvenc_available(encoder=None):
    """
    Check if NVENC (NVIDIA GPU encoding) is available.
    
    Args:
        encoder: Optional specific encoder to check ('h264_nvenc' or 'av1_nvenc').
                 If None, checks if any NVENC encoder is available.
    
    Returns:
        bool: True if the specified NVENC encoder (or any NVENC encoder) is available, False otherwise
    """
    cache_key = encoder or 'any_nvenc'
    
    # Return cached result if available
    if cache_key in _nvenc_availability_cache:
        return _nvenc_availability_cache[cache_key]
    
    try:
        # Try to get the list of encoders from ffmpeg
        result = sp.run(
            ['ffmpeg', '-hide_banner', '-encoders'],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        if result.returncode == 0:
            if encoder:
                # Check for specific encoder
                available = encoder in result.stdout
            else:
                # Check if any NVENC encoder is available (h264_nvenc is the baseline)
                available = 'h264_nvenc' in result.stdout
            
            _nvenc_availability_cache[cache_key] = available
            return available
        
        _nvenc_availability_cache[cache_key] = False
        return False
    except Exception as ex:
        logger.debug(f"Could not check for NVENC availability: {ex}")
        _nvenc_availability_cache[cache_key] = False
        return False



# ---------------------------------------------------------------------------
# HDR detection and HDR -> SDR tone mapping
# ---------------------------------------------------------------------------

# ffprobe's names for the HDR transfer functions: PQ (HDR10) and HLG.
HDR_TRANSFERS = ('smpte2084', 'arib-std-b67')

# The operators a video can be tone mapped with, in the order the UI lists them. bt2390
# runs through libplacebo; the rest through the built-in tonemap filter, which needs
# zscale (libzimg) to get the frame into linear light first.
TONEMAP_OPERATORS = ('bt2390', 'hable', 'mobius', 'reinhard')

# Vulkan devices that are really the CPU. libplacebo runs on them, but many times slower
# than the zscale chain, so they do not make bt2390 the automatic default.
_SOFTWARE_VULKAN_DEVICES = ('llvmpipe', 'lavapipe', 'swiftshader')


def _stream_bit_depth(stream):
    match = re.search(r'p(\d+)(le|be)?$', stream.get('pix_fmt') or '')
    return int(match.group(1)) if match else 8


def is_hdr_stream(stream):
    """Whether an ffprobe video stream is HDR, from its colour tags.

    PQ and HLG are HDR by definition. A 10-bit BT.2020 stream with no transfer tag at
    all is, in practice, an HDR capture that lost its metadata; it is flagged too, and
    the tone map then assumes PQ (see `stream_needs_pq_assumed`).
    """
    if not stream:
        return False
    transfer = (stream.get('color_transfer') or '').lower()
    if transfer in HDR_TRANSFERS:
        return True
    if transfer and transfer != 'unknown':
        return False
    primaries = (stream.get('color_primaries') or '').lower()
    return primaries == 'bt2020' and _stream_bit_depth(stream) >= 10


def stream_needs_pq_assumed(stream):
    """An HDR stream with no transfer tag, which the tone map has to treat as PQ."""
    transfer = (stream.get('color_transfer') or '').lower() if stream else ''
    return is_hdr_stream(stream) and transfer not in HDR_TRANSFERS


def tonemap_filter(operator, assume_pq=False):
    """The ffmpeg input arguments and video filter that turn HDR frames into BT.709 SDR.

    Both chains end in 8-bit 4:2:0 limited range tagged BT.709, which every encoder the
    transcodes use accepts. Returns (input_args, filter).
    """
    if operator not in TONEMAP_OPERATORS:
        raise ValueError(f"Unknown tone map operator: {operator}")
    # A stream with no transfer tag is treated as HDR10. The tags are set on the decoded
    # frames so the conversion reads them; the file is not touched.
    prefix = 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,' if assume_pq else ''
    if operator == 'bt2390':
        vf = (f"{prefix}format=yuv420p10le,hwupload,"
              "libplacebo=tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p,"
              "hwdownload,format=yuv420p")
        return ['-init_hw_device', 'vulkan=vk', '-filter_hw_device', 'vk'], vf
    # PQ/HLG to linear light with 100 nits at 1.0, float RGB in BT.709 primaries, the
    # curve, then back to BT.709 gamma. desat=0 keeps bright colours from greying out.
    vf = (f"{prefix}zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
          f"tonemap=tonemap={operator}:desat=0,"
          "zscale=t=bt709:m=bt709:r=tv,format=yuv420p")
    return [], vf


_ffmpeg_filters_cache = None
_vulkan_device_cache = ('unchecked', None)


def ffmpeg_filters():
    """The names of the filters this ffmpeg build has. Cached for the process."""
    global _ffmpeg_filters_cache
    if _ffmpeg_filters_cache is None:
        names = set()
        try:
            result = sp.run(['ffmpeg', '-hide_banner', '-filters'], capture_output=True, text=True, timeout=30)
            for line in result.stdout.splitlines():
                parts = line.split()
                # " .S. tonemap  V->V  Conversion to/from different dynamic ranges."
                if len(parts) >= 3 and '->' in parts[2]:
                    names.add(parts[1])
        except (OSError, sp.SubprocessError) as ex:
            logger.warning(f"Could not list ffmpeg filters: {ex}")
        _ffmpeg_filters_cache = names
    return _ffmpeg_filters_cache


def vulkan_device():
    """'hardware', 'software' or None: what libplacebo would run on here. Cached."""
    global _vulkan_device_cache
    if _vulkan_device_cache[0] == 'unchecked':
        device = None
        cmd = ['ffmpeg', '-hide_banner', '-v', 'verbose', '-init_hw_device', 'vulkan=vk', '-filter_hw_device', 'vk',
               '-f', 'lavfi', '-i', 'color=black:s=64x64:d=1:r=1',
               '-vf', 'format=yuv420p,hwupload,hwdownload,format=yuv420p', '-frames:v', '1', '-f', 'null', '-']
        try:
            result = sp.run(cmd, capture_output=True, text=True, timeout=60)
            if result.returncode == 0:
                match = re.search(r'Using device:\s*(.+)', result.stderr)
                name = match.group(1).strip().lower() if match else ''
                # Unknown names are treated as software: the only cost is that bt2390
                # is not picked automatically.
                device = 'hardware' if name and not any(m in name for m in _SOFTWARE_VULKAN_DEVICES) else 'software'
                logger.debug(f"Vulkan device: {name or 'unnamed'} ({device})")
            else:
                logger.debug(f"No usable Vulkan device: {result.stderr.strip()[-300:]}")
        except (OSError, sp.SubprocessError) as ex:
            logger.debug(f"Vulkan probe failed: {ex}")
        _vulkan_device_cache = ('checked', device)
    return _vulkan_device_cache[1]


def tonemap_capabilities():
    """Which operators this ffmpeg build can run, and what `auto` resolves to."""
    filters = ffmpeg_filters()
    cpu_ok = 'zscale' in filters and 'tonemap' in filters
    has_placebo = 'libplacebo' in filters
    vulkan = vulkan_device() if has_placebo else None
    operators = []
    for op in TONEMAP_OPERATORS:
        if op == 'bt2390':
            if not has_placebo:
                available, note = False, 'ffmpeg was built without libplacebo'
            elif vulkan is None:
                available, note = False, 'no Vulkan device: install a Vulkan driver (mesa-vulkan-drivers) or expose the GPU'
            elif vulkan == 'hardware':
                available, note = True, 'runs on the GPU'
            else:
                available, note = True, 'runs on the CPU through software Vulkan, several times slower than hable'
        else:
            available, note = cpu_ok, None if cpu_ok else 'ffmpeg was built without libzimg (zscale)'
        operators.append({'id': op, 'available': available, 'note': note})
    caps = {'operators': operators, 'vulkan': vulkan}
    caps['auto_default'] = resolve_tonemap_default('auto', caps)
    return caps


def resolve_tonemap_default(configured, caps=None):
    """The operator `auto` (or an unavailable explicit choice) falls back to.

    bt2390 when it runs on a real GPU, otherwise hable, which is the best of the CPU
    curves and runs everywhere libzimg does. None when the build cannot tone map.
    """
    caps = caps or tonemap_capabilities()
    available = [o['id'] for o in caps['operators'] if o['available']]
    if configured and configured != 'auto' and configured in available:
        return configured
    if 'bt2390' in available and caps.get('vulkan') == 'hardware':
        return 'bt2390'
    for op in ('hable', 'bt2390', 'mobius', 'reinhard'):
        if op in available:
            return op
    return None


def sdr_failure_message(failure_reason):
    """What the editor is shown when an SDR copy could not be made."""
    if failure_reason == 'corruption':
        return 'The video could not be read'
    return 'No encoder could make the SDR copy; see the server log'


# What the SDR copy is tagged as, so players read it as ordinary BT.709 video.
_SDR_OUTPUT_ARGS = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']


def create_sdr_video(video_path, out_path, operator, use_gpu=False, encoder_preference='auto', data_path=None, assume_pq=False):
    """Tone map an HDR video into an SDR copy at its own resolution.

    Encodes with the same encoder chain as the transcodes, so the result plays wherever
    they do. Returns (success, failure_reason) exactly like transcode_video_quality.
    """
    input_args, vf = tonemap_filter(operator, assume_pq)
    # The encoders want even dimensions; a source with an odd edge loses one line.
    vf += ',scale=trunc(iw/2)*2:trunc(ih/2)*2'
    return transcode_video_quality(
        video_path, out_path, None, use_gpu, None, encoder_preference, data_path=data_path,
        video_filter=vf, input_args=input_args, output_args=_SDR_OUTPUT_ARGS, label=f'SDR ({operator})',
    )


def render_tonemap_preview(video_path, seconds, operator, out_dir, width=1280, zoom=(900, 540), assume_pq=False):
    """One frame of video_path at `seconds`, tone mapped with `operator` (or left as
    stored when operator is None), as two WebP files in out_dir: the frame scaled to
    `width`, and a centre crop of `zoom` size at native pixels. Returns their paths, or
    None when ffmpeg failed.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{seconds:.1f}-{operator or 'as_stored'}"
    tile, crop = out_dir / f"{name}.webp", out_dir / f"{name}-zoom.webp"
    if tile.exists() and crop.exists():
        return tile, crop
    if operator:
        input_args, vf = tonemap_filter(operator, assume_pq)
    else:
        input_args, vf = [], 'format=yuv420p'
    zw, zh = zoom
    graph = (f"[0:v]{vf},split[a][b];[a]scale={width}:-2[tile];"
             f"[b]crop=min(iw\\,{zw}):min(ih\\,{zh}):(iw-ow)/2:(ih-oh)/2[zoom]")
    tile_tmp, crop_tmp = out_dir / f"{name}.tmp.webp", out_dir / f"{name}-zoom.tmp.webp"
    cmd = ['ffmpeg', '-v', 'error', '-y', *input_args, '-ss', f'{seconds:.3f}', '-i', str(video_path),
           '-filter_complex', graph,
           '-map', '[tile]', '-frames:v', '1', '-c:v', 'libwebp', '-quality', '85', str(tile_tmp),
           '-map', '[zoom]', '-frames:v', '1', '-c:v', 'libwebp', '-quality', '85', str(crop_tmp)]
    logger.debug(f"$ {' '.join(cmd)}")
    try:
        result = sp.run(cmd, capture_output=True, text=True, timeout=180)
    except (OSError, sp.SubprocessError) as ex:
        logger.warning(f"Tone map preview failed for {video_path} at {seconds}s ({operator}): {ex}")
        result = None
    if result is None or result.returncode != 0 or not tile_tmp.exists() or not crop_tmp.exists():
        if result is not None:
            logger.warning(f"Tone map preview failed for {video_path} at {seconds}s ({operator}): {result.stderr.strip()[-400:]}")
        tile_tmp.unlink(missing_ok=True)
        crop_tmp.unlink(missing_ok=True)
        return None
    os.replace(tile_tmp, tile)
    os.replace(crop_tmp, crop)
    return tile, crop


def transcode_video(video_path, out_path):
    s = time.time()
    logger.debug(f"Transcoding video")
    cmd = ['ffmpeg', '-v', 'quiet', '-y', '-i', str(video_path), '-c:v', 'libx264', '-c:a', 'aac', str(out_path)]
    logger.debug(f"$: {' '.join(cmd)}")
    sp.call(cmd)
    e = time.time()
    logger.debug(f'Transcoded {str(out_path)} in {e-s}s')

def _get_encoder_candidates(use_gpu=False, encoder_preference='auto'):
    """
    Get the list of encoder configurations to try in priority order.

    Args:
        use_gpu: Whether to include GPU encoders in the list
        encoder_preference: 'auto', 'h264', or 'av1'

    Returns:
        list: List of encoder configurations to try in order
    """
    h264_cpu = {
        'name': 'H.264 CPU',
        'video_codec': 'libx264',
        'audio_codec': 'aac',
        'audio_bitrate': '128k',
        'extra_args': ['-preset', 'fast', '-crf', '23'],
        'cap_bitrate': True,
    }
    av1_cpu = {
        'name': 'AV1 CPU',
        'video_codec': 'libsvtav1',
        'audio_codec': 'libopus',
        'audio_bitrate': '96k',
        'extra_args': ['-preset', '6', '-crf', '30', '-b:v', '0']
    }
    h264_nvenc = {
        'name': 'H.264 NVENC',
        'video_codec': 'h264_nvenc',
        'audio_codec': 'aac',
        'audio_bitrate': '128k',
        'extra_args': ['-preset', 'p4', '-cq:v', '23'],
        'cap_bitrate': True,
    }
    av1_nvenc = {
        'name': 'AV1 NVENC',
        'video_codec': 'av1_nvenc',
        'audio_codec': 'libopus',
        'audio_bitrate': '96k',
        'extra_args': ['-preset', 'p4', '-cq:v', '30']
    }

    if encoder_preference == 'h264':
        if use_gpu:
            return [h264_nvenc, h264_cpu]
        return [h264_cpu]
    elif encoder_preference == 'av1':
        if use_gpu:
            return [av1_nvenc, av1_cpu]
        return [av1_cpu]
    else:  # auto - H.264 first (faster), AV1 as fallback
        if use_gpu:
            return [h264_nvenc, av1_nvenc, h264_cpu, av1_cpu]
        return [h264_cpu, av1_cpu]

def run_ffmpeg_with_progress(cmd, total_duration, timeout_seconds=None, data_path=None):
    """
    Run an FFmpeg command with real-time progress tracking via -progress flag.

    If data_path is provided, reads the existing status file and updates it with
    percent/speed. Progress is throttled to every 0.5 seconds to avoid I/O overhead.
    stderr is drained in a background thread to prevent pipe buffer deadlock and
    is logged at warning level if the process exits with a non-zero code.
    """
    # Insert -progress pipe:1 before output file (last arg)
    cmd_with_progress = cmd[:-1] + ['-progress', 'pipe:1'] + [cmd[-1]]

    # Snapshot the stable status fields (current, total, current_video, pid, resolution)
    # once before ffmpeg starts. Using a snapshot prevents a concurrent write (e.g. from
    # an upload scan resetting total=0) from being silently preserved through the
    # read-modify-write that happens on every progress tick.
    status_snapshot = {}
    if data_path:
        existing = read_transcoding_status(data_path)
        status_snapshot = {
            'current': existing.get('current', 0),
            'total': existing.get('total', 0),
            'current_video': existing.get('current_video'),
            'pid': existing.get('pid'),
            'resolution': existing.get('resolution'),
        }

    process = sp.Popen(cmd_with_progress, stdout=sp.PIPE, stderr=sp.PIPE, text=True)
    last_update = 0
    speed = None
    percent = None
    current_seconds = 0

    # Drain stderr in a background thread to prevent pipe buffer from filling
    # and blocking ffmpeg. Collected lines are logged on failure.
    stderr_lines = []
    def _drain_stderr():
        for line in process.stderr:
            stderr_lines.append(line.rstrip())
    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    # -progress outputs clean key=value lines:
    # out_time_us=83450000
    # speed=1.5x
    # progress=continue
    try:
        for line in process.stdout:
            line = line.strip()
            if '=' not in line:
                continue

            key, value = line.split('=', 1)

            if key == 'out_time_us' and total_duration:
                try:
                    current_us = int(value)
                    current_seconds = current_us / 1_000_000
                    percent = min(100, (current_seconds / total_duration) * 100)
                except ValueError:
                    pass

            elif key == 'speed' and value.endswith('x'):
                try:
                    speed = float(value.rstrip('x'))
                except ValueError:
                    pass

            elif key == 'progress':
                # 'continue' or 'end' - good time to update status
                now = time.time()
                if now - last_update >= 0.5 and data_path and percent is not None:
                    # Calculate ETA: remaining time / encoding speed
                    eta_seconds = None
                    if speed and speed > 0 and total_duration:
                        remaining_seconds = total_duration - current_seconds
                        eta_seconds = remaining_seconds / speed

                    # Update status using the snapshot captured before ffmpeg started.
                    # This prevents a concurrent write (e.g. an upload scan resetting
                    # total=0 mid-transcode) from corrupting task count or PID.
                    write_transcoding_status(
                        data_path,
                        status_snapshot.get('current', 0),
                        status_snapshot.get('total', 0),
                        status_snapshot.get('current_video'),
                        status_snapshot.get('pid'),
                        percent,
                        eta_seconds,
                        status_snapshot.get('resolution')
                    )
                    last_update = now

        process.wait(timeout=timeout_seconds)
    except sp.TimeoutExpired:
        process.kill()
        process.wait()
        raise
    finally:
        stderr_thread.join(timeout=5)

    if process.returncode != 0 and stderr_lines:
        logger.warning(f"FFmpeg exited with code {process.returncode}. stderr output:")
        for line in stderr_lines[-100:]:
            logger.warning(f"  ffmpeg: {line}")

    return process


# Ceilings (maxrate, bufsize) for the H.264 transcodes, on top of their quality target.
# Quality alone let a busy 1080p60 clip come out as heavy as its 1440p source, so moving
# a viewer down to it did nothing for a slow connection. These are YouTube's recommended
# upload bitrates, which it treats as good enough to re-encode from, so ordinary footage
# stays under them and only the busiest is held back. Past 30 fps the same bitrate is
# spread over up to twice the frames, so those get the higher set, as does an unknown
# frame rate.
TRANSCODE_BITRATE_CAPS = {
    #      up to 30 fps       above 30 fps
    1080: (('8M', '16M'),    ('12M', '24M')),
    720:  (('5M', '10M'),    ('7500k', '15M')),
    480:  (('2500k', '5M'),  ('4M', '8M')),
}

def _build_transcode_command(video_path, out_path, height, encoder, input_decoder=None, framerate=None,
                             video_filter=None, input_args=None, output_args=None):
    """Build an ffmpeg command for transcoding with the given encoder.

    height is the target height to scale to, or None to keep the source size, in
    which case video_filter (e.g. a tone map chain) does any conversion. input_args
    go before -i (hardware device setup); output_args before the output path.
    """
    cmd = ['ffmpeg', '-v', 'warning', '-stats', '-y']
    if input_args:
        cmd.extend(input_args)
    if input_decoder:
        cmd.extend(['-c:v', input_decoder])
    cmd.append('-i')
    cmd.append(str(video_path))
    cmd.extend(['-c:v', encoder['video_codec']])
    
    if 'extra_args' in encoder:
        cmd.extend(encoder['extra_args'])

    if encoder.get('cap_bitrate') and height in TRANSCODE_BITRATE_CAPS:
        # 31 so that 29.97 fps, and 30 fps recordings a little variable, count as 30
        high_fps = framerate is None or framerate > 31
        maxrate, bufsize = TRANSCODE_BITRATE_CAPS[height][1 if high_fps else 0]
        cmd.extend(['-maxrate', maxrate, '-bufsize', bufsize])
    
    cmd.extend(['-vf', video_filter or f'scale=-2:{height}'])
    if output_args:
        cmd.extend(output_args)
    cmd.extend(['-c:a', encoder['audio_codec'], '-b:a', encoder.get('audio_bitrate', '128k')])
    # The index goes at the front, so the player can start without first fetching the
    # end of the file, and again every time it switches quality.
    cmd.extend(['-movflags', '+faststart'])
    cmd.append(str(out_path))
    
    return cmd

def transcode_video_quality(video_path, out_path, height, use_gpu=False, timeout_seconds=None, encoder_preference='auto', data_path=None,
                            video_filter=None, input_args=None, output_args=None, label=None):
    """
    Transcode a video to a specific height (e.g., 720, 1080) while maintaining aspect ratio.
    
    Tries encoders in priority order during actual transcoding, then caches the first
    successful encoder for all subsequent transcodes until the application is restarted.
    
    Fallback chain when GPU is enabled:
    1. AV1 with GPU (av1_nvenc) - RTX 40 series or newer
    2. H.264 with GPU (h264_nvenc) - GTX 1050+ / Pascal or newer
    3. AV1 with CPU (libaom-av1) - Excellent compression
    4. H.264 with CPU (libx264) - Universal fallback
    
    Args:
        video_path: Path to the source video
        out_path: Path for the transcoded output
        height: Target height in pixels (e.g., 720, 1080), or None to keep the source size
        video_filter, input_args, output_args: see _build_transcode_command
        label: what to call the output in logs when height is None
        use_gpu: Whether to use GPU acceleration (NVENC if available)
        timeout_seconds: Maximum time allowed for encoding (default: calculated based on video duration)
    
    Returns:
        tuple: (success: bool, failure_reason: str or None)
            - (True, None) if transcoding succeeded
            - (False, 'corruption') if source file appears corrupt
            - (False, 'encoders') if all encoders failed
    """
    global _working_encoder_cache
    s = time.time()
    target = f'{height}p' if height else (label or 'source resolution')
    
    # Validate the source video file before attempting transcoding
    # This catches corrupt files early instead of trying all encoders
    is_valid, error_msg, preferred_decoder = validate_video_file(video_path)
    if not is_valid:
        logger.error(f"Source video validation failed: {error_msg}")
        logger.warning("Skipping transcoding for this video due to file corruption or read errors")
        return (False, 'corruption')
    if preferred_decoder:
        logger.debug(f"Using {preferred_decoder} as input decoder for this source file")

    # Get video duration for progress logging
    total_duration = get_video_duration(video_path) or 0
    # Picks which set of bitrate ceilings applies
    framerate = get_video_framerate(video_path)

    # Calculate smart timeout based on video duration if not provided
    if timeout_seconds is None:
        timeout_seconds = calculate_transcode_timeout(video_path)

    logger.debug(f"Using transcode timeout of {timeout_seconds}s ({timeout_seconds/60:.1f} minutes)")
    
    # Determine output container based on codec
    out_path_str = str(out_path)

    # Write to a temp path during transcoding; only rename to the final path on
    # success. This ensures a partially-written file from a crashed ffmpeg process
    # is never picked up and served as a valid transcode output.
    tmp_path = out_path.parent / (out_path.stem + '.tmp.mp4')
    tmp_path_str = str(tmp_path)
    if tmp_path.exists():
        try:
            tmp_path.unlink()
            logger.debug(f"Cleaned up leftover temp file: {tmp_path_str}")
        except OSError as ex:
            logger.debug(f"Could not remove leftover temp file: {ex}")

    mode = 'gpu' if use_gpu else 'cpu'

    # Use cached encoder if available to avoid redundant encoder detection during bulk transcoding.
    if _working_encoder_cache[mode] is not None:
        encoder = _working_encoder_cache[mode]
        logger.debug(f"Using cached {mode.upper()} encoder: {encoder['name']}")

        # Build ffmpeg command using the cached encoder
        logger.info(f"Transcoding video to {target} using {encoder['name']}")
        cmd = _build_transcode_command(video_path, tmp_path, height, encoder, input_decoder=preferred_decoder, framerate=framerate,
                                       video_filter=video_filter, input_args=input_args, output_args=output_args)

        logger.debug(f"$: {' '.join(cmd)}")

        try:
            result = run_ffmpeg_with_progress(cmd, total_duration, timeout_seconds, data_path)
            if result.returncode == 0:
                tmp_path.rename(out_path)
                e = time.time()
                logger.info(f'Transcoded {str(out_path)} to {target} in {e-s:.2f}s')
                return (True, None)
            else:
                # Cached encoder failed - clear cache and fall through to try all encoders
                logger.warning(f"Cached encoder {encoder['name']} failed with exit code {result.returncode}")
                logger.info("Clearing encoder cache and retrying with all available encoders...")
                _working_encoder_cache[mode] = None
                if tmp_path.exists():
                    try:
                        tmp_path.unlink()
                    except OSError as cleanup_ex:
                        logger.debug(f"Could not clean up temp file: {cleanup_ex}")
        except sp.TimeoutExpired:
            logger.warning(f"Cached encoder {encoder['name']} timed out after {timeout_seconds} seconds")
            logger.info("Clearing encoder cache and retrying with all available encoders...")
            _working_encoder_cache[mode] = None
            # Clean up the process and any partial output
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                    logger.debug(f"Cleaned up timed out temp file: {tmp_path_str}")
                except OSError as cleanup_ex:
                    logger.debug(f"Could not clean up timed out temp file: {cleanup_ex}")
        except Exception as ex:
            # Cached encoder failed - clear cache and fall through to try all encoders
            logger.warning(f"Cached encoder {encoder['name']} failed: {ex}")
            logger.info("Clearing encoder cache and retrying with all available encoders...")
            _working_encoder_cache[mode] = None
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError as cleanup_ex:
                    logger.debug(f"Could not clean up temp file: {cleanup_ex}")
    
    # No cached encoder - need to detect a working encoder
    # Check if GPU is requested but NVENC is not available in ffmpeg
    if use_gpu and not check_nvenc_available():
        logger.warning("GPU transcoding requested but NVENC not available in ffmpeg")
        
        # Run diagnostics to help user understand the issue
        diag = diagnose_nvenc_setup()
        
        if diag['nvidia_smi_available']:
            logger.warning("✓ GPU is accessible (nvidia-smi works)")
            logger.warning("✗ But NVENC encoder is not available to ffmpeg")
            logger.warning("")
            
            if not diag['driver_capabilities_has_video']:
                caps = diag['driver_capabilities'] or '(unset)'
                logger.warning(f"NVIDIA_DRIVER_CAPABILITIES is {caps}, which does not include 'video'")
                logger.warning("  The NVIDIA Container Toolkit only mounts libnvidia-encode.so.1 (NVENC) when")
                logger.warning("  'video' is included. Set NVIDIA_DRIVER_CAPABILITIES=compute,utility,video")
                logger.warning("  (or 'all') on the container, or remove your override to use the image default.")
                logger.warning("")
            
            # Try to automatically fix the library path issue
            if diag['libnvidia_encode_found'] and diag['library_paths'] and len(diag['library_paths']) > 0:
                library_dir = str(Path(diag['library_paths'][0]).parent)
                current_ld_path = os.environ.get('LD_LIBRARY_PATH', '')
                current_paths = current_ld_path.split(':') if current_ld_path else []
                
                # Add the library directory to LD_LIBRARY_PATH if not already present
                if library_dir not in current_paths:
                    new_ld_path = f"{library_dir}:{current_ld_path}" if current_ld_path else library_dir
                    os.environ['LD_LIBRARY_PATH'] = new_ld_path
                    logger.info(f"Automatically added {library_dir} to LD_LIBRARY_PATH")
                    
                    # Clear the cache and retry the check
                    clear_nvenc_cache()
                    
                    if check_nvenc_available():
                        logger.info("✓ NVENC is now available! Continuing with GPU transcoding")
                        # Don't set use_gpu to False, let it continue
                    else:
                        logger.warning("✗ NVENC still not available after adding library path")
                        logger.warning("Common causes on Unraid/Docker:")
                        logger.warning("  1. NVIDIA driver libraries not mounted in container")
                        logger.warning("     Solution: Add to docker run or docker-compose:")
                        logger.warning("       --gpus all")
                        logger.warning("       or")
                        logger.warning("       runtime: nvidia")
                        logger.warning("")
                        logger.warning("  2. FFmpeg not compiled with NVENC support")
                        logger.warning("     (This shouldn't happen with the official image)")
                        logger.warning("")
                        logger.warning("See: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html")
                        logger.info("Will attempt GPU transcoding anyway and fall back to CPU if needed")
                else:
                    logger.warning(f"Library found at: {diag['library_paths'][0]}")
                    logger.warning(f"But {library_dir} is already in LD_LIBRARY_PATH")
                    logger.warning("Common causes on Unraid/Docker:")
                    logger.warning("  1. NVIDIA driver libraries not mounted in container")
                    logger.warning("     Solution: Add to docker run or docker-compose:")
                    logger.warning("       --gpus all")
                    logger.warning("       or")
                    logger.warning("       runtime: nvidia")
                    logger.warning("")
                    logger.warning("  2. FFmpeg not compiled with NVENC support")
                    logger.warning("     (This shouldn't happen with the official image)")
                    logger.warning("")
                    logger.warning("See: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html")
                    logger.info("Will attempt GPU transcoding anyway and fall back to CPU if needed")
            else:
                logger.warning("Common causes on Unraid/Docker:")
                logger.warning("  1. NVIDIA driver libraries not mounted in container")
                logger.warning("     Solution: Add to docker run or docker-compose:")
                logger.warning("       --gpus all")
                logger.warning("       or")
                logger.warning("       runtime: nvidia")
                logger.warning("")
                logger.warning("  2. Missing libnvidia-encode.so.1 library")
                logger.warning("     ✗ Library not found in standard paths")
                logger.warning("     Ensure NVIDIA Container Toolkit is installed on host")
                logger.warning("")
                logger.warning("See: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html")
                logger.info("Will attempt GPU transcoding anyway and fall back to CPU if needed")
        else:
            logger.warning("Common causes:")
            logger.warning("  1. NVIDIA drivers are not installed on the host")
            logger.warning("  2. NVIDIA Container Toolkit is not installed")
            logger.warning("  3. Docker is not configured with the nvidia runtime")
            logger.warning("  4. The GPU does not support NVENC")
            logger.warning("")
            logger.warning("See: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html")
            logger.info("Will attempt GPU transcoding anyway and fall back to CPU if needed")
    
    # Try encoders in priority order with actual transcoding
    # When use_gpu=True, the candidate list includes GPU encoders first, then CPU encoders
    # as fallback, so CPU transcoding will be attempted automatically if GPU fails
    logger.info(f"Detecting working {mode.upper()} encoder by attempting transcode...")
    encoders = _get_encoder_candidates(use_gpu, encoder_preference)

    last_exception = None
    for encoder in encoders:
        logger.debug(f"Trying {encoder['name']}...")

        # Build ffmpeg command targeting the temp path
        cmd = _build_transcode_command(video_path, tmp_path, height, encoder, input_decoder=preferred_decoder, framerate=framerate,
                                       video_filter=video_filter, input_args=input_args, output_args=output_args)

        logger.debug(f"$: {' '.join(cmd)}")

        try:
            result = run_ffmpeg_with_progress(cmd, total_duration, timeout_seconds, data_path)
            if result.returncode == 0:
                # Success! Move temp file to final location, cache encoder, and return.
                tmp_path.rename(out_path)
                logger.info(f"✓ {encoder['name']} works! Using it for all transcodes this session.")
                _working_encoder_cache[mode] = encoder
                e = time.time()
                logger.info(f'Transcoded {str(out_path)} to {target} in {e-s:.2f}s')
                return (True, None)
            else:
                logger.warning(f"✗ {encoder['name']} failed with exit code {result.returncode}")
                last_exception = Exception(f"Transcode failed with exit code {result.returncode}")
                # Clean up temp file before trying next encoder
                if tmp_path.exists():
                    try:
                        tmp_path.unlink()
                        logger.debug(f"Cleaned up failed temp file: {tmp_path_str}")
                    except OSError as cleanup_ex:
                        logger.debug(f"Could not clean up failed temp file: {cleanup_ex}")
        except sp.TimeoutExpired:
            logger.warning(f"✗ {encoder['name']} timed out after {timeout_seconds} seconds")
            last_exception = Exception(f"Transcode timed out after {timeout_seconds} seconds")
            # Clean up temp file before trying next encoder
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                    logger.debug(f"Cleaned up timed out temp file: {tmp_path_str}")
                except OSError as cleanup_ex:
                    logger.debug(f"Could not clean up timed out temp file: {cleanup_ex}")
        except Exception as ex:
            logger.warning(f"✗ {encoder['name']} failed: {ex}")
            last_exception = ex
            # Clean up temp file before trying next encoder
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                    logger.debug(f"Cleaned up failed temp file: {tmp_path_str}")
                except OSError as cleanup_ex:
                    logger.debug(f"Could not clean up failed temp file: {cleanup_ex}")
    
    # If we get here, no encoder worked
    error_msg = f"No working {mode.upper()} encoder found for video. Tried: {', '.join([e['name'] for e in encoders])}"
    logger.error(error_msg)
    if last_exception:
        logger.error(f"Last error was: {last_exception}")
    
    # Return failure with 'encoders' reason to indicate encoder failure (not corruption)
    # This allows the calling code to continue processing other videos
    return (False, 'encoders')

def create_boomerang_preview(video_path, out_path, clip_duration=5):
    s = time.time()
    duration = get_video_duration(video_path) or 0
    start = max(0, duration / 2 - clip_duration / 2)
    cmd = ['ffmpeg', '-v', 'quiet', '-ss', str(start), '-t', str(clip_duration),
        '-i', str(video_path), '-y', '-vf', 'scale=-2:480',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
        '-an', '-movflags', '+faststart', str(out_path)]
    logger.debug(f"Creating boomerang preview")
    logger.debug(f"$: {' '.join(cmd)}")
    sp.call(cmd)
    e = time.time()
    logger.debug(f'Generated boomerang preview {str(out_path)} in {e-s}s')

def dur_string_to_seconds(dur: str) -> float:
    if type(dur) == int: return float(dur)
    num_parts = len(dur.split(':'))
    if num_parts == 1:
        return int(dur)
    elif num_parts == 2:
        m, s = dur.split(':')
        m, s = int(m), int(s)
        return s + m*60
    elif num_parts == 3:
        h, m, s = dur.split(':')
        h, m, s = int(h), int(m), int(s.split('.')[0])
        return s + m*60 + h*60*60
    else:
        logger.warn(f'Could not parse duration in to total seconds from {dur}')
        return None

def seconds_to_dur_string(sec):
    sec = int(round(sec))
    hours = sec // 60 // 60
    mins = (sec - hours*60*60) // 60
    s = (sec-hours*60*60-mins*60) % 60
    if hours:
        return ':'.join([str(hours), str(mins).zfill(2), str(s).zfill(2)])
    else:
        return ':'.join([str(mins), str(s).zfill(2)])

def _case_affinity(candidate, query):
    """How strongly a candidate's own casing is echoed by the query.

    Only ever used to break a tie. Folding case away is what lets a filename match
    a game at all, but it also makes "RUMBLE" and "rumble" — two different games —
    score identically against a clip named "RUMBLE clip". The casing the query
    itself used is the only signal left to separate them.
    """
    if candidate and candidate in query:
        return len(candidate)
    return sum(1 for a, b in zip(candidate, query) if a == b)


def _match_game_by_name(query, games, score_cutoff):
    """Pick the local game a name refers to, preferring an exact match to a fuzzy one.

    Three things this has to get right, none of which the previous inline
    process.extractOne() call did:

    * It was handed a list of (name, game) tuples as the choices, so rapidfuzz
      scored the query against the tuple rather than the name and returned 0 for
      everything — no local match could ever clear the cutoff, and every lookup
      fell through to a SteamGridDB search. It also read the game back out of
      result[2], which for a list of choices is the index, not the element.
    * Scoring is case-insensitive, because a filename's casing rarely matches the
      publisher's. An exact, case-sensitive hit is still taken first, so a name
      that matches outright is never talked out of by a fuzzy score.
    * Once case is folded away, names differing only in case tie. extractOne
      resolves a tie by returning whichever it reached first, which is row order —
      so which of two real games got suggested came down to which was added first.
      Ties are broken on case instead.

    Returns (game, score_out_of_100), or (None, 0) when nothing clears the cutoff.
    """
    from rapidfuzz import fuzz, process

    stripped = (query or '').strip()
    if not stripped or not games:
        return None, 0

    for game in games:
        if game.name == stripped:
            return game, 100

    names = [g.name or '' for g in games]
    scored = process.extract(
        stripped,
        names,
        scorer=fuzz.token_set_ratio,
        processor=str.lower,
        score_cutoff=score_cutoff,
        limit=None,
    )
    if not scored:
        return None, 0

    best_score = max(entry[1] for entry in scored)
    tied = [entry for entry in scored if entry[1] == best_score]
    best = max(tied, key=lambda entry: (_case_affinity(entry[0], stripped), entry[0]))
    return games[best[2]], best_score


def _pick_steamgrid_result(query, results):
    """Choose among SteamGridDB hits, preferring an exact name match to the top hit.

    The autocomplete endpoint orders by its own relevance, which does not separate
    two games whose names differ only in case, so taking results[0] on faith is how
    a clip of "RUMBLE" ends up labelled "rumble".
    """
    stripped = (query or '').strip()
    for result in results:
        if (result.get('name') or '') == stripped:
            return result
    case_variants = [r for r in results if (r.get('name') or '').lower() == stripped.lower()]
    if case_variants:
        # Same tie-break as the local lookup: nearest on case, rather than trusting
        # an ordering that does not distinguish these at all.
        return max(
            case_variants,
            key=lambda r: (_case_affinity(r.get('name') or '', stripped), r.get('name') or ''),
        )
    return results[0]


def detect_game_from_filename(filename: str, steamgriddb_api_key: str = None, path: str = None):
    """
    Fuzzy match a video filename against existing games in database using RapidFuzz.
    Falls back to SteamGridDB search if no local match found.

    Args:
        filename: Video filename without extension
        steamgriddb_api_key: Optional API key for SteamGridDB fallback
        path: Optional relative path (e.g. "Game Name/clip.mp4") - folder name is tried first

    Returns:
        dict with 'game_id', 'game_name', 'steamgriddb_id', 'confidence', 'source' or None
    """
    from fireshare.models import GameMetadata
    import re

    # Step 0: Try folder name first (highest confidence source)
    # Skip folder-based detection for upload folders (they're not game names)
    from fireshare.constants import DEFAULT_CONFIG
    upload_folders = {
        DEFAULT_CONFIG['app_config']['admin_upload_folder_name'].lower(),
        DEFAULT_CONFIG['app_config']['public_upload_folder_name'].lower(),
    }

    if path:
        normalized_path = path.replace('\\', '/')
        parts = [part for part in normalized_path.split('/') if part]
        if len(parts) > 1:  # Has at least one folder
            folder_name = parts[0]  # Top-level folder

            # Skip folder-based detection for upload folders
            if folder_name.lower() not in upload_folders:
                # Try matching folder name against local game database
                games = GameMetadata.query.all()
                if games:
                    matched_game, score = _match_game_by_name(
                        folder_name, games, score_cutoff=80  # Higher threshold for folder match
                    )

                    if matched_game:
                        best_match = {
                            'game_id': matched_game.id,
                            'game_name': matched_game.name,
                            'steamgriddb_id': matched_game.steamgriddb_id,
                            'confidence': score / 100,
                            'source': 'folder_local'
                        }
                        logger.info(f"Folder-based game match: {best_match['game_name']} (confidence: {score:.0f}%)")
                        return best_match

                # Try SteamGridDB with folder name
                if steamgriddb_api_key:
                    logger.debug(f"No local folder match, searching SteamGridDB for folder: '{folder_name}'")
                    from fireshare.steamgrid import SteamGridDBClient
                    client = SteamGridDBClient(steamgriddb_api_key)

                    try:
                        results = client.search_games(folder_name)
                        if results and len(results) > 0:
                            top_result = _pick_steamgrid_result(folder_name, results)
                            # Use higher confidence for folder-based SteamGridDB match
                            detected = {
                                'game_id': None,
                                'game_name': top_result.get('name'),
                                'steamgriddb_id': top_result.get('id'),
                                'confidence': 0.85,  # Higher than filename-based
                                'source': 'folder_steamgriddb',
                                'release_date': top_result.get('release_date')
                            }
                            logger.info(f"Folder-based SteamGridDB match: {detected['game_name']} (id: {detected['steamgriddb_id']})")
                            return detected
                    except Exception as ex:
                        logger.warning(f"SteamGridDB folder search failed: {ex}")
            else:
                logger.debug(f"Skipping folder-based detection for upload folder: '{folder_name}'")

    # Clean filename for better matching. The original casing is kept: it is what
    # tells "RUMBLE" from "rumble" further down, and the only pattern below that
    # cares about case already asks for re.IGNORECASE.
    clean_name = filename
    # Remove common patterns: dates, numbers, "gameplay", etc.
    clean_name = re.sub(r'\d{4}-\d{2}-\d{2}', '', clean_name)  # Remove dates like 2024-01-14
    clean_name = re.sub(r'\d{8}', '', clean_name)  # Remove YYYYMMDD format
    clean_name = re.sub(r'\b(gameplay|clip|highlights?|match|game|recording|video)\b', '', clean_name, flags=re.IGNORECASE)
    clean_name = re.sub(r'[_\-]+', ' ', clean_name)  # Replace _ and - with spaces
    clean_name = re.sub(r'\s+', ' ', clean_name)  # Normalize whitespace
    clean_name = clean_name.strip()

    if not clean_name:
        logger.debug("Filename cleaned to empty string, cannot detect game")
        return None

    # Step 1: Try local database first
    games = GameMetadata.query.all()

    if not games:
        logger.debug("No games in database to match against")
    else:
        # token_set_ratio ignores word order and extra words
        matched_game, score = _match_game_by_name(
            clean_name, games, score_cutoff=65  # Minimum confidence (0-100 scale)
        )

        if matched_game:
            best_match = {
                'game_id': matched_game.id,
                'game_name': matched_game.name,
                'steamgriddb_id': matched_game.steamgriddb_id,
                'confidence': score / 100,  # Convert to 0-1 scale
                'source': 'local'
            }
            logger.info(f"Local game match: {best_match['game_name']} (confidence: {score:.0f}%)")
            return best_match

    # Step 2: Fallback to SteamGridDB search
    if steamgriddb_api_key:
        logger.debug(f"No local match found, searching SteamGridDB for: '{clean_name}'")
        from fireshare.steamgrid import SteamGridDBClient
        client = SteamGridDBClient(steamgriddb_api_key)

        try:
            results = client.search_games(clean_name)
            if results and len(results) > 0:
                # SteamGridDB returns best matches first, but cannot tell two names
                # apart that differ only in case, so prefer an exact hit if there is one.
                top_result = _pick_steamgrid_result(clean_name, results)
                detected = {
                    'game_id': None,  # Not in our DB yet
                    'game_name': top_result.get('name'),
                    'steamgriddb_id': top_result.get('id'),
                    'confidence': 0.75,  # Assume SteamGridDB results are good
                    'source': 'steamgriddb',
                    'release_date': top_result.get('release_date')
                }
                logger.info(f"SteamGridDB match: {detected['game_name']} (id: {detected['steamgriddb_id']})")
                return detected
        except Exception as ex:
            logger.warning(f"SteamGridDB search failed: {ex}")

    logger.debug(f"No game match found for filename: '{clean_name}'")
    return None

def _extract_date_from_filename(filename: str):
    """
    Extract a recording date from a video filename using regex patterns.

    Supports formats from common screen recording software:
    - 2024-01-14, 2024_01_14, 2024.01.14
    - 20240114
    - 01-14-2024, 01_14_2024

    Args:
        filename: Video filename (with or without extension)

    Returns:
        datetime object if a valid date was found, None otherwise
    """
    name = Path(filename).stem

    # Pattern 1: YYYY-MM-DD or YYYY_MM_DD or YYYY.MM.DD (with optional time)
    match = re.search(r'(\d{4})[-_.](\d{2})[-_.](\d{2})(?:[-_.\s]+(\d{2})[-_.](\d{2})[-_.](\d{2}))?', name)
    if match:
        y, m, d = int(match.group(1)), int(match.group(2)), int(match.group(3))
        hr = int(match.group(4)) if match.group(4) else 0
        mi = int(match.group(5)) if match.group(5) else 0
        se = int(match.group(6)) if match.group(6) else 0
        try:
            if 2000 <= y <= datetime.now().year + 1:
                return datetime(y, m, d, hr, mi, se)
        except ValueError:
            pass

    # Pattern 2: YYYYMMDD (compact, with optional time HHMMSS)
    match = re.search(r'(\d{4})(\d{2})(\d{2})(?:[-_]?(\d{2})(\d{2})(\d{2}))?', name)
    if match:
        y, m, d = int(match.group(1)), int(match.group(2)), int(match.group(3))
        hr = int(match.group(4)) if match.group(4) else 0
        mi = int(match.group(5)) if match.group(5) else 0
        se = int(match.group(6)) if match.group(6) else 0
        try:
            if 2000 <= y <= datetime.now().year + 1:
                return datetime(y, m, d, hr, mi, se)
        except ValueError:
            pass

    # Pattern 3: MM-DD-YYYY or MM_DD_YYYY (US format)
    match = re.search(r'(\d{2})[-_](\d{2})[-_](\d{4})', name)
    if match:
        m, d, y = int(match.group(1)), int(match.group(2)), int(match.group(3))
        try:
            if 2000 <= y <= datetime.now().year + 1:
                return datetime(y, m, d)
        except ValueError:
            pass

    return None


def _extract_date_from_metadata(file_path: Path):
    """
    Extract creation date from video file metadata using ffprobe.

    Looks for common metadata tags like creation_time, date, etc.

    Args:
        file_path: Path to the video file

    Returns:
        datetime object if a valid date was found in metadata, None otherwise
    """
    try:
        cmd = ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_entries', 'format_tags', str(file_path)]
        logger.debug(f"$ {' '.join(cmd)}")
        data = json.loads(sp.check_output(cmd).decode('utf-8'))
        
        tags = data.get('format', {}).get('tags', {})
        if not tags:
            return None
        
        # Common metadata date tags (case-insensitive check)
        date_tags = ['creation_time', 'date', 'date_recorded', 'recorded_date', 
                     'com.apple.quicktime.creationdate', 'creation_date']
        
        for tag in date_tags:
            # Try both original case and lowercase
            value = tags.get(tag) or tags.get(tag.upper()) or tags.get(tag.lower())
            if value:
                # Try parsing various date formats
                date_formats = [
                    '%Y-%m-%dT%H:%M:%S.%fZ',  # ISO format with microseconds
                    '%Y-%m-%dT%H:%M:%SZ',      # ISO format
                    '%Y-%m-%dT%H:%M:%S.%f',    # ISO without Z
                    '%Y-%m-%dT%H:%M:%S',       # ISO without Z or microseconds
                    '%Y-%m-%d %H:%M:%S',       # Standard datetime
                    '%Y-%m-%d',                # Date only
                    '%Y:%m:%d %H:%M:%S',       # EXIF style
                ]
                
                for fmt in date_formats:
                    try:
                        # Handle timezone offset (e.g., +00:00)
                        clean_value = re.sub(r'[+-]\d{2}:\d{2}$', '', value)
                        parsed = datetime.strptime(clean_value, fmt)
                        if 2000 <= parsed.year <= datetime.now().year + 1:
                            logger.debug(f"Extracted date {parsed} from metadata tag '{tag}'")
                            return parsed
                    except ValueError:
                        continue
        
        return None
    except Exception as ex:
        logger.debug(f"Failed to extract date from metadata: {ex}")
        return None


def _extract_date_from_image_exif(file_path: Path):
    """
    Extract creation date from image EXIF metadata using PIL.

    Checks DateTimeOriginal (36867), DateTimeDigitized (36868), and DateTime (306).
    """
    try:
        from PIL import Image as PILImage
        with PILImage.open(str(file_path)) as img:
            exif_data = img._getexif()
            if not exif_data:
                return None
        # EXIF tag IDs for date fields in priority order
        for tag_id in (36867, 36868, 306):
            value = exif_data.get(tag_id)
            if value:
                try:
                    parsed = datetime.strptime(value, '%Y:%m:%d %H:%M:%S')
                    if 2000 <= parsed.year <= datetime.now().year + 1:
                        logger.debug(f"Extracted date {parsed} from image EXIF tag {tag_id}")
                        return parsed
                except ValueError:
                    continue
        return None
    except Exception as ex:
        logger.debug(f"Failed to extract EXIF date from image: {ex}")
        return None


def extract_date_from_image_file(file_path: Path):
    """
    Extract a creation date from an image file.

    Tries in order:
    1. EXIF metadata (DateTimeOriginal, DateTimeDigitized, DateTime)
    2. Filename date patterns
    3. File modification time
    """
    file_path = Path(file_path)

    if not file_path.exists():
        logger.warning(f"Cannot extract date from non-existent file: {file_path}")
        return None

    exif_date = _extract_date_from_image_exif(file_path)
    if exif_date:
        return exif_date

    filename_date = _extract_date_from_filename(file_path.name)
    if filename_date:
        logger.debug(f"Using filename date for {file_path.name}: {filename_date}")
        return filename_date

    try:
        created_date = datetime.fromtimestamp(os.path.getmtime(file_path))
        logger.debug(f"Using file mtime for {file_path.name}: {created_date}")
        return created_date
    except Exception as ex:
        logger.warning(f"Failed to get file mtime for {file_path}: {ex}")
        return None


def extract_date_from_file(file_path: Path):
    """
    Extract a recording date from a video file.

    Tries the following sources in order:
    1. Video metadata (creation_time, date tags via ffprobe)
    2. Filename patterns (common screen recording software formats)
    3. File creation timestamp

    Args:
        file_path: Path to the video file

    Returns:
        datetime object with the best available date, or None if file doesn't exist
    """
    file_path = Path(file_path)
    
    if not file_path.exists():
        logger.warning(f"Cannot extract date from non-existent file: {file_path}")
        return None
    
    # 1. Try metadata first (most accurate)
    metadata_date = _extract_date_from_metadata(file_path)
    if metadata_date:
        logger.debug(f"Using metadata date for {file_path.name}: {metadata_date}")
        return metadata_date
    
    # 2. Try filename patterns
    filename_date = _extract_date_from_filename(file_path.name)
    if filename_date:
        logger.debug(f"Using filename date for {file_path.name}: {filename_date}")
        return filename_date
    
    # 3. Fall back to file modification time (mtime is stable; ctime changes on move/chmod)
    try:
        created_timestamp = os.path.getmtime(file_path)
        created_date = datetime.fromtimestamp(created_timestamp)
        logger.debug(f"Using file mtime for {file_path.name}: {created_date}")
        return created_date
    except Exception as ex:
        logger.warning(f"Failed to get file creation time for {file_path}: {ex}")
        return None
