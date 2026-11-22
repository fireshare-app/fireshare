import React, { useEffect, useRef, useState } from 'react'
import { saveProgress, getResumeTime } from '../../common/videoProgress'
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import TagChip from '../ui/TagChip'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import AccessTimeIcon from '@mui/icons-material/AccessTime'
import CloseIcon from '@mui/icons-material/Close'
import CheckIcon from '@mui/icons-material/Check'
import LinkIcon from '@mui/icons-material/Link'
import DownloadIcon from '@mui/icons-material/Download'
import RefreshIcon from '@mui/icons-material/Refresh'
import LockIcon from '@mui/icons-material/Lock'
import AddPhotoAlternateIcon from '@mui/icons-material/AddPhotoAlternate'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import VisibilityIcon from '@mui/icons-material/Visibility'
import {
  copyLink,
  copyToClipboard,
  downloadFile,
  downloadName,
  getPublicWatchUrl,
  getUrl,
  getVideoSources,
  getVideoUrl,
  getSetting,
  getPosterUrl as getVideoPosterUrl,
} from '../../common/utils'
import { ConfigService, VideoService, GameService, TagService } from '../../services'
import SnackbarAlert from '../alert/SnackbarAlert'
import VideoJSPlayer from '../player/VideoJSPlayer'
import SuggestionCard from '../cards/SuggestionCard'
import WaveformCropper from './WaveformCropper'
import TonemapControls from './TonemapControls'
import MediaModalShell, {
  GamePill,
  MediaMetaRow,
  MediaPanel,
  MediaTitle,
  actionBtnSx,
  aspectRatioOf,
  inputSx,
  labelSx,
  panelButtonSx,
} from './MediaModalShell'
import { GameField, TagsField } from './MediaEditFields'
import DateField from './DateField'

const URL = getUrl()
const PURL = getPublicWatchUrl()
const APP_ORIGIN = window.location.origin


// ─── Component ────────────────────────────────────────────────────────────────


const VideoModal = ({
  open,
  onClose,
  videoId,
  feedView,
  authenticated,
  updateCallback,
  onNext,
  onPrev,
  onSuggestionSelect,
}) => {
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [updateable, setUpdatable] = React.useState(false)
  const [privateView, setPrivateView] = React.useState(false)
  const [selectedDate, setSelectedDate] = React.useState(null)
  const [selectedTime, setSelectedTime] = React.useState('')
  const [vid, setVideo] = React.useState(null)
  const [viewAdded, setViewAdded] = React.useState(false)
  const [alert, setAlert] = React.useState({ open: false, type: 'info', message: '' })
  const [autoplay, setAutoplay] = useState(false)
  const [selectedGame, setSelectedGame] = React.useState(null)
  const [editMode, setEditMode] = React.useState(false)
  const [hasPassword, setHasPassword] = React.useState(false)
  const [passwordInput, setPasswordInput] = React.useState('')
  const [passwordLoading, setPasswordLoading] = React.useState(false)
  const [passwordReveal, setPasswordReveal] = React.useState(null)
  const [videoTags, setVideoTags] = React.useState([])
  const [allTags, setAllTags] = React.useState([])
  const [cropStart, setCropStart] = React.useState(null)
  const [cropEnd, setCropEnd] = React.useState(null)
  const [hasCustomPoster, setHasCustomPoster] = React.useState(false)
  const [thumbnailHover, setThumbnailHover] = React.useState(false)
  const [posterCacheKey, setPosterCacheKey] = React.useState(() => Date.now())
  const [pendingThumbnailFile, setPendingThumbnailFile] = React.useState(null)
  const [pendingThumbnailPreview, setPendingThumbnailPreview] = React.useState(null)
  const [thumbnailLoaded, setThumbnailLoaded] = React.useState(false)
  const [suggestions, setSuggestions] = React.useState([])
  const [cropProcessing, setCropProcessing] = React.useState(false)
  const [playerVersion, setPlayerVersion] = React.useState(0)

  const playerRef = React.useRef()
  const waveformRef = React.useRef(null)
  const thumbnailInputRef = React.useRef(null)
  const lastSavedRef = useRef(0)
  const cropPollRef = useRef(null)

  useEffect(() => {
    if (!open || editMode) return
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.key === 'ArrowRight') onNext?.()
      if (e.key === 'ArrowLeft') onPrev?.()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, editMode, onNext, onPrev])

  const getRandomVideo = async () => {
    try {
      const res = !feedView
        ? (await VideoService.getRandomVideo()).data
        : (await VideoService.getRandomPublicVideo()).data

      setViewAdded(false)
      setVideo(res)
      setTitle(res.info?.title)
      setDescription(res.info?.description)
      setUpdatable(false)
      setPrivateView(res.info?.private)
    } catch (err) {
      console.log(err)
    }
  }

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const result = await ConfigService.getConfig()
        setAutoplay(result.data?.autoplay || false)
      } catch (error) {
        console.error('Error fetching config:', error)
      }
    }
    fetchConfig()
  }, [])

  React.useEffect(() => {
    let cancelled = false
    async function fetch() {
      try {
        const details = (await VideoService.getDetails(videoId)).data
        if (cancelled) return
        setViewAdded(false)
        setVideo(details)
        setTitle(details.info?.title)
        setDescription(details.info?.description)
        setPrivateView(details.info?.private)
        setHasPassword(details.info?.has_password || false)
        setPasswordReveal(null)
        setPasswordInput('')
        setCropStart(details.info?.start_time ?? null)
        setCropEnd(details.info?.end_time ?? null)
        setHasCustomPoster(details.has_custom_poster || false)
        setUpdatable(false)
        if (details.recorded_at) {
          const d = new Date(details.recorded_at)
          const pad = (n) => n.toString().padStart(2, '0')
          setSelectedDate(d)
          setSelectedTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`)
        } else {
          setSelectedDate(null)
          setSelectedTime('')
        }
        try {
          const gameData = (await GameService.getVideoGame(videoId)).data
          if (cancelled) return
          setSelectedGame(gameData || null)
        } catch (err) {
          if (!cancelled) setSelectedGame(null)
        }
        try {
          const [tagsRes, allTagsRes] = await Promise.all([TagService.getVideoTags(videoId), TagService.getTags()])
          if (cancelled) return
          setVideoTags(tagsRes.data || [])
          setAllTags(allTagsRes.data || [])
        } catch (err) {
          if (!cancelled) {
            setVideoTags([])
            setAllTags([])
          }
        }
      } catch (err) {
        if (!cancelled) setAlert({ type: 'error', message: 'Unable to load video details', open: true })
      }
    }
    if (videoId) {
      setTitle('')
      setDescription('')
      setSelectedGame(null)
      setSelectedDate(null)
      setSelectedTime('')
      setEditMode(false)
      setVideoTags([])
      setCropStart(null)
      setCropEnd(null)
      setHasCustomPoster(false)
      setPosterCacheKey(Date.now())
      if (pendingThumbnailPreview) window.URL.revokeObjectURL(pendingThumbnailPreview)
      setPendingThumbnailFile(null)
      setPendingThumbnailPreview(null)
      fetch()
    }
    return () => {
      cancelled = true
    }
  }, [videoId])

  React.useEffect(() => {
    let cancelled = false

    if (!open || !videoId) {
      setSuggestions([])
      return () => {
        cancelled = true
      }
    }

    VideoService.getSuggestions(videoId)
      .then((res) => {
        if (!cancelled) setSuggestions(res.data || [])
      })
      .catch(() => {
        if (!cancelled) setSuggestions([])
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) {
      clearInterval(cropPollRef.current)
      setCropProcessing(false)
      // Drop the player wrapper so the unmounted <video> element it references
      // can be garbage collected along with its decoder resources.
      playerRef.current = null
    }
  }, [open])

  const handleGameLinked = async (game, warning) => {
    try {
      await GameService.linkVideoToGame(vid.video_id, game.id)
      setSelectedGame(game)
      if (warning) {
        setAlert({ type: 'warning', message: `Linked to ${game.name}. ${warning}`, open: true })
      } else {
        setAlert({ type: 'success', message: `Linked to ${game.name}`, open: true })
      }
    } catch (err) {
      setAlert({ type: 'error', message: 'Failed to link game', open: true })
    }
  }

  const handleUnlinkGame = async () => {
    try {
      await GameService.unlinkVideoFromGame(vid.video_id)
      setSelectedGame(null)
      setAlert({ type: 'info', message: 'Game link removed', open: true })
    } catch (err) {
      setAlert({ type: 'error', message: 'Failed to unlink game', open: true })
    }
  }

  const handleAddTag = async (tag) => {
    if (!tag || !vid) return
    try {
      let tagId = tag.id
      if (!tagId) {
        // Create the tag if it doesn't exist yet
        const res = await TagService.createTag({ name: tag.name })
        tagId = res.data.id
        setAllTags((prev) => [...prev, res.data])
      }
      await TagService.addTagToVideo(vid.video_id, tagId)
      const updatedTags = (await TagService.getVideoTags(vid.video_id)).data
      setVideoTags(updatedTags)
    } catch (err) {
      console.error('Failed to add tag:', err)
    }
  }

  const handleRemoveTag = async (tagId) => {
    if (!vid) return
    try {
      await TagService.removeTagFromVideo(vid.video_id, tagId)
      setVideoTags((prev) => prev.filter((t) => t.id !== tagId))
    } catch (err) {
      console.error('Failed to remove tag:', err)
    }
  }

  const handleMouseDown = (e) => {
    if (e.button === 1) window.open(`${PURL}${vid.video_id}`, '_blank')
  }

  const getRecordedAtISO = () => {
    if (!selectedDate) return null
    const d = new Date(selectedDate)
    if (selectedTime) {
      const [h, m] = selectedTime.split(':')
      d.setHours(+h, +m, 0, 0)
    }
    // Return a naive local ISO string (no Z/offset) so the server stores the
    // time exactly as the user entered it, without any timezone conversion.
    const pad = (n) => n.toString().padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
  }

  const update = async () => {
    if (!authenticated) return
    const cropChanged = cropStart !== (vid?.info?.start_time ?? null) || cropEnd !== (vid?.info?.end_time ?? null)
    if (!updateable && !cropChanged && !pendingThumbnailFile) {
      setEditMode(false)
      return
    }

    // Optimistically close edit mode and reflect changes in the UI immediately.
    setUpdatable(false)
    setEditMode(false)
    updateCallback?.({ id: vid.video_id, title, description })
    setAlert({ type: 'success', message: 'Details Updated', open: true })

    const cropApplied = cropChanged && (cropStart !== null || cropEnd !== null)
    const cropCleared = cropChanged && cropStart === null && cropEnd === null

    if (cropChanged) {
      setVideo((prev) => ({
        ...prev,
        info: { ...prev.info, start_time: cropStart, end_time: cropEnd, has_crop: false },
      }))
    }
    if (cropApplied) {
      setCropProcessing(true)
    }
    if (cropCleared) {
      setPlayerVersion((v) => v + 1)
    }

    // Upload pending thumbnail (must complete before details call).
    if (pendingThumbnailFile) {
      const formData = new FormData()
      formData.append('file', pendingThumbnailFile)
      try {
        await VideoService.uploadCustomPoster(vid.video_id, formData)
        setHasCustomPoster(true)
        setPosterCacheKey(Date.now())
        window.URL.revokeObjectURL(pendingThumbnailPreview)
        setPendingThumbnailFile(null)
        setPendingThumbnailPreview(null)
      } catch {
        setAlert({ type: 'error', message: 'Failed to upload thumbnail', open: true })
      }
    }

    if (!updateable && !cropChanged) return

    try {
      const payload = { title, description, recorded_at: getRecordedAtISO() }
      if (cropChanged) {
        payload.start_time = cropStart
        payload.end_time = cropEnd
      }
      await VideoService.updateDetails(vid.video_id, payload)
      if (cropApplied) {
        const videoId = vid.video_id
        clearInterval(cropPollRef.current)
        cropPollRef.current = setInterval(async () => {
          try {
            const res = await VideoService.getDetails(videoId)
            if (res.data?.info?.has_crop) {
              clearInterval(cropPollRef.current)
              setVideo((prev) => ({ ...prev, info: { ...prev.info, ...res.data.info } }))
              setPlayerVersion((v) => v + 1)
              setCropProcessing(false)
              setPosterCacheKey(Date.now())
            }
          } catch {
            // ignore transient poll errors
          }
        }, 2000)
      }
    } catch {
      setAlert({ type: 'error', message: 'An error occurred trying to save changes', open: true })
      if (cropApplied) setCropProcessing(false)
    }
  }

  const handlePrivacyChange = async () => {
    if (authenticated) {
      try {
        await VideoService.updatePrivacy(vid.video_id, !privateView)
        updateCallback?.({ id: vid.video_id, private: !privateView })
        setAlert({
          type: privateView ? 'info' : 'warning',
          message: privateView ? 'Added to your public feed' : 'Removed from your public feed',
          open: true,
        })
        setPrivateView(!privateView)
      } catch (err) {
        console.log(err)
      }
    }
  }

  const handleTitleChange = (newValue) => {
    if (newValue) setUpdatable(newValue !== vid.info?.title || description !== vid.info?.description)
    setTitle(newValue)
  }

  const handleDescriptionChange = (newValue) => {
    if (newValue) setUpdatable(newValue !== vid.info?.description || title !== vid.info?.title)
    setDescription(newValue)
  }

  const copyTimestamp = () => {
    let currentTime = 0
    if (playerRef.current && typeof playerRef.current.currentTime === 'function') {
      const time = playerRef.current.currentTime()
      currentTime = time && !isNaN(time) ? time : 0
    }
    copyToClipboard(`${PURL}${vid.video_id}?t=${currentTime}`).then(
      () => setAlert({ type: 'info', message: 'Time stamped link copied to clipboard', open: true }),
      () => setAlert({ type: 'error', message: "Couldn't copy the link. Your browser blocked it.", open: true }),
    )
  }

  const handleTimeUpdate = (e) => {
    const currentTime = e.playedSeconds || 0

    // Sync waveform cursor with video playback
    waveformRef.current?.seekTo(currentTime)

    if (!viewAdded) {
      if (!vid.info?.duration || vid.info?.duration < 10) {
        setViewAdded(true)
        VideoService.addView(vid?.video_id || videoId).catch((err) => console.error(err))
      } else if (currentTime >= 10) {
        setViewAdded(true)
        VideoService.addView(vid?.video_id || videoId).catch((err) => console.error(err))
      }
    }

    const now = Date.now()
    if (now - lastSavedRef.current > 5000) {
      lastSavedRef.current = now
      saveProgress(vid.video_id, currentTime, vid.info?.duration)
    }
  }

  const getPosterUrl = () => {
    return getVideoPosterUrl(vid.video_id)
  }

  const getThumbnailPreviewUrl = () => {
    if (pendingThumbnailPreview) return pendingThumbnailPreview
    return getVideoPosterUrl(vid.video_id, posterCacheKey)
  }

  const handleThumbnailUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file || !vid) return
    e.target.value = ''
    if (pendingThumbnailPreview) window.URL.revokeObjectURL(pendingThumbnailPreview)
    setPendingThumbnailFile(file)
    setPendingThumbnailPreview(window.URL.createObjectURL(file))
    setThumbnailLoaded(false)
  }

  const handleCaptureThumbnail = () => {
    const videoEl = playerRef.current?.el()
    if (!videoEl || videoEl.readyState < 2) {
      setAlert({ type: 'warning', message: 'Play the video first before capturing a frame', open: true })
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = videoEl.videoWidth
    canvas.height = videoEl.videoHeight
    canvas.getContext('2d').drawImage(videoEl, 0, 0)
    canvas.toBlob((blob) => {
      if (!blob) {
        setAlert({ type: 'error', message: 'Failed to capture frame', open: true })
        return
      }
      if (pendingThumbnailPreview) window.URL.revokeObjectURL(pendingThumbnailPreview)
      setPendingThumbnailFile(new File([blob], 'capture.webp', { type: 'image/webp' }))
      setPendingThumbnailPreview(window.URL.createObjectURL(blob))
      setThumbnailLoaded(false)
    }, 'image/webp')
  }

  const handleClearThumbnail = async () => {
    if (pendingThumbnailFile) {
      window.URL.revokeObjectURL(pendingThumbnailPreview)
      setPendingThumbnailFile(null)
      setPendingThumbnailPreview(null)
      return
    }
    if (!vid) return
    try {
      await VideoService.deleteCustomPoster(vid.video_id)
      setHasCustomPoster(false)
      setPosterCacheKey(Date.now())
      setAlert({ type: 'info', message: 'Custom thumbnail removed', open: true })
    } catch (err) {
      setAlert({ type: 'error', message: 'Failed to remove thumbnail', open: true })
    }
  }

  if (!vid) return null

  // Video aspect ratio — drives the modal size via CSS min().
  const ar = aspectRatioOf(vid?.info)

  return (
    <>
      <SnackbarAlert severity={alert.type} open={alert.open} setOpen={(open) => setAlert({ ...alert, open })}>
        {alert.message}
      </SnackbarAlert>
      <MediaModalShell
        open={open}
        onClose={onClose}
        aspectRatio={ar}
        stageSx={{
          // Override VideoJS default 8px border-radius responsively
          '& > div': {
            borderRadius: {
              xs: '0 !important',
              md: editMode ? '8px 0 0 0 !important' : '8px 0 0 8px !important',
            },
          },
        }}
        stage={
          <>
            <VideoJSPlayer
              key={`${vid.video_id}-${playerVersion}`}
              sources={getVideoSources(vid.video_id, vid?.info, vid.extension, { forceOriginal: editMode })}
              poster={getPosterUrl()}
              autoplay={autoplay}
              controls={true}
              onTimeUpdate={handleTimeUpdate}
              onReady={(player) => {
                playerRef.current = player
              }}
              startTime={getResumeTime(vid.video_id, vid.info?.duration)}
              fill={true}
              fluid={false}
              playsinline={true}
            />
            {cropProcessing && (
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backdropFilter: 'blur(6px)',
                  backgroundColor: 'rgba(2, 13, 26, 0.55)',
                  zIndex: 10,
                  borderRadius: 'inherit',
                }}
              >
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
                  <CircularProgress size={48} sx={{ color: '#fff' }} />
                  <Typography variant="body2" sx={{ color: '#fff', fontWeight: 500, letterSpacing: '0.02em' }}>
                    Cropping video...
                  </Typography>
                </Box>
              </Box>
            )}
          </>
        }
        panel={
          <MediaPanel
            label="Now Playing"
            onClose={onClose}
            actions={
              <>
                {authenticated && (
                  <Tooltip title={privateView ? 'Make public' : 'Make private'}>
                    <IconButton
                      size="small"
                      aria-label={privateView ? 'Make public' : 'Make private'}
                      onClick={handlePrivacyChange}
                      sx={{ ...actionBtnSx, color: privateView ? '#FF6B6B' : '#FFFFFFB3' }}
                    >
                      {privateView ? <VisibilityOffIcon sx={{ fontSize: 20 }} /> : <VisibilityIcon sx={{ fontSize: 20 }} />}
                    </IconButton>
                  </Tooltip>
                )}

                <Tooltip title="Copy link">
                  <IconButton
                    size="small"
                    aria-label="Copy link"
                    onClick={() => copyLink(`${PURL}${vid.video_id}`, setAlert)}
                    sx={actionBtnSx}
                  >
                    <LinkIcon sx={{ fontSize: 20 }} />
                  </IconButton>
                </Tooltip>

                <Tooltip title="Copy timestamp link">
                  <IconButton size="small" aria-label="Copy timestamp link" onClick={copyTimestamp} sx={actionBtnSx}>
                    <AccessTimeIcon sx={{ fontSize: 20 }} />
                  </IconButton>
                </Tooltip>

                <Tooltip title="Download">
                  <IconButton
                    size="small"
                    aria-label="Download"
                    onClick={() =>
                      downloadFile(
                        getVideoUrl(vid.video_id, 'original', vid.extension),
                        downloadName(title || vid.info?.title, vid.extension),
                      )
                    }
                    sx={actionBtnSx}
                  >
                    <DownloadIcon sx={{ fontSize: 20 }} />
                  </IconButton>
                </Tooltip>

                {authenticated &&
                  (editMode ? (
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={update}
                      sx={{
                        ...panelButtonSx,
                        color: updateable ? '#3399FF' : '#FFFFFF',
                        borderColor: updateable ? '#3399FF88' : '#FFFFFF44',
                        '&:hover': {
                          borderColor: updateable ? '#3399FF' : '#FFFFFF99',
                          bgcolor: updateable ? '#3399FF11' : '#FFFFFF11',
                        },
                        ...(updateable && { animation: 'blink-blue 0.5s ease-in-out infinite alternate' }),
                      }}
                    >
                      Save
                    </Button>
                  ) : (
                    <Button size="small" onClick={() => setEditMode(true)} variant="outlined" sx={panelButtonSx}>
                      Edit
                    </Button>
                  ))}
              </>
            }
          >
            {/* Title */}
            <Box>
              {editMode ? (
                <TextField
                  fullWidth
                  size="small"
                  value={title || ''}
                  placeholder="Video Title"
                  onChange={(e) => handleTitleChange(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && update()}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                  sx={inputSx}
                />
              ) : (
                <MediaTitle>{title}</MediaTitle>
              )}
              {!editMode && (
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', mt: 0.5, gap: 2 }}>
                  <MediaMetaRow viewCount={vid.view_count} date={vid.recorded_at} uploader={vid.uploader} />
                  <GamePill game={selectedGame} />
                  {videoTags.length > 0 && (
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 0.5 }}>
                      {videoTags.map((tag) => (
                        <TagChip key={tag.id} name={tag.name} color={tag.color} href={`${APP_ORIGIN}/tags/${tag.id}`} size="small" />
                      ))}
                    </Box>
                  )}
                </Box>
              )}
            </Box>

            {/* Description */}
            {(editMode || description) && (
              <Box>
                {editMode ? (
                  <TextField
                    fullWidth
                    multiline
                    rows={4}
                    size="small"
                    placeholder="Enter a video description..."
                    value={description || ''}
                    onChange={(e) => handleDescriptionChange(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    sx={inputSx}
                  />
                ) : (
                  <Typography sx={{ fontSize: 14, color: '#FFFFFF', lineHeight: 1.6 }}>
                    {description}
                  </Typography>
                )}
              </Box>
            )}

            {/* Game (edit mode only) */}
            {editMode && (authenticated || getSetting('ui_config')?.allow_public_game_tag) && (
              <GameField
                game={selectedGame}
                onLinked={handleGameLinked}
                onUnlink={handleUnlinkGame}
                onError={(err) =>
                  setAlert({
                    open: true,
                    type: 'error',
                    message: err.response?.data || 'Error linking game',
                  })
                }
              />
            )}

            {/* Tags (edit mode only) */}
            {editMode && authenticated && (
              <TagsField tags={videoTags} allTags={allTags} onAdd={handleAddTag} onRemove={handleRemoveTag} />
            )}

            {/* Thumbnail (edit mode only) */}
            {editMode && authenticated && (
              <Box>
                <Typography sx={labelSx}>Thumbnail</Typography>
                <Box
                  sx={{
                    position: 'relative',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    cursor: 'pointer',
                    lineHeight: 0,
                  }}
                  onMouseEnter={() => setThumbnailHover(true)}
                  onMouseLeave={() => setThumbnailHover(false)}
                >
                  <img
                    key={pendingThumbnailPreview ?? posterCacheKey}
                    src={getThumbnailPreviewUrl()}
                    alt="Thumbnail"
                    onLoad={() => setThumbnailLoaded(true)}
                    style={{ width: '100%', display: thumbnailLoaded ? 'block' : 'none', borderRadius: 8 }}
                  />
                  {!thumbnailLoaded && (
                    <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                      <CircularProgress size={28} sx={{ color: '#FFFFFF44' }} />
                    </Box>
                  )}
                  {thumbnailHover && (
                    <Box
                      sx={{
                        position: 'absolute',
                        inset: 0,
                        bgcolor: 'rgba(0,0,0,0.55)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 1,
                        borderRadius: '8px',
                      }}
                    >
                      <Tooltip title="Upload thumbnail">
                        <IconButton
                          onClick={() => thumbnailInputRef.current?.click()}
                          sx={{ color: 'white', bgcolor: '#FFFFFF22', '&:hover': { bgcolor: '#FFFFFF44' } }}
                        >
                          <AddPhotoAlternateIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Use current frame">
                        <IconButton
                          onClick={handleCaptureThumbnail}
                          sx={{ color: 'white', bgcolor: '#FFFFFF22', '&:hover': { bgcolor: '#FFFFFF44' } }}
                        >
                          <PhotoCameraIcon />
                        </IconButton>
                      </Tooltip>
                      {(hasCustomPoster || pendingThumbnailFile) && (
                        <Tooltip
                          title={pendingThumbnailFile ? 'Cancel pending upload' : 'Remove custom thumbnail'}
                        >
                          <IconButton
                            onClick={handleClearThumbnail}
                            sx={{ color: '#FF6B6B', bgcolor: '#FFFFFF22', '&:hover': { bgcolor: '#FFFFFF44' } }}
                          >
                            <DeleteOutlineIcon />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Box>
                  )}
                </Box>
                <input
                  ref={thumbnailInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  style={{ display: 'none' }}
                  onChange={handleThumbnailUpload}
                />
              </Box>
            )}

            {/* Date picker (edit mode only) */}
            {editMode && (
              <Box>
                <Typography sx={labelSx}>Recorded Date</Typography>
                <DateField
                  selectedDate={selectedDate}
                  selectedTime={selectedTime}
                  onDateChange={(d) => {
                    setSelectedDate(d)
                    setUpdatable(true)
                  }}
                  onTimeChange={(t) => {
                    setSelectedTime(t)
                    setUpdatable(true)
                  }}
                />
              </Box>
            )}

            {/* Dynamic range (edit mode only, HDR sources) */}
            {editMode && authenticated && vid.info?.is_hdr && (
              <Box>
                <Typography sx={labelSx}>Dynamic Range</Typography>
                <TonemapControls
                  videoId={vid.video_id}
                  videoInfo={vid.info}
                  onInfoChange={(info) =>
                    setVideo((prev) => (prev ? { ...prev, info: { ...prev.info, ...info } } : prev))
                  }
                  onConverted={() => {
                    setPlayerVersion((v) => v + 1)
                    setPosterCacheKey(Date.now())
                  }}
                  alertHandler={setAlert}
                  getCurrentTime={() => playerRef.current?.currentTime() ?? 0}
                />
              </Box>
            )}

            {/* Password protection (edit mode only) */}
            {editMode && authenticated && (
              <Box>
                <Typography sx={labelSx}>Password Protection</Typography>
                {(() => {
                  const adornmentBtnSx = { color: '#FFFFFF66', '&:hover': { color: 'white' }, p: 0.5 }
                  const handleSetPassword = async () => {
                    if (!passwordInput.trim()) return
                    setPasswordLoading(true)
                    try {
                      await VideoService.setPassword(vid.video_id, passwordInput.trim())
                      setPasswordInput('')
                      setHasPassword(true)
                      setAlert({ type: 'success', message: 'Password set.', open: true })
                    } catch {
                      setAlert({ type: 'error', message: 'Failed to set password.', open: true })
                    }
                    setPasswordLoading(false)
                  }
                  if (passwordReveal) {
                    return (
                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        <TextField
                          value={passwordReveal}
                          fullWidth
                          size="small"
                          inputProps={{ readOnly: true }}
                          sx={{ ...inputSx, '& input': { fontFamily: 'monospace', letterSpacing: 1 } }}
                          InputProps={{
                            endAdornment: (
                              <InputAdornment position="end" sx={{ gap: 0.25 }}>
                                <IconButton
                                  size="small"
                                  onClick={() => {
                                    navigator.clipboard.writeText(passwordReveal)
                                    setAlert({ type: 'info', message: 'Copied to clipboard.', open: true })
                                  }}
                                  sx={adornmentBtnSx}
                                >
                                  <ContentCopyIcon sx={{ fontSize: 16 }} />
                                </IconButton>
                                <IconButton
                                  size="small"
                                  onClick={() => setPasswordReveal(null)}
                                  sx={adornmentBtnSx}
                                >
                                  <CloseIcon sx={{ fontSize: 16 }} />
                                </IconButton>
                              </InputAdornment>
                            ),
                          }}
                        />
                      </Box>
                    )
                  }
                  if (hasPassword) {
                    return (
                      <TextField
                        value="••••••••"
                        fullWidth
                        size="small"
                        inputProps={{ readOnly: true }}
                        sx={inputSx}
                        InputProps={{
                          startAdornment: (
                            <InputAdornment position="start">
                              <LockIcon sx={{ fontSize: 15, color: '#FFFFFF66' }} />
                            </InputAdornment>
                          ),
                          endAdornment: (
                            <InputAdornment position="end">
                              {passwordLoading ? (
                                <CircularProgress size={16} sx={{ color: '#FFFFFF66' }} />
                              ) : (
                                <IconButton
                                  size="small"
                                  onClick={async () => {
                                    setPasswordLoading(true)
                                    try {
                                      await VideoService.removePassword(vid.video_id)
                                      setHasPassword(false)
                                      setAlert({ type: 'info', message: 'Password removed.', open: true })
                                    } catch {
                                      setAlert({
                                        type: 'error',
                                        message: 'Failed to remove password.',
                                        open: true,
                                      })
                                    }
                                    setPasswordLoading(false)
                                  }}
                                  sx={{ ...adornmentBtnSx, '&:hover': { color: '#EF9A9A' } }}
                                >
                                  <CloseIcon sx={{ fontSize: 16 }} />
                                </IconButton>
                              )}
                            </InputAdornment>
                          ),
                        }}
                      />
                    )
                  }
                  return (
                    <TextField
                      value={passwordInput}
                      onChange={(e) => setPasswordInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSetPassword()}
                      placeholder="Set a password..."
                      size="small"
                      fullWidth
                      sx={inputSx}
                      InputProps={{
                        endAdornment: (
                          <InputAdornment position="end" sx={{ gap: 0.25 }}>
                            {passwordLoading ? (
                              <CircularProgress size={16} sx={{ color: '#FFFFFF66' }} />
                            ) : (
                              <>
                                <IconButton
                                  size="small"
                                  onClick={async () => {
                                    setPasswordLoading(true)
                                    try {
                                      const res = await VideoService.generatePassword(vid.video_id)
                                      setPasswordReveal(res.data?.generated_password)
                                      setHasPassword(true)
                                    } catch {
                                      setAlert({
                                        type: 'error',
                                        message: 'Failed to generate password.',
                                        open: true,
                                      })
                                    }
                                    setPasswordLoading(false)
                                  }}
                                  sx={{ ...adornmentBtnSx, '&:hover': { color: '#90CAF9' } }}
                                >
                                  <RefreshIcon sx={{ fontSize: 16 }} />
                                </IconButton>
                                <IconButton
                                  size="small"
                                  onClick={handleSetPassword}
                                  disabled={!passwordInput.trim()}
                                  sx={adornmentBtnSx}
                                >
                                  <CheckIcon sx={{ fontSize: 16 }} />
                                </IconButton>
                              </>
                            )}
                          </InputAdornment>
                        ),
                      }}
                    />
                  )
                })()}
              </Box>
            )}

            {suggestions.some((s) => s.video_id !== videoId) &&
              !editMode &&
              getSetting('ui_config')?.show_suggestions !== false && (
                <Box>
                  <Typography sx={labelSx}>Suggested</Typography>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                    {suggestions
                      .filter((s) => s.video_id !== videoId)
                      .map((suggestion) => (
                        <SuggestionCard
                          key={suggestion.video_id}
                          video={suggestion}
                          onSelect={onSuggestionSelect}
                        />
                      ))}
                  </Box>
                </Box>
              )}
          </MediaPanel>
        }
        below={
          editMode &&
          authenticated && (
            <Box
              sx={{
                display: { xs: 'none', md: 'block' },
                borderTop: '1px solid #FFFFFF1A',
                bgcolor: '#020D1A',
                px: 2,
                py: 1,
                overflow: 'hidden',
              }}
            >
              <WaveformCropper
                ref={waveformRef}
                key={vid.video_id}
                videoId={vid.video_id}
                duration={vid.info?.duration || 0}
                startTime={cropStart}
                endTime={cropEnd}
                onChange={({ startTime, endTime }) => {
                  setCropStart(startTime)
                  setCropEnd(endTime)
                }}
                onSeek={(time) => playerRef.current?.seek(time)}
                getCurrentTime={() => playerRef.current?.currentTime() ?? 0}
              />
            </Box>
          )
        }
      />
    </>
  )
}

export default VideoModal
