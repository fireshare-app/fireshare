<!-- PROJECT LOGO -->
<br />
<p align="center">
  <a href="https://github.com/fireshare-app/fireshare">
    <img src="app/client/src/assets/logo.png" alt="Logo" width="120" height="160">
  </a>

  <h1 align="center">Fireshare</h1>

  <p align="center">
    Share your game clips, videos, or other media via unique links.
    <br /><br />
    <a href="https://github.com/fireshare-app/fireshare/actions">
      <img alt="Docker Build" src="https://github.com/fireshare-app/fireshare/actions/workflows/docker-publish-main.yml/badge.svg" />
    </a>
    <a href="https://hub.docker.com/r/shaneisrael/fireshare">
      <img alt="Docker Pulls" src="https://img.shields.io/docker/pulls/shaneisrael/fireshare?label=docker%20pulls">
    </a>
    <a href="https://hub.docker.com/r/shaneisrael/fireshare/tags?page=1&ordering=last_updated">
      <img alt="GitHub tag (latest SemVer)" src="https://img.shields.io/github/v/tag/fireshare-app/fireshare?label=version">
    </a>
    <a href="https://github.com/fireshare-app/fireshare/stargazers">
      <img alt="GitHub stars" src="https://img.shields.io/github/stars/fireshare-app/fireshare">
    </a>
    <br /><br />
    <a href="https://www.buymeacoffee.com/shaneisrael">
      <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="41" width="174" />
    </a>
    <br /><br />
    <a href="https://demo.fireshare.net">Live Demo</a>
    &nbsp;&middot;&nbsp;
    <a href="https://github.com/fireshare-app/fireshare/issues">Report a Bug</a>
  </p>
</p>

---

If Fireshare is useful to you, [GitHub Sponsors](https://github.com/sponsors/ShaneIsrael) is the best way to support development. It keeps the demo server running and helps me carve out time on weekends for new features and updates.

## Key Features

- Share videos through unique links
- Public / private feeds (private is link-only)
- [Video transcoding with CPU or GPU](#transcoding-optional)
- Password protected videos
- Game-based organization with cover art, including games you add by hand with your own artwork
- Folder sharing
- Mobile device support
- Uploads (optional, can be restricted)
- Video view counting
- Video cropping
- Video tags for improved search and categorization
- Open Graph metadata for rich link previews
- [Notifications to Discord and others](./docs/Notifications.md)
- RSS feed for new public videos
- [Multiple users with per-user permissions](./docs/Users.md)
- [Shareable user profiles for uploads](./docs/Users.md#profiles)
- [Two-factor authentication (TOTP authenticator apps)](./docs/Security.md#two-factor-authentication-mfa)
- [Login IP whitelisting](./docs/Security.md#login-ip-whitelist)
- [Upload tokens for scripts and other tools](./docs/UploadTokens.md)

## Supported Video Formats

| Container   | Extension | Notes                                     |
| ----------- | --------- | ----------------------------------------- |
| MP4         | `.mp4`    | Most compatible, recommended              |
| MP4 (Apple) | `.m4v`    | Identical to MP4, common on Apple devices |
| QuickTime   | `.mov`    | Common on macOS / iOS                     |
| WebM        | `.webm`   | Open format, browser-native               |

**Supported encodings:** H.264 (AVC), H.265 (HEVC), AV1, VP9.

Files must be in a supported format because the original file is always served directly to the viewer. Transcoding (when enabled) only generates additional lower-quality versions for adaptive streaming; the original is never modified.

## Navigation

- [Installation](#installation)
- [Configuration](#configuration)
- [Local Development](#local-development)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)

---

<h4 align="center">Dashboard</h4>

![card-view][card-view]

<h4 align="center">Automatic Game Organization</h4>

![folders][folders]

![folders-game][folders-game]

<h4 align="center">Video Details</h4>

![edit][edit]

<h4 align="center">Public / Private Uploading</h4>

![uploading][uploading]

---

## Installation

Fireshare is designed to run in Docker.

**Required volume mounts:**

| Mount        | Purpose                                      |
| ------------ | -------------------------------------------- |
| `/data`      | Internal database                            |
| `/processed` | Generated metadata (posters, metadata files) |
| `/videos`    | Source video directory to scan               |
| `/images`    | Source image directory to scan               |

### Docker Compose

```yaml
services:
  fireshare:
    container_name: fireshare
    image: shaneisrael/fireshare:latest-lite
    ports:
      - "8080:80"
    volumes:
      - /path/to/data:/data
      - /path/to/processed:/processed
      - /path/to/videos:/videos
      - /path/to/images:/images
    environment:
      - ADMIN_USERNAME=your-admin-username
      - ADMIN_PASSWORD=your-admin-password
      # A key for signing login cookies is generated on first start and kept in
      # /data, so there is nothing to set here. See docs/Security.md
      # The domain your instance is hosted at. e.x: demo.fireshare.net
      # this is required for opengraph to work correctly for shared links.
      - DOMAIN=
      # PUID/PGID: the user/group ID the container runs as. Files written to your
      # volumes (data, processed, videos, images) will be owned by this user. Set these to
      # match the owner of your host directories to avoid permission errors.
      # Run `id` on your host to find your UID and GID.
      - PUID=1000
      - PGID=1000
      # The port the web server (nginx) listens on inside the container (default: 80).
      # Leave this alone and change the host-side "ports" mapping above unless you run
      # with network_mode: host, where "ports" is ignored and this becomes the host port.
      # - FIRESHARE_PORT=80
```

Update the volume paths and credentials, then run:

```sh
docker-compose up -d
```

Open `http://localhost:8080`.

### Docker Run

```sh
docker run --name fireshare \
  -v $(pwd)/fireshare/data:/data:rw \
  -v $(pwd)/fireshare/processed:/processed:rw \
  -v /path/to/my/videos:/videos:rw \
  -v /path/to/my/images:/images:rw \
  -p 8080:80 \
  -e ADMIN_USERNAME=your-admin-username \
  -e ADMIN_PASSWORD=your-admin-password \
  -e PUID=user-id-with-read-write-permissions \
  -e PGID=group-id-with-read-write-permissions \
  -d shaneisrael/fireshare:latest
```

Open `http://localhost:8080`.

### Fireshare Lite

The `fireshare:latest-lite` image is a smaller alternative that uses the system-provided FFmpeg instead of the CUDA-enabled build included in the standard image. It is a good fit for most users who do not need GPU transcoding.

|                                | Standard                | Lite          |
| ------------------------------ | ----------------------- | ------------- |
| GPU transcoding (NVIDIA NVENC) | Supported               | Not available |
| CPU transcoding                | Supported               | Supported     |
| Image size                     | Larger (CUDA libraries) | Smaller       |

Use the lite image by appending `-lite` to your tag:

> **Note:** Setting `TRANSCODE_GPU=true` has no effect in the lite image. GPU transcoding is permanently disabled regardless of environment variables.

---

## Configuration

### Security (IP Whitelist & Two-Factor Authentication)

Fireshare can restrict logins to a whitelist of IP addresses/CIDR ranges and supports TOTP two-factor
authentication with any authenticator app. See [Security.md](./docs/Security.md) for setup instructions.

### Transcoding (Optional)

When enabled, Fireshare will create lower quality versions of your original supported file type videos. Your viewers can then choose to play your videos at lower qualities that their internet can handle. Fireshare will also attempt to automatically downgrade the quality of a viewer who is constantly buffering.

Transcoding is off by default. To enable it, set the following environment variables:

```
ENABLE_TRANSCODING=true
TRANSCODE_GPU=true   # optional, NVIDIA only
```

CPU transcoding works out of the box. For NVIDIA GPU transcoding you need three things: an NVIDIA GPU with NVENC support, the NVIDIA driver and [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed on the host, and the container started with GPU access (`--gpus all` or `runtime: nvidia`).

The image ships with `NVIDIA_DRIVER_CAPABILITIES=compute,utility,video`, which is what makes the NVIDIA Container Toolkit mount the NVENC libraries into the container. You do not need to set it yourself. If you do override it, it must include `video` (or be `all`), otherwise `nvidia-smi` will work inside the container but ffmpeg will have no NVENC encoder and Fireshare will fall back to CPU transcoding.

**GPU requirements:** NVIDIA GPU with NVENC support.

#### Docker / Docker Compose Setup

1. Install the NVIDIA driver and NVIDIA Container Toolkit on the host.
2. In `docker-compose.yml`, uncomment either `runtime: nvidia` or the `deploy.resources.reservations.devices` block (or pass `--gpus all` to `docker run`).
3. Set:
   ```
   ENABLE_TRANSCODING=true
   TRANSCODE_GPU=true
   ```

#### Unraid Setup

1. Install the "NVIDIA Driver" plugin from Apps / Community Applications.
2. Add to the Fireshare container environment:
   ```
   ENABLE_TRANSCODING=true
   TRANSCODE_GPU=true
   NVIDIA_DRIVER_CAPABILITIES=all
   ```
   `NVIDIA_DRIVER_CAPABILITIES` is optional on current images, which already default to `compute,utility,video`. It is required on older images, and harmless to keep.
3. Add `--gpus=all` to "Extra Parameters".

#### Encoder Selection

Fireshare automatically selects the best available encoder.

**GPU mode** (`TRANSCODE_GPU=true`):

| Encoder            | Requirement                |
| ------------------ | -------------------------- |
| AV1 (av1_nvenc)    | RTX 40 series or newer     |
| H.264 (h264_nvenc) | GTX 1050 or newer          |
| CPU fallback       | Used if GPU encoding fails |

**CPU mode** (`TRANSCODE_GPU=false`):

| Encoder | Notes                            |
| ------- | -------------------------------- |
| H.264   | Most compatible, faster encoding |
| AV1     | Best compression, slower         |

### Docker Environment Variables

See [EnvironmentVariables.md](./docs/EnvironmentVariables.md) for the full list of available environment variables.

---

## Local Development

**Requirements:** Python 3, Node.js, and npm.

1. Clone the repo:
   ```sh
   git clone https://github.com/fireshare-app/fireshare.git
   ```
2. Start backend services from the project root:
   ```sh
   ./run_local.sh
   ```
3. Start the frontend:
   ```sh
   cd app/client
   npm install
   npm start
   ```
4. Open `http://localhost:3000` and sign in with `admin` / `admin`.

---

## Contributing

Contributions are welcome. For larger changes, open an issue first to align on scope.

1. Know how to code! **I DO NOT WANT VIBE CODERS SUBMITTING PRs**
   AI assisted coding is fine if you can read, understand, and validate AI code.
   _Asking AI to review itself doesn't count as reading, understanding, and validating AI code._
2. Fork the repository
3. Create a branch from `develop`
4. Commit your changes
5. Rebase on latest `develop`
6. Open a pull request to `develop`

For issues and feature requests, visit the [issue tracker](https://github.com/fireshare-app/fireshare/issues).

**Please DO NOT open a pull request for a feature or addition that was not previously discussed with me. Pull requests that do this will be automatically closed.**

### Database Changes

If you update models, create a migration and review it before opening a pull request.

---

## Troubleshooting

See [TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) for a full guide covering installation issues, playback problems, permission errors, transcoding, and more.

---

## Star History

If you like the project, consider giving it a star. It helps increase visibility and supports continued development.

<a href="https://www.star-history.com/?repos=fireshare-app%2Ffireshare&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=fireshare-app/fireshare&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=fireshare-app/fireshare&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=fireshare-app/fireshare&type=date&legend=top-left" />
  </picture>
</a>

---

[card-view]: .github/images/card-view.png
[folders]: .github/images/folders.png
[folders-game]: .github/images/folders-game.png
[edit]: .github/images/edit-details.png
[uploading]: .github/images/uploading.png
