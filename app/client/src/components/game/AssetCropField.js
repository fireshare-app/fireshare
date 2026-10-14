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
    hint: 'The game logo on a transparent background, any shape. The frame starts at its visible edges; zoom out for space around it, in to trim.',
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

// .ico is listed by extension as well as type: browsers report it as either
// image/x-icon or image/vnd.microsoft.icon, and some report no type at all.
const ACCEPT = 'image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon,.ico'
const ACCEPTED_TYPES = /^image\/(png|jpeg|webp|x-icon|vnd\.microsoft\.icon)$/
const isAcceptedFile = (file) => ACCEPTED_TYPES.test(file.type) || /\.ico$/i.test(file.name)
const MAX_UPLOAD_MB = 20

// The crop frame has the slot's own shape. The image is scaled to cover it, so
// one that already has that shape is shown whole, scaled down to fit, and only
// a mismatched one is centred and cropped. A frame of some other shape would
// scale a matching image to the frame's width and crop away most of it.
const frameSx = (type, value) => {
  const spec = ASSET_SPECS[type]
  if (spec.aspect === 1) return { width: 'min(100%, 260px)', aspectRatio: '1 / 1', mx: 'auto' }
  if (spec.aspect) return { width: '100%', aspectRatio: `${spec.width} / ${spec.height}` }
  // A logo keeps the shape of its visible part; the cap stops a tall one taking
  // over the dialog.
  const box = value.box || value
  return { width: '100%', aspectRatio: `${box.width} / ${box.height}`, maxHeight: 280 }
}

const readImageSize = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('That file could not be read as an image.'))
    img.src = url
  })

// Where a logo's visible pixels are, in natural pixels. Found on a copy no
// larger than 1024px so a big PNG doesn't cost a full-size readback, then
// widened by a pixel so the edge is never clipped. A JPEG, or a PNG with
// nothing transparent, gets the whole image.
const findOpaqueBox = (url, width, height) =>
  new Promise((resolve) => {
    const whole = { x: 0, y: 0, width, height }
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, 1024 / Math.max(width, height))
        const w = Math.max(1, Math.round(width * scale))
        const h = Math.max(1, Math.round(height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0, w, h)
        const { data } = ctx.getImageData(0, 0, w, h)
        let minX = w
        let minY = h
        let maxX = -1
        let maxY = -1
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > 8) {
              if (x < minX) minX = x
              if (x > maxX) maxX = x
              if (y < minY) minY = y
              if (y > maxY) maxY = y
            }
          }
        }
        if (maxX < 0) return resolve(whole)
        const x = Math.max(0, Math.floor(minX / scale) - 1)
        const y = Math.max(0, Math.floor(minY / scale) - 1)
        resolve({
          x,
          y,
          width: Math.min(width, Math.ceil((maxX + 1) / scale) + 1) - x,
          height: Math.min(height, Math.ceil((maxY + 1) / scale) + 1) - y,
        })
      } catch {
        resolve(whole)
      }
    }
    img.onerror = () => resolve(whole)
    img.src = url
  })

// A logo's frame opens on its visible edges, which may be a long way into a
// padded canvas, so its zoom range has to reach there and back out again.
// Zoom 1 is the whole image; below that is transparent space around it.
const LOGO_MIN_ZOOM = 0.5
const zoomBounds = (type, value) => {
  if (ASSET_SPECS[type].aspect || !value?.box) return { min: 1, max: 4 }
  const startZoom = Math.min(value.width / value.box.width, value.height / value.box.height)
  return { min: LOGO_MIN_ZOOM, max: Math.max(4, startZoom * 2) }
}

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
      text: `${dims} will be scaled to fit within ${spec.width} × ${spec.height}. Zoom out to add space around the logo, in to trim it.`,
    }
  }
  return { severity: 'info', text: `${dims}. Zoom out to add space around the logo, in to trim it.` }
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
    if (!isAcceptedFile(file)) {
      setError('Use a PNG, JPEG, WebP or ICO image.')
      return
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setError(`Images must be smaller than ${MAX_UPLOAD_MB}MB.`)
      return
    }
    const nextUrl = URL.createObjectURL(file)
    try {
      const { width, height } = await readImageSize(nextUrl)
      const box = spec.aspect ? null : await findOpaqueBox(nextUrl, width, height)
      setCrop({ x: 0, y: 0 })
      setZoom(1)
      onChange({ file, url: nextUrl, width, height, box, area: null })
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
  const transparent = type === 'logo' || type === 'icon'
  const bounds = zoomBounds(type, value)
  const frameBox = value?.box || value

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
              ...frameSx(type, value),
              borderRadius: '8px',
              overflow: 'hidden',
              border: '1px solid #FFFFFF26',
              ...(transparent ? checkerboardSx : { bgcolor: '#000000' }),
            }}
          >
            <Cropper
              key={value.url}
              image={value.url}
              crop={crop}
              zoom={zoom}
              // A fixed-shape slot starts with the image covering the frame,
              // centred, which is the "just centre it" default, and the image
              // can't leave the frame. A logo's frame takes the shape of its
              // visible part and opens on it; it may then be zoomed out past
              // the image's own edges, which pads the logo with transparency.
              aspect={spec.aspect || frameBox.width / frameBox.height}
              objectFit={spec.aspect ? 'cover' : 'contain'}
              initialCroppedAreaPixels={spec.aspect ? undefined : value.box}
              restrictPosition={Boolean(spec.aspect)}
              minZoom={bounds.min}
              maxZoom={bounds.max}
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
                min={bounds.min}
                max={bounds.max}
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
          <Typography sx={{ fontSize: 12, color: '#FFFFFF66' }}>
            PNG, JPEG, WebP or ICO, up to {MAX_UPLOAD_MB}MB
          </Typography>
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
