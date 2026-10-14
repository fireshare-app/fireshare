/**
 * CustomVideoSkin — a copy of Video.js 10's default VideoSkin with a
 * quality-selector button injected into the control bar.
 *
 * All primitives are public exports of @videojs/react so this is safe
 * to maintain across minor updates.
 */
import React from 'react'
import {
  Container,
  usePlayer,
  useMedia,
  BufferingIndicator,
  CaptionsButton,
  Controls,
  FullscreenButton,
  MuteButton,
  PiPButton,
  PlayButton,
  PlaybackRateButton,
  Popover,
  SeekButton,
  Slider,
  Time,
  TimeSlider,
  Tooltip,
  VolumeSlider,
  AlertDialog,
} from '@videojs/react'

import {
  CaptionsOffIcon,
  CaptionsOnIcon,
  FullscreenEnterIcon,
  FullscreenExitIcon,
  PauseIcon,
  PipIcon,
  PlayIcon,
  RestartIcon,
  SeekIcon,
  SpinnerIcon,
  VolumeHighIcon,
  VolumeLowIcon,
  VolumeOffIcon,
} from './VideoSkinIcons'

const SEEK_TIME = 10

const DISABLE_PIP_BUTTON = true

const IS_IOS = /iP(ad|hone|od)/.test(navigator.userAgent)

// iOS Safari does not support the standard Fullscreen API — only
// video.webkitEnterFullscreen() works, and only on the <video> element itself.
function IOSFullscreenButton() {
  const media = useMedia()
  const [isFullscreen, setIsFullscreen] = React.useState(false)

  React.useEffect(() => {
    if (!media) return
    const onEnter = () => setIsFullscreen(true)
    const onExit = () => setIsFullscreen(false)
    media.addEventListener('webkitbeginfullscreen', onEnter)
    media.addEventListener('webkitendfullscreen', onExit)
    return () => {
      media.removeEventListener('webkitbeginfullscreen', onEnter)
      media.removeEventListener('webkitendfullscreen', onExit)
    }
  }, [media])

  const handleClick = () => {
    if (!media) return
    if (isFullscreen) {
      media.webkitExitFullscreen?.()
    } else {
      media.webkitEnterFullscreen?.()
    }
  }

  return (
    <Button onClick={handleClick} className="media-button--icon media-button--fullscreen">
      {isFullscreen ? (
        <FullscreenExitIcon className="media-icon media-icon--fullscreen-exit" />
      ) : (
        <FullscreenEnterIcon className="media-icon media-icon--fullscreen-enter" />
      )}
    </Button>
  )
}

/* ── tiny helper matching the skin's internal <Button> wrapper ──────── */
const Button = React.forwardRef(function Button({ className, ...props }, ref) {
  return <button ref={ref} type="button" className={`media-button ${className ?? ''}`} {...props} />
})

/* ── label helpers (reactive via usePlayer selectors) ───────────────── */
function PlayLabel() {
  const ended = usePlayer((s) => Boolean(s.ended))
  const paused = usePlayer((s) => Boolean(s.paused))
  if (ended) return <>Replay</>
  return paused ? <>Play</> : <>Pause</>
}
function CaptionsLabel() {
  return usePlayer((s) => Boolean(s.subtitlesShowing)) ? <>Disable captions</> : <>Enable captions</>
}
function PiPLabel() {
  return usePlayer((s) => Boolean(s.pip)) ? <>Exit picture-in-picture</> : <>Enter picture-in-picture</>
}
function FullscreenLabel() {
  return usePlayer((s) => Boolean(s.fullscreen)) ? <>Exit fullscreen</> : <>Enter fullscreen</>
}

/* ── error dialog (positioned over the player via .media-error) ────── */
function ErrorDialog() {
  const error = usePlayer((s) => s.error)
  if (!error) return null
  return (
    <AlertDialog.Root open={!!error}>
      <AlertDialog.Popup className="media-error">
        <div className="media-error__dialog media-surface">
          <div className="media-error__content">
            <div className="media-error__title">Playback Error</div>
            <div className="media-error__description">{error?.message || 'An error occurred.'}</div>
          </div>
          <div className="media-error__actions">
            <AlertDialog.Close className="media-button">OK</AlertDialog.Close>
          </div>
        </div>
      </AlertDialog.Popup>
    </AlertDialog.Root>
  )
}

/* ── Quality selector (popover inside the control bar) ──────────────── */
function QualitySelector({ sources, currentSourceIndex, onSelect }) {
  const media = useMedia()

  if (!sources || sources.length <= 1) return null
  const currentLabel = sources[currentSourceIndex]?.label || 'Quality'

  const handleSelect = (index) => {
    if (index === currentSourceIndex) return

    // Save current playback state so we can restore after source switch
    const savedTime = media?.currentTime ?? 0
    const wasPlaying = media && !media.paused

    onSelect(index)

    if (!media) return

    // Jump back to where the viewer was as soon as the new file's metadata is in, so
    // the browser fetches that part of the file first rather than the start, and
    // resume once it can play from there. Waiting for canplay to do both meant a
    // load from the beginning, a frame of it on screen, and a second fetch for the
    // real position, which on a slow link looked like a stall and triggered the
    // automatic step down.
    let restored = false
    const restorePosition = () => {
      if (restored) return
      restored = true
      if (savedTime > 0) {
        media.currentTime = media.duration > 0 ? Math.min(savedTime, media.duration) : savedTime
      }
    }
    const resume = () => {
      restorePosition()
      if (wasPlaying && media.paused) {
        const p = media.play()
        if (p) p.catch(() => {})
      }
    }
    media.addEventListener('loadedmetadata', restorePosition, { once: true })
    media.addEventListener('canplay', resume, { once: true })
  }

  return (
    <Popover.Root openOnHover delay={200} closeDelay={300} side="top">
      <Popover.Trigger
        render={
          <button
            type="button"
            className="media-button media-button--icon"
            style={{
              fontSize: '0.7rem',
              fontWeight: 600,
              minWidth: 32,
              padding: '0 6px',
              marginRight: 6,
              marginLeft: 6,
            }}
          >
            {currentLabel}
          </button>
        }
      />
      <Popover.Popup className="media-surface media-popover" style={{ padding: '4px 0' }}>
        {sources.map((source, index) => (
          <button
            key={source.label || index}
            type="button"
            onClick={() => handleSelect(index)}
            style={{
              display: 'block',
              width: '100%',
              padding: '6px 16px',
              border: 'none',
              background: index === currentSourceIndex ? 'rgba(255,255,255,0.15)' : 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: '0.8rem',
              fontWeight: index === currentSourceIndex ? 700 : 400,
            }}
          >
            {source.label || `Source ${index + 1}`}
          </button>
        ))}
      </Popover.Popup>
    </Popover.Root>
  )
}

/* ── The custom skin ────────────────────────────────────────────────── */
function CustomVideoSkin({ children, className, sources, currentSourceIndex, onQualitySelect, ...rest }) {
  return (
    <Container className={`media-default-skin media-default-skin--video${className ? ` ${className}` : ''}`} {...rest}>
      {/* Caller-provided children (e.g. <Video>, <Poster>) */}
      {children}

      {/* Buffering spinner */}
      <BufferingIndicator
        render={(props) => (
          <div {...props} className="media-buffering-indicator">
            <div className="media-surface">
              <SpinnerIcon className="media-icon" />
            </div>
          </div>
        )}
      />

      {/* Error overlay */}
      <ErrorDialog />

      {/* ── Control bar ─────────────────────────────────────────────── */}
      <Controls.Root className="media-surface media-controls">
        <Tooltip.Provider>
          {/* Play / Pause / Replay */}
          <Tooltip.Root side="top">
            <Tooltip.Trigger
              render={
                <PlayButton
                  render={(props) => (
                    <Button {...props} className="media-button--icon media-button--play">
                      <RestartIcon className="media-icon media-icon--restart" />
                      <PlayIcon className="media-icon media-icon--play" />
                      <PauseIcon className="media-icon media-icon--pause" />
                    </Button>
                  )}
                />
              }
            />
            <Tooltip.Popup className="media-surface media-tooltip">
              <PlayLabel />
            </Tooltip.Popup>
          </Tooltip.Root>

          {/* Seek backward */}
          <Tooltip.Root side="top">
            <Tooltip.Trigger
              render={
                <SeekButton
                  seconds={-SEEK_TIME}
                  render={(props) => (
                    <Button {...props} className="media-button--icon media-button--seek">
                      <span className="media-icon__container">
                        <SeekIcon className="media-icon media-icon--seek media-icon--flipped" />
                        <span className="media-icon__label">{SEEK_TIME}</span>
                      </span>
                    </Button>
                  )}
                />
              }
            />
            <Tooltip.Popup className="media-surface media-tooltip">Seek backward {SEEK_TIME} seconds</Tooltip.Popup>
          </Tooltip.Root>

          {/* Seek forward */}
          <Tooltip.Root side="top">
            <Tooltip.Trigger
              render={
                <SeekButton
                  seconds={SEEK_TIME}
                  render={(props) => (
                    <Button {...props} className="media-button--icon media-button--seek">
                      <span className="media-icon__container">
                        <SeekIcon className="media-icon media-icon--seek" />
                        <span className="media-icon__label">{SEEK_TIME}</span>
                      </span>
                    </Button>
                  )}
                />
              }
            />
            <Tooltip.Popup className="media-surface media-tooltip">Seek forward {SEEK_TIME} seconds</Tooltip.Popup>
          </Tooltip.Root>

          {/* Time bar: current / slider / duration */}
          <Time.Group className="media-time">
            <Time.Value type="current" className="media-time__value" />
            <TimeSlider.Root className="media-slider">
              <Slider.Track className="media-slider__track">
                <Slider.Fill className="media-slider__fill" />
                <Slider.Buffer className="media-slider__buffer" />
              </Slider.Track>
              <Slider.Thumb className="media-slider__thumb" />
            </TimeSlider.Root>
            <Time.Value type="duration" className="media-time__value" />
          </Time.Group>

          {/* Playback rate */}
          <Tooltip.Root side="top">
            <Tooltip.Trigger
              render={
                <PlaybackRateButton
                  render={(props) => <Button {...props} className="media-button--icon media-button--playback-rate" />}
                />
              }
            />
            <Tooltip.Popup className="media-surface media-tooltip">Toggle playback rate</Tooltip.Popup>
          </Tooltip.Root>

          {/* Volume (mute button + popover slider) */}
          <Popover.Root openOnHover delay={200} closeDelay={100} side="top">
            <Popover.Trigger
              render={
                <MuteButton
                  render={(props) => (
                    <Button {...props} className="media-button--icon media-button--mute">
                      <VolumeOffIcon className="media-icon media-icon--volume-off" />
                      <VolumeLowIcon className="media-icon media-icon--volume-low" />
                      <VolumeHighIcon className="media-icon media-icon--volume-high" />
                    </Button>
                  )}
                />
              }
            />
            <Popover.Popup className="media-surface media-popover media-popover--volume">
              <VolumeSlider.Root className="media-slider" orientation="vertical" thumbAlignment="edge">
                <Slider.Track className="media-slider__track">
                  <Slider.Fill className="media-slider__fill" />
                </Slider.Track>
                <Slider.Thumb className="media-slider__thumb media-slider__thumb--persistent" />
              </VolumeSlider.Root>
            </Popover.Popup>
          </Popover.Root>

          {/* ★ Quality selector ★ */}
          <QualitySelector sources={sources} currentSourceIndex={currentSourceIndex} onSelect={onQualitySelect} />

          {/* Captions */}
          <Tooltip.Root side="top">
            <Tooltip.Trigger
              render={
                <CaptionsButton
                  render={(props) => (
                    <Button {...props} className="media-button--icon media-button--captions">
                      <CaptionsOffIcon className="media-icon media-icon--captions-off" />
                      <CaptionsOnIcon className="media-icon media-icon--captions-on" />
                    </Button>
                  )}
                />
              }
            />
            <Tooltip.Popup className="media-surface media-tooltip">
              <CaptionsLabel />
            </Tooltip.Popup>
          </Tooltip.Root>

          {/* Picture-in-Picture */}
          {!DISABLE_PIP_BUTTON && (
            <Tooltip.Root side="top">
              <Tooltip.Trigger
                render={
                  <PiPButton
                    render={(props) => (
                      <Button {...props} className="media-button--icon">
                        <PipIcon className="media-icon" />
                      </Button>
                    )}
                  />
                }
              />
              <Tooltip.Popup className="media-surface media-tooltip">
                <PiPLabel />
              </Tooltip.Popup>
            </Tooltip.Root>
          )}

          {/* Fullscreen */}
          {IS_IOS ? (
            <IOSFullscreenButton />
          ) : (
            <Tooltip.Root side="top">
              <Tooltip.Trigger
                render={
                  <FullscreenButton
                    render={(props) => (
                      <Button {...props} className="media-button--icon media-button--fullscreen">
                        <FullscreenEnterIcon className="media-icon media-icon--fullscreen-enter" />
                        <FullscreenExitIcon className="media-icon media-icon--fullscreen-exit" />
                      </Button>
                    )}
                  />
                }
              />
              <Tooltip.Popup className="media-surface media-tooltip">
                <FullscreenLabel />
              </Tooltip.Popup>
            </Tooltip.Root>
          )}
        </Tooltip.Provider>
      </Controls.Root>

      {/* Click-to-play overlay */}
      <div className="media-overlay" />
    </Container>
  )
}

export default CustomVideoSkin
