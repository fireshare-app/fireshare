import React, { useEffect, useRef, useState } from 'react'
import { Box, Button, Chip, Typography } from '@mui/material'
import { VideoService } from '../../services'
import TonemapCompareModal, { TONEMAP_LABELS } from './TonemapCompareModal'

const btnSx = {
  fontSize: 12,
  textTransform: 'none',
  color: '#fff',
  borderColor: '#FFFFFF44',
  px: 2.25,
  py: 0.75,
  minHeight: 34,
  '&:hover': { borderColor: '#FFFFFF99', bgcolor: '#FFFFFF11' },
  '&.Mui-disabled': { color: '#FFFFFF55', borderColor: '#FFFFFF1A' },
}

const dangerBtnSx = {
  ...btnSx,
  color: '#F5A37C',
  borderColor: '#F0824A66',
  '&:hover': { borderColor: '#F0824A', bgcolor: '#F0824A1F' },
}

const label = (operator) => TONEMAP_LABELS[operator] || operator

/**
 * The Dynamic Range controls for an HDR video: what it plays as, the operator to
 * convert it with, the compare modal, and removal. Shared by the video modal's edit
 * sidebar and the Edit Video dialog.
 *
 * Changes apply immediately (the copy is built in the background), like the password
 * field. While a copy is being built the component polls the video's details and
 * hands the parent the new info through onInfoChange; onConverted fires when the
 * player should reload.
 */
const TonemapControls = ({ videoId, videoInfo, onInfoChange, onConverted, alertHandler, getCurrentTime }) => {
  const [caps, setCaps] = useState(null)
  const [staged, setStaged] = useState('')
  const [compareOpen, setCompareOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const pollRef = useRef(null)

  const info = videoInfo || {}
  const converting = Boolean(info.tonemap) && !info.has_sdr && !info.sdr_error
  const ops = caps?.operators || []
  const value = staged || info.tonemap || caps?.auto_default || ''
  const selectedOp = ops.find((o) => o.id === value)
  const canApply =
    Boolean(value) && Boolean(selectedOp?.available) && !converting && (value !== info.tonemap || !info.has_sdr)

  useEffect(() => {
    VideoService.getTonemapCapabilities()
      .then((res) => setCaps(res.data))
      .catch(() => setCaps({ operators: [], auto_default: null }))
  }, [])

  useEffect(() => {
    setStaged('')
    setConfirmRemove(false)
  }, [videoId])

  useEffect(() => {
    clearInterval(pollRef.current)
    if (!converting) return undefined
    pollRef.current = setInterval(async () => {
      try {
        const res = await VideoService.getDetails(videoId)
        const next = res.data?.info
        if (!next) return
        if (next.has_sdr || next.sdr_error || !next.tonemap) {
          clearInterval(pollRef.current)
          onInfoChange?.(next)
          onConverted?.()
          if (next.sdr_error)
            alertHandler?.({ open: true, type: 'error', message: `SDR copy failed: ${next.sdr_error}` })
        }
      } catch {
        // transient poll errors are retried on the next tick
      }
    }, 3000)
    return () => clearInterval(pollRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, converting])

  const apply = async (operator) => {
    try {
      await VideoService.setTonemap(videoId, operator)
      setCompareOpen(false)
      setStaged('')
      onInfoChange?.({ tonemap: operator, has_sdr: false, sdr_error: null })
      alertHandler?.({
        open: true,
        type: 'info',
        message: `Converting to SDR with ${label(operator)}. The player switches over when it is ready.`,
      })
    } catch (err) {
      alertHandler?.({
        open: true,
        type: 'error',
        message: err.response?.data?.message || 'Failed to apply the tone map',
      })
    }
  }

  const remove = async () => {
    setConfirmRemove(false)
    try {
      await VideoService.setTonemap(videoId, null)
      setCompareOpen(false)
      setStaged('')
      onInfoChange?.({ tonemap: null, has_sdr: false, sdr_error: null })
      onConverted?.()
      alertHandler?.({ open: true, type: 'info', message: 'Tone map removed. The source is the HDR original again.' })
    } catch (err) {
      alertHandler?.({
        open: true,
        type: 'error',
        message: err.response?.data?.message || 'Failed to remove the tone map',
      })
    }
  }

  const status = converting
    ? { text: `Converting to SDR with ${label(info.tonemap)}…`, color: '#4AA3FF' }
    : info.sdr_error
      ? { text: `SDR copy failed: ${info.sdr_error}`, color: '#FF6B6B' }
      : info.has_sdr
        ? { text: `Plays as SDR · ${label(info.tonemap)}`, color: '#4CC08A' }
        : { text: 'Plays the HDR original, which looks washed out on most displays', color: '#FFFFFF99' }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        p: 2,
        borderRadius: '10px',
        bgcolor: '#FFFFFF08',
        border: '1px solid #FFFFFF14',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'wrap' }}>
        <Chip
          label="HDR"
          size="small"
          sx={{
            height: 20,
            fontSize: 10.5,
            fontWeight: 600,
            color: '#F0824A',
            border: '1px solid #F0824A',
            bgcolor: 'transparent',
            '& .MuiChip-label': { px: 0.9 },
          }}
        />
        <Typography sx={{ fontSize: 13, color: status.color, lineHeight: 1.4 }}>{status.text}</Typography>
      </Box>

      <select
        value={value}
        disabled={converting || ops.length === 0}
        onChange={(e) => setStaged(e.target.value)}
        aria-label="Tone map operator"
        style={{
          width: '100%',
          background: '#FFFFFF0D',
          color: 'white',
          border: '1px solid #FFFFFF26',
          borderRadius: 8,
          padding: '9px 10px',
          fontSize: 14,
        }}
      >
        {ops.length === 0 && <option value="">{caps ? 'No tone map filters in this ffmpeg' : 'Loading…'}</option>}
        {ops.map((o) => (
          <option key={o.id} value={o.id} disabled={!o.available}>
            {label(o.id)}
            {o.id === caps?.auto_default ? ' (default)' : ''}
            {o.available ? '' : ' – unavailable'}
          </option>
        ))}
      </select>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Button size="small" variant="outlined" disabled={!canApply} onClick={() => apply(value)} sx={btnSx}>
          Apply
        </Button>
        <Button
          size="small"
          variant="outlined"
          disabled={converting || ops.length === 0}
          onClick={() => setCompareOpen(true)}
          sx={btnSx}
        >
          Compare…
        </Button>
        {info.tonemap && !converting && !confirmRemove && (
          <Button
            size="small"
            variant="text"
            onClick={() => setConfirmRemove(true)}
            sx={{ ml: 'auto', fontSize: 12, textTransform: 'none', color: '#F5A37C', px: 1 }}
          >
            Remove tone map
          </Button>
        )}
      </Box>

      {confirmRemove && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            flexWrap: 'wrap',
            p: 1.5,
            borderRadius: '8px',
            bgcolor: '#F0824A14',
            border: '1px solid #F0824A44',
          }}
        >
          <Typography sx={{ fontSize: 12.5, flex: 1, minWidth: 160, lineHeight: 1.4 }}>
            Delete the SDR copy and play the HDR original again?
          </Typography>
          <Button size="small" variant="outlined" onClick={() => setConfirmRemove(false)} sx={btnSx}>
            Keep
          </Button>
          <Button size="small" variant="outlined" onClick={remove} sx={dangerBtnSx}>
            Remove
          </Button>
        </Box>
      )}

      <TonemapCompareModal
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
        videoId={videoId}
        videoInfo={info}
        capabilities={caps}
        getCurrentTime={getCurrentTime}
        onApply={apply}
        onRemove={remove}
        busy={converting}
      />
    </Box>
  )
}

export default TonemapControls
