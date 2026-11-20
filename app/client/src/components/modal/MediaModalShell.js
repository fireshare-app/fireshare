import React from 'react'
import { Box, Divider, IconButton, Modal, Paper, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { motion } from 'framer-motion'
import UploaderMention from '../user/UploaderMention'

// The detail modal that videos and images share: the media on a dark stage at
// its own aspect ratio, and a side panel of the same width beside it (below it
// on a phone). VideoModal and ImageModal fill in the stage and the panel.

const APP_ORIGIN = window.location.origin

export const labelSx = {
  fontSize: 11,
  color: '#FFFFFFB3',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  mb: 0.75,
}

export const inputSx = {
  '& .MuiOutlinedInput-root': {
    color: 'white',
    bgcolor: '#FFFFFF0D',
    borderRadius: '8px',
    '& fieldset': { borderColor: '#FFFFFF26' },
    '&:hover fieldset': { borderColor: '#FFFFFF55' },
    '&.Mui-focused fieldset': { borderColor: '#3399FF' },
  },
  '& .MuiInputBase-input.Mui-disabled': {
    WebkitTextFillColor: 'rgba(255, 255, 255, 0.85)',
  },
}

export const rowBoxSx = {
  display: 'flex',
  alignItems: 'center',
  gap: 1,
  bgcolor: '#FFFFFF0D',
  border: '1px solid #FFFFFF26',
  borderRadius: '8px',
  px: 1.5,
  py: 1,
}

export const actionBtnSx = {
  color: '#FFFFFFB3',
  bgcolor: '#FFFFFF0D',
  border: '1px solid #FFFFFF1A',
  borderRadius: '8px',
  p: 1,
  '&:hover': { bgcolor: '#FFFFFF1A', color: 'white' },
}

// The Edit / Save button at the right end of the panel's action row.
export const panelButtonSx = {
  ml: 'auto',
  fontSize: 12,
  fontWeight: 400,
  color: '#FFFFFF',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  borderColor: '#FFFFFF44',
  borderRadius: '8px',
  '&:hover': { borderColor: '#FFFFFF99', bgcolor: '#FFFFFF11' },
}

export const SIDEBAR_WIDTH = 'clamp(280px, 24vw, 420px)'

// Viewport inset around the modal on the side-by-side layout.
const MODAL_PAD = 96
// Short viewports (a phone held in landscape) can't spare 96px per side — the
// media ends up a sliver — so they get a much smaller inset.
const MODAL_PAD_SHORT = 24
const SHORT_MD = '@media (min-width: 900px) and (max-height: 620px)'
// Narrow *and* short: too little height to stack the media above the info
// panel, so lay them out side by side like the desktop layout.
const NARROW_SHORT = '@media (max-width: 899.95px) and (max-height: 620px)'
// Cap for the stacked layout so the info panel — and with it the close button
// and the actions — always stays on screen for portrait media.
const STACKED_MEDIA_MAX_H = '60dvh'

/**
 * Stage dimensions for the side-by-side layout: the largest box with the media's
 * aspect ratio that fits the viewport minus the inset and the sidebar.
 */
const sideBySideBox = (ar, pad) => {
  const h = `min(calc((100vw - ${2 * pad}px - ${SIDEBAR_WIDTH}) / ${ar}), calc(100dvh - ${2 * pad}px))`
  return { h, w: `calc((${h}) * ${ar})` }
}

export const aspectRatioOf = (info) => Number(((info?.width || 16) / (info?.height || 9)).toFixed(6))

const MediaModalShell = ({ open, onClose, aspectRatio, stage, stageSx, panel, below, editMode = false }) => {
  const animatedRef = React.useRef(null)
  const box = sideBySideBox(aspectRatio, MODAL_PAD)
  const boxShort = sideBySideBox(aspectRatio, MODAL_PAD_SHORT)

  return (
    <Modal
      open={open}
      onClose={onClose}
      disableAutoFocus={true}
      slotProps={{ backdrop: { sx: { backgroundColor: 'rgba(0, 0, 0, 0.7)' } } }}
    >
      {/* Centering wrapper. A click anywhere outside the modal closes it. The
          animated row around the modal spans the full width, so a click beside a
          narrow (portrait) modal lands on it rather than on the wrapper; both count. */}
      <Box
        tabIndex={-1}
        sx={{
          outline: 'none',
          display: 'flex',
          height: '100%',
          alignItems: { xs: 'flex-start', md: 'center' },
          justifyContent: 'center',
          p: { xs: 0, md: `${MODAL_PAD}px` },
          [SHORT_MD]: { p: `${MODAL_PAD_SHORT}px` },
          overflowY: { xs: 'hidden', md: 'unset' },
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget || e.target === animatedRef.current) onClose()
        }}
      >
        <motion.div
          ref={animatedRef}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          style={{ display: 'flex', justifyContent: 'center', width: '100%', maxWidth: '100%' }}
        >
          <Paper
            sx={{
              borderRadius: { xs: 0, md: '8px' },
              overflow: 'hidden',
              boxShadow: '0 25px 60px rgba(0, 0, 0, 0.8)',
              bgcolor: '#020D1A',
              display: 'flex',
              flexDirection: 'column',
              width: { xs: '100%', md: `calc(${box.w} + ${SIDEBAR_WIDTH})` },
              [SHORT_MD]: { width: `calc(${boxShort.w} + ${SIDEBAR_WIDTH})` },
              height: { xs: '100dvh', md: 'auto' },
              maxHeight: { xs: '100dvh', md: '100%' },
              maxWidth: '100%',
            }}
          >
            <Box
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', md: 'row' },
                height: { xs: '100%', md: box.h },
                [SHORT_MD]: { height: boxShort.h },
                [NARROW_SHORT]: { flexDirection: 'row' },
                overflow: 'hidden',
              }}
            >
              {/* Stage */}
              <Box
                sx={{
                  position: 'relative',
                  flexShrink: 0,
                  bgcolor: '#020D1A',
                  // Stacked: full width at the media's aspect ratio, capped in height
                  // so the panel below it always stays on screen.
                  width: { xs: '100%', md: box.w },
                  height: { xs: `min(calc(100vw / ${aspectRatio}), ${STACKED_MEDIA_MAX_H})`, md: '100%' },
                  [SHORT_MD]: { width: boxShort.w },
                  // Fill whatever is left beside the sidebar; the media letterboxes itself.
                  [NARROW_SHORT]: { flex: 1, minWidth: 0, width: 'auto', height: '100%' },
                  ...stageSx,
                }}
              >
                {stage}
              </Box>

              {/* Panel */}
              <Box
                sx={{
                  width: { xs: '100%', md: SIDEBAR_WIDTH },
                  flex: { xs: 1, md: 'none' },
                  flexShrink: 0,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  bgcolor: '#041223',
                  borderLeft: { md: '1px solid #FFFFFF14' },
                  borderTop: { xs: '1px solid #FFFFFF14', md: 'none' },
                  [NARROW_SHORT]: {
                    width: SIDEBAR_WIDTH,
                    flex: 'none',
                    borderLeft: '1px solid #FFFFFF14',
                    borderTop: 'none',
                  },
                  overflow: 'hidden',
                }}
              >
                {panel}
              </Box>
            </Box>
            {below}
          </Paper>
        </motion.div>
      </Box>
    </Modal>
  )
}

// The panel's contents: a header with its label and the close button, the
// scrolling body, and the row of actions pinned to the bottom.
export const MediaPanel = ({ label, onClose, children, actions }) => (
  <>
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        px: 2.5,
        pt: 2,
        pb: 1.75,
        flexShrink: 0,
      }}
    >
      <Typography
        sx={{
          fontWeight: 700,
          fontSize: 12,
          color: '#FFFFFF66',
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
        }}
      >
        {label}
      </Typography>
      <IconButton
        onClick={onClose}
        size="small"
        aria-label="Close"
        sx={{
          color: '#FFFFFF80',
          bgcolor: '#FFFFFF14',
          borderRadius: '8px',
          '&:hover': { bgcolor: '#FFFFFF2A', color: 'white' },
          width: 30,
          height: 30,
        }}
      >
        <CloseIcon sx={{ fontSize: 17 }} />
      </IconButton>
    </Box>

    <Divider sx={{ borderColor: '#FFFFFF14', flexShrink: 0 }} />

    <Box
      sx={{
        flex: 1,
        overflowY: 'auto',
        px: 2.5,
        pt: 2,
        pb: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        '&::-webkit-scrollbar': { width: 4 },
        '&::-webkit-scrollbar-track': { bgcolor: 'transparent' },
        '&::-webkit-scrollbar-thumb': { bgcolor: '#FFFFFF26', borderRadius: 2 },
      }}
    >
      {children}
    </Box>

    <Divider sx={{ borderColor: '#FFFFFF14', flexShrink: 0 }} />

    <Box sx={{ px: 2.5, py: 2, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      {actions}
    </Box>
  </>
)

export const MediaTitle = ({ children }) => (
  <Typography
    component="h2"
    sx={{
      m: 0,
      fontWeight: 900,
      fontSize: 21,
      color: 'white',
      lineHeight: 1.3,
      letterSpacing: '-0.03em',
      overflowX: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }}
  >
    {children || 'Untitled'}
  </Typography>
)

// "12 views | Nov 16, 2026 | @uploader"
export const MediaMetaRow = ({ viewCount, date, uploader }) => {
  const separator = <Typography sx={{ fontSize: 14, color: '#FFFFFF55' }}>|</Typography>
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
      <Typography sx={{ fontSize: 14, color: '#FFFFFF55', flexShrink: 0 }}>
        {(viewCount ?? 0).toLocaleString()} {viewCount === 1 ? 'view' : 'views'}
      </Typography>
      {date && (
        <>
          {separator}
          <Typography sx={{ fontSize: 14, color: '#FFFFFF55' }}>
            {new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </Typography>
        </>
      )}
      {uploader && (
        <>
          {separator}
          <UploaderMention uploader={uploader} size={20} />
        </>
      )}
    </Box>
  )
}

// The most saturated colour in a game's icon, for tinting its pill.
const useIconColor = (iconUrl) => {
  const [color, setColor] = React.useState(null)
  React.useEffect(() => {
    if (!iconUrl) {
      setColor(null)
      return
    }
    let cancelled = false
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (cancelled) return
      const SIZE = 64
      const canvas = document.createElement('canvas')
      canvas.width = SIZE
      canvas.height = SIZE
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, SIZE, SIZE)
      const { data } = ctx.getImageData(0, 0, SIZE, SIZE)
      let bestColor = null
      let bestSaturation = -1
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue
        const r = data[i] / 255
        const g = data[i + 1] / 255
        const b = data[i + 2] / 255
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        const lightness = (max + min) / 2
        // Skip near-black and near-white pixels
        if (lightness < 0.15 || lightness > 0.92) continue
        const chroma = max - min
        const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1))
        if (saturation > bestSaturation) {
          bestSaturation = saturation
          bestColor = [data[i], data[i + 1], data[i + 2]]
        }
      }
      setColor(bestSaturation > 0.2 ? bestColor : null)
    }
    img.onerror = () => !cancelled && setColor(null)
    img.src = iconUrl
    return () => {
      cancelled = true
    }
  }, [iconUrl])
  return color
}

// The linked game as a pill, tinted with its icon's colour, linking to its page.
export const GamePill = ({ game }) => {
  const color = useIconColor(game?.icon_url)
  if (!game) return null
  const linked = Boolean(game.steamgriddb_id)
  return (
    <Box
      component={linked ? 'a' : 'div'}
      href={linked ? `${APP_ORIGIN}/games/${game.steamgriddb_id}` : undefined}
      onClick={linked ? (e) => e.stopPropagation() : undefined}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        minWidth: 0,
        bgcolor: color ? `rgba(${color.join(',')}, 0.15)` : '#FFFFFF14',
        border: `1px solid ${color ? `rgba(${color.join(',')}, 0.5)` : '#FFFFFF26'}`,
        borderRadius: '8px',
        px: 1,
        py: 0.35,
        textDecoration: 'none',
        flexShrink: 0,
        ...(linked && {
          cursor: 'pointer',
          '&:hover': { bgcolor: color ? `rgba(${color.join(',')}, 0.4)` : '#FFFFFF22' },
        }),
      }}
    >
      {game.icon_url && (
        <img
          src={game.icon_url}
          alt=""
          onError={(e) => {
            e.currentTarget.style.display = 'none'
          }}
          style={{ width: 20, height: 20, objectFit: 'contain', borderRadius: 3, flexShrink: 0 }}
        />
      )}
      <Typography
        sx={{ fontSize: 14, color: '#FFFFFF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {game.name}
      </Typography>
    </Box>
  )
}

export default MediaModalShell
