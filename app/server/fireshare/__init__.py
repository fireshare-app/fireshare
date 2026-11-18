import os, sys, re, copy, tempfile
import os.path
from . import ldap_retired
from flask import Flask
from flask.logging import default_handler
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_login import LoginManager
from flask_cors import CORS
from pathlib import Path
import logging
import json
import secrets
from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.pool import NullPool
from sqlite3 import Connection as SQLite3Connection

logger = logging.getLogger('fireshare')
handler = logging.StreamHandler(sys.stdout)
handler.setLevel(os.getenv('FS_LOGLEVEL', 'INFO').upper())
formatter = logging.Formatter('%(asctime)s %(levelname)-7s %(module)s.%(funcName)s:%(lineno)d | %(message)s')
handler.setFormatter(formatter)
logger.addHandler(handler)
logger.setLevel(logging.DEBUG)
# This handler is the only place fireshare's records are written. Left to
# propagate, they reached the root logger too, which a bare logging.info()
# anywhere in the process configures, and every line printed a second time.
logger.propagate = False


def claim_sentinel(name, on_error=False):
    """
    Atomically create a sentinel file in shared memory and return True for the
    one process that created it, False for every other. O_CREAT|O_EXCL makes
    this a race-free election across gunicorn workers and the CLI processes they
    launch. `name` must start with "fireshare_": gunicorn.conf.py's on_starting
    removes every such file, so each run of the server holds a fresh election.

    on_error is returned when the sentinel cannot be created at all, such as an
    unwritable /dev/shm, so the caller chooses whether to act anyway or not at all.
    """
    shm_dir = "/dev/shm" if os.path.isdir("/dev/shm") else tempfile.gettempdir()
    try:
        fd = os.open(os.path.join(shm_dir, name), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return False
    except Exception as e:
        logger.warning(f"Could not create sentinel {name}: {e}")
        return on_error
    # The file now exists, so this process has won whatever happens next. The pid
    # inside is only a note for whoever looks; a full /dev/shm must not turn a
    # won election into an exception.
    try:
        os.write(fd, str(os.getpid()).encode())
    except OSError as e:
        logger.warning(f"Could not write sentinel {name}: {e}")
    finally:
        os.close(fd)
    return True

def env_bool(name, default=False):
    """Read a boolean env var. An explicitly falsy value ("false", "0", "no") turns the
    feature off — bool(os.getenv(...)) treated *any* value, including "false", as on."""
    raw = os.getenv(name)
    if raw is None or raw.strip() == '':
        return default
    return raw.strip().lower() in ('true', '1', 'yes', 'on')


# Configure SQLite for better concurrency
@event.listens_for(Engine, "connect")
def set_sqlite_pragma(dbapi_conn, connection_record):
    if isinstance(dbapi_conn, SQLite3Connection):
        cursor = dbapi_conn.cursor()
        
        # Enable WAL mode for better concurrency
        cursor.execute("PRAGMA journal_mode=WAL")
        
        # Set busy timeout to 30 seconds (instead of failing immediately)
        cursor.execute("PRAGMA busy_timeout = 30000")

        # Raise WAL autocheckpoint threshold to reduce write-latency spikes
        # (default is 1000 pages ~4MB; 10000 pages ~40MB smooths out periodic flushes)
        cursor.execute("PRAGMA wal_autocheckpoint = 10000")
        
        # Increase cache size (default is 2MB, increase to 64MB)
        cursor.execute("PRAGMA cache_size = -64000")
        
        # Synchronous = NORMAL for better performance (still safe with WAL)
        cursor.execute("PRAGMA synchronous = NORMAL")
        
        # Temp store in memory
        cursor.execute("PRAGMA temp_store = MEMORY")
        
        # Increase mmap size for better read performance
        cursor.execute("PRAGMA mmap_size = 268435456")  # 256MB
        
        cursor.close()
        
# init SQLAlchemy so we can use it later in our models
db = SQLAlchemy()
migrate = Migrate()

def update_config(path):
    logger.debug("Validating configuration file...")
    def combine(dict1, dict2):
        for key in dict2:
            if key in dict1:
                if isinstance(dict1[key], list): # If value is a list, we want special logic
                    if isinstance(dict2[key], list): # if the "input" is a list, just do list + list
                        dict1[key] = dict1[key] + dict2[key]
                    else:
                        dict1[key].append(dict2[key])
                elif isinstance(dict1[key], dict): # calling itself recursively
                    if key in dict2 and isinstance(dict2[key], dict):
                        dict1[key] = combine(dict1[key], dict2[key])
                    else:
                        pass #keep default dict as is




                else: # Overwrites all other values
                    dict1[key] = dict2[key]
            else: # Creates the values that doesn't exist.
                dict1[key] = dict2[key]
        return dict1

    def atomic_write(target, content):
        dir = target.parent
        with tempfile.NamedTemporaryFile('w', dir=dir, delete=False, suffix='.tmp') as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        os.replace(tmp_path, target)

    from .constants import DEFAULT_CONFIG
    if not path.exists():
        atomic_write(path, json.dumps(DEFAULT_CONFIG, indent=2))

    with open(path, 'r') as configfile:
        try:
            current = json.load(configfile)
        except:
            backup = path.with_suffix('.json.bak')
            logger.warning(f"Invalid config.json at {str(path)}, backing up to {str(backup)} and resetting to defaults")
            path.rename(backup)
            atomic_write(path, json.dumps(DEFAULT_CONFIG, indent=2))
            current = copy.deepcopy(DEFAULT_CONFIG)
        # If image_defaults is missing, inherit from video_defaults so privacy stays consistent
        if 'image_defaults' not in current.get('app_config', {}):
            video_private = current.get('app_config', {}).get('video_defaults', {}).get('private', True)
            current.setdefault('app_config', {})['image_defaults'] = {'private': video_private}
        updated = combine(copy.deepcopy(DEFAULT_CONFIG), current)
        atomic_write(path, json.dumps(updated, indent=2))

def create_app(init_schedule=False):
    # Before anything else, including the migration step that also builds the app:
    # refuse to run while an LDAP configuration is still present.
    ldap_retired.abort_if_ldap_configured(logger)

    app = Flask(__name__, static_url_path='', static_folder='build', template_folder='build')
    # app.logger is the 'fireshare' logger above, since Flask names it after the
    # import name. Flask adds its own stderr handler to it unless one is already
    # set at the logger's level, and ours sits at FS_LOGLEVEL rather than DEBUG,
    # so it always did: every record then printed twice, in two formats.
    app.logger.removeHandler(default_handler)

    # Cross-origin access is off unless an operator names the origins that need it.
    # It used to be CORS(app, supports_credentials=True) with no origins, which
    # flask-cors reads as "any origin": it echoed whatever Origin arrived back as
    # Access-Control-Allow-Origin next to Access-Control-Allow-Credentials: true,
    # so any site a signed-in user visited could call the API as them. Fireshare
    # serves its frontend from this same origin, so nothing needs this by default.
    cors_origins = [o.strip() for o in os.getenv('CORS_ORIGINS', '').split(',') if o.strip()]
    if '*' in cors_origins:
        logger.warning(
            "CORS_ORIGINS=* cannot be combined with credentialed requests and has been "
            "ignored. List the origins that need access explicitly."
        )
        cors_origins = [o for o in cors_origins if o != '*']
    if cors_origins:
        CORS(app, supports_credentials=True, origins=cors_origins)
        logger.info(f"CORS enabled for: {', '.join(cors_origins)}")

    if 'DATA_DIRECTORY' not in os.environ:
        raise Exception("DATA_DIRECTORY not found in environment")

    app.config['ENVIRONMENT'] = os.getenv('ENVIRONMENT')
    app.config['DOMAIN'] = os.getenv('DOMAIN')
    app.config['THUMBNAIL_VIDEO_LOCATION'] = int(os.getenv('THUMBNAIL_VIDEO_LOCATION') or 0)

    # Both of these shipped filled in — one in docker-compose.yml, one in the README's
    # compose example — so instances that never edited the line were signing cookies
    # with a key published in this repo. A signing key is worth nothing once public,
    # so treat either as if it were unset.
    PUBLISHED_SECRET_KEYS = {
        'replace_this_with_some_random_string',
        'replace_with_random_string_can_be_anything',
    }
    _secret_key = os.getenv('SECRET_KEY') or ''
    if _secret_key in PUBLISHED_SECRET_KEYS:
        logger.warning(
            "SECRET_KEY is set to an example value published in the Fireshare docs. That key "
            "is public, so it is being ignored in favour of a generated one. Remove the line "
            "from your compose file; sessions will not survive a restart until you do."
        )
        _secret_key = ''
    app.config['SECRET_KEY'] = _secret_key or secrets.token_hex(32)

    from datetime import timedelta
    app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(hours=1)

    # SameSite was never set, leaving both cookies on whatever the browser happened
    # to default to. Lax is stated explicitly so a cross-site request cannot carry
    # them regardless of that default. Secure is opt-in because plenty of instances
    # are reached over plain HTTP on a LAN, where it would lock users out entirely.
    secure_cookies = env_bool('SECURE_COOKIES')
    app.config['SESSION_COOKIE_HTTPONLY'] = True
    app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
    app.config['SESSION_COOKIE_SECURE'] = secure_cookies
    app.config['REMEMBER_COOKIE_HTTPONLY'] = True
    app.config['REMEMBER_COOKIE_SAMESITE'] = 'Lax'
    app.config['REMEMBER_COOKIE_SECURE'] = secure_cookies

    app.config['DATA_DIRECTORY'] = os.getenv('DATA_DIRECTORY')
    app.config['VIDEO_DIRECTORY'] = os.getenv('VIDEO_DIRECTORY')
    app.config['PROCESSED_DIRECTORY'] = os.getenv('PROCESSED_DIRECTORY')
    app.config['IMAGE_DIRECTORY'] = os.getenv('IMAGE_DIRECTORY')
    app.config['ADMIN_USERNAME'] = os.getenv('ADMIN_USERNAME')
    app.config['ADMIN_PASSWORD'] = os.getenv('ADMIN_PASSWORD')
    app.config['DISABLE_ADMINCREATE'] = env_bool("DISABLE_ADMINCREATE")
    app.config['DEMO_MODE'] = os.getenv('DEMO_MODE', '').lower() in ('true', '1', 'yes')
    app.config['DEMO_UPLOAD_LIMIT_MB'] = int(os.getenv('DEMO_UPLOAD_LIMIT_MB', '0') or '0')
    app.config['ENABLE_TRANSCODING'] = (
        False if app.config['DEMO_MODE']
        else os.getenv('ENABLE_TRANSCODING', '').lower() in ('true', '1', 'yes')
    )
    app.config['TRANSCODE_GPU'] = (
        False if os.getenv('FIRESHARE_LITE', '').lower() in ('true', '1', 'yes')
        else os.getenv('TRANSCODE_GPU', '').lower() in ('true', '1', 'yes')
    )
    app.config['SERVE_GAME_ASSETS_NGINX'] = os.getenv('ENVIRONMENT', '') == 'production'
    app.config['TRANSCODE_TIMEOUT'] = int(os.getenv('TRANSCODE_TIMEOUT', '7200'))  # Default: 2 hours

    from .ip_whitelist import parse_ip_whitelist
    app.config['LOGIN_IP_WHITELIST'] = parse_ip_whitelist(os.getenv('LOGIN_IP_WHITELIST', ''))
    # In the container the bundled nginx is one trusted hop in front of gunicorn; in dev
    # Flask is exposed directly, so client-supplied X-Forwarded-For must be ignored.
    _default_hops = '1' if os.getenv('ENVIRONMENT', '') == 'production' else '0'
    try:
        app.config['LOGIN_IP_WHITELIST_TRUSTED_PROXIES'] = int(os.getenv('LOGIN_IP_WHITELIST_TRUSTED_PROXIES') or _default_hops)
    except ValueError:
        logger.error("FATAL: LOGIN_IP_WHITELIST_TRUSTED_PROXIES must be an integer")
        sys.exit(1)
    if app.config['LOGIN_IP_WHITELIST'] is not None:
        logger.info(
            f"Login IP whitelist active with {len(app.config['LOGIN_IP_WHITELIST'])} "
            f"entries ({app.config['LOGIN_IP_WHITELIST_TRUSTED_PROXIES']} trusted proxy hops)"
        )

    #Integrations
    app.config['DISCORD_WEBHOOK_URL'] = os.getenv('DISCORD_WEBHOOK_URL', '')
    app.config['GENERIC_WEBHOOK_URL'] = os.getenv('GENERIC_WEBHOOK_URL', '')
    raw_payload = os.getenv('GENERIC_WEBHOOK_PAYLOAD')
    if raw_payload:
        try:
            app.config['GENERIC_WEBHOOK_PAYLOAD'] = json.loads(raw_payload)
        except (json.JSONDecodeError, TypeError) as e:
            app.logger.error(f"FATAL: GENERIC_WEBHOOK_PAYLOAD contains invalid JSON syntax, please verify JSON format")
            sys.exit(1) 
    else:
        app.config['GENERIC_WEBHOOK_PAYLOAD'] = None

    app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{app.config["DATA_DIRECTORY"]}/db.sqlite'
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
    # Configure SQLite connection for thread safety with Flask's --with-threads
    # NullPool creates a fresh connection per request, avoiding thread conflicts
    # WAL mode (set in pragma) handles concurrent reads/writes efficiently
    app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
        'poolclass': NullPool,
        'connect_args': {
            'check_same_thread': False,
        },
    }
    app.config['SCHEDULED_JOBS_DATABASE_URI'] = f'sqlite:///{app.config["DATA_DIRECTORY"]}/jobs.sqlite'
    app.config['INIT_SCHEDULE'] = init_schedule
    # `0` disables the automatic scan entirely; negatives are treated the same.
    # An unparseable value falls back to the default rather than silently disabling scans.
    raw_scan_interval = os.getenv('MINUTES_BETWEEN_VIDEO_SCANS', '5').strip() or '5'
    try:
        app.config['MINUTES_BETWEEN_VIDEO_SCANS'] = max(int(raw_scan_interval), 0)
    except ValueError:
        logger.warning(f"MINUTES_BETWEEN_VIDEO_SCANS={raw_scan_interval!r} is not a valid integer, "
                       "falling back to 5. Set it to 0 to disable the automatic scan.")
        app.config['MINUTES_BETWEEN_VIDEO_SCANS'] = 5
    app.config['WARNINGS'] = []

    if (app.config['ADMIN_PASSWORD'] and app.config['ADMIN_USERNAME'] == "admin") and app.config["DISABLE_ADMINCREATE"] == False:
        stdPasswordWarning = "You are using the Default Login-Credentials, please consider changing it."
        app.config['WARNINGS'].append(stdPasswordWarning)

    # Check for SteamGridDB API key
    config_path = Path(app.config['DATA_DIRECTORY']) / 'config.json'
    steamgrid_api_key = os.environ.get('STEAMGRIDDB_API_KEY', '')
    if config_path.exists():
        with open(config_path, 'r') as configfile:
            try:
                config_data = json.load(configfile)
                config_steamgrid_key = config_data.get('integrations', {}).get('steamgriddb_api_key', '')
                if config_steamgrid_key:
                    steamgrid_api_key = config_steamgrid_key
            except:
                pass

    if not steamgrid_api_key:
        steamgridWarning = "SteamGridDB API key not configured. Game metadata features are unavailable. Click here to set it up."
        app.config['WARNINGS'].append(steamgridWarning)

    paths = {
        'data': Path(app.config['DATA_DIRECTORY']),
        'video': Path(app.config['VIDEO_DIRECTORY']),
        'processed': Path(app.config['PROCESSED_DIRECTORY']),
    }
    if app.config['IMAGE_DIRECTORY']:
        paths['images'] = Path(app.config['IMAGE_DIRECTORY'])
    app.config['PATHS'] = paths
    failed_paths = []
    for k, path in paths.items():
        if not path.is_dir():
            if k != 'images':
                logger.info(f"Creating {k} directory at {str(path)}")
            try:
                path.mkdir(parents=True, exist_ok=True)
            except PermissionError:
                if k != 'images':
                    logger.warning(f"Permission denied creating {k} directory at {str(path)}. Mount a volume to this path or ensure the directory exists with correct permissions.")
                failed_paths.append(k)
    for k in failed_paths:
        del paths[k]
    app.config['PATHS'] = paths
    subpaths = [
        paths['processed'] / 'video_links',
        paths['processed'] / 'image_links',
        paths['processed'] / 'derived',
    ]
    for subpath in subpaths:
        if not subpath.is_dir():
            logger.info(f"Creating subpath directory at {str(subpath.absolute())}")
            subpath.mkdir(parents=True, exist_ok=True)

    # Clean up any leftover chunk files from interrupted uploads, but only once
    # per gunicorn master lifetime.  With preload_app=False, create_app() runs in
    # every worker process, including workers that restart while an upload is in
    # progress.  We use a sentinel file (same O_CREAT|O_EXCL pattern as the
    # scheduler election) so only the very first worker to start does the cleanup;
    # all subsequent workers - including restarts triggered by max_requests or
    # crashes - skip it and leave in-progress chunks untouched.
    _should_cleanup = claim_sentinel("fireshare_cleanup.lock")

    # Log the startup warnings once per server start. Every gunicorn worker runs
    # create_app(), and so does each `fireshare` CLI process the scheduled scan
    # launches every few minutes, so logging them unconditionally repeated them for
    # as long as the container ran. Only web workers (init_schedule) take part,
    # and the first one logs. If the sentinel cannot be created at all, each logs
    # rather than none. The dev server runs without gunicorn, so it always logs.
    # The UI shows the warnings either way.
    if (init_schedule and claim_sentinel("fireshare_startup_warnings.lock", on_error=True)) \
            or app.config['ENVIRONMENT'] == 'dev':
        for warning in app.config['WARNINGS']:
            logger.warning(warning)

    if _should_cleanup:
        import glob as _glob
        import time as _time
        # Only parts that have gone stale. Sweeping unconditionally would destroy
        # uploads that are merely in flight: a token client holding a partly sent
        # set has no way to tell that its parts are gone, so every restart of this
        # container during an upload would strand that upload at 202. An age cut
        # still collects what the sweep is actually for — sets abandoned by a tool
        # that never came back — because each part carries the mtime of the moment
        # it was written, and an upload in progress is nowhere near the threshold.
        _CHUNK_MAX_AGE_SECONDS = 24 * 60 * 60
        cutoff = _time.time() - _CHUNK_MAX_AGE_SECONDS
        # Images are swept too: token uploads can be chunked, and an image one
        # leaves its parts under the image root rather than the video root.
        # '.assembling' is a chunked upload caught mid-reassembly; it never carries
        # a media extension, so nothing will have scanned it.
        chunk_roots = [paths['video']] + ([paths['images']] if 'images' in paths else [])
        chunk_patterns = ('*.part[0-9][0-9][0-9][0-9]', '*.assembling')
        chunk_files = [f for root in chunk_roots for pattern in chunk_patterns
                       for f in _glob.glob(str(root / '**' / pattern), recursive=True)]
        for chunk_file in chunk_files:
            try:
                if os.path.getmtime(chunk_file) > cutoff:
                    continue
                os.remove(chunk_file)
                logger.info(f"Removed stale upload chunk: {chunk_file}")
            except OSError as e:
                logger.warning(f"Failed to remove stale upload chunk {chunk_file}: {e}")

    # Ensure game_assets directory exists
    game_assets_dir = paths['data'] / 'game_assets'
    if not game_assets_dir.is_dir():
        logger.info(f"Creating game_assets directory at {str(game_assets_dir.absolute())}")
        game_assets_dir.mkdir(parents=True, exist_ok=True)
    
    update_config(paths['data'] / 'config.json')

    if app.config['DEMO_MODE']:
        _demo_config_path = paths['data'] / 'config.json'
        with open(_demo_config_path, 'r+') as _f:
            _cfg = json.load(_f)
            _cfg.setdefault('app_config', {})['allow_public_upload'] = True
            _cfg.setdefault('app_config', {})['allow_public_folder_selection'] = True
            _cfg.setdefault('app_config', {})['allow_public_game_tag'] = True
            _f.seek(0)
            json.dump(_cfg, _f, indent=2)
            _f.truncate()

    db.init_app(app)
    migrate.init_app(app, db)

    # Reset any transcode jobs that were marked 'running' when the container
    # last shut down — those processes are gone, so the jobs need to be retried.
    # Also purge completed/failed rows from the previous session so their counts
    # don't bleed into the next session's progress display.
    try:
        from .models import TranscodeJob
        from .api.transcoding import _ensure_drain_running
        with app.app_context():
            purged = TranscodeJob.query.filter(
                TranscodeJob.status.in_(['complete', 'failed'])
            ).delete()
            if purged:
                logger.info(f"Purged {purged} completed/failed transcode job(s) from previous session")

            stale = TranscodeJob.query.filter_by(status='running').all()
            for job in stale:
                job.status = 'pending'
                job.started_at = None
            if stale:
                logger.info(f"Reset {len(stale)} stale transcode job(s) to pending on startup")

            db.session.commit()

            if stale:
                _ensure_drain_running(app, paths['data'])
    except Exception as e:
        logger.warning(f"Could not reset stale transcode jobs: {e}")

    login_manager = LoginManager()
    login_manager.init_app(app)

    from .models import User

    @login_manager.user_loader
    def load_user(user_id):
        try:
            user = db.session.get(User, int(user_id))
        except (TypeError, ValueError):
            return None
        # Refusing to load a disabled account is what actually ends its access:
        # it invalidates live sessions and "remember me" cookies immediately,
        # rather than leaving the user signed in until their session expires.
        if user is None or user.disabled:
            return None
        return user

    # blueprint for auth routes in our app
    from .auth import auth as auth_blueprint
    app.register_blueprint(auth_blueprint)

    # blueprint for api routes
    from .api import api as api_blueprint
    app.register_blueprint(api_blueprint)

    # blueprint for non-auth parts of app
    from .main import main as main_blueprint
    app.register_blueprint(main_blueprint)

    if init_schedule and os.environ.get('FIRESHARE_START_SCHEDULER') == '1':
        from .schedule import init_schedule as _init_schedule
        _init_schedule(app.config['SCHEDULED_JOBS_DATABASE_URI'],
            app.config['MINUTES_BETWEEN_VIDEO_SCANS'])
    
    #Integrations Validation
    if app.config.get('DISCORD_WEBHOOK_URL'):
        discord_regex = r"^https:\/\/discord\.com\/api\/webhooks\/\d{17,20}\/[\w-]{60,}$"
        if re.match(discord_regex, app.config['DISCORD_WEBHOOK_URL']):
            app.logger.info(f"Discord Integration: URL VALID | ENABLED (URL: {app.config['DISCORD_WEBHOOK_URL'][:20]}...)")
        else:            
            app.logger.error("Discord Webhook URL format looks invalid. Please double-check the URL.")
            sys.exit(1)

    if app.config.get("GENERIC_WEBHOOK_URL") or app.config.get("GENERIC_WEBHOOK_PAYLOAD"):
        if not app.config.get("GENERIC_WEBHOOK_URL") or not app.config.get("GENERIC_WEBHOOK_PAYLOAD"):
            app.logger.error("FATAL: Incomplete Generic Webhook configuration. Both URL and PAYLOAD must be set.")
            sys.exit(1)

        url_regex = r"^https?:\/\/[^\s\/$.?#].[^\s]*$"
        if re.match(url_regex, app.config['GENERIC_WEBHOOK_URL']):
            app.logger.info(f"Generic Webhook: URL VALID | ENABLED ({app.config['GENERIC_WEBHOOK_URL'][:20]}...)")
        else:            
            app.logger.error(f"FATAL: Generic Webhook URL format is invalid: {app.config['GENERIC_WEBHOOK_URL']}")
            sys.exit(1)

        if isinstance(app.config['GENERIC_WEBHOOK_PAYLOAD'], dict):
            app.logger.info("Generic Webhook: PAYLOAD VALID | ENABLED")
        else:
            app.logger.error("FATAL: Generic Webhook PAYLOAD must be a JSON object (dictionary).")
            sys.exit(1)

    from .constants import DEFAULT_CONFIG
    if 'integrations' not in DEFAULT_CONFIG:
        DEFAULT_CONFIG['integrations'] = {}

    update_config(paths['data'] / 'config.json')

    # Only overwrite integration settings in config.json if the env vars are explicitly set.
    # This preserves values the user may have configured via the UI or directly in config.json.
    config_path = paths['data'] / 'config.json'
    with open(config_path, 'r+') as f:
        data = json.load(f)

        if app.config.get('DISCORD_WEBHOOK_URL'):
            data['integrations']['discord_webhook_url'] = app.config['DISCORD_WEBHOOK_URL']
        if app.config.get('GENERIC_WEBHOOK_URL'):
            data['integrations']['generic_webhook_url'] = app.config['GENERIC_WEBHOOK_URL']
        if app.config.get('GENERIC_WEBHOOK_PAYLOAD'):
            data['integrations']['generic_webhook_payload'] = app.config['GENERIC_WEBHOOK_PAYLOAD']

        f.seek(0)
        json.dump(data, f, indent=2)
        f.truncate()

    with app.app_context():
        # db.create_all()

        from sqlalchemy import text as _sa_text
        try:
            with db.engine.connect() as _conn:
                _cols = {row[1] for row in _conn.execute(_sa_text("PRAGMA table_info(video_info)"))}
                if "password_hash" not in _cols:
                    _conn.execute(_sa_text("ALTER TABLE video_info ADD COLUMN password_hash VARCHAR(256)"))
                _conn.commit()
        except Exception:
            pass  # table doesn't exist yet; will be created by flask db upgrade

        from sqlalchemy.exc import OperationalError
        from werkzeug.security import generate_password_hash, check_password_hash
        from .models import User as _User
        try:
            from datetime import datetime as _datetime

            # ADMIN_USERNAME / ADMIN_PASSWORD are re-applied on every boot, so the
            # account they own has to be identified unambiguously. Once a second
            # administrator exists, "the first local admin" is an arbitrary row and
            # this logic could rewrite the wrong person's credentials, so the
            # bootstrap account is pinned with env_managed instead.
            admin = _User.query.filter_by(env_managed=True).first()
            if not admin:
                # Pre-upgrade install, or one where the pin was lost: adopt the
                # lowest-id local admin, which is the account the bootstrap created.
                #
                # A stored password is what makes an administrator local. This
                # used to read `ldap=False`, but that column is dropped by the
                # LDAP removal migration, and on the `flask db upgrade` run that
                # applies it this code executes first — while directory rows are
                # still present. Adopting one would rename a directory admin to
                # ADMIN_USERNAME and hand it the env password. Fireshare never
                # stored a password for a directory account, so requiring one
                # excludes them, and on an LDAP-only instance it correctly falls
                # through to creating a fresh local administrator below.
                admin = (_User.query
                         .filter(_User.admin == True, _User.password.isnot(None))
                         .order_by(_User.id)
                         .first())
                if admin:
                    admin.env_managed = True
                    db.session.commit()

            if not admin and not app.config['DISABLE_ADMINCREATE']:
                username = app.config['ADMIN_USERNAME'] or 'admin'
                admin_user = _User(
                    username=username,
                    password=generate_password_hash(app.config['ADMIN_PASSWORD'] or 'admin', method='pbkdf2:sha256'),
                    admin=True,
                    env_managed=True,
                    created_at=_datetime.utcnow(),
                )
                db.session.add(admin_user)
                db.session.commit()
            if admin:
                # The env-managed account must stay usable as an administrator;
                # a demotion here would lock the operator out of their own instance.
                if not admin.admin or admin.disabled:
                    admin.admin = True
                    admin.disabled = False
                    db.session.commit()
                if app.config['ADMIN_PASSWORD']:
                    try:
                        password_mismatch = not check_password_hash(admin.password or '', app.config['ADMIN_PASSWORD'])
                    except ValueError:
                        password_mismatch = True  # old hash format (sha256), force reset to pbkdf2:sha256
                    if password_mismatch:
                        admin.password = generate_password_hash(app.config['ADMIN_PASSWORD'], method='pbkdf2:sha256')
                        admin.must_change_password = False
                        db.session.commit()
                if app.config['ADMIN_USERNAME'] and admin.username != app.config['ADMIN_USERNAME']:
                    # Only rename when the target name is free, otherwise the unique
                    # constraint would abort startup.
                    #
                    # Compared case-insensitively, like account creation in
                    # api/users.py. The column has no NOCASE collation, so the
                    # unique constraint would happily accept a name differing only
                    # by case — but profile lookups resolve on lower(username), so
                    # the two rows would then be indistinguishable in a URL and one
                    # of them would be unreachable.
                    clash = (_User.query
                             .filter(db.func.lower(_User.username)
                                     == app.config['ADMIN_USERNAME'].lower(),
                                     _User.id != admin.id)
                             .first())
                    if clash:
                        logger.error(
                            f"Cannot apply ADMIN_USERNAME={app.config['ADMIN_USERNAME']!r}: another "
                            f"account already uses that username. Leaving the admin account as "
                            f"{admin.username!r}."
                        )
                    else:
                        admin.username = app.config['ADMIN_USERNAME']
                        db.session.commit()
            # Remove the non-admin demo account when DEMO_MODE is off.
            if not app.config['DEMO_MODE']:
                stale_demo = _User.query.filter_by(username='demo', admin=False).first()
                if stale_demo:
                    db.session.delete(stale_demo)
                    db.session.commit()
            # In DEMO_MODE, ensure a separate non-admin demo account exists.
            # If the admin was previously named 'demo' (old demo mode behavior) and no
            # explicit ADMIN_USERNAME is configured, rename it to 'admin' first.
            if app.config['DEMO_MODE']:
                # Local admins only, for the same reason as the adoption query above.
                admin = (_User.query
                         .filter(_User.admin == True, _User.password.isnot(None))
                         .first())
                if admin and admin.username == 'demo' and not app.config['ADMIN_USERNAME']:
                    admin.username = 'admin'
                    db.session.commit()
                if not _User.query.filter_by(username='demo').first():
                    demo_user = _User(
                        username='demo',
                        password=generate_password_hash('demo', method='pbkdf2:sha256'),
                        admin=False,
                    )
                    db.session.add(demo_user)
                    db.session.commit()
        except OperationalError:
            pass  # tables don't exist yet (e.g. during flask db upgrade), skip init

        return app
