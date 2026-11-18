import glob
import multiprocessing
import os
import tempfile

_SHM_DIR = "/dev/shm" if os.path.isdir("/dev/shm") else tempfile.gettempdir()

# Server socket
bind = "127.0.0.1:5000"
backlog = 2048  # Number of pending connections

# Worker processes
# Cap at 4 by default — fireshare is an I/O-bound media server and gthread workers
# with multiple threads handle concurrency efficiently without needing many processes.
# High core-count machines (e.g. 32c/64t) would otherwise spawn 65+ workers, each
# loading CUDA, pushing PID counts well past typical container limits (~2048).
# Override with GUNICORN_WORKERS; set GUNICORN_WORKER_CAP=0 to remove the cap.
_default_workers = multiprocessing.cpu_count() * 2 + 1
_worker_cap = int(os.environ.get("GUNICORN_WORKER_CAP", 4))
workers = int(os.environ.get("GUNICORN_WORKERS",
              min(_default_workers, _worker_cap) if _worker_cap > 0 else _default_workers))
worker_class = "gthread"  # Use threaded workers
threads = int(os.environ.get("GUNICORN_THREADS", 8))  # 8 threads per worker (I/O-bound workload benefits from more threads)
worker_connections = 1000
max_requests = 2000  # Restart workers after N requests (prevents memory leaks)
max_requests_jitter = 100  # Add randomness to prevent all workers restarting at once

# Timeouts
timeout = 120  # Worker timeout (normal requests)
graceful_timeout = 30
keepalive = 5  # Keep connections alive

# Logging
loglevel = "warning"
accesslog = None
errorlog = "-"   # Log to stderr
access_log_format = '%(h)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s" %(D)s'

# Process naming
proc_name = "fireshare"

# Server mechanics
daemon = False
pidfile = None
umask = 0
user = None  # Set by command line
group = None  # Set by command line
tmp_upload_dir = None

# Preload app (be careful with SQLite - might need to disable)
preload_app = False  # Changed from True - SQLite doesn't like forking

# Worker tmp directory
worker_tmp_dir = "/dev/shm"  # Use RAM for worker tmp files

# Sentinel files used to elect exactly one worker per gunicorn lifetime.
# Uses /dev/shm (already our worker_tmp_dir) which is guaranteed writable.
# Written with O_EXCL so the first worker to create it wins atomically.
# The app claims its own through fireshare.claim_sentinel (the startup chunk
# cleanup, the startup warnings, the update notice). Every one is named
# fireshare_*, and on_starting clears them all by that prefix, so this file does
# not need to know their names.
_SCHEDULER_SENTINEL = os.path.join(_SHM_DIR, "fireshare_scheduler.lock")
_SENTINEL_GLOB = os.path.join(_SHM_DIR, "fireshare_*")


def on_starting(server):
    """Called just before the master process is initialized."""
    # Remove stale sentinels from a previous run, and any the entrypoint's CLI
    # steps claimed before the server started, so this run's workers hold a fresh
    # election for every role.
    for sentinel in glob.glob(_SENTINEL_GLOB):
        try:
            os.unlink(sentinel)
        except Exception:
            pass
    server.log.info("Starting Fireshare")


def post_fork(server, worker):
    """Elect exactly one worker to run the background scheduler.

    Each worker races to create the sentinel file with O_CREAT|O_EXCL, which
    is atomic on POSIX filesystems.  The winner sets FIRESHARE_START_SCHEDULER
    in its own environment; losers leave it unset.  create_app() reads this
    env var to decide whether to call init_schedule().

    Any failure here is logged and swallowed so hook errors never crash workers.
    """
    try:
        fd = os.open(_SCHEDULER_SENTINEL, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        os.environ['FIRESHARE_START_SCHEDULER'] = '1'
        server.log.info(f"Worker {os.getpid()}: elected as scheduler worker")
    except FileExistsError:
        # Another worker already claimed the scheduler role
        os.environ.pop('FIRESHARE_START_SCHEDULER', None)
    except Exception as e:
        # Sentinel creation failed (permissions, missing dir, etc.) — degrade
        # gracefully: no worker will run the scheduler rather than crashing.
        server.log.warning(f"Worker {os.getpid()}: could not create scheduler sentinel: {e}")
        os.environ.pop('FIRESHARE_START_SCHEDULER', None)


def worker_exit(server, worker):
    """When the scheduler worker exits, clear the sentinel so a replacement
    worker can take over the scheduler role on its next startup."""
    try:
        with open(_SCHEDULER_SENTINEL, 'r') as f:
            scheduler_pid = int(f.read().strip())
        if scheduler_pid == worker.pid:
            os.unlink(_SCHEDULER_SENTINEL)
            server.log.info(
                f"Scheduler worker {worker.pid} exited; sentinel cleared "
                "so a new worker can take over"
            )
    except Exception:
        pass


def when_ready(server):
    """Called just after the server is started."""
    server.log.info("Fireshare is ready")


def on_reload(server):
    """Called to recycle workers during a reload."""
    server.log.info("Reloading Fireshare")
