import React, { useEffect, useRef, useState } from 'react'
import { Box, Typography, CircularProgress, Menu, MenuItem, Button } from '@mui/material'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import { getUrl } from '../../common/utils'

const labelSx = { fontSize: 11, color: '#FFFFFFB3', mb: 0.5, textTransform: 'uppercase', letterSpacing: '0.08em' }

const numInputSx = {
  width: 80,
  bgcolor: '#FFFFFF0D',
  border: '1px solid #FFFFFF26',
  borderRadius: '6px',
  color: 'white',
  fontSize: 13,
  fontFamily: 'monospace',
  padding: '4px 8px',
  outline: 'none',
  '&:focus': { borderColor: '#3399FF' },
}

const TIMELINE_HEIGHT = 20 // px

// A video with no audio track gets silence from the server, so the crop still has a
// timeline to sit on. Said in words, because a flat line looks like a waveform that
// failed to draw.
const isSilent = (buffer) => {
  if (!buffer) return false
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i]) > 0.001) return false
    }
  }
  return true
}

/**
 * WaveformCropper — renders an audio waveform for the original (unmodified) video
 * with a draggable/resizable region marking the crop start and end points.
 *
 * Props:
 *   videoId    — video ID used to build /api/video/original?id={videoId}
 *   duration   — original video duration in seconds (used as fallback)
 *   startTime  — current crop start (null = full start)
 *   endTime    — current crop end   (null = full end)
 *   onChange   — ({ startTime: number|null, endTime: number|null }) => void
 */
const WaveformCropper = React.forwardRef(
  ({ videoId, duration, startTime, endTime, onChange, onSeek, getCurrentTime }, ref) => {
    const containerRef = useRef(null)
    const timelineCanvasRef = useRef(null)
    const extScrollbarRef = useRef(null)
    const extScrollbarInnerRef = useRef(null)
    const isSyncingScroll = useRef(false)
    const drawTimelineRef = useRef(() => {})
    const wsRef = useRef(null)
    const regionsPluginRef = useRef(null)
    const regionRef = useRef(null)
    const onSeekRef = useRef(onSeek)
    const getCurrentTimeRef = useRef(getCurrentTime)
    const zoomRef = useRef(1)
    const minZoomRef = useRef(1)
    const isReadyRef = useRef(false)
    const cursorTimeRef = useRef(0)

    const [contextMenu, setContextMenu] = useState(null) // { x, y, cursorTime } | null

    useEffect(() => {
      onSeekRef.current = onSeek
    }, [onSeek])
    useEffect(() => {
      getCurrentTimeRef.current = getCurrentTime
    }, [getCurrentTime])

    // Expose a seekTo(time) handle so VideoModal can sync the cursor with video playback
    React.useImperativeHandle(
      ref,
      () => ({
        seekTo: (time) => {
          const ws = wsRef.current
          if (!ws || !isReadyRef.current) return
          const total = ws.getDuration()
          if (!total) return
          cursorTimeRef.current = time
          ws.seekTo(Math.max(0, Math.min(1, time / total)))
        },
      }),
      [],
    )

    const [isLoading, setIsLoading] = useState(true)
    const [loadError, setLoadError] = useState(false)
    const [silent, setSilent] = useState(false)
    const [localStart, setLocalStart] = useState(startTime ?? 0)
    const [localEnd, setLocalEnd] = useState(endTime ?? duration ?? 0)
    const [totalDuration, setTotalDuration] = useState(duration ?? 0)

    // Emit null when values are trivially close to full range
    const toNullable = (s, e, total) => ({
      startTime: s <= 0.05 ? null : s,
      endTime: e >= total - 0.05 ? null : e,
    })

    // Keep the external scrollbar's inner width in sync with WaveSurfer's content width
    const syncScrollbarWidth = () => {
      const scrollContainer = wsRef.current?.getWrapper()?.parentElement
      if (!scrollContainer || !extScrollbarInnerRef.current) return
      extScrollbarInnerRef.current.style.width = scrollContainer.scrollWidth + 'px'
    }

    useEffect(() => {
      if (!containerRef.current) return

      // ── Custom canvas timeline ──────────────────────────────────────────────
      // Draws tick marks + time labels onto a <canvas> above the waveform.
      // Replaces WaveSurfer's TimelinePlugin which has a virtualAppend bug that
      // prevents ticks from rendering when clientWidth is 0 on first paint.
      const drawTimeline = () => {
        const canvas = timelineCanvasRef.current
        if (!canvas || !isReadyRef.current) return
        const ws = wsRef.current
        const duration = ws?.getDuration() ?? 0
        if (!duration || zoomRef.current <= 0) return

        // ws.getWrapper() = inner .wrapper div (never scrolls).
        // ws.getScroll()  = scrollContainer.scrollLeft (the actual scrollable element).
        // ws.getWrapper().offsetWidth = rendered canvas width = pxPerSec * duration.
        const scrollLeft = ws.getScroll()
        const pxPerSec = (ws?.getWrapper()?.offsetWidth ?? 0) / duration
        const dpr = window.devicePixelRatio || 1
        const cssWidth = canvas.offsetWidth
        const cssHeight = canvas.offsetHeight

        canvas.width = cssWidth * dpr
        canvas.height = cssHeight * dpr

        const ctx = canvas.getContext('2d')
        ctx.scale(dpr, dpr)
        ctx.clearRect(0, 0, cssWidth, cssHeight)

        // Pick "nice" intervals so ticks stay ~40px apart, labels ~120px apart
        const niceAll = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
        const niceLabel = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
        const tickInterval = niceAll.find((n) => n >= 40 / pxPerSec) ?? 600
        const labelInterval = niceLabel.find((n) => n >= 120 / pxPerSec) ?? 600
        const labelsPerTick = Math.max(1, Math.round(labelInterval / tickInterval))

        const startTime = scrollLeft / pxPerSec
        const firstTickIndex = Math.max(0, Math.floor(startTime / tickInterval))
        const firstTick = firstTickIndex * tickInterval

        ctx.font = `13px monospace, -apple-system, sans-serif`
        ctx.textBaseline = 'top'

        for (let i = 0; ; i++) {
          const t = firstTick + i * tickInterval
          if (t > duration + tickInterval) break
          const x = Math.round(t * pxPerSec - scrollLeft)
          if (x > cssWidth + 2) break

          const isLabel = (firstTickIndex + i) % labelsPerTick === 0

          // Tick line
          ctx.globalAlpha = isLabel ? 0.5 : 0.2
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(x + 0.5, isLabel ? 0 : cssHeight * 0.55)
          ctx.lineTo(x + 0.5, cssHeight)
          ctx.stroke()

          if (isLabel) {
            const m = Math.floor(t / 60)
            const s = Math.floor(t % 60)
            const label = `${m}:${s.toString().padStart(2, '0')}`
            ctx.globalAlpha = 0.55
            ctx.fillStyle = '#ffffff'
            ctx.fillText(label, x + 3, 1)
          }
        }
      }
      drawTimelineRef.current = drawTimeline

      const regionsPlugin = RegionsPlugin.create()
      regionsPluginRef.current = regionsPlugin

      const ws = WaveSurfer.create({
        container: containerRef.current,
        waveColor: '#FFFFFF30',
        progressColor: '#3399ffce',
        cursorColor: 'rgba(255, 255, 255, 0.85)',
        cursorWidth: 2,
        height: 64,
        barHeight: 1,
        normalize: true,
        interact: false,
        autoScroll: false,
        autoCenter: false,
        barWidth: 1,
        barGap: 1,
        barRadius: 0,
        barAlign: 'bottom',
        url: `${getUrl()}/api/video/audio?id=${videoId}`,
        fetchParams: { credentials: 'include', signal: AbortSignal.timeout(180000) },
        plugins: [regionsPlugin],
      })
      wsRef.current = ws

      ws.on('error', () => {
        setIsLoading(false)
        setLoadError(true)
      })

      ws.on('ready', () => {
        isReadyRef.current = true
        const total = ws.getDuration()
        setTotalDuration(total)
        setIsLoading(false)
        setSilent(isSilent(ws.getDecodedData()))

        const s = startTime ?? 0
        const e = endTime ?? total

        setLocalStart(s)
        setLocalEnd(e)

        regionRef.current = regionsPlugin.addRegion({
          start: s,
          end: e,
          color: 'rgba(51, 153, 255, 0.36)',
          drag: true,
          resize: true,
          minLength: 1,
        })

        // Style the resize handles as solid grab bars with grip lines.
        // WaveSurfer regions plugin uses part="region-handle region-handle-left/right"
        // (not data-resize) in this version.
        const handleEls = regionRef.current.element?.querySelectorAll('[part~="region-handle"]')
        if (handleEls?.length) {
          handleEls.forEach((el) => {
            const side = el.getAttribute('part')?.includes('left') ? 'left' : 'right'
            Object.assign(el.style, {
              width: '6px',
              background: 'rgba(51, 153, 255, 0.88)',
              border: 'none',
              cursor: 'ew-resize',
              borderRadius: side === 'left' ? '3px 0 0 3px' : '0 3px 3px 0',
            })
            // Three horizontal grip lines centered in the bar
            ;['-5px', '0px', '5px'].forEach((offset) => {
              const line = document.createElement('div')
              Object.assign(line.style, {
                position: 'absolute',
                width: '6px',
                height: '2px',
                background: 'rgba(255, 255, 255, 0.5)',
                left: '50%',
                top: '50%',
                transform: `translate(-50%, calc(-50% + ${offset}))`,
                borderRadius: '1px',
                pointerEvents: 'none',
              })
              el.appendChild(line)
            })
          })
        }

        onChange(toNullable(s, e, total))

        // Sync cursor to current video playback position
        const currentVideoTime = getCurrentTimeRef.current?.() ?? 0
        if (currentVideoTime > 0 && total > 0) {
          ws.seekTo(Math.max(0, Math.min(1, currentVideoTime / total)))
        }

        // Compute and apply the zoom that fits the full waveform in the container
        const containerWidth = containerRef.current?.clientWidth || 500
        const fitZoom = containerWidth / total
        minZoomRef.current = fitZoom
        zoomRef.current = fitZoom
        ws.zoom(fitZoom)

        // Hide WaveSurfer's built-in scrollbar — we use an external one below.
        // The actual scrollable element is the .scroll div (wrapper's parent), not
        // the inner .wrapper returned by getWrapper().
        const scrollContainer = ws.getWrapper()?.parentElement
        if (scrollContainer) {
          scrollContainer.style.scrollbarWidth = 'none'
          scrollContainer.style.msOverflowStyle = 'none'
          if (!document.getElementById('__fs_ws_hide_sb')) {
            const styleEl = document.createElement('style')
            styleEl.id = '__fs_ws_hide_sb'
            styleEl.textContent = '.__fs_ws_hide_sb::-webkit-scrollbar{display:none}'
            document.head.appendChild(styleEl)
          }
          scrollContainer.classList.add('__fs_ws_hide_sb')
        }

        requestAnimationFrame(() => {
          drawTimeline()
          syncScrollbarWidth()
        })
      })

      // Sync WaveSurfer scroll → external scrollbar + timeline redraw
      ws.on('scroll', () => {
        if (!isSyncingScroll.current && extScrollbarRef.current) {
          isSyncingScroll.current = true
          extScrollbarRef.current.scrollLeft = ws.getScroll()
          isSyncingScroll.current = false
        }
        drawTimeline()
      })

      regionsPlugin.on('region-updated', (region) => {
        const total = wsRef.current?.getDuration() ?? totalDuration
        const s = parseFloat(Math.max(0, region.start).toFixed(2))
        const e = parseFloat(Math.min(total, region.end).toFixed(2))
        setLocalStart(s)
        setLocalEnd(e)
        onChange(toNullable(s, e, total))
      })

      // Click anywhere on the waveform → move seek cursor + seek video
      const container = containerRef.current
      const handleClick = (e) => {
        const ws = wsRef.current
        if (!ws || !ws.getDuration()) return
        // WaveSurfer uses a Shadow DOM internally; its inner wrapper's getBoundingClientRect()
        // automatically accounts for scroll offset (its .left goes negative when scrolled right),
        // so this gives the correct waveform-relative click position at any zoom level.
        const wrapper = ws.getWrapper()
        const rect = wrapper.getBoundingClientRect()
        const progress = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        cursorTimeRef.current = progress * ws.getDuration()
        ws.seekTo(progress)
        onSeekRef.current?.(cursorTimeRef.current)
      }

      const handleContextMenu = (e) => {
        e.preventDefault()
        setContextMenu({ x: e.clientX, y: e.clientY, cursorTime: cursorTimeRef.current })
      }

      // Vertical scroll → zoom in/out; horizontal scroll passes through naturally
      const handleWheel = (e) => {
        if (e.deltaY === 0 || !wsRef.current) return
        e.preventDefault()
        const newZoom = Math.max(minZoomRef.current, Math.min(500, zoomRef.current * (e.deltaY < 0 ? 1.3 : 0.77)))
        zoomRef.current = newZoom
        wsRef.current.zoom(newZoom)
        requestAnimationFrame(() => {
          drawTimeline()
          syncScrollbarWidth()
        })
      }

      container.addEventListener('click', handleClick)
      container.addEventListener('contextmenu', handleContextMenu)
      container.addEventListener('wheel', handleWheel, { passive: false })

      return () => {
        isReadyRef.current = false
        ws.destroy()
        container.removeEventListener('click', handleClick)
        container.removeEventListener('contextmenu', handleContextMenu)
        container.removeEventListener('wheel', handleWheel)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videoId])

    // External scrollbar → WaveSurfer scroll position + timeline redraw
    const handleExternalScroll = () => {
      if (isSyncingScroll.current) return
      const ws = wsRef.current
      if (!ws || !extScrollbarRef.current) return
      isSyncingScroll.current = true
      ws.setScroll(extScrollbarRef.current.scrollLeft)
      isSyncingScroll.current = false
      drawTimelineRef.current()
    }

    const handleStartChange = (val) => {
      const total = wsRef.current?.getDuration() ?? totalDuration
      const clamped = parseFloat(Math.max(0, Math.min(val, localEnd - 1)).toFixed(2))
      setLocalStart(clamped)
      if (regionRef.current) regionRef.current.setOptions({ start: clamped })
      onChange(toNullable(clamped, localEnd, total))
    }

    const handleEndChange = (val) => {
      const total = wsRef.current?.getDuration() ?? totalDuration
      const clamped = parseFloat(Math.min(total, Math.max(val, localStart + 1)).toFixed(2))
      setLocalEnd(clamped)
      if (regionRef.current) regionRef.current.setOptions({ end: clamped })
      onChange(toNullable(localStart, clamped, total))
    }

    const handleReset = () => {
      const total = wsRef.current?.getDuration() ?? totalDuration
      if (regionRef.current) regionRef.current.setOptions({ start: 0, end: total })
      setLocalStart(0)
      setLocalEnd(total)
      onChange({ startTime: null, endTime: null })
    }

    return (
      <>
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', height: '100%' }}>
          {/* Waveform column — cropper box + external scrollbar below it */}
          <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <Box
              sx={{
                position: 'relative',
                bgcolor: '#FFFFFF08',
                border: '1px solid #FFFFFF1A',
                borderRadius: '8px',
                overflow: 'hidden',
                minHeight: 68 + TIMELINE_HEIGHT,
              }}
            >
              {/* Waveform canvas */}
              <div ref={containerRef} style={{ width: '100%', overflow: 'hidden' }} />
              {/* Custom timeline canvas — sits below the waveform bars */}
              <canvas
                ref={timelineCanvasRef}
                style={{
                  display: 'block',
                  width: '100%',
                  height: TIMELINE_HEIGHT,
                  borderTop: '1px solid rgba(255,255,255,0.06)',
                }}
              />
              {(isLoading || loadError) && (
                <Box
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 1.5,
                    pb: `${TIMELINE_HEIGHT}px`, // account for timeline canvas at the bottom
                  }}
                >
                  {loadError ? (
                    <Typography sx={{ fontSize: 12, color: '#FF6B6B66' }}>Unable to load audio waveform</Typography>
                  ) : (
                    <>
                      <CircularProgress size={20} sx={{ color: '#3399FF' }} />
                      <Typography sx={{ fontSize: 12, color: '#FFFFFF66' }}>Loading audio…</Typography>
                    </>
                  )}
                </Box>
              )}
              {silent && !isLoading && !loadError && (
                <Box
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    pb: `${TIMELINE_HEIGHT}px`,
                    pointerEvents: 'none',
                  }}
                >
                  <Typography sx={{ fontSize: 12, color: '#FFFFFF66' }}>No audio track</Typography>
                </Box>
              )}
            </Box>

            {/* External scrollbar — sits below the cropper, only visible when zoomed in */}
            <div
              ref={extScrollbarRef}
              onScroll={handleExternalScroll}
              style={{ overflowX: 'auto', overflowY: 'hidden', width: '100%', height: 14 }}
            >
              <div ref={extScrollbarInnerRef} style={{ height: 1 }} />
            </div>
          </Box>

          {/* Controls — horizontal row to the right */}
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              pb: '14px', // offset the external scrollbar height so centering aligns with the cropper box
            }}
          >
            <Box sx={{ display: 'flex', flexDirection: 'row', gap: 1 }}>
              <Box>
                <Typography sx={labelSx}>Start (s)</Typography>
                <Box
                  component="input"
                  type="number"
                  step="0.1"
                  min={0}
                  max={localEnd - 1}
                  value={localStart}
                  disabled={isLoading}
                  onChange={(e) => handleStartChange(parseFloat(e.target.value) || 0)}
                  sx={numInputSx}
                />
              </Box>
              <Box>
                <Typography sx={labelSx}>End (s)</Typography>
                <Box
                  component="input"
                  type="number"
                  step="0.1"
                  min={localStart + 1}
                  max={totalDuration}
                  value={localEnd}
                  disabled={isLoading}
                  onChange={(e) => handleEndChange(parseFloat(e.target.value) || totalDuration)}
                  sx={numInputSx}
                />
              </Box>
            </Box>
            <Button
              size="medium"
              disabled={isLoading}
              onClick={handleReset}
              sx={{
                mt: 1,
                fontSize: 11,
                color: '#FFFFFF66',
                bgcolor: '#0D1F33',
                '&:hover': { color: 'white' },
                width: '100%',
              }}
            >
              Reset
            </Button>
          </Box>
        </Box>

        <Menu
          open={contextMenu !== null}
          onClose={() => setContextMenu(null)}
          anchorReference="anchorPosition"
          anchorPosition={contextMenu ? { top: contextMenu.y, left: contextMenu.x } : undefined}
          slotProps={{
            paper: { sx: { bgcolor: '#0D1F33', border: '1px solid #FFFFFF1A', color: 'white', minWidth: 140 } },
          }}
        >
          <MenuItem
            disabled={contextMenu?.cursorTime >= localEnd}
            onClick={() => {
              handleStartChange(parseFloat(contextMenu.cursorTime.toFixed(2)))
              setContextMenu(null)
            }}
            sx={{
              fontSize: 13,
              color: 'white',
              '&:hover': { bgcolor: '#FFFFFF14' },
              '&.Mui-disabled': { color: '#FFFFFF33' },
            }}
          >
            Set Start
          </MenuItem>
          <MenuItem
            disabled={contextMenu?.cursorTime <= localStart}
            onClick={() => {
              handleEndChange(parseFloat(contextMenu.cursorTime.toFixed(2)))
              setContextMenu(null)
            }}
            sx={{
              fontSize: 13,
              color: 'white',
              '&:hover': { bgcolor: '#FFFFFF14' },
              '&.Mui-disabled': { color: '#FFFFFF33' },
            }}
          >
            Set End
          </MenuItem>
          <MenuItem
            onClick={() => {
              handleReset()
              setContextMenu(null)
            }}
            sx={{ fontSize: 13, color: '#FFFFFF99', '&:hover': { bgcolor: '#FFFFFF14', color: 'white' } }}
          >
            Reset
          </MenuItem>
        </Menu>
      </>
    )
  },
)

export default WaveformCropper
