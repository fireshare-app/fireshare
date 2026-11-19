import React from 'react'
import { Box, Typography, IconButton, Skeleton } from '@mui/material'
import LinkIcon from '@mui/icons-material/Link'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import CheckIcon from '@mui/icons-material/Check'
import ImageIcon from '@mui/icons-material/Image'
import { getImageThumbnailUrl, mediaTitle } from '../../common/utils'
import UploaderMention from '../user/UploaderMention'
import CardMenu from './CardMenu'
import useImageCardActions from './useImageCardActions'

const IMAGE_VERSION = Date.now()
const APP_ORIGIN = window.location.origin

// Phones and tablets can't hover, so they get the ⋮ button on the image itself.
const NO_HOVER = '@media (hover: none)'

export const imageAspectRatio = (image) =>
  image.info?.width && image.info?.height ? `${image.info.width} / ${image.info.height}` : '16 / 9'

const darkButtonSx = {
  bgcolor: '#000000BF',
  '&:hover': { background: '#2684FF88' },
}

/**
 * An image in a waterfall: the whole card is the image, at its own shape. On
 * hover it shows what a video card shows in its footer (game, title, date,
 * uploader and the ⋮ menu) over the bottom of the image, with the view count,
 * visibility toggle and copy link along the top.
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

  const openMenu = (e) => {
    e.stopPropagation()
    setMenuAnchorEl(e.currentTarget)
  }

  const title = mediaTitle(image)
  const game = image.game
  const viewCount = image.view_count || 0
  const thumbnailUrl = getImageThumbnailUrl(image.image_id, IMAGE_VERSION)
  // The overlay stays up while its menu is open, so the menu keeps its anchor.
  const showDetails = thumbnailHover || Boolean(menuAnchorEl)
  const hoverFade = { opacity: showDetails ? 1 : 0, transition: 'opacity 0.2s ease-in-out' }

  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        bgcolor: '#00000066',
        borderRadius: { xs: 0, sm: '8px' },
        overflow: 'hidden',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        border: imgLoaded ? '2px solid #000' : 'none',
      }}
    >
      <Box
        sx={{ overflow: 'hidden', position: 'relative', lineHeight: 0, cursor: 'pointer' }}
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
            sx={{ aspectRatio: imageAspectRatio(image), bgcolor: 'transparent' }}
          />
        )}
        <img
          key={imgRetryKey}
          src={thumbnailUrl}
          alt={title}
          onLoad={() => setImgLoaded(true)}
          onError={handleImgError}
          style={{ width: '100%', display: imgLoaded ? 'block' : 'none' }}
        />

        {/* Top left on hover: view count and the visibility toggle */}
        <Box
          sx={{
            position: 'absolute',
            top: 8,
            left: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            zIndex: 2,
            ...hoverFade,
          }}
        >
          <Box
            sx={{
              bgcolor: '#000000BF',
              borderRadius: '4px',
              px: 0.75,
              py: 0.25,
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
            }}
          >
            <Typography sx={{ fontWeight: 600, fontSize: 14, color: 'white', fontFamily: 'monospace' }}>
              {viewCount}
            </Typography>
            {privateView ? (
              <VisibilityOffIcon sx={{ fontSize: 20, color: '#FF6B6B' }} aria-label="private" />
            ) : (
              <VisibilityIcon sx={{ fontSize: 20, color: 'white' }} />
            )}
          </Box>
          {authenticated && (
            <IconButton
              sx={{ ...darkButtonSx, '&:hover': { background: privateView ? '#FF232360' : '#2684FF88' } }}
              aria-label="toggle visibility"
              size="small"
              onClick={togglePrivacy}
            >
              {privateView ? (
                <VisibilityOffIcon sx={{ color: '#FF6B6B', fontSize: 20 }} />
              ) : (
                <VisibilityIcon sx={{ color: 'white', fontSize: 20 }} />
              )}
            </IconButton>
          )}
        </Box>

        {/* Photo mark, top right until hover, when it's among videos */}
        {showTypeIndicator && (
          <Box
            sx={{
              position: 'absolute',
              top: 8,
              right: 8,
              width: 28,
              height: 28,
              borderRadius: '6px',
              bgcolor: '#000000A6',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
              zIndex: 1,
              opacity: showDetails ? 0 : 1,
              transition: 'opacity 0.2s ease-in-out',
              [NO_HOVER]: { display: 'none' },
            }}
          >
            <ImageIcon sx={{ fontSize: 18, color: 'rgba(255,255,255,0.85)' }} />
          </Box>
        )}

        {/* Top right on hover: copy link. Without hover, the ⋮ menu instead. */}
        <Box
          sx={{
            position: 'absolute',
            top: 8,
            right: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            zIndex: 2,
            ...hoverFade,
            [NO_HOVER]: { opacity: 1 },
          }}
        >
          <IconButton
            sx={{ ...darkButtonSx, [NO_HOVER]: { display: 'none' } }}
            aria-label="copy link"
            size="small"
            onClick={copy}
          >
            <LinkIcon sx={{ color: 'white', fontSize: 20 }} />
          </IconButton>
          <IconButton
            sx={{ ...darkButtonSx, display: 'none', [NO_HOVER]: { display: 'inline-flex' } }}
            aria-label="More actions"
            size="small"
            onClick={openMenu}
          >
            <MoreVertIcon sx={{ color: 'white', fontSize: 20 }} />
          </IconButton>
        </Box>

        {/* Bottom on hover: the same details a video card's footer shows */}
        <Box
          sx={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            background: 'linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.6) 65%, transparent 100%)',
            px: 1.5,
            pb: 1.25,
            pt: 5,
            lineHeight: 'normal',
            pointerEvents: showDetails ? 'auto' : 'none',
            ...hoverFade,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 1.5 }}>
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
              <Typography
                title={title}
                sx={{
                  fontWeight: 700,
                  fontSize: 16,
                  lineHeight: 1.3,
                  color: 'white',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {title}
              </Typography>
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
                    <Typography sx={{ fontSize: 14, color: '#FFFFFFB3', flexShrink: 0 }}>
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
              onClick={openMenu}
              sx={{
                alignSelf: 'flex-start',
                color: menuAnchorEl ? 'primary.main' : '#FFFFFFB3',
                transition: 'color 0.2s',
                p: 0.5,
                mt: 0.25,
                '&:hover': { color: 'white' },
              }}
            >
              <MoreVertIcon sx={{ fontSize: 24 }} />
            </IconButton>
          </Box>
        </Box>

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
