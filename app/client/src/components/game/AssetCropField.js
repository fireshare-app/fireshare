import React from 'react'
import Cropper from 'react-easy-crop'
import { Box, Button, Slider, Typography } from '@mui/material'
import UploadFileIcon from '@mui/icons-material/UploadFile'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'

// Mirrors ASSET_SPECS in app/server/fireshare/api/custom_games.py. The server does
// the cropping and scaling; the sizes here only drive the crop frame's shape and
// the guidance text.
export const ASSET_SPECS = {
  hero: {
    label: 'Hero',
    width: 1920,
    height: 620,
    aspect: 1920 / 620,
    required: true,
    hint: 'Wide artwork for the game card and page background.',
  },
  banner: {
    label: 'Banner',
    width: 1920,
    height: 620,
    aspect: 1920 / 620,
    required: false,
    hint: 'Optional artwork behind the game page header. Uses the hero when left empty.',
  },
  logo: {
    label: 'Logo',
    width: 1280,
    height: 720,
    aspect: null,
    required: true,
    hint: 'The game logo on a transparent background, any shape. Transparent edges are trimmed.',
  },
  icon: {
    label: 'Icon',
    width: 512,
    height: 512,
    aspect: 1,
    required: true,
    hint: 'Square icon shown beside tagged videos and images.',
  },
}

export const ASSET_ORDER = ['hero', 'banner', 'logo', 'icon']

const ACCEPT = 'image/png,image/jpeg,image/webp'
const MAX_UPLOAD_MB = 20
const FRAME_HEIGHT = { hero: 230, banner: 230, logo: 230, icon: 220 }

const readImageSize = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('That file could not be read as an image.'))
    img.src = url
  })

// Logos and icons are drawn over other artwork, so their previews sit on a
// checkerboard that makes transparency visible.
const checkerboardSx = {
  backgroundColor: '#13213a',
  backgroundImage:
    'linear-gradient(45deg, #FFFFFF14 25%, transparent 25%), linear-gradient(-45deg, #FFFFFF14 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #FFFFFF14 75%), linear-gradient(-45deg, transparent 75%, #FFFFFF14 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
}

const noteSx = { display: 'flex', alignItems: 'center', gap: 0.75, fontSize: 12, color: '#FFFFFF99' }

const sizeNote = (type, width, height) => {
  const spec = ASSET_SPECS[type]
  const dims = `${width} × ${height}`
  if (spec.aspect) {
    if (width < spec.width || height < spec.height) {
      return {
        severity: 'warning',
        text: `${dims} is smaller than the recommended ${spec.width} × ${spec.height}. It will be scaled up and may look soft.`,
      }
    }
    if (width === spec.width && height === spec.height) {
      return { severity: 'ok', text: `${dims} matches the recommended size.` }
    }
    return {
      severity: 'info',
      text: `${dims}. Drag to reposition and use the slider to zoom; the frame is saved at ${spec.width} × ${spec.height}, so zooming in far will look soft.`,
    }
  }
  if (width > spec.width || height > spec.height) {
    return {
      severity: 'info',
      text: `${dims} will be scaled to fit within ${spec.width} × ${spec.height}. Zoom in to trim the edges.`,
    }
  }
  return { severity: 'info', text: `${dims}. Zoom in to trim the edges.` }
}

const NoteIcon = ({ severity }) => {
  if (severity === 'warning') return <WarningAmberIcon sx={{ fontSize: 15, color: '#FFB74D' }} />
  if (severity === 'ok') return <CheckCircleOutlineIcon sx={{ fontSize: 15, color: '#66BB6A' }} />
  return <InfoOutlinedIcon sx={{ fontSize: 15, color: '#FFFFFF66' }} />
}

const actionButtonSx = {
  color: 'white',
  borderColor: '#FFFFFF44',
  textTransform: 'none',
  // The theme pulls every small button 8px left so text buttons sit flush with
  // their content; side by side in a row that would swallow the gap between them.
  ml: 0,
  '&:hover': { borderColor: 'white', bgcolor: '#FFFFFF12' },
}

/**
 * One artwork slot in the custom game form.
 *
 * Pick a file, then pan and zoom it inside a frame of the slot's recommended
 * shape. `value` is null or { file, url, width, height, area }, where `area` is
 * the crop rectangle in source pixels that the server applies. `currentUrl`
 * shows the asset a game already has when editing it.
 */
const AssetCropField = ({ type, value, onChange, currentUrl, disabled = false }) => {
  const spec = ASSET_SPECS[type]
  const inputRef = React.useRef(null)
  const valueRef = React.useRef(value)
  valueRef.current = value
  const [crop, setCrop] = React.useState({ x: 0, y: 0 })
  const [zoom, setZoom] = React.useState(1)
  const [error, setError] = React.useState(null)

  // Object URLs are only released explicitly, so drop the previous one whenever
  // the file changes and when the field goes away.
  const url = value?.url
  React.useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url)
    },
    [url],
  )

  const handleFile = async (file) => {
    if (!file) return
    setError(null)
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setError('Use a PNG, JPEG or WebP image.')
      return
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setError(`Images must be smaller than ${MAX_UPLOAD_MB}MB.`)
      return
    }
    const nextUrl = URL.createObjectURL(file)
    try {
      const { width, height } = await readImageSize(nextUrl)
      setCrop({ x: 0, y: 0 })
      setZoom(1)
      onChange({ file, url: nextUrl, width, height, area: null })
    } catch (err) {
      URL.revokeObjectURL(nextUrl)
      setError(err.message)
    }
  }

  const openPicker = () => {
    if (!disabled) inputRef.current?.click()
  }

  const handleRemove = () => {
    setError(null)
    onChange(null)
  }

  const note = value ? sizeNote(type, value.width, value.height) : null
  const frameHeight = FRAME_HEIGHT[type]
  const transparent = type === 'logo' || type === 'icon'

  return (
    <Box>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          handleFile(e.target.files?.[0])
          e.target.value = '' // allow picking the same file again
        }}
      />

      <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 2, mb: 0.75 }}>
        <Typography sx={{ fontSize: 13, fontWeight: 700, color: 'white', letterSpacing: '0.04em' }}>
          {spec.label}
          {spec.required ? (
            <Box component="span" sx={{ color: '#3399FF', ml: 0.5 }}>
              *
            </Box>
          ) : (
            <Box component="span" sx={{ color: '#FFFFFF66', fontWeight: 400, ml: 1 }}>
              optional
            </Box>
          )}
        </Typography>
        <Typography sx={{ fontSize: 12, color: '#FFFFFF80', whiteSpace: 'nowrap' }}>
          {spec.aspect ? 'Recommended ' : 'Up to '}
          {spec.width} × {spec.height}
        </Typography>
      </Box>
      <Typography sx={{ fontSize: 12, color: '#FFFFFF80', mb: 1.25 }}>{spec.hint}</Typography>

      {value ? (
        <Box>
          <Box
            sx={{
              position: 'relative',
              width: '100%',
              height: frameHeight,
              borderRadius: '8px',
              overflow: 'hidden',
              border: '1px solid #FFFFFF26',
              ...(transparent ? checkerboardSx : { bgcolor: '#000000' }),
            }}
          >
            <Cropper
              image={value.url}
              crop={crop}
              zoom={zoom}
              // A fixed-shape slot starts with the image covering the frame,
              // centred, which is the "just centre it" default. A logo keeps its
              // own shape, so it starts fully in frame and is only ever trimmed.
              aspect={spec.aspect || value.width / value.height}
              objectFit={spec.aspect ? 'cover' : 'contain'}
              minZoom={1}
              maxZoom={4}
              // The wheel scrolls the dialog, not the image: a form this long is
              // scrolled through, and zoom has the slider (and pinch on touch).
              zoomWithScroll={false}
              showGrid={false}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={(_, areaPixels) => onChange({ ...valueRef.current, area: areaPixels })}
              style={{ cropAreaStyle: { border: '2px solid #3399FF', boxShadow: '0 0 0 9999px rgba(4, 18, 35, 0.7)' } }}
            />
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 1, flexWrap: 'wrap' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flex: 1, minWidth: 180 }}>
              <Typography sx={{ fontSize: 12, color: '#FFFFFF80' }}>Zoom</Typography>
              <Slider
                size="small"
                min={1}
                max={4}
                step={0.01}
                value={zoom}
                onChange={(_, v) => setZoom(v)}
                disabled={disabled}
                sx={{ color: '#3399FF', maxWidth: 240 }}
              />
            </Box>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button size="small" variant="outlined" onClick={openPicker} disabled={disabled} sx={actionButtonSx}>
                Replace
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<DeleteOutlineIcon />}
                onClick={handleRemove}
                disabled={disabled}
                sx={actionButtonSx}
              >
                Remove
              </Button>
            </Box>
          </Box>
          {note ? (
            <Box sx={{ ...noteSx, mt: 0.75, color: note.severity === 'warning' ? '#FFB74D' : '#FFFFFF99' }}>
              <NoteIcon severity={note.severity} />
              <span>{note.text}</span>
            </Box>
          ) : null}
        </Box>
      ) : currentUrl ? (
        <Box>
          <Box
            sx={{
              position: 'relative',
              width: '100%',
              height: 150,
              borderRadius: '8px',
              overflow: 'hidden',
              border: '1px solid #FFFFFF26',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              ...(transparent ? checkerboardSx : { bgcolor: '#000000' }),
            }}
          >
            <Box
              component="img"
              src={currentUrl}
              alt=""
              sx={{
                width: '100%',
                height: '100%',
                objectFit: transparent ? 'contain' : 'cover',
                p: transparent ? 1.5 : 0,
              }}
            />
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 1, gap: 2 }}>
            <Typography sx={{ fontSize: 12, color: '#FFFFFF80' }}>Current image</Typography>
            <Button
              size="small"
              variant="outlined"
              startIcon={<UploadFileIcon />}
              onClick={openPicker}
              disabled={disabled}
              sx={actionButtonSx}
            >
              Replace
            </Button>
          </Box>
        </Box>
      ) : (
        <Box
          onClick={openPicker}
          sx={{
            height: 110,
            borderRadius: '8px',
            border: '1px dashed #FFFFFF40',
            bgcolor: '#FFFFFF08',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 0.75,
            cursor: disabled ? 'default' : 'pointer',
            transition: 'border-color 0.15s ease, background-color 0.15s ease',
            '&:hover': disabled ? {} : { borderColor: '#3399FF', bgcolor: '#3399FF14' },
          }}
        >
          <UploadFileIcon sx={{ color: '#FFFFFF80' }} />
          <Typography sx={{ fontSize: 13, color: 'white', fontWeight: 600 }}>Choose image</Typography>
          <Typography sx={{ fontSize: 12, color: '#FFFFFF66' }}>PNG, JPEG or WebP, up to {MAX_UPLOAD_MB}MB</Typography>
        </Box>
      )}

      {error ? (
        <Box sx={{ ...noteSx, mt: 0.75, color: '#EF5350' }}>
          <WarningAmberIcon sx={{ fontSize: 15 }} />
          <span>{error}</span>
        </Box>
      ) : null}
    </Box>
  )
}

export default AssetCropField
