import base64
import io
import re
import time

import pyotp
import qrcode
from flask import Blueprint, redirect, request, Response, jsonify, current_app, session
from flask_login import login_user, logout_user, current_user, login_required
from werkzeug.security import generate_password_hash, check_password_hash
from .models import User
from . import db, claim_sentinel
from . import permissions as fs_permissions
from .api.misc import _get_local_version, _fetch_release_notes
from .api.decorators import demo_restrict
from .ip_whitelist import login_ip_required, get_client_ip, is_ip_permitted
from . import login_throttle
from datetime import datetime, timezone

auth = Blueprint('auth', __name__)

MFA_PENDING_MAX_AGE = 300
MFA_MAX_ATTEMPTS = 5

def _clear_mfa_pending():
    session.pop('mfa_pending_user_id', None)
    session.pop('mfa_pending_at', None)
    session.pop('mfa_attempts', None)
    session.pop('mfa_username', None)

def _verify_totp(user, code):
    """
    Return the 30s timestep the code matches (with one step of clock drift
    tolerance either way), or None. Each code is only accepted once (RFC 6238):
    a code at or before the last accepted timestep is rejected as a replay.
    """
    code = str(code or '').strip()
    if not code:
        return None
    totp = pyotp.TOTP(user.totp_secret)
    now_step = int(time.time() // 30)
    for offset in (0, -1, 1):
        step = now_step + offset
        if pyotp.utils.strings_equal(totp.at(step * 30), code):
            if user.totp_last_used is not None and step <= user.totp_last_used:
                return None
            return step
    return None

def _record_login(user):
    user.last_login_at = datetime.utcnow()
    db.session.commit()


@auth.route('/api/login', methods=['POST'])
@login_ip_required
def login():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return Response(response="Invalid request", status=400)
    username = body.get('username')
    password = body.get('password')
    if not isinstance(username, str) or not isinstance(password, str):
        return Response(response="Invalid username or password", status=401)

    client_ip = get_client_ip()
    wait = login_throttle.retry_after(client_ip, username)
    if wait:
        # The hash comparison below is deliberately skipped while throttled, so a
        # blocked caller cannot keep the server doing pbkdf2 work for them.
        return Response(
            response=f"Too many failed sign-in attempts. Try again in {wait} seconds.",
            status=429,
            headers={'Retry-After': str(wait)},
        )

    user = User.query.filter_by(username=username).first()

    # A user awaiting an invite has no password hash, and a disabled account must
    # not authenticate at all. Both are reported as ordinary credential failures
    # so the response never distinguishes them from a wrong password.
    if user and user.password and not user.disabled and check_password_hash(user.password, password):
        if user.mfa_enabled and user.totp_secret:
            session['mfa_pending_user_id'] = user.id
            session['mfa_pending_at'] = time.time()
            session['mfa_attempts'] = 0
            session['mfa_username'] = user.username
            return jsonify({'mfa_required': True})
        _clear_mfa_pending()
        login_throttle.clear(client_ip, username)
        login_user(user, remember=True)
        _record_login(user)
        return Response(status=200)

    login_throttle.record_failure(client_ip, username)
    return Response(response="Invalid username or password", status=401)

@auth.route('/api/login/mfa', methods=['POST'])
@login_ip_required
def login_mfa():
    pending_user_id = session.get('mfa_pending_user_id')
    pending_at = session.get('mfa_pending_at', 0)
    attempts = session.get('mfa_attempts', 0)

    expired = time.time() - pending_at > MFA_PENDING_MAX_AGE
    if not pending_user_id or expired or attempts >= MFA_MAX_ATTEMPTS:
        _clear_mfa_pending()
        return jsonify({'error': 'Login session expired. Please sign in again.', 'restart': True}), 401

    # The per-session cap above resets whenever the password step is passed again,
    # so on its own it only ever costs an attacker who already holds the password a
    # fresh login round per five guesses. Failed codes are therefore counted against
    # the same address/account budget as failed passwords.
    client_ip = get_client_ip()
    pending_username = session.get('mfa_username')
    wait = login_throttle.retry_after(client_ip, pending_username)
    if wait:
        return jsonify({'error': f'Too many failed attempts. Try again in {wait} seconds.'}), 429

    user = db.session.get(User, pending_user_id)
    if not user or user.disabled or not user.mfa_enabled or not user.totp_secret:
        _clear_mfa_pending()
        return jsonify({'error': 'Login session expired. Please sign in again.', 'restart': True}), 401

    session['mfa_attempts'] = attempts + 1

    matched_step = _verify_totp(user, (request.json or {}).get('code'))
    if matched_step is None:
        login_throttle.record_failure(client_ip, pending_username)
        return jsonify({'error': 'Invalid authentication code.'}), 401

    user.totp_last_used = matched_step
    user.last_login_at = datetime.utcnow()
    db.session.commit()
    login_throttle.clear(client_ip, pending_username)
    _clear_mfa_pending()
    login_user(user, remember=True)
    return jsonify({'authenticated': True})

@auth.route('/api/mfa/status', methods=['GET'])
@login_required
def mfa_status():
    is_demo = current_app.config.get('DEMO_MODE') and current_user.username == 'demo'
    return jsonify({
        'enabled': bool(current_user.mfa_enabled),
        'supported': not is_demo,
    })

@auth.route('/api/mfa/setup', methods=['POST'])
@login_required
@demo_restrict
def mfa_setup():
    if current_user.mfa_enabled:
        return jsonify({'error': 'Two-factor authentication is already enabled.'}), 400

    secret = pyotp.random_base32()
    current_user.totp_secret = secret
    db.session.commit()

    otpauth_url = pyotp.totp.TOTP(secret).provisioning_uri(name=current_user.username, issuer_name='Fireshare')
    png = io.BytesIO()
    qrcode.make(otpauth_url).save(png, format='PNG')
    qr_data_uri = 'data:image/png;base64,' + base64.b64encode(png.getvalue()).decode('ascii')

    return jsonify({'secret': secret, 'otpauth_url': otpauth_url, 'qr': qr_data_uri})

@auth.route('/api/mfa/confirm', methods=['POST'])
@login_required
@demo_restrict
def mfa_confirm():
    if current_user.mfa_enabled:
        return jsonify({'error': 'Two-factor authentication is already enabled.'}), 400
    if not current_user.totp_secret:
        return jsonify({'error': 'Two-factor authentication setup has not been started.'}), 400

    matched_step = _verify_totp(current_user, (request.json or {}).get('code'))
    if matched_step is None:
        return jsonify({'error': 'Invalid authentication code.'}), 400

    current_user.mfa_enabled = True
    current_user.totp_last_used = matched_step
    db.session.commit()
    return jsonify({'enabled': True})

@auth.route('/api/mfa/disable', methods=['POST'])
@login_required
@demo_restrict
def mfa_disable():
    if not current_user.mfa_enabled or not current_user.totp_secret:
        return jsonify({'error': 'Two-factor authentication is not enabled.'}), 400

    # A valid, unused current code is required so a hijacked session (or a
    # just-observed code) alone cannot strip MFA.
    if _verify_totp(current_user, (request.json or {}).get('code')) is None:
        return jsonify({'error': 'Invalid authentication code.'}), 400

    current_user.totp_secret = None
    current_user.mfa_enabled = False
    current_user.totp_last_used = None
    db.session.commit()
    return jsonify({'enabled': False})

# /api/signup was removed in favour of POST /api/admin/users. It was gated only by
# @login_required while User.admin defaulted to True, so any signed-in non-admin
# could create an administrator account.

def _version_parts(version):
    """A version like "1.9.2" as a tuple of ints for comparing, or None for
    anything that is not plain dotted numbers."""
    if not version or not re.fullmatch(r'[0-9]+(?:\.[0-9]+)*', version):
        return None
    return tuple(int(x) for x in version.split('.'))


@auth.route('/api/loggedin', methods=['GET'])
def loggedin():
    login_allowed = is_ip_permitted(get_client_ip())
    if not current_user.is_authenticated:
        return jsonify({'authenticated': False, 'login_allowed': login_allowed})

    release_data = _fetch_release_notes()
    local_version = _get_local_version()

    latest_release = None
    latest_version = release_data['version'] if release_data else None
    latest_parts = _version_parts(latest_version)
    local_parts = _version_parts(local_version)
    # A tag that is not plain dotted numbers (a prerelease such as 2.0.0-beta.1)
    # is not offered as an update; parsing it used to fail this whole request.
    if latest_parts and local_parts:
        update_available = latest_parts > local_parts
        if update_available:
            # This endpoint runs on every page load, in every worker: say it once
            # per server start for each new version. _version_parts only accepts
            # digits and dots, so the version is safe in a file name.
            if claim_sentinel(f"fireshare_update_notice_{latest_version}"):
                current_app.logger.info(f"A new version of Fireshare is available! You have v{local_version}, latest is v{latest_version}.")
            is_dev = current_app.config.get('ENVIRONMENT') == 'dev'
            release_is_old_enough = is_dev
            if not is_dev:
                try:
                    published_dt = datetime.fromisoformat(release_data.get('published_at', '').replace('Z', '+00:00'))
                    release_is_old_enough = (datetime.now(timezone.utc) - published_dt).total_seconds() >= 86400
                except (ValueError, TypeError):
                    pass
            if release_is_old_enough:
                latest_release = release_data
        else:
            pass

    return jsonify({
        'authenticated': True,
        'admin': current_user.admin,
        'username': current_user.username,
        'display_name': current_user.display_name,
        'name': current_user.name,
        'avatar_url': current_user.avatar_url(),
        # Admins bypass every check, so the client is handed the full grantable set
        # rather than an empty list it would have to special-case.
        'permissions': (list(fs_permissions.GRANTABLE_PERMISSIONS) if current_user.admin
                        else sorted(current_user.granted_permissions)),
        'must_change_password': bool(current_user.must_change_password),
        'latest_release': latest_release,
        'login_allowed': login_allowed,
    })

@auth.route('/api/logout', methods=['POST'])
def logout():
    _clear_mfa_pending()
    logout_user()
    return Response(status=200)
