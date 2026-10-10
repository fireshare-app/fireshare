import React, { useEffect, useRef, useState, useMemo } from 'react'
import '@videojs/react/video/skin.css'
import './videoSkinOverrides.css'
import { createPlayer, useMedia, Poster } from '@videojs/react'
import { Video, videoFeatures } from '@videojs/react/video'
import CustomVideoSkin from './CustomVideoSkin'
import usePlayableSources from './usePlayableSources'
import { rememberSourceChoice } from '../../common/utils'

// Tolerance threshold for checking if player is already at the desired start time (in seconds)
const SEEK_TOLERANCE_SECONDS = 0.5

// How long to wait while buffering before switching to a lower quality source (in ms)
const BUFFER_STALL_TIMEOUT_MS = 5000

// Number of buffering events within the window that triggers a quality downgrade
const BUFFER_COUNT_THRESHOLD = 4

// Sliding window duration for counting buffering events (in ms)
const BUFFER_COUNT_WINDOW_MS = 30000

// Create the Video.js 10 player instance (module-level singleton)
const Player = createPlayer({ features: videoFeatures })

function PlayerEffects({ sources, onSourceChange, onTimeUpdate, onReady, startTime }) {
  const store = Player.usePlayer()
  const media = Player.useMedia()
  const currentTime = Player.usePlayer((s) => s.currentTime)
  const onTimeUpdateRef = useRef(onTimeUpdate)
  const onReadyRef = useRef(onReady)
  const startTimeApplied = useRef(false)
  const readyFired = useRef(false)

  useEffect(() => {
    onTimeUpdateRef.current = onTimeUpdate
    onReadyRef.current = onReady
  }, [onTimeUpdate, onReady])

  useEffect(() => {
    if (onTimeUpdateRef.current) {
      onTimeUpdateRef.current({ playedSeconds: currentTime || 0 })
    }
  }, [currentTime])

  // --- onReady: provide a wrapper that mimics the v8 player API --------------
  const mediaRef = useRef(null)
  useEffect(() => {
    mediaRef.current = media
  }, [media])

  const playerWrapper = useMemo(
    () => ({
      currentTime: () => mediaRef.current?.currentTime ?? 0,
      duration: () => mediaRef.current?.duration ?? 0,
      paused: () => mediaRef.current?.paused ?? true,
      play: () => store.play?.(),
      pause: () => store.pause?.(),
      seek: (time) => {
        if (mediaRef.current) mediaRef.current.currentTime = time
      },
      el: () => mediaRef.current,
    }),
    [store],
  )

  useEffect(() => {
    if (media && !readyFired.current) {
      readyFired.current = true
      if (onReadyRef.current) {
        onReadyRef.current(playerWrapper)
      }
    }
  }, [media, playerWrapper])

  // --- teardown: release the media element's decoder/buffers on unmount ------
  // React only removes the <video> node from the DOM; without an explicit src
  // detach Chrome keeps the demuxer and hardware decoder pinned until GC,
  // which accumulates across open/close cycles and can crash the GPU process.
  useEffect(() => {
    if (!media) return
    return () => {
      // isConnected is still true during StrictMode's simulated unmount —
      // only tear down once the element has really left the DOM.
      if (media.isConnected) return
      media.pause()
      media.removeAttribute('src')
      media.load()
    }
  }, [media])

  // --- startTime: seek to the requested position once the player is ready ----
  useEffect(() => {
    if (!media || !startTime || startTimeApplied.current) return

    const applySeek = () => {
      // Validate against actual media duration when available, skipping the seek
      // if the saved position is outside the 10–90% window.
      if (media.duration > 0) {
        const pct = startTime / media.duration
        if (startTime < 10 || pct > 0.9) {
          startTimeApplied.current = true
          return
        }
      }
      media.currentTime = startTime
      startTimeApplied.current = true
    }

    // canplay fires after loadedmetadata and guarantees the browser is actually
    // ready to play from any position — more reliable than loadedmetadata alone.
    const handleCanPlay = () => {
      if (!startTimeApplied.current) applySeek()
    }

    // loadedmetadata is an earlier signal; use it as a first attempt.
    const handleLoaded = () => {
      if (!startTimeApplied.current) applySeek()
    }

    if (media.readyState >= 1) {
      // Metadata already loaded — try immediately, canplay will catch it if needed.
      applySeek()
    } else {
      media.addEventListener('loadedmetadata', handleLoaded, { once: true })
    }
    media.addEventListener('canplay', handleCanPlay, { once: true })

    // Final safety net: if autoplay fires before canplay (e.g. the browser starts
    // playing before our listeners run), seek on the first play event too.
    const handlePlay = () => {
      if (!startTimeApplied.current || Math.abs(media.currentTime - startTime) > SEEK_TOLERANCE_SECONDS) {
        applySeek()
      }
    }
    media.addEventListener('play', handlePlay, { once: true })

    return () => {
      media.removeEventListener('loadedmetadata', handleLoaded)
      media.removeEventListener('canplay', handleCanPlay)
      media.removeEventListener('play', handlePlay)
    }
  }, [media, startTime])

  // --- Auto-downgrade: switch to lower quality on buffering / error ----------
  useEffect(() => {
    if (!media || !sources || sources.length <= 1) return

    let bufferStallTimer = null
    let bufferTimestamps = []
    let isSourceTransitioning = false
    let sourceTransitionTimer = null
    let isSeeking = false

    const clearStallTimer = () => {
      if (bufferStallTimer) {
        clearTimeout(bufferStallTimer)
        bufferStallTimer = null
      }
    }

    const clearTransitionTimer = () => {
      if (sourceTransitionTimer) {
        clearTimeout(sourceTransitionTimer)
        sourceTransitionTimer = null
      }
    }

    const switchToNextSource = () => {
      onSourceChange((prev) => {
        if (prev + 1 < sources.length) return prev + 1
        return prev
      })
    }

    const handleError = () => {
      if (isSourceTransitioning) {
        setTimeout(() => {
          if (media.error) {
            isSourceTransitioning = false
            clearTransitionTimer()
            switchToNextSource()
          }
        }, 1000)
      } else {
        switchToNextSource()
      }
    }

    const handleLoadStart = () => {
      isSourceTransitioning = true
      bufferTimestamps = []
      clearStallTimer()
      clearTransitionTimer()
      sourceTransitionTimer = setTimeout(() => {
        isSourceTransitioning = false
      }, BUFFER_STALL_TIMEOUT_MS)
    }

    const handleCanPlay = () => {
      isSourceTransitioning = false
      clearTransitionTimer()
    }

    const handleSeeking = () => {
      isSeeking = true
      clearStallTimer()
    }

    const handleSeeked = () => {
      isSeeking = false
      clearStallTimer()
    }

    const handleWaiting = () => {
      // Seeking to an unbuffered position naturally fires 'waiting' while the
      // browser loads that range — that's not real network stalling and
      // shouldn't count toward a quality downgrade.
      if (isSourceTransitioning || isSeeking) return

      const now = Date.now()
      bufferTimestamps.push(now)
      bufferTimestamps = bufferTimestamps.filter((t) => now - t < BUFFER_COUNT_WINDOW_MS)

      if (bufferTimestamps.length >= BUFFER_COUNT_THRESHOLD) {
        bufferTimestamps = []
        clearStallTimer()
        switchToNextSource()
        return
      }

      clearStallTimer()
      bufferStallTimer = setTimeout(() => {
        if (media.paused || media.readyState < 3) {
          bufferTimestamps = []
          switchToNextSource()
        }
      }, BUFFER_STALL_TIMEOUT_MS)
    }

    const handlePlayingOrPause = () => clearStallTimer()

    media.addEventListener('error', handleError)
    media.addEventListener('loadstart', handleLoadStart)
    media.addEventListener('canplay', handleCanPlay)
    media.addEventListener('waiting', handleWaiting)
    media.addEventListener('playing', handlePlayingOrPause)
    media.addEventListener('pause', handlePlayingOrPause)
    media.addEventListener('seeking', handleSeeking)
    media.addEventListener('seeked', handleSeeked)

    return () => {
      clearStallTimer()
      clearTransitionTimer()
      media.removeEventListener('error', handleError)
      media.removeEventListener('loadstart', handleLoadStart)
      media.removeEventListener('canplay', handleCanPlay)
      media.removeEventListener('waiting', handleWaiting)
      media.removeEventListener('playing', handlePlayingOrPause)
      media.removeEventListener('pause', handlePlayingOrPause)
      media.removeEventListener('seeking', handleSeeking)
      media.removeEventListener('seeked', handleSeeked)
    }
  }, [media, sources, onSourceChange])

  return null
}

/**
 * SpacebarToggle — listens for the spacebar key and toggles play/pause.
 * Must be rendered inside <Player.Provider>.
 */
function SpacebarToggle() {
  const media = Player.useMedia()

  useEffect(() => {
    if (!media) return

    const handleKeyDown = (e) => {
      // Only handle spacebar; ignore if user is typing in an input/textarea
      if (e.code !== 'Space' && e.key !== ' ') return
      const tag = document.activeElement?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return

      e.preventDefault()
      if (media.paused) {
        media.play()?.catch(() => {})
      } else {
        media.pause()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [media])

  return null
}

/**
 * FrameStepKeys — listens for , and . keys to step one frame backward/forward.
 * Detects the actual frame duration via requestVideoFrameCallback during playback;
 * falls back to 30 fps until the real rate is known.
 * Must be rendered inside <Player.Provider>.
 */
const FRAME_STEP_INTERVAL_MS = 150

function FrameStepKeys() {
  const media = Player.useMedia()
  const lastStepAt = useRef(0)
  const frameDuration = useRef(1 / 30)
  // Prevents the play/pause frame-render trick from poisoning rVFC measurements
  const isStepping = useRef(false)

  // Measure real frame duration from the video stream as it plays naturally.
  // Callbacks that fire during our own play/pause seek trick are ignored.
  useEffect(() => {
    if (!media || typeof media.requestVideoFrameCallback !== 'function') return

    let handle
    let prevMediaTime = null
    let prevPresentedFrames = null

    const onFrame = (_, metadata) => {
      if (!isStepping.current && prevMediaTime !== null && prevPresentedFrames !== null) {
        const timeDelta = metadata.mediaTime - prevMediaTime
        // presentedFrames counts every composited frame, so dividing gives the
        // true per-frame duration even when the callback fires every 2-4 frames
        const frameDelta = metadata.presentedFrames - prevPresentedFrames
        if (frameDelta > 0 && timeDelta > 0) {
          const perFrame = timeDelta / frameDelta
          if (perFrame > 1 / 240 && perFrame < 1 / 8) {
            frameDuration.current = perFrame
          }
        }
      }
      if (!isStepping.current) {
        prevMediaTime = metadata.mediaTime
        prevPresentedFrames = metadata.presentedFrames
      } else {
        prevMediaTime = null
        prevPresentedFrames = null
      }
      handle = media.requestVideoFrameCallback(onFrame)
    }

    handle = media.requestVideoFrameCallback(onFrame)
    return () => media.cancelVideoFrameCallback(handle)
  }, [media])

  useEffect(() => {
    if (!media) return

    const handleKeyDown = (e) => {
      if (e.key !== ',' && e.key !== '.') return
      const tag = document.activeElement?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return

      const now = Date.now()
      if (now - lastStepAt.current < FRAME_STEP_INTERVAL_MS) return
      lastStepAt.current = now

      e.preventDefault()
      isStepping.current = true
      media.pause()
      media.currentTime = Math.min(
        Math.max(media.currentTime + (e.key === '.' ? frameDuration.current : -frameDuration.current), 0),
        media.duration || 0,
      )
      // Force the browser to decode and paint the new frame even if play()
      // has never been called (before first play the renderer stays frozen).
      media
        .play()
        .then(() => {
          media.pause()
          isStepping.current = false
        })
        .catch(() => {
          isStepping.current = false
        })
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [media])

  return null
}

const PlayerWithSources = ({
  sources,
  poster,
  autoplay = false,
  fill = false,
  playsinline = false,
  onTimeUpdate,
  onReady,
  startTime,
  className,
  style,
}) => {
  const [currentSourceIndex, setCurrentSourceIndex] = useState(() => {
    // Start with the "selected" source, or default to index 0
    const idx = sources?.findIndex((s) => s.selected)
    return idx >= 0 ? idx : 0
  })

  // Reset source index when the sources actually change (e.g. new video).
  // Compare by src URLs rather than array reference to avoid resetting the
  // user's quality selection when the parent re-renders with a new array
  // that contains the same sources.
  const prevSourcesRef = useRef(sources)
  useEffect(() => {
    const prevSrcs = prevSourcesRef.current?.map((s) => s.src)
    const nextSrcs = sources?.map((s) => s.src)
    const changed = prevSrcs?.length !== nextSrcs?.length || prevSrcs?.some((s, i) => s !== nextSrcs[i])
    if (changed) {
      prevSourcesRef.current = sources
      const idx = sources?.findIndex((s) => s.selected)
      setCurrentSourceIndex(idx >= 0 ? idx : 0)
    }
  }, [sources])

  const activeSrc = sources?.[currentSourceIndex]?.src || sources?.[0]?.src

  // Container styles: emulate fluid / fill behaviour
  const containerStyle = {
    maxWidth: '100%',
    ...(fill && { width: '100%', height: '100%' }),
    ...style,
  }

  return (
    <Player.Provider>
      <CustomVideoSkin
        className={className}
        style={containerStyle}
        sources={sources}
        currentSourceIndex={currentSourceIndex}
        onQualitySelect={(index) => {
          // A pick from the menu is the viewer's word on HDR versus SDR for this device.
          rememberSourceChoice(sources?.[index])
          setCurrentSourceIndex(index)
        }}
      >
        <Video src={activeSrc} autoPlay={autoplay} playsInline={playsinline} preload="auto" />
        {poster && <Poster src={poster} alt="" />}
      </CustomVideoSkin>
      <PlayerEffects
        sources={sources}
        onSourceChange={setCurrentSourceIndex}
        onTimeUpdate={onTimeUpdate}
        onReady={onReady}
        startTime={startTime}
      />
      <SpacebarToggle />
      <FrameStepKeys />
    </Player.Provider>
  )
}

/**
 * VideoJSPlayer — a drop-in replacement powered by Video.js 10.
 *
 * Accepts the same props as the previous v8 component so that consumers
 * (Watch.js, VideoModal.js) do not need to change their usage.
 *
 * Mounts once the starting source is settled, so a source this device cannot
 * play smoothly is never loaded just to be switched away from.
 */
const VideoJSPlayer = ({ sources, ...props }) => {
  const playable = usePlayableSources(sources)
  if (!playable) return null
  return <PlayerWithSources sources={playable} {...props} />
}

export default VideoJSPlayer
