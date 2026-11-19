import React from 'react'
import { Box, Typography, IconButton, Skeleton } from '@mui/material'
import LinkIcon from '@mui/icons-material/Link'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import PhotoIcon from '@mui/icons-material/Photo'
import CheckIcon from '@mui/icons-material/Check'
import { getImageThumbnailUrl } from '../../common/utils'
import UploaderMention from '../user/UploaderMention'
import CardMenu from './CardMenu'
import useImageCardActions from './useImageCardActions'

const IMAGE_VERSION = Date.now()

const CompactImageCard = ({
  image,
  openImageHandler,
  alertHandler,
  authenticated,
  onRemoveFromView,
  editMode = false,
  selected = false,
  onSelect,
  showTypeIndicator = false,
  hideUploader = false,
}) => {
  const [thumbnailHover, setThumbnailHover] = React.useState(false)
  const { privateView, togglePrivacy, copy, menuItems, modals } = useImageCardActions({
    image,
    alertHandler,
    openImageHandler,
    onRemoveFromView,
  })
  const [title, setTitle] = React.useState(
    image.info?.title ||
      (image.path
        ? image.path
            .split('/')
            .pop()
            .replace(/\.[^/.]+$/, '')
        : 'Untitled'),
  )
  const [menuAnchorEl, setMenuAnchorEl] = React.useState(null)
  const [imgLoaded, setImgLoaded] = React.useState(false)
  const [imgRetryKey, setImgRetryKey] = React.useState(0)
  const retryTimeoutRef = React.useRef(null)
  const retryCountRef = React.useRef(0)
  const [titleHover, setTitleHover] = React.useState(false)
  const [titleOverflowAmount, setTitleOverflowAmount] = React.useState(0)
  const titleRef = React.useRef(null)

  React.useEffect(() => {
    if (!titleHover) return
    const el = titleRef.current
    if (!el) return
    setTitleOverflowAmount(Math.max(0, el.scrollWidth - el.clientWidth))
  }, [titleHover, title])
  const MAX_RETRIES = 20

  React.useEffect(() => {
    setTitle(
      image.info?.title ||
        (image.path
          ? image.path
              .split('/')
              .pop()
              .replace(/\.[^/.]+$/, '')
          : 'Untitled'),
    )
  }, [image.info?.title, image.path])

  React.useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current)
    }
  }, [])

  const [game, setGame] = React.useState(image.game || null)

  React.useEffect(() => {
    setGame(image.game || null)
  }, [image.game])

  const menuOpen = Boolean(menuAnchorEl)
  const thumbnailUrl = getImageThumbnailUrl(image.image_id, IMAGE_VERSION)
  const viewCount = image.view_count || 0

  const handleImgError = React.useCallback(() => {
    if (retryCountRef.current >= MAX_RETRIES) return
    retryCountRef.current += 1
    retryTimeoutRef.current = setTimeout(() => {
      setImgRetryKey((k) => k + 1)
    }, 4000)
  }, [])

  return (
    <>
      <Box
        sx={{
          width: '100%',
          height: '100%',
          bgcolor: '#00000066',
          borderRadius: '12px',
          overflow: 'hidden',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Selected border overlay */}
        {selected && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              border: '2px solid #2684FF',
              borderRadius: '12px',
              zIndex: 10,
              pointerEvents: 'none',
            }}
          />
        )}

        {/* Thumbnail — fixed 16:9 with contain + black bars to match video card height */}
        <Box
          sx={{ aspectRatio: '16 / 9', overflow: 'hidden', position: 'relative', bgcolor: '#000', cursor: 'pointer' }}
          onClick={() => (editMode ? onSelect?.(image.image_id) : openImageHandler?.(image))}
          onMouseEnter={() => setThumbnailHover(true)}
          onMouseLeave={() => setThumbnailHover(false)}
        >
          <Skeleton
            variant="rectangular"
            animation="wave"
            width="100%"
            height="100%"
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              opacity: imgLoaded ? 0 : 1,
              transition: 'opacity 0.8s ease',
              bgcolor: 'rgba(30, 60, 130, 0.4)',
            }}
          />
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
              transition: 'opacity 0.8s ease',
            }}
          />

          {/* Views badge — bottom left, hides on hover to reveal privacy toggle */}
          <Box
            sx={{
              position: 'absolute',
              bottom: 8,
              left: 8,
              bgcolor: '#000000BF',
              borderRadius: '4px',
              px: 0.75,
              py: 0.25,
              opacity: thumbnailHover ? 0 : 1,
              transition: 'opacity 0.2s ease-in-out',
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography sx={{ fontWeight: 600, fontSize: 14, color: 'white', fontFamily: 'monospace' }}>
                {viewCount}
              </Typography>
              {privateView ? (
                <VisibilityOffIcon sx={{ fontSize: 18, color: '#FF6B6B' }} aria-label="private" />
              ) : (
                <VisibilityIcon sx={{ fontSize: 18, color: 'white' }} />
              )}
            </Box>
          </Box>

          {/* Media type indicator — centered, fades out on hover */}
          {showTypeIndicator && (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
                zIndex: 2,
                opacity: thumbnailHover ? 0 : 1,
                transition: 'opacity 2s ease-in-out',
              }}
            >
              <PhotoIcon
                sx={{ fontSize: 40, color: 'rgba(255,255,255,0.75)', filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.9))' }}
              />
            </Box>
          )}

          {/* Copy link button — top right, shows on hover */}
          <Box
            sx={{
              position: 'absolute',
              top: 8,
              right: 8,
              opacity: thumbnailHover ? 1 : 0,
              transition: 'opacity 0.2s ease-in-out',
            }}
          >
            <IconButton
              sx={{ bgcolor: '#000000BF', '&:hover': { background: '#2684FF88' } }}
              aria-label="copy link"
              size="small"
              onClick={copy}
            >
              <LinkIcon sx={{ color: 'white', fontSize: 24 }} />
            </IconButton>
          </Box>

          {/* Privacy toggle — bottom left, shows on hover when authenticated */}
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
                sx={{
                  bgcolor: '#000000BF',
                  '&:hover': { background: privateView ? '#FF232360' : '#2684FF88' },
                }}
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

          {/* Selection overlay */}
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

        {/* Info section below thumbnail */}
        <Box
          onMouseEnter={() => setTitleHover(true)}
          onMouseLeave={() => setTitleHover(false)}
          sx={{
            display: 'flex',
            alignItems: 'stretch',
            flex: 1,
            mt: 1.5,
            px: 1.5,
            pb: 1.5,
            gap: 1.5,
          }}
        >
          {/* Game icon */}
          {game?.icon_url && (
            <a
              href={`games/${game.steamgriddb_id}`}
              onClick={(e) => e.stopPropagation()}
              style={{ flexShrink: 0, lineHeight: 0, alignSelf: 'flex-start' }}
            >
              <img
                src={game.icon_url}
                alt={game.name}
                onError={(e) => {
                  e.currentTarget.parentElement.style.display = 'none'
                }}
                style={{ width: 40, height: 40, objectFit: 'contain', display: 'block' }}
              />
            </a>
          )}

          {/* Text info */}
          <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <Typography
              ref={titleRef}
              sx={{
                fontWeight: 700,
                fontSize: 16,
                lineHeight: 1.3,
                color: 'white',
                overflow: 'hidden',
                textOverflow: titleHover && titleOverflowAmount > 0 ? 'clip' : 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {titleHover && titleOverflowAmount > 0 ? (
                <Box
                  component="span"
                  sx={{
                    display: 'inline-block',
                    whiteSpace: 'nowrap',
                    animation: `title-marquee-${image.image_id} 6s ease-in-out infinite`,
                    [`@keyframes title-marquee-${image.image_id}`]: {
                      '0%, 10%': { transform: 'translateX(0)' },
                      '45%, 55%': { transform: `translateX(-${titleOverflowAmount}px)` },
                      '90%, 100%': { transform: 'translateX(0)' },
                    },
                  }}
                >
                  {title}
                </Box>
              ) : (
                title
              )}
            </Typography>

            {game?.name && (
              <Typography
                component={game.steamgriddb_id ? 'a' : 'span'}
                href={game.steamgriddb_id ? `games/${game.steamgriddb_id}` : undefined}
                onClick={game.steamgriddb_id ? (e) => e.stopPropagation() : undefined}
                sx={{
                  fontSize: 14,
                  color: '#FFFFFFB3',
                  mt: 0.25,
                  display: 'block',
                  textDecoration: 'none',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  ...(game.steamgriddb_id && {
                    '&:hover': { color: '#3399FF', textDecoration: 'underline' },
                  }),
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

          {/* 3-dot menu */}
          <IconButton
            size="small"
            aria-label="More actions"
            onClick={(e) => {
              e.stopPropagation()
              setMenuAnchorEl(e.currentTarget)
            }}
            sx={{
              alignSelf: 'flex-start',
              color: menuOpen ? 'primary.main' : '#FFFFFF59',
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
      </Box>

      {modals}
    </>
  )
}

export default CompactImageCard
