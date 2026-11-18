# Fireshare Troubleshooting Guide

## Index

- [Videos Not Appearing](#videos-not-appearing)
- [Playback Problems](#playback-problems)
- [Upload Fails](#upload-fails)
- [Permission Errors](#permission-errors)
- [Cannot Log In](#cannot-log-in)
- [Locked Out by the IP Whitelist](#locked-out-by-the-ip-whitelist)
- [Locked Out of Two-Factor Authentication (MFA)](#locked-out-of-two-factor-authentication-mfa)
- [Sessions Expire on Every Restart](#sessions-expire-on-every-restart)
- [Transcoding Issues](#transcoding-issues)
- [Open Graph / Link Previews Not Working](#open-graph--link-previews-not-working)
- [Webhook Notifications Not Sending](#webhook-notifications-not-sending)
- [LDAP Has Been Removed](#ldap-has-been-removed)
- [Stale Scan Lock](#stale-scan-lock)
- [Corrupt Video Detected](#corrupt-video-detected)
- [Database Errors](#database-errors)

---

## Videos Not Appearing

Videos are discovered by a background scan that runs every `MINUTES_BETWEEN_VIDEO_SCANS` minutes (default: 5). If a video is not showing up:

1. **Wait for the next scan.** The scan runs on an interval; new files won't appear instantly.

   If `MINUTES_BETWEEN_VIDEO_SCANS` is set to `0`, the automatic scan is disabled and new files will never appear on their own — trigger a scan manually from the admin panel, or set the variable back to a positive number and restart the container. The startup logs say which mode you're in.

2. **Check that your video directory is mounted correctly.** The container expects source videos at `/videos`. Confirm the volume is mapped in your `docker-compose.yml` or `docker run` command:
   ```yaml
   - /path/to/your/clips:/videos
   ```

3. **Check supported file extensions.** Only `.mp4`, `.mov`, and `.webm` files are scanned. Files with other extensions are ignored.

4. **Chunk files are skipped.** Files with extensions like `.part0000` (in-progress uploads) are intentionally ignored until complete.

5. **macOS sidecar files are skipped.** Files prefixed with `._` are skipped automatically.

6. **Duplicate detection.** If a video with the same content (by hash) already exists in the database, the new file is skipped. Check if the same clip exists under a different path.

7. **Check container logs** for scan errors:
   ```sh
   docker logs fireshare
   ```

---

## Playback Problems

If video playback is slow, buffering, or failing:

- **Reduce source file size or bitrate.** High-bitrate files require adequate upload bandwidth on the host.
- **Use browser-compatible formats.** MP4 with H.264 video is the most universally supported format for browser playback. Some codecs (AV1, HEVC) may not play in all browsers.
- **Enable transcoding with H.264.** Setting `ENABLE_TRANSCODING=true` can produce more compatible versions, but only if the encoder preference is set to H.264 in Settings → Transcoding. AV1 transcodes may still not play in all browsers.
- **Test in another browser.** Some codecs are only supported in certain browsers. Chrome supports more formats than Safari/Firefox in some cases.
- **Check `.webm` files.** WebM files must use VP8, VP9, or AV1 video codecs to play natively in browsers.

---

## Upload Fails

### Behind a Reverse Proxy (Nginx, Traefik, etc.)

Proxies often have default limits that are too small for large video uploads.

**Nginx:** Add to your proxy configuration:
```nginx
client_max_body_size 0;
proxy_read_timeout 999999s;
```

**Traefik:** Set via entrypoint or middleware configuration to increase read timeout and body size limits. Refer to Traefik documentation for your version.

**Other proxies:** Apply equivalent upload size and timeout settings.

### Direct Upload (no proxy)

- The internal Nginx in the container has no file size restriction by default.
- Gunicorn workers time out after 120 seconds — very large uploads over a slow connection may hit this limit.

---

## Permission Errors

The container runs as user/group `PUID`/`PGID` (default: `1000`/`1000`). All mounted directories must be readable and writable by this user.

At startup Fireshare takes ownership of `/data` and `/processed`. It never changes ownership inside `/videos` or `/images`, since those hold your own library; it only claims either one when it is empty (a fresh Docker named volume, for example). If one of them is still not writable, the startup log says so with a line like `/videos is not writable by UID=1000 GID=1000`.

**Symptoms:**
- Videos scanned but symlinks fail to create
- Database not initializing on first run
- Transcoded files not appearing in `/processed/derived/`
- Uploads failing with "The server was denied access to a file or folder"
- Errors containing `Permission denied` in container logs

**Preferred fix:** Set `PUID` and `PGID` to match the user that already owns your directories:
```yaml
PUID=1001
PGID=1001
```

Run `id your-username` on the host to find the correct UID/GID values.

**Alternative:** Change ownership of the directories to match the container's default user:
```sh
chown -R 1000:1000 /path/to/data /path/to/processed /path/to/videos
```

> **Note:** On NFS mounts, ensure the NFS export grants the correct UID/GID permissions at the server level regardless of which approach you use.

---

## Cannot Log In

1. **Default credentials** are `admin` / `admin` if `ADMIN_USERNAME` and `ADMIN_PASSWORD` are not set.

2. **Credentials set via environment variables are applied on every startup.** If you changed `ADMIN_PASSWORD` in your `docker-compose.yml` and restarted, the admin account password was updated to that value.

3. **`DISABLE_ADMINCREATE=true` with no existing admin user** will result in no admin account existing. Remove this variable, restart to let the admin account be created, then re-enable it if needed.

4. **A former LDAP account cannot log in.** Accounts converted from LDAP have no password until an administrator sets one or sends an invite from **Settings → Users**. See [LDAP Has Been Removed](#ldap-has-been-removed).

5. **Verify admin account state** by checking the database directly:
   ```sh
   docker exec fireshare sqlite3 /data/db.sqlite "SELECT username, admin FROM user WHERE admin=1;"
   ```

6. **The login page redirects straight to the home page.** A `LOGIN_IP_WHITELIST` is set and your IP
   is not on it — see [Locked Out by the IP Whitelist](#locked-out-by-the-ip-whitelist).

---

## Locked Out by the IP Whitelist

If `LOGIN_IP_WHITELIST` is set and your IP is not on it (e.g. your home IP changed), the login page
silently redirects to the home page and login requests return
`403 — Your IP address is not permitted to log in.`

**Fix:** the whitelist lives entirely in the environment variable. Edit or remove `LOGIN_IP_WHITELIST`
in your `docker-compose.yml` / `docker run` command and restart the container.

If you believe your IP *should* be allowed, check the container logs — every blocked attempt logs
`Blocked login attempt from non-whitelisted IP <ip>`, showing the address Fireshare derived for you.
If that address is your reverse proxy rather than your real client IP, adjust
`LOGIN_IP_WHITELIST_TRUSTED_PROXIES` (see [Security.md](./Security.md#how-the-client-ip-is-determined)).

Also note the container **fails to start** if any whitelist entry is malformed — look for
`FATAL: LOGIN_IP_WHITELIST contains invalid entry` in the logs.

---

## Locked Out of Two-Factor Authentication (MFA)

If you lost access to your authenticator app, disable MFA for the account from inside the container:

```sh
docker exec fireshare fireshare disable-mfa -u <username>
```

The account can then log in with just its password and re-enroll MFA from **Settings → Security**.

If valid codes are being rejected, check that the server and phone clocks are accurate — codes are
only valid within a ±30 second window.

---

## Sessions Expire on Every Restart

Current versions generate a signing key on first start and persist it to `/data/.secret_key`, so
sessions survive restarts on their own. If everyone is still logged out on every restart, that file is
not surviving:

- **`/data` isn't a persistent volume**, or is mounted read-only. Check the mount, then look for
  `generated one and saved it to` in the startup logs. If instead you see `not writable — using an
  ephemeral key`, the container cannot write to `/data`.
- **`SECRET_KEY` is set to a different value on each start.** Either leave it unset and let Fireshare
  manage it, or set one fixed value.

A single sign-out after upgrading is expected if your compose file still carries the old example
`SECRET_KEY`: that published value is refused and replaced with a generated one. Delete the line.

See [Security.md](./Security.md#the-session-signing-key).

---

## Transcoding Issues

### Transcoded videos not appearing

1. Confirm `ENABLE_TRANSCODING=true` is set.
2. Check that `auto_transcode` is enabled in Settings → Transcoding within the UI (this writes to `/data/config.json`).
3. Transcoding runs as part of the background scan. Wait for the next scan cycle or check logs for progress.
4. Source videos with a height equal to or less than the target resolution are skipped (e.g., a 720p source will not produce a 1080p transcode).

### GPU transcoding not working

1. Confirm your GPU supports NVENC. GTX 1050 or newer is required for H.264; RTX 40 series for AV1.
2. Make sure the container has GPU access. On standard Docker add `runtime: nvidia` or `--gpus all` to your compose file or run command. On **Unraid** add `--gpus=all` to Extra Parameters. The host needs the NVIDIA driver and NVIDIA Container Toolkit installed (on Unraid, the "NVIDIA Driver" plugin).
3. Check `NVIDIA_DRIVER_CAPABILITIES`. The NVIDIA Container Toolkit only mounts the NVENC library (`libnvidia-encode.so.1`) when this variable includes `video`. The image defaults to `compute,utility,video`; if you override it, keep `video` or use `all`. Older images defaulted to `compute,utility`, so on those you must set it yourself. The telltale sign of this problem is `nvidia-smi` working inside the container while the logs say NVENC is not available to ffmpeg.
4. If GPU encoding fails, Fireshare automatically falls back to CPU encoding. Check logs to see which encoder is being used.

### Encoder fallback order

When `TRANSCODE_GPU=true`:
1. AV1 via GPU (av1_nvenc) — RTX 40 series+
2. H.264 via GPU (h264_nvenc) — GTX 1050+
3. AV1 via CPU (libsvtav1)
4. H.264 via CPU (libx264) — universal fallback

### Transcoding a specific video

A video can be manually queued for transcoding via the video detail/edit page in the UI.

---

## Open Graph / Link Previews Not Working

Rich previews when sharing links (Discord, Slack, Twitter/X, etc.) require the `DOMAIN` variable to be set.

```yaml
DOMAIN=v.example.com
```

- Do **not** include `http://` or `https://` — just the bare domain.
- Without this, Open Graph meta tags will have incorrect or empty URLs and social media platforms will not generate previews.

---

## Webhook Notifications Not Sending

### Discord

- The `DISCORD_WEBHOOK_URL` must match the format: `https://discord.com/api/webhooks/{id}/{token}`
- An incorrectly formatted URL will cause a validation error on startup — check the container logs.

### Generic Webhook

- Both `GENERIC_WEBHOOK_URL` **and** `GENERIC_WEBHOOK_PAYLOAD` must be set together.
- If only one is provided, the app will exit with a fatal error on startup.
- The payload must be valid JSON.

---

## LDAP Has Been Removed

LDAP authentication was removed. If Fireshare will not start and the log shows
`LDAP has been discontinued`, that is deliberate: an `LDAP_*` variable is still
set, and Fireshare stops before migrating the database so the change cannot
happen without you knowing.

**To continue the upgrade,** remove every `LDAP_*` variable from your compose
file and start Fireshare again. The log lists the ones it found. Directory
accounts are then converted to local accounts with no password — set one, or
send an invite, from **Settings → Users**. See
[Users.md](./Users.md#ldap-has-been-removed) for what is kept and what changes.

**To keep using LDAP,** leave the variables in place and pin your image to the
release you were running before the upgrade. This version cannot authenticate
against a directory server.

---

## Stale Scan Lock

During a video scan, a lock file is created at `/data/fireshare.lock` to prevent concurrent scans. If the scan process crashes without cleaning up, the lock file remains and subsequent scans will not run.

Fireshare automatically detects and removes stale locks from processes that are no longer running. This happens at the start of each scan cycle.

If scans appear permanently stuck even after restarting the container, you can manually remove the lock:
```sh
docker exec fireshare rm /data/fireshare.lock
```

---

## Corrupt Video Detected

When a video fails validation (during metadata extraction or transcoding), it is recorded in `/data/corrupt_videos.json` and skipped in future scans.

**Symptoms:**
- A video file exists on disk but never appears in the UI
- Container logs show: `"There may be a corrupt video in your video Directory"`

**Notes:**
- AV1-encoded source files may be flagged as corrupt due to false positives during initial frame decoding.
- A video marked corrupt can still be manually queued for transcoding via the UI, which uses a more lenient validation pass.

**To clear the corrupt list manually:**
```sh
docker exec fireshare truncate -s 0 /data/corrupt_videos.json
```
Then wait for the next scan to re-evaluate the files.

---

## Database Errors

Fireshare uses SQLite with WAL (Write-Ahead Logging) mode for concurrent access. Most database issues are caused by filesystem problems.

**Common causes:**
- `/data` is on a network filesystem (NFS, SMB/CIFS) that does not support POSIX file locking — SQLite WAL mode requires proper lock support. Use a local disk or a filesystem that supports `flock`.
- Insufficient disk space on the volume holding `/data`.
- The database file was corrupted by a hard shutdown mid-write.

**Check database integrity:**
```sh
docker exec fireshare sqlite3 /data/db.sqlite "PRAGMA integrity_check;"
```

If the integrity check returns anything other than `ok`, restore from a backup or delete `db.sqlite` to let it be recreated (all video metadata will be re-discovered on the next scan, but custom titles, descriptions, and tags will be lost).
