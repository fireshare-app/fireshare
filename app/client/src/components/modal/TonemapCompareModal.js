import React, { useEffect, useState } from 'react'
import { Box, Button, CircularProgress, IconButton, Modal, Paper, Tooltip, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import ZoomInIcon from '@mui/icons-material/ZoomIn'
import { getUrl } from '../../common/utils'
import { VideoService } from '../../services'

export const TONEMAP_LABELS = {
  bt2390: 'bt.2390',
  hable: 'hable',
  mobius: 'mobius',
  reinhard: 'reinhard',
}

const AS_STORED = { id: 'as_stored', available: true, note: 'reference, no tone map' }

const formatTime = (seconds) => {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s < 10 ? '0' : ''}${s}`
}

export const previewUrl = (videoId, seconds, operator, zoom = false) =>
  `${getUrl()}/api/video/${videoId}/tonemap/preview?t=${seconds}&op=${operator}${zoom ? '&zoom=1' : ''}`

/**
 * One rendered frame. The server renders it on the first request, which takes a few
 * seconds for a big file, so the tile shows a spinner until the image arrives.
 */
const Tile = ({ videoId, seconds, operator, onZoom }) => {
  const [state, setState] = useState('loading')
  useEffect(() => setState('loading'), [videoId, seconds, operator])
  return (
    <Box
      component="button"
      type="button"
      onClick={() => state === 'ready' && onZoom(seconds, operator)}
      aria-label={`${TONEMAP_LABELS[operator] || 'as stored'} at ${formatTime(seconds)}, zoom`}
      sx={{
        position: 'relative',
        display: 'block',
        width: '100%',
        aspectRatio: '16 / 9',
        p: 0,
        border: '1px solid #FFFFFF1A',
        borderRadius: '8px',
        overflow: 'hidden',
        bgcolor: '#000',
        cursor: state === 'ready' ? 'zoom-in' : 'default',
        '&:hover .zoom-hint': { opacity: 1 },
      }}
    >
      <img
        src={previewUrl(videoId, seconds, operator)}
        alt=""
        onLoad={() => setState('ready')}
        onError={() => setState('error')}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: state === 'ready' ? 'block' : 'none' }}
      />
      {state === 'loading' && (
        <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <CircularProgress size={22} sx={{ color: '#FFFFFF66' }} />
        </Box>
      )}
      {state === 'error' && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            px: 1,
          }}
        >
          <Typography sx={{ fontSize: 11, color: '#FF6B6B', textAlign: 'center' }}>Could not render</Typography>
        </Box>
      )}
      {state === 'ready' && (
        <ZoomInIcon
          className="zoom-hint"
          sx={{
            position: 'absolute',
            right: 6,
            bottom: 6,
            fontSize: 18,
            color: '#fff',
            opacity: 0,
            transition: 'opacity 0.15s',
          }}
        />
      )}
    </Box>
  )
}

/**
 * Compare the tone map operators on real frames of the video before choosing one.
 *
 * Columns are the operators the server can run (plus the frame as stored), rows are a
 * few random timestamps. Any tile zooms to a native-pixel crop beside the as-stored
 * version. Applying hands the choice to the parent, which saves it and shows progress.
 */
const TonemapCompareModal = ({
  open,
  onClose,
  videoId,
  videoInfo,
  capabilities,
  getCurrentTime,
  onApply,
  onRemove,
  busy = false,
}) => {
  const [frames, setFrames] = useState([])
  const [framesLoading, setFramesLoading] = useState(false)
  const [framesError, setFramesError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [zoom, setZoom] = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const current = videoInfo?.has_sdr ? videoInfo.tonemap : null
  const operators = [AS_STORED, ...(capabilities?.operators || [])]

  const loadFrames = async () => {
    setFramesLoading(true)
    setFramesError(null)
    try {
      const res = await VideoService.getTonemapFrames(videoId, 3)
      setFrames(res.data.frames || [])
    } catch (err) {
      setFramesError(err.response?.data?.message || 'Could not pick frames from this video')
    }
    setFramesLoading(false)
  }

  useEffect(() => {
    if (!open) return
    setSelected(null)
    setZoom(null)
    setConfirmRemove(false)
    loadFrames()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, videoId])

  const addCurrentTime = () => {
    const t = Math.round((getCurrentTime?.() ?? 0) * 10) / 10
    if (!frames.includes(t)) setFrames((prev) => [...prev, t].sort((a, b) => a - b))
  }

  const canApply = selected && !busy && (selected !== current || !videoInfo?.has_sdr)
  const columns = `repeat(${operators.length}, minmax(0, 1fr))`

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}
    >
      <Paper
        sx={{
          position: 'relative',
          width: 'min(1400px, 100%)',
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: '#061322',
          color: '#fff',
          border: '1px solid #FFFFFF1F',
          borderRadius: '14px',
          overflow: 'hidden',
          outline: 'none',
        }}
      >
        {/* Header */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            px: 2.5,
            py: 1.5,
            borderBottom: '1px solid #FFFFFF1F',
            flexWrap: 'wrap',
          }}
        >
          <Box sx={{ flex: 1, minWidth: 200 }}>
            <Typography sx={{ fontWeight: 700, fontSize: 17 }}>Compare tone mapping</Typography>
            <Typography sx={{ fontSize: 12, color: '#FFFFFFA6', fontFamily: 'monospace' }}>
              {videoInfo?.title} · HDR · {videoInfo?.width}x{videoInfo?.height}
            </Typography>
          </Box>
          <Button size="small" variant="outlined" onClick={loadFrames} disabled={framesLoading || busy} sx={ghostBtnSx}>
            Reshuffle frames
          </Button>
          {getCurrentTime && (
            <Button size="small" variant="outlined" onClick={addCurrentTime} disabled={busy} sx={ghostBtnSx}>
              Add current time
            </Button>
          )}
          <IconButton size="small" onClick={onClose} disabled={busy} sx={{ color: '#FFFFFFB3' }} aria-label="Close">
            <CloseIcon />
          </IconButton>
        </Box>

        {/* Body */}
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 2.5 }}>
          <Box
            sx={{ display: 'grid', gridTemplateColumns: columns, gap: 1, mb: 1 }}
            role="radiogroup"
            aria-label="Tone map operator"
          >
            {operators.map((op) => {
              const isRef = op.id === 'as_stored'
              const checked = selected === op.id
              return (
                <Tooltip key={op.id} title={op.note || ''} placement="top" disableHoverListener={!op.note}>
                  <Box
                    component="button"
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    disabled={isRef || !op.available || busy}
                    onClick={() => !isRef && op.available && setSelected(op.id)}
                    sx={{
                      textAlign: 'left',
                      border: '1px solid',
                      borderColor: checked ? '#4AA3FF' : '#FFFFFF1F',
                      borderStyle: isRef ? 'dashed' : 'solid',
                      boxShadow: checked ? 'inset 0 0 0 1px #4AA3FF' : 'none',
                      borderRadius: '10px',
                      bgcolor: '#0B1B2E',
                      color: op.available ? '#fff' : '#FFFFFF55',
                      p: 1,
                      cursor: isRef || !op.available ? 'default' : 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 0.5,
                      minWidth: 0,
                      fontFamily: 'inherit',
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, fontWeight: 600, fontSize: 13 }}>
                      {!isRef && (
                        <Box
                          sx={{
                            width: 13,
                            height: 13,
                            borderRadius: '50%',
                            border: '2px solid',
                            borderColor: checked ? '#4AA3FF' : '#FFFFFF80',
                            flex: 'none',
                            background: checked ? 'radial-gradient(circle, #4AA3FF 45%, transparent 50%)' : 'none',
                          }}
                        />
                      )}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {isRef ? 'As stored' : TONEMAP_LABELS[op.id] || op.id}
                      </span>
                      {op.id === current && (
                        <Box
                          component="span"
                          sx={{
                            ml: 'auto',
                            fontSize: 10,
                            bgcolor: '#4AA3FF',
                            color: '#061322',
                            borderRadius: '4px',
                            px: 0.6,
                            fontFamily: 'monospace',
                          }}
                        >
                          current
                        </Box>
                      )}
                    </Box>
                    <Typography
                      sx={{
                        fontSize: 10.5,
                        color: '#FFFFFFA6',
                        fontFamily: 'monospace',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {isRef ? op.note : op.available ? op.note || 'available' : op.note || 'not available'}
                    </Typography>
                  </Box>
                </Tooltip>
              )
            })}
          </Box>

          {framesError && <Typography sx={{ color: '#FF6B6B', fontSize: 13, my: 2 }}>{framesError}</Typography>}
          {framesLoading && frames.length === 0 && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
              <CircularProgress size={28} sx={{ color: '#FFFFFF80' }} />
            </Box>
          )}
          {frames.map((t) => (
            <Box key={t} sx={{ mb: 1 }}>
              <Typography sx={{ fontSize: 11, color: '#FFFFFFA6', fontFamily: 'monospace', mb: 0.5 }}>
                frame {formatTime(t)}
              </Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: columns, gap: 1 }}>
                {operators.map((op) =>
                  op.available ? (
                    <Tile
                      key={op.id}
                      videoId={videoId}
                      seconds={t}
                      operator={op.id}
                      onZoom={(s, o) => setZoom({ seconds: s, operator: o })}
                    />
                  ) : (
                    <Box
                      key={op.id}
                      sx={{ aspectRatio: '16 / 9', border: '1px dashed #FFFFFF1A', borderRadius: '8px' }}
                    />
                  ),
                )}
              </Box>
            </Box>
          ))}
        </Box>

        {/* Remove confirmation */}
        {confirmRemove && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              flexWrap: 'wrap',
              px: 2.5,
              py: 1.25,
              bgcolor: '#F0824A14',
              borderTop: '1px solid #F0824A44',
            }}
          >
            <Typography sx={{ fontSize: 13, flex: 1, minWidth: 240 }}>
              Remove the tone map? This deletes the SDR copy and remakes the transcodes from the original. The HDR file
              itself is never touched.
            </Typography>
            <Button size="small" variant="outlined" onClick={() => setConfirmRemove(false)} sx={ghostBtnSx}>
              Keep it
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={() => {
                setConfirmRemove(false)
                onRemove()
              }}
              sx={dangerBtnSx}
            >
              Remove
            </Button>
          </Box>
        )}

        {/* Footer */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            flexWrap: 'wrap',
            px: 2.5,
            py: 1.5,
            borderTop: '1px solid #FFFFFF1F',
            bgcolor: '#0B1B2E',
          }}
        >
          <Typography sx={{ fontSize: 13, color: '#FFFFFFA6', flex: 1, minWidth: 200 }}>
            {busy ? (
              <>
                <CircularProgress size={12} sx={{ color: '#4AA3FF', mr: 1, verticalAlign: 'middle' }} />
                Building the SDR copy, then the transcodes…
              </>
            ) : current ? (
              <>
                Current: <b style={{ color: '#fff' }}>{TONEMAP_LABELS[current] || current}</b>
                {canApply ? ' · applying rebuilds the SDR copy and every transcode' : ' · SDR ready'}
              </>
            ) : (
              <>
                No tone map · plays the <b style={{ color: '#fff' }}>HDR original</b>
              </>
            )}
          </Typography>
          {current && !busy && (
            <Button size="small" variant="outlined" onClick={() => setConfirmRemove(true)} sx={dangerBtnSx}>
              Remove tone map
            </Button>
          )}
          <Button size="small" variant="outlined" onClick={onClose} disabled={busy} sx={ghostBtnSx}>
            Close
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={!canApply}
            onClick={() => onApply(selected)}
            sx={{ fontWeight: 600 }}
          >
            {selected ? `Apply ${TONEMAP_LABELS[selected] || selected}` : 'Apply'}
          </Button>
        </Box>

        {/* Zoom: the chosen tile beside the frame as stored, both at native pixels */}
        {zoom && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              bgcolor: '#000000E6',
              display: 'flex',
              flexDirection: 'column',
              zIndex: 5,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, px: 2, py: 1 }}>
              <Typography sx={{ fontSize: 12, color: '#FFFFFFA6', fontFamily: 'monospace' }}>
                frame {formatTime(zoom.seconds)} · centre crop at native pixels
              </Typography>
              <Button size="small" variant="outlined" onClick={() => setZoom(null)} sx={ghostBtnSx}>
                Close
              </Button>
            </Box>
            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                overflow: 'auto',
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                gap: 1,
                px: 2,
                pb: 2,
              }}
            >
              {[
                { operator: 'as_stored', label: 'as stored' },
                { operator: zoom.operator, label: TONEMAP_LABELS[zoom.operator] || zoom.operator },
              ].map(({ operator, label }) => (
                <Box key={operator} sx={{ minWidth: 0 }}>
                  <img
                    src={previewUrl(videoId, zoom.seconds, operator, true)}
                    alt={`${label} crop`}
                    style={{ width: '100%', height: 'auto', borderRadius: 6, display: 'block' }}
                  />
                  <Typography sx={{ fontSize: 11, color: '#FFFFFFA6', fontFamily: 'monospace', mt: 0.5 }}>
                    {label} · 1:1
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>
        )}
      </Paper>
    </Modal>
  )
}

const ghostBtnSx = {
  color: '#fff',
  borderColor: '#FFFFFF33',
  textTransform: 'none',
  '&:hover': { borderColor: '#FFFFFF80', bgcolor: '#FFFFFF11' },
  '&.Mui-disabled': { color: '#FFFFFF55', borderColor: '#FFFFFF1A' },
}

const dangerBtnSx = {
  color: '#F5A37C',
  borderColor: '#F0824A66',
  textTransform: 'none',
  '&:hover': { borderColor: '#F0824A', bgcolor: '#F0824A1F' },
}

export default TonemapCompareModal
