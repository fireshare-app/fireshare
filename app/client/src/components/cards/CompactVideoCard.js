import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Box, Chip, Typography, IconButton, Menu, MenuItem, ListItemIcon, Skeleton, Tooltip } from '@mui/material'
import TagChip from '../ui/TagChip'
import UploaderMention from '../user/UploaderMention'
import LockIcon from '@mui/icons-material/Lock'
import LinkIcon from '@mui/icons-material/Link'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import EditIcon from '@mui/icons-material/Edit'
import SlowMotionVideoIcon from '@mui/icons-material/SlowMotionVideo'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import FolderIcon from '@mui/icons-material/Folder'
import CheckIcon from '@mui/icons-material/Check'
import CloseIcon from '@mui/icons-material/Close'
import { CopyToClipboard } from 'react-copy-to-clipboard'
import {
  getPublicWatchUrl,
  toHHMMSS,
  getVideoUrl,
  getMediaVersion,
  getSetting,
  getPosterUrl,
  getGameAssetUrl,
} from '../../common/utils'
import { GameService, VideoService, ConfigService } from '../../services'
import UpdateDetailsModal from '../modal/UpdateDetailsModal'
import DeleteVideoModal from '../modal/DeleteVideoModal'
import MoveVideoModal from '../modal/MoveVideoModal'
import PasswordModal from '../modal/PasswordModal'
import _ from 'lodash'

const PURL = getPublicWatchUrl()
const POSTER_VERSION = Date.now()
const APP_ORIGIN = window.location.origin

const CompactVideoCard = ({
  video,
  openVideoHandler,
  alertHandler,
  authenticated,
  editMode = false,
  selected = false,
  onSelect,
  onRemoveFromView,
  removeOnMove = false,
  showTypeIndicator = false,
  hideUploader = false,
}) => {
  const [intVideo, setIntVideo] = React.useState(video)
  const [hover, setHover] = React.useState(false)
  const [thumbnailHover, setThumbnailHover] = React.useState(false)
  const [game, setGame] = React.useState(video.game || null)
  const [gameReady, setGameReady] = React.useState(!!video.game)
  const [privateView, setPrivateView] = React.useState(video.info?.private)
  const [title, setTitle] = React.useState(
    video.info?.title ||
      (video.path
        ? video.path
            .split('/')
            .pop()
            .replace(/\.[^/.]+$/, '')
        : 'Untitled'),
  )
  const [description, setDescription] = React.useState(video.info?.description || '')
  const [menuAnchorEl, setMenuAnchorEl] = React.useState(null)
  const [detailsModalOpen, setDetailsModalOpen] = React.useState(false)
  const [deleteModalOpen, setDeleteModalOpen] = React.useState(false)
  const [moveModalOpen, setMoveModalOpen] = React.useState(false)
  const menuOpen = Boolean(menuAnchorEl)
  const [gameSuggestion, setGameSuggestion] = React.useState(null)
  const [showSuggestion, setShowSuggestion] = React.useState(true)
  const [suggestionLoading, setSuggestionLoading] = React.useState(false)
  const [suggestionIcon, setSuggestionIcon] = React.useState(null)
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [titleDraft, setTitleDraft] = React.useState(title)
  const [imgLoaded, setImgLoaded] = React.useState(false)
  const [imgRetryKey, setImgRetryKey] = React.useState(0)
  const retryTimeoutRef = React.useRef(null)
  const retryCountRef = React.useRef(0)
  const MAX_THUMBNAIL_RETRIES = 20
  const [localTags, setLocalTags] = React.useState(video.tags || [])
  const [passwordModalOpen, setPasswordModalOpen] = React.useState(false)
  const [unlockedLocally, setUnlockedLocally] = React.useState(video.info?.session_unlocked || false)
  const [titleHover, setTitleHover] = React.useState(false)
  const [titleOverflowAmount, setTitleOverflowAmount] = React.useState(0)
  const titleRef = React.useRef(null)

  React.useEffect(() => {
    if (!titleHover) return
    const el = titleRef.current
    if (!el) return
    setTitleOverflowAmount(Math.max(0, el.scrollWidth - el.clientWidth))
  }, [titleHover, title])

  const uiConfig = getSetting('ui_config')
  const canTagGames = authenticated || uiConfig?.allow_public_game_tag

  const videoRef = React.useRef(null)

  const isLocked = !authenticated && !unlockedLocally && video.info?.has_password

  React.useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (hover && !isLocked) {
      const info = intVideo?.info || video.info || {}
      const version = getMediaVersion(info)
      v.src = info.has_480p
        ? getVideoUrl(video.video_id, '480p', video.extension, version)
        : info.has_720p
          ? getVideoUrl(video.video_id, '720p', video.extension, version)
          : info.has_1080p
            ? getVideoUrl(video.video_id, '1080p', video.extension, version)
            : getVideoUrl(video.video_id, 'original', video.extension, version)
      v.muted = true
      v.play().catch(() => {})
    } else {
      v.pause()
      v.removeAttribute('src')
      v.load()
    }
  }, [hover, video.video_id, video.extension, video.info, intVideo?.info])

  const cardRef = React.useRef(null)
  const isTouchDevice = React.useRef(
    typeof window !== 'undefined' && window.matchMedia('(hover: none) and (pointer: coarse)').matches,
  )

  React.useEffect(() => {
    if (!isTouchDevice.current) return
    const el = cardRef.current
    if (!el) return
    const debouncedPlay = _.debounce(() => setHover(true), 300)
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          debouncedPlay()
        } else {
          debouncedPlay.cancel()
          setHover(false)
        }
      },
      { rootMargin: '-30% 0px -50% 0px', threshold: 0 },
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
      debouncedPlay.cancel()
    }
  }, [])

  const previousVideoRef = React.useRef()
  const previousVideo = previousVideoRef.current
  if (!_.isEqual(video, previousVideo) && !_.isEqual(video, intVideo)) {
    setIntVideo(video)
    setTitle(
      video.info?.title ||
        (video.path
          ? video.path
              .split('/')
              .pop()
              .replace(/\.[^/.]+$/, '')
          : 'Untitled'),
    )
    setDescription(video.info?.description || '')
    setLocalTags(video.tags || [])
    if (video.game !== undefined) setGame(video.game || null)
    if (video.video_id !== previousVideo?.video_id) {
      setImgLoaded(false)
      setImgRetryKey(0)
      retryCountRef.current = 0
      clearTimeout(retryTimeoutRef.current)
    }
  }
  React.useEffect(() => {
    previousVideoRef.current = video
  })

  React.useEffect(() => {
    return () => clearTimeout(retryTimeoutRef.current)
  }, [])

  const handleThumbnailLoad = () => {
    setImgLoaded(true)
    clearTimeout(retryTimeoutRef.current)
    retryCountRef.current = 0
  }

  const handleThumbnailError = () => {
    if (retryCountRef.current >= MAX_THUMBNAIL_RETRIES) return
    retryCountRef.current += 1
    retryTimeoutRef.current = setTimeout(() => {
      setImgRetryKey((k) => k + 1)
    }, 4000)
  }

  React.useEffect(() => {
    if (video.game) return
    GameService.getVideoGame(video.video_id)
      .then((response) => {
        if (response.data) setGame(response.data)
      })
      .catch(() => {})
      .finally(() => setGameReady(true))
  }, [video.video_id, video.game])

  const gameRef = React.useRef(game)
  React.useEffect(() => {
    gameRef.current = game
  }, [game])
  React.useEffect(() => {
    const handler = (e) => {
      const { steamgriddbId, bust } = e.detail
      if (gameRef.current?.steamgriddb_id === steamgriddbId) {
        setGame((prev) => (prev ? { ...prev, icon_url: getGameAssetUrl(steamgriddbId, 'icon_1', bust) } : prev))
      }
    }
    window.addEventListener('gameAssetsUpdated', handler)
    return () => window.removeEventListener('gameAssetsUpdated', handler)
  }, [video.video_id])

  const suggestionFetchedRef = React.useRef(false)
  React.useEffect(() => {
    const el = cardRef.current
    if (!el) return
    if (suggestionFetchedRef.current) return

    const fetchSuggestion = () => {
      if (suggestionFetchedRef.current) return
      suggestionFetchedRef.current = true
      VideoService.getGameSuggestion(video.video_id)
        .then((response) => {
          if (response.data) {
            setGameSuggestion(response.data)
            setShowSuggestion(true)
            if (response.data.steamgriddb_id) {
              GameService.getGameAssets(response.data.steamgriddb_id)
                .then((assets) => {
                  if (assets.data?.icon_url) setSuggestionIcon(assets.data.icon_url)
                })
                .catch(() => {})
            }
          }
        })
        .catch(() => {})
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect()
          fetchSuggestion()
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [video.video_id])

  const handleSuggestionAccept = async () => {
    setSuggestionLoading(true)
    try {
      let gameId = gameSuggestion.game_id
      if (!gameId && gameSuggestion.steamgriddb_id) {
        const assets = (await GameService.getGameAssets(gameSuggestion.steamgriddb_id)).data
        const createdGame = (
          await GameService.createGame({
            steamgriddb_id: gameSuggestion.steamgriddb_id,
            name: gameSuggestion.game_name,
            hero_url: assets.hero_url,
            logo_url: assets.logo_url,
            icon_url: assets.icon_url,
          })
        ).data
        gameId = createdGame.id
      }
      await GameService.linkVideoToGame(video.video_id, gameId)
      await VideoService.rejectGameSuggestion(video.video_id)
      const gameResponse = await GameService.getVideoGame(video.video_id)
      if (gameResponse.data) setGame(gameResponse.data)
      setShowSuggestion(false)
      setGameSuggestion(null)
    } catch (err) {
      console.error('Failed to accept game suggestion:', err)
      setSuggestionLoading(false)
    }
  }

  const handleSuggestionReject = async () => {
    setSuggestionLoading(true)
    try {
      await VideoService.rejectGameSuggestion(video.video_id)
      setShowSuggestion(false)
      setTimeout(() => setGameSuggestion(null), 300)
    } catch (err) {
      console.error('Failed to reject game suggestion:', err)
      setSuggestionLoading(false)
    }
  }

  const debouncedMouseEnter = React.useRef(
    _.debounce(() => {
      setHover(true)
    }, 750),
  ).current

  const handleMouseLeave = () => {
    debouncedMouseEnter.cancel()
    setHover(false)
  }

  const handleMouseDown = (e) => {
    if (editMode && e.shiftKey) {
      // Keep shift-click range selection from extending the native text selection
      e.preventDefault()
      return
    }
    if (e.button === 1) {
      window.open(`${PURL}${video.video_id}`, '_blank')
    }
  }

  const handlePrivacyChange = async (e) => {
    e.stopPropagation()
    try {
      await VideoService.updatePrivacy(video.video_id, !privateView)
      alertHandler?.({
        type: privateView ? 'info' : 'warning',
        message: privateView ? 'Added to your public feed' : 'Removed from your public feed',
        open: true,
      })
      setPrivateView(!privateView)
    } catch (err) {
      console.log(err)
    }
  }

  const gameName = game?.name || ''
  const viewCount = video.view_count || 0

  const filenameFallback = video.path
    ? video.path
        .split('/')
        .pop()
        .replace(/\.[^/.]+$/, '')
    : 'Untitled'

  const refreshVideoDetails = async () => {
    try {
      const refreshed = (await VideoService.getDetails(video.video_id)).data
      setIntVideo(refreshed)
      setPrivateView(refreshed.info?.private)
      setTitle(refreshed.info?.title || filenameFallback)
      setDescription(refreshed.info?.description || '')
    } catch (_) {}
  }

  const handleTranscode = async () => {
    try {
      const response = await ConfigService.startTranscodingVideo(video.video_id)
      const status = response?.data?.status
      alertHandler?.({
        type: 'info',
        message: status === 'queued' ? 'Transcode queued.' : 'Transcode started.',
        open: true,
      })
      refreshVideoDetails()
      setTimeout(refreshVideoDetails, 1000)
    } catch (err) {
      alertHandler?.({
        type: 'error',
        message: err.response?.data?.includes('not enabled')
          ? 'Transcoding is disabled. Add ENABLE_TRANSCODING=true to your Docker environment variables.'
          : 'Failed to start transcoding.',
        open: true,
      })
    }
  }

  const handleTitleSave = async () => {
    setEditingTitle(false)
    const trimmed = titleDraft.trim() || filenameFallback
    if (trimmed === title) return
    setTitle(trimmed)
    try {
      await VideoService.updateTitle(video.video_id, trimmed)
    } catch (err) {
      console.error('Failed to save title:', err)
      setTitle(title)
    }
  }

  const handleDetailsModalClose = (update) => {
    setDetailsModalOpen(false)
    if (update && update !== 'delete') {
      if (update.title !== undefined) setTitle(update.title || filenameFallback)
      if (update.description !== undefined) setDescription(update.description || '')
      if ('game' in update) setGame(update.game)
      if (update.tags !== undefined) setLocalTags(update.tags)
      if ('uploader' in update) setIntVideo((v) => ({ ...v, uploader: update.uploader }))
    }
  }

  return (
    <>
      <PasswordModal
        open={passwordModalOpen}
        onClose={() => setPasswordModalOpen(false)}
        videoId={video.video_id}
        onUnlocked={() => {
          setUnlockedLocally(true)
          setPasswordModalOpen(false)
          openVideoHandler(video.video_id)
        }}
      />
      <DeleteVideoModal
        open={deleteModalOpen}
        onClose={(result) => {
          setDeleteModalOpen(false)
          if (result === 'delete') onRemoveFromView?.(video.video_id)
        }}
        videoId={video.video_id}
        alertHandler={alertHandler}
      />
      <MoveVideoModal
        open={moveModalOpen}
        onClose={(result, newFolder) => {
          setMoveModalOpen(false)
          if (result === 'move') {
            if (removeOnMove) {
              onRemoveFromView?.(video.video_id)
            } else {
              const filename = intVideo.path.split('/').pop()
              setIntVideo((v) => ({ ...v, path: `${newFolder}/${filename}` }))
            }
          }
        }}
        video={intVideo}
        alertHandler={alertHandler}
      />
      <UpdateDetailsModal
        open={detailsModalOpen}
        close={handleDetailsModalClose}
        videoId={video.video_id}
        currentTitle={title}
        currentDescription={description}
        currentRecordedAt={video.recorded_at}
        currentGame={game}
        currentHasPassword={intVideo?.info?.has_password}
        currentUploader={intVideo?.uploader}
        currentInfo={intVideo?.info}
        onInfoChange={(info) => setIntVideo((v) => ({ ...v, info: { ...v.info, ...info } }))}
        alertHandler={alertHandler}
      />

      <Box
        sx={{
          width: '100%',
          height: '100%',
          bgcolor: '#00000066',
          borderRadius: { xs: 0, sm: '12px' },
          overflow: 'hidden',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          opacity: gameReady ? 1 : 0,
          transition: 'opacity 0.15s ease',
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
        {/* Thumbnail */}
        <Box ref={cardRef} sx={{ aspectRatio: '16 / 9', overflow: 'hidden', position: 'relative' }}>
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
          <motion.div
            style={{ position: 'absolute', inset: 0, cursor: 'pointer' }}
            onClick={(e) => {
              if (editMode) {
                onSelect?.(video.video_id, e.shiftKey)
                return
              }
              if (isLocked) {
                setPasswordModalOpen(true)
                return
              }
              openVideoHandler(video.video_id)
            }}
            onMouseEnter={(e) => {
              setThumbnailHover(true)
              debouncedMouseEnter(e)
            }}
            onMouseLeave={() => {
              setThumbnailHover(false)
              handleMouseLeave()
            }}
            onMouseDown={handleMouseDown}
          >
            <img
              src={getPosterUrl(video.video_id, imgRetryKey > 0 ? `${POSTER_VERSION}-${imgRetryKey}` : POSTER_VERSION)}
              alt=""
              onLoad={handleThumbnailLoad}
              onError={handleThumbnailError}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'block',
                opacity: imgLoaded ? 1 : 0,
                transition: 'opacity 0.8s ease, filter 0.3s ease, transform 0.3s ease',
              }}
            />

            <video
              ref={videoRef}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                opacity: hover ? 1 : 0,
                transition: hover ? 'opacity 1.5s ease-in' : 'none',
                pointerEvents: 'none',
              }}
              playsInline
              disablePictureInPicture
            />

            {/* Lock overlay — centered, fades on hover */}
            {video.info?.has_password && (
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
                  transition: 'opacity 0.2s ease-in-out',
                }}
              >
                <LockIcon
                  sx={{
                    fontSize: 40,
                    color: 'rgba(255,255,255,0.75)',
                    filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.9))',
                  }}
                />
              </Box>
            )}

            {/* Duration badge */}
            <Box
              sx={{
                position: 'absolute',
                bottom: 8,
                right: 8,
                bgcolor: '#000000BF',
                borderRadius: '4px',
                px: 0.75,
                py: 0.25,
              }}
            >
              <Typography
                sx={{
                  fontWeight: 600,
                  fontSize: 14,
                  color: 'white',
                  fontFamily: 'monospace',
                }}
              >
                {toHHMMSS(video.info?.duration)}
              </Typography>
            </Box>

            {/* Views badge - bottom left, hides on hover to give way to copy link */}
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
                <VisibilityIcon sx={{ fontSize: 18, color: privateView ? '#FF6B6B' : 'white' }} />
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
                <SlowMotionVideoIcon
                  sx={{
                    fontSize: 40,
                    color: 'rgba(255,255,255,0.75)',
                    filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.9))',
                  }}
                />
              </Box>
            )}

            {/* Copy link button - shows on hover */}
            <Box
              sx={{
                position: 'absolute',
                top: 8,
                right: 8,
                opacity: thumbnailHover ? 1 : 0,
                transition: 'opacity 0.2s ease-in-out',
              }}
            >
              <CopyToClipboard text={`${PURL}${video.video_id}`}>
                <IconButton
                  sx={{
                    bgcolor: '#000000BF',
                    '&:hover': {
                      background: '#2684FF88',
                    },
                  }}
                  aria-label="copy link"
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation()
                    alertHandler?.({
                      type: 'info',
                      message: 'Link copied to clipboard',
                      open: true,
                    })
                  }}
                >
                  <LinkIcon sx={{ color: 'white', fontSize: 24 }} />
                </IconButton>
              </CopyToClipboard>
            </Box>

            {/* Visibility toggle button - shows on hover when authenticated */}
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
                    '&:hover': {
                      background: privateView ? '#FF232360' : '#2684FF88',
                    },
                  }}
                  aria-label="toggle visibility"
                  size="small"
                  onClick={handlePrivacyChange}
                >
                  {privateView ? (
                    <VisibilityOffIcon sx={{ color: '#FF6B6B', fontSize: 24 }} />
                  ) : (
                    <VisibilityIcon sx={{ color: 'white', fontSize: 24 }} />
                  )}
                </IconButton>
              </Box>
            )}
          </motion.div>

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

          {/* Game detection suggestion bar — overlaid on thumbnail bottom */}
          <AnimatePresence>
            {canTagGames && gameSuggestion && showSuggestion && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2 }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    px: 2,
                    py: 1.25,
                    bgcolor: '#0b132b99',
                    backdropFilter: 'blur(4px)',
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
                    {suggestionIcon && (
                      <img
                        src={suggestionIcon}
                        alt=""
                        style={{ width: 30, height: 30, borderRadius: '4px', flexShrink: 0, objectFit: 'cover' }}
                      />
                    )}
                    <Typography
                      sx={{
                        fontSize: 15,
                        color: '#FFFFFFD9',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Game Detected: <strong>{gameSuggestion.game_name}</strong>
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 0.75, flexShrink: 0 }}>
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleSuggestionAccept()
                      }}
                      disabled={suggestionLoading}
                      sx={{
                        color: '#4caf50',
                        bgcolor: '#4CAF501A',
                        '&:hover': { bgcolor: '#4CAF5033' },
                        width: 34,
                        height: 34,
                      }}
                    >
                      <CheckIcon sx={{ fontSize: 20 }} />
                    </IconButton>
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleSuggestionReject()
                      }}
                      disabled={suggestionLoading}
                      sx={{
                        color: '#f44336',
                        bgcolor: '#F443361A',
                        '&:hover': { bgcolor: '#F4433633' },
                        width: 34,
                        height: 34,
                      }}
                    >
                      <CloseIcon sx={{ fontSize: 20 }} />
                    </IconButton>
                  </Box>
                </Box>
              </motion.div>
            )}
          </AnimatePresence>
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
          {/* Game icon — space reserved whenever a game is linked so the layout doesn't shift when the image loads */}
          {game && (
            <Box
              component={game.icon_url ? 'a' : 'div'}
              href={game.icon_url ? `${APP_ORIGIN}/games/${game.steamgriddb_id}` : undefined}
              onClick={game.icon_url ? (e) => e.stopPropagation() : undefined}
              sx={{ flexShrink: 0, lineHeight: 0, alignSelf: 'flex-start', width: 40, height: 40 }}
            >
              {game.icon_url && (
                <img
                  src={game.icon_url}
                  alt={game.name}
                  onLoad={(e) => {
                    e.currentTarget.style.opacity = 1
                  }}
                  onError={(e) => {
                    e.currentTarget.style.display = 'none'
                  }}
                  style={{
                    width: 40,
                    height: 40,
                    objectFit: 'contain',
                    display: 'block',
                    opacity: 0,
                    transition: 'opacity 0.15s ease',
                  }}
                />
              )}
            </Box>
          )}

          {/* Text info */}
          <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {/* Title */}
            {editingTitle ? (
              <input
                autoFocus
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
                ref={titleRef}
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
                  textOverflow: titleHover && titleOverflowAmount > 0 ? 'clip' : 'ellipsis',
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
                {titleHover && titleOverflowAmount > 0 ? (
                  <Box
                    component="span"
                    sx={{
                      display: 'inline-block',
                      whiteSpace: 'nowrap',
                      animation: `title-marquee-${video.video_id} 6s ease-in-out infinite`,
                      [`@keyframes title-marquee-${video.video_id}`]: {
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
            )}

            {/* Game name + tag chips on same row */}
            {gameName && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.25 }}>
                <Typography
                  component={game?.steamgriddb_id ? 'a' : 'span'}
                  href={game?.steamgriddb_id ? `${APP_ORIGIN}/games/${game.steamgriddb_id}` : undefined}
                  onClick={game?.steamgriddb_id ? (e) => e.stopPropagation() : undefined}
                  sx={{
                    fontSize: 14,
                    color: '#FFFFFFB3',
                    flex: 1,
                    minWidth: 0,
                    display: 'block',
                    textDecoration: 'none',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    ...(game?.steamgriddb_id && {
                      '&:hover': { color: '#3399FF', textDecoration: 'underline' },
                    }),
                  }}
                >
                  {gameName}
                </Typography>
              </Box>
            )}

            {/* Bottom meta row: recorded date and the uploader byline. Sharing one
                row keeps card height identical whether or not media has an owner. */}
            {(video.recorded_at || (intVideo.uploader && !hideUploader)) && (
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  mt: 'auto',
                  pt: 0.5,
                  minWidth: 0,
                }}
              >
                {video.recorded_at && (
                  <Typography sx={{ fontSize: 14, color: '#FFFFFF80', flexShrink: 0 }}>
                    {new Date(video.recorded_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </Typography>
                )}
                {!hideUploader && <UploaderMention uploader={intVideo.uploader} sx={{ ml: 'auto' }} />}
              </Box>
            )}
          </Box>

          {/* 3-dot menu toggle */}
          <IconButton
            size="small"
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

        {/* Floating context menu */}
        <Menu
          anchorEl={menuAnchorEl}
          open={menuOpen}
          onClose={() => setMenuAnchorEl(null)}
          onClick={(e) => e.stopPropagation()}
          transformOrigin={{ horizontal: 'right', vertical: 'top' }}
          anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
          slotProps={{
            paper: {
              sx: {
                bgcolor: '#0b132b',
                border: '1px solid #FFFFFF14',
                borderRadius: '10px',
                minWidth: 160,
                boxShadow: '0 8px 32px #00000099',
                mt: 0.5,
              },
            },
          }}
        >
          {[
            {
              label: 'Edit',
              Icon: EditIcon,
              color: '#FFFFFFE6',
              requiresAuth: true,
              onClick: () => setDetailsModalOpen(true),
            },
            {
              label: 'Transcode',
              Icon: SlowMotionVideoIcon,
              color: '#FFFFFFE6',
              requiresAuth: true,
              hidden: !getSetting('ui_config')?.transcoding_enabled,
              onClick: handleTranscode,
            },
            {
              label: 'Copy Link',
              Icon: LinkIcon,
              color: '#FFFFFFE6',
              onClick: () => {
                navigator.clipboard.writeText(`${PURL}${video.video_id}`)
                alertHandler?.({ type: 'info', message: 'Link copied to clipboard', open: true })
              },
            },
            {
              label: 'Move...',
              Icon: FolderIcon,
              color: '#FFFFFFE6',
              requiresAuth: true,
              onClick: () => setMoveModalOpen(true),
            },
            {
              label: 'Delete',
              Icon: DeleteOutlineIcon,
              color: '#EF5350',
              danger: true,
              requiresAuth: true,
              onClick: () => setDeleteModalOpen(true),
            },
          ]
            .filter((item) => !item.hidden)
            .filter((item) => !item.requiresAuth || authenticated)
            .map(({ label, Icon, color, danger, onClick }) => (
              <MenuItem
                key={label}
                onClick={() => {
                  onClick?.()
                  setMenuAnchorEl(null)
                }}
                sx={{
                  gap: 1.5,
                  py: 1.25,
                  fontSize: 14,
                  color,
                  bgcolor: danger ? '#EF535012' : 'transparent',
                  '&:hover': { bgcolor: danger ? '#EF535028' : '#FFFFFF12' },
                }}
              >
                <ListItemIcon sx={{ minWidth: 0, color: danger ? '#EF5350' : 'white' }}>
                  <Icon fontSize="small" />
                </ListItemIcon>
                {label}
              </MenuItem>
            ))}
        </Menu>
      </Box>
    </>
  )
}

export default CompactVideoCard
