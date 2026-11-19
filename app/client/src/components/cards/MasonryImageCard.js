import React from 'react'
import { Box, Typography, IconButton, Skeleton } from '@mui/material'
import LinkIcon from '@mui/icons-material/Link'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import CheckIcon from '@mui/icons-material/Check'
import ImageIcon from '@mui/icons-material/Image'
import { getImageThumbnailUrl, mediaTitle } from '../../common/utils'
import { ImageService } from '../../services'
import UploaderMention from '../user/UploaderMention'
import CardMenu from './CardMenu'
import useImageCardActions from './useImageCardActions'

const IMAGE_VERSION = Date.now()
const APP_ORIGIN = window.location.origin

// The footer under every image card has a fixed height, so a waterfall can work
// out a card's height from the image's shape before the card mounts, and a
// placeholder of that height holds the column steady while it loads.
export const IMAGE_CARD_FOOTER_HEIGHT = 88

export const imageAspectRatio = (image) =>
  image.info?.width && image.info?.height ? `${image.info.width} / ${image.info.height}` : '16 / 9'

const badgeSx = {
  position: 'absolute',
  bgcolor: '#000000BF',
  borderRadius: '4px',
  px: 0.75,
  py: 0.25,
}

const hoverButtonSx = {
  bgcolor: '#000000BF',
  '&:hover': { background: '#2684FF88' },
}

/**
 * An image in a waterfall. The image keeps its own shape, uncropped; under it is
 * the same footer a video card has (game, title, date, uploader and the ⋮ menu),
 * and on it the same badges and hover buttons.
 */
const MasonryImageCard = ({
  image,
  openImageHandler,
  alertHandler,
  authenticated,
  onRemoveFromView,
  removeOnMove = false,
  editMode = false,
  selected = false,
  hideUploader = false,
  // Marks the card as a photo when it sits among videos, as on the Home feed.
  showTypeIndicator = false,
}) => {
  const [thumbnailHover, setThumbnailHover] = React.useState(false)
  const [title, setTitle] = React.useState(mediaTitle(image))
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [titleDraft, setTitleDraft] = React.useState(title)
  const [menuAnchorEl, setMenuAnchorEl] = React.useState(null)
  const [imgLoaded, setImgLoaded] = React.useState(false)
  const [imgRetryKey, setImgRetryKey] = React.useState(0)
  const retryTimeoutRef = React.useRef(null)
  const retryCountRef = React.useRef(0)
  const MAX_RETRIES = 20

  const { privateView, togglePrivacy, copy, menuItems, modals } = useImageCardActions({
    image,
    alertHandler,
    openImageHandler,
    onRemoveFromView,
    removeOnMove,
  })

  // Re-sync when the image prop changes (an edit saved in the image modal).
  React.useEffect(() => {
    setTitle(mediaTitle(image))
  }, [image.info?.title, image.path]) // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current)
    }
  }, [])

  // The image may still be processing just after an upload.
  const handleImgError = React.useCallback(() => {
    if (retryCountRef.current >= MAX_RETRIES) return
    retryCountRef.current += 1
    retryTimeoutRef.current = setTimeout(() => setImgRetryKey((k) => k + 1), 4000)
  }, [])

  const handleTitleSave = async () => {
    setEditingTitle(false)
    const trimmed = titleDraft.trim() || mediaTitle({ path: image.path })
    if (trimmed === title) return
    const previous = title
    setTitle(trimmed)
    try {
      await ImageService.updateDetails(image.image_id, { title: trimmed })
    } catch (err) {
      setTitle(previous)
      alertHandler?.({ open: true, type: 'error', message: 'Failed to save title.' })
    }
  }

  const game = image.game
  const viewCount = image.view_count || 0
  const thumbnailUrl = getImageThumbnailUrl(image.image_id, IMAGE_VERSION)

  return (
    <Box
      sx={{
        width: '100%',
        bgcolor: '#00000066',
        borderRadius: { xs: 0, sm: '12px' },
        overflow: 'hidden',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {selected && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            border: '2px solid #2684FF',
            borderRadius: { xs: 0, sm: '12px' },
            zIndex: 10,
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Image, at its own aspect ratio */}
      <Box
        sx={{ position: 'relative', overflow: 'hidden', cursor: 'pointer', aspectRatio: imageAspectRatio(image) }}
        onClick={() => openImageHandler?.(image)}
        onMouseEnter={() => setThumbnailHover(true)}
        onMouseLeave={() => setThumbnailHover(false)}
      >
        {!imgLoaded && (
          <Skeleton
            variant="rectangular"
            animation="wave"
            width="100%"
            height="100%"
            sx={{ position: 'absolute', inset: 0, bgcolor: 'rgba(30, 60, 130, 0.4)' }}
          />
        )}
        <img
          key={imgRetryKey}
          src={thumbnailUrl}
          alt={title}
          onLoad={() => setImgLoaded(true)}
          onError={handleImgError}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
            opacity: imgLoaded ? 1 : 0,
            transition: 'opacity 0.4s ease',
          }}
        />

        {/* Views, bottom left. Gives way to the visibility toggle on hover. */}
        <Box
          sx={{
            ...badgeSx,
            bottom: 8,
            left: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            opacity: thumbnailHover ? 0 : 1,
            transition: 'opacity 0.2s ease-in-out',
          }}
        >
          <Typography sx={{ fontWeight: 600, fontSize: 14, color: 'white', fontFamily: 'monospace' }}>
            {viewCount}
          </Typography>
          {privateView ? (
            <VisibilityOffIcon sx={{ fontSize: 18, color: '#FF6B6B' }} aria-label="private" />
          ) : (
            <VisibilityIcon sx={{ fontSize: 18, color: 'white' }} />
          )}
        </Box>

        {/* Photo mark, bottom right: where a video card shows its duration */}
        {showTypeIndicator && (
          <Box sx={{ ...badgeSx, bottom: 8, right: 8, py: 0.5, display: 'flex', pointerEvents: 'none' }}>
            <ImageIcon sx={{ fontSize: 18, color: 'white' }} aria-label="photo" />
          </Box>
        )}

        {/* Copy link, top right on hover */}
        <Box
          sx={{
            position: 'absolute',
            top: 8,
            right: 8,
            opacity: thumbnailHover ? 1 : 0,
            transition: 'opacity 0.2s ease-in-out',
          }}
        >
          <IconButton sx={hoverButtonSx} aria-label="copy link" size="small" onClick={copy}>
            <LinkIcon sx={{ color: 'white', fontSize: 24 }} />
          </IconButton>
        </Box>

        {/* Visibility toggle, bottom left on hover */}
        {authenticated && (
          <Box
            sx={{
              position: 'absolute',
              bottom: 8,
              left: 8,
              opacity: thumbnailHover ? 1 : 0,
              transition: 'opacity 0.2s ease-in-out',
            }}
          >
            <IconButton
              sx={{ ...hoverButtonSx, '&:hover': { background: privateView ? '#FF232360' : '#2684FF88' } }}
              aria-label="toggle visibility"
              size="small"
              onClick={togglePrivacy}
            >
              {privateView ? (
                <VisibilityOffIcon sx={{ color: '#FF6B6B', fontSize: 24 }} />
              ) : (
                <VisibilityIcon sx={{ color: 'white', fontSize: 24 }} />
              )}
            </IconButton>
          </Box>
        )}

        {/* Selection checkbox */}
        {editMode && (
          <Box
            sx={{
              position: 'absolute',
              top: 8,
              left: 8,
              width: 32,
              height: 32,
              borderRadius: '8px',
              bgcolor: selected ? '#1565C0CC' : '#00000055',
              border: '2px solid',
              borderColor: selected ? '#90CAF9' : 'rgba(255,255,255,0.5)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 3,
              pointerEvents: 'none',
            }}
          >
            {selected && <CheckIcon sx={{ fontSize: 20, color: 'white' }} />}
          </Box>
        )}
      </Box>

      {/* Footer: the same layout as a video card's */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'stretch',
          height: IMAGE_CARD_FOOTER_HEIGHT,
          boxSizing: 'border-box',
          pt: 1.5,
          px: 1.5,
          pb: 1.5,
          gap: 1.5,
          overflow: 'hidden',
        }}
      >
        {game && (
          <Box
            component={game.steamgriddb_id ? 'a' : 'div'}
            href={game.steamgriddb_id ? `${APP_ORIGIN}/games/${game.steamgriddb_id}` : undefined}
            onClick={(e) => e.stopPropagation()}
            sx={{ flexShrink: 0, lineHeight: 0, alignSelf: 'flex-start', width: 40, height: 40 }}
          >
            {game.icon_url && (
              <img
                src={game.icon_url}
                alt={game.name}
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                }}
                style={{ width: 40, height: 40, objectFit: 'contain', display: 'block' }}
              />
            )}
          </Box>
        )}

        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {editingTitle ? (
            <input
              autoFocus
              aria-label="Title"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleSave}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.target.blur()
                if (e.key === 'Escape') {
                  setTitleDraft(title)
                  setEditingTitle(false)
                }
              }}
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '100%',
                background: '#FFFFFF1F',
                border: 'none',
                borderRadius: '4px',
                outline: 'none',
                color: 'white',
                fontWeight: 700,
                fontSize: 16,
                lineHeight: 1.3,
                padding: '2px 4px',
                boxSizing: 'border-box',
                fontFamily: 'inherit',
              }}
            />
          ) : (
            <Typography
              title={title}
              onDoubleClick={
                authenticated
                  ? (e) => {
                      e.stopPropagation()
                      setTitleDraft(title)
                      setEditingTitle(true)
                    }
                  : undefined
              }
              sx={{
                fontWeight: 700,
                fontSize: 16,
                lineHeight: 1.3,
                color: 'white',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                ...(authenticated && {
                  cursor: 'text',
                  borderRadius: '4px',
                  px: '4px',
                  mx: '-4px',
                  transition: 'background 0.15s',
                  '&:hover': { background: '#FFFFFF1F' },
                }),
              }}
            >
              {title}
            </Typography>
          )}

          {game?.name && (
            <Typography
              component={game.steamgriddb_id ? 'a' : 'span'}
              href={game.steamgriddb_id ? `${APP_ORIGIN}/games/${game.steamgriddb_id}` : undefined}
              onClick={(e) => e.stopPropagation()}
              sx={{
                mt: 0.25,
                fontSize: 14,
                lineHeight: 1.3,
                color: '#FFFFFFB3',
                display: 'block',
                textDecoration: 'none',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                ...(game.steamgriddb_id && { '&:hover': { color: '#3399FF', textDecoration: 'underline' } }),
              }}
            >
              {game.name}
            </Typography>
          )}

          {(image.created_at || (image.uploader && !hideUploader)) && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 'auto', pt: 0.5, minWidth: 0 }}>
              {image.created_at && (
                <Typography sx={{ fontSize: 14, color: '#FFFFFF80', flexShrink: 0 }}>
                  {new Date(image.created_at).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </Typography>
              )}
              {!hideUploader && <UploaderMention uploader={image.uploader} sx={{ ml: 'auto' }} />}
            </Box>
          )}
        </Box>

        <IconButton
          size="small"
          aria-label="More actions"
          onClick={(e) => {
            e.stopPropagation()
            setMenuAnchorEl(e.currentTarget)
          }}
          sx={{
            alignSelf: 'flex-start',
            color: menuAnchorEl ? 'primary.main' : '#FFFFFF59',
            transition: 'color 0.2s',
            p: 0.5,
            mt: 0.25,
          }}
        >
          <MoreVertIcon sx={{ fontSize: 24 }} />
        </IconButton>
      </Box>

      <CardMenu
        anchorEl={menuAnchorEl}
        onClose={() => setMenuAnchorEl(null)}
        items={menuItems}
        authenticated={authenticated}
      />
      {modals}
    </Box>
  )
}

export default MasonryImageCard
