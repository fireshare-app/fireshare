import React from 'react'
import { useMediaQuery, useTheme } from '@mui/material'

import { dialogPaperSx, fullScreenDialogPaperSx } from './modalStyles'

let isLocalhost =
  (window.location.hostname.indexOf('localhost') >= 0 || window.location.hostname.indexOf('127.0.0.1') >= 0) &&
  window.location.port !== ''
export const getServedBy = () => {
  // When running `vite` over LAN IP, hostname is not localhost
  // but static content is still served by the dev server proxy, not nginx.
  const isDevClient = process.env.NODE_ENV === 'development' && window.location.port !== ''
  return isLocalhost || isDevClient ? 'flask' : 'nginx'
}

export const getUrl = () => {
  const portWithColon = window.location.port ? `:${window.location.port}` : ''
  return isLocalhost
    ? `http://${window.location.hostname}:${import.meta.env.VITE_SERVER_PORT || window.location.port}`
    : `${window.location.protocol}//${window.location.hostname}${portWithColon}`
}

export const getPublicWatchUrl = () => {
  const shareableLinkDomain = getSetting('ui_config')?.['shareable_link_domain']
  if (shareableLinkDomain) {
    return `${shareableLinkDomain}/w/`
  }
  const portWithColon = window.location.port ? `:${window.location.port}` : ''
  return isLocalhost
    ? `http://${window.location.hostname}:${import.meta.env.VITE_SERVER_PORT || window.location.port}/w/`
    : `${window.location.protocol}//${window.location.hostname}${portWithColon}/w/`
}

export const getVideoPath = (id, extension) => {
  if (extension === '.mkv') {
    return `${id}-1.mp4`
  }
  return `${id}${extension}`
}

export const useDebounce = (value, delay) => {
  const [debouncedValue, setDebouncedValue] = React.useState(value)

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay)
    return () => {
      clearTimeout(timer)
    }
  }, [value, delay])

  return debouncedValue
}

// Dialogs that carry a real form are cramped when centred on a phone, so below
// the sm breakpoint they take over the screen. Spread the result onto a Dialog:
// it swaps in the edge-to-edge paper style along with fullScreen, so the two
// can never drift apart.
export const useMobileFullScreenDialog = () => {
  const theme = useTheme()
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'))

  return {
    fullScreen,
    PaperProps: { sx: fullScreen ? fullScreenDialogPaperSx : dialogPaperSx },
  }
}

export const getSetting = (setting) =>
  localStorage.getItem('config') && JSON.parse(localStorage.getItem('config'))[setting]
export const setSetting = (setting, value) => {
  if (localStorage.getItem('config')) {
    const settings = JSON.parse(localStorage.getItem('config'))
    localStorage.setItem('config', JSON.stringify({ ...settings, [setting]: value }))
  } else {
    localStorage.setItem('config', JSON.stringify({ [setting]: value }))
  }
}

export const toHHMMSS = (secs) => {
  var sec_num = parseInt(secs, 10)
  var hours = Math.floor(sec_num / 3600)
  var minutes = Math.floor(sec_num / 60) % 60
  var seconds = sec_num % 60

  return [hours, minutes, seconds]
    .map((v) => (v < 10 ? '0' + v : v))
    .filter((v, i) => v !== '00' || i > 0)
    .join(':')
}

export const copyToClipboard = (textToCopy) => {
  // navigator clipboard api needs a secure context (https)
  if (navigator.clipboard && window.isSecureContext) {
    // navigator clipboard api method'
    return navigator.clipboard.writeText(textToCopy)
  } else {
    // text area method
    let textArea = document.createElement('textarea')
    textArea.value = textToCopy
    // make the textarea out of viewport
    textArea.style.position = 'fixed'
    textArea.style.left = '-999999px'
    textArea.style.top = '-999999px'
    document.body.appendChild(textArea)
    textArea.focus()
    textArea.select()
    return new Promise((res, rej) => {
      // here the magic happens
      document.execCommand('copy') ? res() : rej()
      textArea.remove()
    })
  }
}

/**
 * Gets the URL for a video's poster/thumbnail image.
 * When served by nginx, uses a static route that tries custom_poster.webp first, then poster.jpg.
 * @param {string} videoId - The video ID
 * @param {string|number} [cacheBuster] - Optional cache-busting value appended as a query param
 * @returns {string} Poster URL
 */
export const getPosterUrl = (videoId, cacheBuster) => {
  const baseUrl = getUrl()
  const SERVED_BY = getServedBy()
  if (SERVED_BY === 'nginx') {
    const url = `${baseUrl}/_content/derived/${videoId}/thumbnail`
    return cacheBuster ? `${url}?v=${cacheBuster}` : url
  }
  const url = `${baseUrl}/api/video/poster?id=${videoId}`
  return cacheBuster ? `${url}&v=${cacheBuster}` : url
}

/**
 * A version for the URLs of a video's crop, its SDR copy and the transcodes made from
 * them. They are rebuilt under the same names whenever the video is re-cropped or tone
 * mapped again, so without one the browser plays the previous files from its cache.
 * Empty when the video is neither cropped nor tone mapped: its transcodes are then made
 * from the original, which never changes.
 * @param {Object} videoInfo - Video info object containing has_crop, start_time, end_time, has_sdr, tonemap
 * @returns {string} Version to pass to getVideoUrl
 */
export const getMediaVersion = (videoInfo) => {
  const parts = []
  if (videoInfo?.has_crop) parts.push(`${videoInfo.start_time ?? 0}-${videoInfo.end_time ?? 'end'}`)
  if (videoInfo?.has_sdr) parts.push(`sdr-${videoInfo.tonemap}`)
  return parts.join('_')
}

const withVersion = (url, version) =>
  version ? `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}` : url

/**
 * Gets the URL for a specific video quality
 * @param {string} videoId - The video ID
 * @param {string} quality - Quality ('720p', '1080p', or 'original')
 * @param {string} extension - Video file extension (e.g., '.mp4', '.mkv')
 * @param {string} [version] - From getMediaVersion
 * @returns {string} Video URL
 */
export const getVideoUrl = (videoId, quality, extension, version) => {
  const URL = getUrl()
  const SERVED_BY = getServedBy()

  if (quality === '480p' || quality === '720p' || quality === '1080p') {
    if (SERVED_BY === 'nginx') {
      return withVersion(`${URL}/_content/derived/${videoId}/${videoId}-${quality}.mp4`, version)
    }
    return withVersion(`${URL}/api/video?id=${videoId}&quality=${quality}`, version)
  }

  // Original quality
  if (SERVED_BY === 'nginx') {
    const videoPath = getVideoPath(videoId, extension)
    return withVersion(`${URL}/_content/video/${videoPath}`, version)
  }
  return withVersion(`${URL}/api/video?id=${extension === '.mkv' ? `${videoId}&subid=1` : videoId}`, version)
}

/**
 * Gets the public share URL for an image (/i/<image_id>)
 * @returns {string} Base URL ending with /i/
 */
export const getPublicImageUrl = () => {
  const shareableLinkDomain = getSetting('ui_config')?.['shareable_link_domain']
  if (shareableLinkDomain) {
    return `${shareableLinkDomain}/i/`
  }
  const portWithColon = window.location.port ? `:${window.location.port}` : ''
  return isLocalhost
    ? `http://${window.location.hostname}:${import.meta.env.VITE_SERVER_PORT || window.location.port}/i/`
    : `${window.location.protocol}//${window.location.hostname}${portWithColon}/i/`
}

/**
 * Gets the URL for a game asset (hero, banner, logo, icon).
 * In nginx/prod mode uses /_content/game_assets/; in dev uses /api/game/assets/.
 * @param {number} steamgriddbId - SteamGridDB game ID
 * @param {string} slot - Asset slot name, e.g. 'hero_1', 'logo_1', 'icon_1'
 * @param {string|number} [cacheBuster] - Optional cache-busting value
 * @returns {string} Asset URL
 */
export const getGameAssetUrl = (steamgriddbId, slot, cacheBuster) => {
  const SERVED_BY = getServedBy()
  const base =
    SERVED_BY === 'nginx'
      ? `/_content/game_assets/${steamgriddbId}`
      : `/api/game/assets/${steamgriddbId}`
  const url = `${base}/${slot}.webp`
  return cacheBuster ? `${url}?v=${cacheBuster}` : url
}

/**
 * Gets the thumbnail URL for an image
 */
export const getImageThumbnailUrl = (imageId, cacheBuster) => {
  const baseUrl = getUrl()
  const SERVED_BY = getServedBy()
  if (SERVED_BY === 'nginx') {
    const url = `${baseUrl}/_content/derived/${imageId}/thumbnail.webp`
    return cacheBuster ? `${url}?v=${cacheBuster}` : url
  }
  const url = `${baseUrl}/api/image/thumbnail?id=${imageId}`
  return cacheBuster ? `${url}&v=${cacheBuster}` : url
}

/**
 * Gets the full-quality URL for an image
 */
export const getImageUrl = (imageId) => {
  const baseUrl = getUrl()
  const SERVED_BY = getServedBy()
  if (SERVED_BY === 'nginx') {
    return `${baseUrl}/_content/derived/${imageId}/image.webp`
  }
  return `${baseUrl}/api/image?id=${imageId}`
}

// Transcodes are H.264 unless an admin has switched the encoder to AV1, and nothing
// records which one a given transcode used, so they are described as H.264. The
// description is only used to ask whether the device decodes that kind of file in
// hardware.
const TRANSCODE_CODEC = 'avc1.640033'

// Rough bits per pixel per frame, for a file that does not record its bitrate. The
// browser decides on codec, size and frame rate; the bitrate only has to be plausible.
const ESTIMATED_BITS_PER_PIXEL = 0.1

const describeMedia = (contentType, width, height, framerate, bitrate) => {
  if (!width || !height) return null
  const fps = framerate > 0 ? framerate : 30
  return {
    contentType,
    width,
    height,
    framerate: fps,
    bitrate: bitrate > 0 ? bitrate : Math.round(width * height * fps * ESTIMATED_BITS_PER_PIXEL),
  }
}

/**
 * What the source file is, in the terms navigator.mediaCapabilities asks for, so the
 * player can check it will play smoothly before starting on it.
 *
 * Null when that is unknown or must not matter: the editor always needs the uncut
 * original, and an .mkv's source is Fireshare's own H.264 conversion rather than the
 * file the stored codec describes.
 */
const getSourceMedia = (videoInfo, extension, { hasCrop, forceOriginal, hdrFormat }) => {
  if (forceOriginal || extension === '.mkv' || !videoInfo?.codec) return null
  // A crop is a stream copy into MP4, so it keeps the original's codec.
  const container = extension === '.webm' && !hasCrop ? 'video/webm' : 'video/mp4'
  const media = describeMedia(
    `${container}; codecs="${videoInfo.codec}"`,
    videoInfo.width,
    videoInfo.height,
    videoInfo.framerate,
    videoInfo.bitrate,
  )
  if (media && hdrFormat) {
    // So the browser answers for HDR playback specifically: a device that decodes the
    // codec but cannot present PQ/HLG on this display reports it as unsupported.
    media.colorGamut = 'rec2020'
    media.transferFunction = hdrFormat === 'hlg' ? 'hlg' : 'pq'
    if (hdrFormat !== 'hlg') media.hdrMetadataType = 'smpteSt2086'
  }
  return media
}

/**
 * Whether this display can show HDR video, as the browser reports it. False where the
 * media queries are unknown, so an old browser is treated as SDR.
 */
export const displaySupportsHdr = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  (window.matchMedia('(video-dynamic-range: high)').matches || window.matchMedia('(dynamic-range: high)').matches)

// Transcodes are scaled to the target height with the source's aspect ratio and frame
// rate, as ffmpeg's scale=-2:<height> does.
const getTranscodeMedia = (videoInfo, height) => {
  if (!videoInfo?.width || !videoInfo?.height) return null
  const width = Math.round((videoInfo.width * height) / videoInfo.height / 2) * 2
  return describeMedia(`video/mp4; codecs="${TRANSCODE_CODEC}"`, width, height, videoInfo.framerate)
}

/**
 * Generates video sources array for Video.js player with quality options
 * Defaults to original quality, with 720p and 1080p as alternatives. Each source
 * carries a `media` description so the player can move the default to a transcode
 * when this device cannot play the original smoothly.
 * @param {string} videoId - The video ID
 * @param {Object} videoInfo - Video info object containing has_720p, has_1080p flags
 * @param {string} extension - Video file extension (e.g., '.mp4', '.mkv')
 * @returns {Array} Array of video sources for Video.js
 */
export const getVideoSources = (videoId, videoInfo, extension, { forceOriginal = false } = {}) => {
  const sources = []
  const URL = getUrl()
  const SERVED_BY = getServedBy()

  const has480p = videoInfo?.has_480p
  const has720p = videoInfo?.has_720p
  const has1080p = videoInfo?.has_1080p
  const hasCrop = videoInfo?.has_crop
  const hasSdr = videoInfo?.has_sdr
  const version = getMediaVersion(videoInfo)

  const derivedUrl = (name, quality) =>
    withVersion(
      SERVED_BY === 'nginx'
        ? `${URL}/_content/derived/${videoId}/${videoId}-${name}.mp4`
        : `${URL}/api/video?id=${videoId}&quality=${quality}`,
      version,
    )

  // forceOriginal bypasses the crop and the SDR copy — used by the editor so admins see
  // the full uncut video. Otherwise the crop stands in for the original.
  const originalUrl =
    forceOriginal && SERVED_BY === 'nginx'
      ? `${URL}/_content/video-raw/${videoId}${extension}`
      : hasCrop
        ? derivedUrl('cropped', 'cropped')
        : getVideoUrl(videoId, 'original', extension, version)

  if (hasSdr && !forceOriginal) {
    // A tone-mapped video has two sources: the SDR copy, and the HDR original (or its
    // crop) for displays that can show it. The player starts on the first source the
    // browser can decode smoothly, so the one this display should get is listed first.
    // On an SDR display the original carries no media description, so it is never
    // picked automatically and stays a manual choice in the quality menu.
    const hdrDisplay = displaySupportsHdr()
    const sdrSource = {
      src: derivedUrl('sdr', 'sdr'),
      type: 'video/mp4',
      label: 'Source',
      selected: !hdrDisplay,
      // The SDR copy is encoded like a transcode, at the source's size.
      media: getTranscodeMedia(videoInfo, videoInfo.height),
    }
    const hdrSource = {
      src: originalUrl,
      type: 'video/mp4',
      label: 'Source (HDR)',
      selected: hdrDisplay,
      media: hdrDisplay
        ? getSourceMedia(videoInfo, extension, { hasCrop, forceOriginal, hdrFormat: videoInfo.hdr_format })
        : null,
    }
    sources.push(...(hdrDisplay ? [hdrSource, sdrSource] : [sdrSource, hdrSource]))
  } else {
    sources.push({
      src: originalUrl,
      type: 'video/mp4',
      label: 'Source',
      selected: true,
      media: getSourceMedia(videoInfo, extension, { hasCrop, forceOriginal }),
    })
  }

  if (has1080p) {
    sources.push({
      src: getVideoUrl(videoId, '1080p', extension, version),
      type: 'video/mp4',
      label: '1080p',
      media: getTranscodeMedia(videoInfo, 1080),
    })
  }

  if (has720p) {
    sources.push({
      src: getVideoUrl(videoId, '720p', extension, version),
      type: 'video/mp4',
      label: '720p',
      media: getTranscodeMedia(videoInfo, 720),
    })
  }

  if (has480p) {
    sources.push({
      src: getVideoUrl(videoId, '480p', extension, version),
      type: 'video/mp4',
      label: '480p',
      media: getTranscodeMedia(videoInfo, 480),
    })
  }

  return sources
}

export const formatSize = (bytes) => {
  if (bytes == null || bytes === 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export const formatTableDate = (isoString) => {
  if (!isoString) return '—'
  try {
    return new Date(isoString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return '—'
  }
}

export const formatDuration = (seconds) => {
  if (seconds == null || isNaN(seconds)) return '—'
  const s = Math.floor(seconds)
  const hrs = Math.floor(s / 3600)
  const mins = Math.floor((s % 3600) / 60)
  const secs = s % 60
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export const formatResolution = (width, height) => {
  if (!width || !height) return '—'
  const shortSide = Math.min(width, height)
  if (shortSide >= 2160) return '4K'
  if (shortSide >= 1440) return '1440p'
  if (shortSide >= 1080) return '1080p'
  if (shortSide >= 720) return '720p'
  if (shortSide >= 480) return '480p'
  return `${width}×${height}`
}

// The name shown for an uploader, matching what UploaderMention renders so a
// sort on the Uploader column orders by the text actually on screen.
export const uploaderLabel = (uploader) => (uploader ? uploader.name || uploader.username : '')

// Sort key for the Uploader column. Unattributed media sorts as though it were
// greater than every name, so it clusters at the end ascending and at the top
// descending — finding it is the whole point of the column, so it has to be
// reachable by one click rather than scattered through the list.
export const uploaderSortKey = (uploader) => (uploader ? uploaderLabel(uploader).toLowerCase() : '￿')

// The option label for the uploader pickers: "Name (@username)", or just
// "@username" when the account has no distinct display name.
export const uploaderOptionLabel = (u) =>
  u.name && u.name !== u.username ? `${u.name} (@${u.username})` : `@${u.username}`
