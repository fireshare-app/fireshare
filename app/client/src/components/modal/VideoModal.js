import React, { useEffect, useRef, useState } from 'react'
import { saveProgress, getResumeTime } from '../../common/videoProgress'
import {
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  InputAdornment,
  Modal,
  Paper,
  Popover,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import TagChip from '../ui/TagChip'
import { motion } from 'framer-motion'
import { DayPicker } from 'react-day-picker'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import AccessTimeIcon from '@mui/icons-material/AccessTime'
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth'
import CloseIcon from '@mui/icons-material/Close'
import CheckIcon from '@mui/icons-material/Check'
import LinkIcon from '@mui/icons-material/Link'
import RefreshIcon from '@mui/icons-material/Refresh'
import LockIcon from '@mui/icons-material/Lock'
import AddPhotoAlternateIcon from '@mui/icons-material/AddPhotoAlternate'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera'
import './datepicker-dark.css'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import VisibilityIcon from '@mui/icons-material/Visibility'
import {
  copyToClipboard,
  getPublicWatchUrl,
  getUrl,
  getVideoSources,
  getSetting,
  getPosterUrl as getVideoPosterUrl,
} from '../../common/utils'
import { ConfigService, VideoService, GameService, TagService } from '../../services'
import SnackbarAlert from '../alert/SnackbarAlert'
import VideoJSPlayer from '../player/VideoJSPlayer'
import GameSearch from '../game/GameSearch'
import SuggestionCard from '../cards/SuggestionCard'
import UploaderMention from '../user/UploaderMention'
import WaveformCropper from './WaveformCropper'
import TonemapCompareModal, { TONEMAP_LABELS } from './TonemapCompareModal'

const URL = getUrl()
const PURL = getPublicWatchUrl()
const APP_ORIGIN = window.location.origin

// ─── Shared style constants (matching UpdateDetailsModal / CompactVideoCard) ──

const labelSx = {
  fontSize: 11,
  color: '#FFFFFFB3',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  mb: 0.75,
}

const inputSx = {
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

const rowBoxSx = {
  display: 'flex',
  alignItems: 'center',
  gap: 1,
  bgcolor: '#FFFFFF0D',
  border: '1px solid #FFFFFF26',
  borderRadius: '8px',
  px: 1.5,
  py: 1,
}

const smallBtnSx = {
  fontSize: 12,
  textTransform: 'none',
  color: '#fff',
  borderColor: '#FFFFFF44',
  '&:hover': { borderColor: '#FFFFFF99', bgcolor: '#FFFFFF11' },
  '&.Mui-disabled': { color: '#FFFFFF55', borderColor: '#FFFFFF1A' },
}

const actionBtnSx = {
  color: '#FFFFFFB3',
  bgcolor: '#FFFFFF0D',
  border: '1px solid #FFFFFF1A',
  borderRadius: '8px',
  p: 1,
  '&:hover': { bgcolor: '#FFFFFF1A', color: 'white' },
}

const SIDEBAR_WIDTH = 'clamp(280px, 24vw, 420px)'

// Viewport inset around the modal on the side-by-side layout.
const MODAL_PAD = 96
// Short viewports (a phone held in landscape) can't spare 96px per side — the
// video ends up a sliver — so they get a much smaller inset.
const MODAL_PAD_SHORT = 24
const SHORT_MD = '@media (min-width: 900px) and (max-height: 620px)'
// Narrow *and* short: too little height to stack the video above the info
// panel, so lay them out side by side like the desktop layout.
const NARROW_SHORT = '@media (max-width: 899.95px) and (max-height: 620px)'
// Cap for the stacked layout so the info panel — and with it the close button,
// share actions and suggestions — always stays on screen for portrait videos.
const STACKED_VIDEO_MAX_H = '60dvh'

/**
 * Video box dimensions for the side-by-side layout: the largest box with the
 * video's aspect ratio that fits the viewport minus the inset and the sidebar.
 */
const sideBySideVideo = (ar, pad) => {
  const h = `min(calc((100vw - ${2 * pad}px - ${SIDEBAR_WIDTH}) / ${ar}), calc(100dvh - ${2 * pad}px))`
  return { h, w: `calc((${h}) * ${ar})` }
}

const timeInputStyle = {
  background: '#FFFFFF0D',
  border: '1px solid #FFFFFF26',
  borderRadius: 6,
  color: 'white',
  fontSize: 13,
  padding: '4px 8px',
  colorScheme: 'dark',
  flex: 1,
}

const DateField = ({ selectedDate, selectedTime, onDateChange, onTimeChange }) => {
  const [anchor, setAnchor] = React.useState(null)
  const display = selectedDate
    ? selectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      (selectedTime ? ` at ${selectedTime}` : '')
    : null
  return (
    <>
      <Box
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{ ...rowBoxSx, cursor: 'pointer', py: 1.1, '&:hover': { borderColor: '#FFFFFF55' } }}
      >
        <CalendarMonthIcon sx={{ color: '#FFFFFF66', fontSize: 20 }} />
        <Typography sx={{ color: display ? 'white' : '#FFFFFF4D', fontSize: 14, flex: 1 }}>
          {display || 'Pick a date…'}
        </Typography>
        {selectedDate && (
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation()
              onDateChange(null)
              onTimeChange('')
            }}
            sx={{ color: '#FFFFFF66', '&:hover': { color: 'white' }, p: 0.25 }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        )}
      </Box>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { bgcolor: 'transparent', boxShadow: 'none', mt: 0.5 } } }}
      >
        <div className="fireshare-rdp">
          <DayPicker
            animate
            mode="single"
            selected={selectedDate}
            onSelect={(d) => onDateChange(d || null)}
            defaultMonth={selectedDate || new Date()}
            captionLayout="dropdown"
            startMonth={new Date(1970, 0)}
            endMonth={new Date(new Date().getFullYear() + 1, 11)}
          />
          <Box sx={{ px: 1, pb: 1, display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Typography sx={{ color: '#FFFFFFB3', fontSize: 13 }}>Time</Typography>
            <input
              type="time"
              value={selectedTime}
              onChange={(e) => onTimeChange(e.target.value)}
              style={timeInputStyle}
            />
            <Button
              size="small"
              variant="contained"
              onClick={() => setAnchor(null)}
              sx={{ bgcolor: '#3399FF', '&:hover': { bgcolor: '#1976D2' }, minWidth: 60 }}
            >
              Done
            </Button>
          </Box>
        </div>
      </Popover>
    </>
  )
}

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
  const [gamePillColor, setGamePillColor] = React.useState(null)
  const [videoTags, setVideoTags] = React.useState([])
  const [allTags, setAllTags] = React.useState([])
  const [tagInputValue, setTagInputValue] = React.useState('')
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
  // HDR sources: the tone map in progress, what this server can run, the operator
  // staged in the row's select, and the compare modal.
  const [tonemapProcessing, setTonemapProcessing] = React.useState(false)
  const [tonemapCaps, setTonemapCaps] = React.useState(null)
  const [stagedTonemap, setStagedTonemap] = React.useState('')
  const [compareOpen, setCompareOpen] = React.useState(false)
  const [removeTonemapConfirm, setRemoveTonemapConfirm] = React.useState(false)
  const tonemapPollRef = React.useRef(null)

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

  React.useEffect(() => {
    if (!selectedGame?.icon_url) {
      setGamePillColor(null)
      return
    }

    const img = new Image()
    img.crossOrigin = 'anonymous'

    img.onload = () => {
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
        const alpha = data[i + 3]
        if (alpha < 128) continue

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

      setGamePillColor(bestSaturation > 0.2 ? bestColor : null)
    }

    img.onerror = () => setGamePillColor(null)
    img.src = selectedGame.icon_url
  }, [selectedGame?.icon_url])

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
      clearInterval(tonemapPollRef.current)
      setCropProcessing(false)
      setTonemapProcessing(false)
      setCompareOpen(false)
      setStagedTonemap('')
      // Drop the player wrapper so the unmounted <video> element it references
      // can be garbage collected along with its decoder resources.
      playerRef.current = null
    }
  }, [open])

  // The SDR copy is built in the background after a tone map is applied. Poll until
  // it is in place (or failed), then move the player onto it.
  const startTonemapPoll = (videoId) => {
    clearInterval(tonemapPollRef.current)
    tonemapPollRef.current = setInterval(async () => {
      try {
        const res = await VideoService.getDetails(videoId)
        const info = res.data?.info
        if (!info) return
        if (info.has_sdr || info.sdr_error || !info.tonemap) {
          clearInterval(tonemapPollRef.current)
          setVideo((prev) => (prev ? { ...prev, info: { ...prev.info, ...info } } : prev))
          setPlayerVersion((v) => v + 1)
          setPosterCacheKey(Date.now())
          if (info.sdr_error) setAlert({ type: 'error', message: `SDR copy failed: ${info.sdr_error}`, open: true })
        }
      } catch {
        // ignore transient poll errors
      }
    }, 3000)
  }

  useEffect(() => {
    const info = vid?.info
    const converting = Boolean(info?.tonemap) && !info?.has_sdr && !info?.sdr_error
    setTonemapProcessing(converting)
    // Viewers keep watching the original while the copy is built; only an editor
    // (who sees the row's status) needs to hear when it is ready.
    if (converting && open && authenticated) startTonemapPoll(vid.video_id)
    else clearInterval(tonemapPollRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, authenticated, vid?.video_id, vid?.info?.tonemap, vid?.info?.has_sdr, vid?.info?.sdr_error])

  useEffect(() => {
    if (!editMode || !authenticated || !vid?.info?.is_hdr || tonemapCaps) return
    VideoService.getTonemapCapabilities()
      .then((res) => setTonemapCaps(res.data))
      .catch(() => setTonemapCaps({ operators: [], auto_default: null }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, authenticated, vid?.info?.is_hdr])

  const applyTonemap = async (operator) => {
    try {
      await VideoService.setTonemap(vid.video_id, operator)
      setCompareOpen(false)
      setStagedTonemap('')
      setVideo((prev) => ({ ...prev, info: { ...prev.info, tonemap: operator, has_sdr: false, sdr_error: null } }))
      setAlert({
        type: 'info',
        message: `Converting to SDR with ${TONEMAP_LABELS[operator] || operator}. The player switches over when it is ready.`,
        open: true,
      })
    } catch (err) {
      setAlert({ type: 'error', message: err.response?.data?.message || 'Failed to apply the tone map', open: true })
    }
  }

  const removeTonemap = async () => {
    setRemoveTonemapConfirm(false)
    try {
      await VideoService.setTonemap(vid.video_id, null)
      setCompareOpen(false)
      setStagedTonemap('')
      setVideo((prev) => ({ ...prev, info: { ...prev.info, tonemap: null, has_sdr: false, sdr_error: null } }))
      setPlayerVersion((v) => v + 1)
      setPosterCacheKey(Date.now())
      setAlert({ type: 'info', message: 'Tone map removed. The source is the HDR original again.', open: true })
    } catch (err) {
      setAlert({ type: 'error', message: err.response?.data?.message || 'Failed to remove the tone map', open: true })
    }
  }

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
      setTagInputValue('')
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
    copyToClipboard(`${PURL}${vid.video_id}?t=${currentTime}`)
    setAlert({ type: 'info', message: 'Time stamped link copied to clipboard', open: true })
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
  const ar = Number(((vid?.info?.width || 16) / (vid?.info?.height || 9)).toFixed(6))
  const videoBox = sideBySideVideo(ar, MODAL_PAD)
  const videoBoxShort = sideBySideVideo(ar, MODAL_PAD_SHORT)

  return (
    <>
      <SnackbarAlert severity={alert.type} open={alert.open} setOpen={(open) => setAlert({ ...alert, open })}>
        {alert.message}
      </SnackbarAlert>

      <Modal
        open={open}
        onClose={onClose}
        disableAutoFocus={true}
        slotProps={{ backdrop: { sx: { backgroundColor: 'rgba(0, 0, 0, 0.7)' } } }}
      >
        {/* Centering wrapper — click-outside closes modal */}
        <Box
          tabIndex={-1}
          sx={{
            outline: 'none',
            display: 'flex',
            height: '100%',
            alignItems: { xs: 'flex-start', md: 'center' },
            justifyContent: 'center',
            // Full-screen on small viewports, padded on desktop
            p: { xs: 0, md: `${MODAL_PAD}px` },
            [SHORT_MD]: { p: `${MODAL_PAD_SHORT}px` },
            overflowY: { xs: 'hidden', md: 'unset' },
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose()
          }}
        >
          <motion.div
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
                width: { xs: '100%', md: `calc(${videoBox.w} + ${SIDEBAR_WIDTH})` },
                [SHORT_MD]: { width: `calc(${videoBoxShort.w} + ${SIDEBAR_WIDTH})` },
                height: { xs: '100dvh', md: 'auto' },
                maxHeight: { xs: '100dvh', md: '100%' },
                maxWidth: '100%',
              }}
            >
              {/* ── Top row: Video + Sidebar ─────────────────────────────────── */}
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: { xs: 'column', md: 'row' },
                  height: { xs: '100%', md: videoBox.h },
                  [SHORT_MD]: { height: videoBoxShort.h },
                  [NARROW_SHORT]: { flexDirection: 'row' },
                  overflow: 'hidden',
                }}
              >
                {/* ── Left: Video Player ───────────────────────────────────────── */}
                <Box
                  sx={{
                    position: 'relative',
                    flexShrink: 0,
                    bgcolor: '#020D1A',
                    // Stacked: full width at the video's aspect ratio, capped in height
                    // so the info panel below it always stays on screen.
                    // Side-by-side: explicit dimensions from CSS.
                    width: { xs: '100%', md: videoBox.w },
                    height: { xs: `min(calc(100vw / ${ar}), ${STACKED_VIDEO_MAX_H})`, md: '100%' },
                    [SHORT_MD]: { width: videoBoxShort.w },
                    // Fill whatever is left beside the sidebar; the video letterboxes itself.
                    [NARROW_SHORT]: { flex: 1, minWidth: 0, width: 'auto', height: '100%' },
                    // Override VideoJS default 8px border-radius responsively
                    '& > div': {
                      borderRadius: {
                        xs: '0 !important',
                        md: editMode ? '8px 0 0 0 !important' : '8px 0 0 8px !important',
                      },
                    },
                  }}
                >
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
                </Box>

                {/* ── Right: Info Sidebar ──────────────────────────────────────── */}
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
                  {/* Header */}
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
                      Now Playing
                    </Typography>
                    <IconButton
                      onClick={onClose}
                      size="small"
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

                  {/* Scrollable info content */}
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
                        <Typography
                          sx={{
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
                          {title || 'Untitled'}
                        </Typography>
                      )}
                      {/* Views + Game inline row */}
                      {!editMode && (
                        <Box
                          sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', mt: 0.5, gap: 2 }}
                        >
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                            <Typography sx={{ fontSize: 14, color: '#FFFFFF55', flexShrink: 0 }}>
                              {(vid.view_count ?? 0).toLocaleString()} {vid.view_count === 1 ? 'view' : 'views'}
                            </Typography>
                            {vid.recorded_at && (
                              <>
                                <Typography sx={{ fontSize: 14, color: '#FFFFFF55' }}>|</Typography>
                                <Typography sx={{ fontSize: 14, color: '#FFFFFF55' }}>
                                  {new Date(vid.recorded_at).toLocaleDateString('en-US', {
                                    month: 'short',
                                    day: 'numeric',
                                    year: 'numeric',
                                  })}
                                </Typography>
                              </>
                            )}
                            {vid.uploader && (
                              <>
                                <Typography sx={{ fontSize: 14, color: '#FFFFFF55' }}>|</Typography>
                                <UploaderMention uploader={vid.uploader} size={20} />
                              </>
                            )}
                          </Box>
                          {selectedGame && (
                            <Box
                              component={selectedGame.steamgriddb_id ? 'a' : 'div'}
                              href={
                                selectedGame.steamgriddb_id
                                  ? `${APP_ORIGIN}/games/${selectedGame.steamgriddb_id}`
                                  : undefined
                              }
                              onClick={selectedGame.steamgriddb_id ? (e) => e.stopPropagation() : undefined}
                              sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 0.75,
                                minWidth: 0,
                                bgcolor: gamePillColor ? `rgba(${gamePillColor.join(',')}, 0.15)` : '#FFFFFF14',
                                border: `1px solid ${gamePillColor ? `rgba(${gamePillColor.join(',')}, 0.5)` : '#FFFFFF26'}`,
                                borderRadius: '8px',
                                px: 1,
                                py: 0.35,
                                textDecoration: 'none',
                                flexShrink: 0,
                                ...(selectedGame.steamgriddb_id && {
                                  cursor: 'pointer',
                                  '&:hover': {
                                    bgcolor: gamePillColor ? `rgba(${gamePillColor.join(',')}, 0.4)` : '#FFFFFF22',
                                  },
                                }),
                              }}
                            >
                              {selectedGame.icon_url && (
                                <img
                                  src={selectedGame.icon_url}
                                  alt=""
                                  onError={(e) => {
                                    e.currentTarget.style.display = 'none'
                                  }}
                                  style={{
                                    width: 20,
                                    height: 20,
                                    objectFit: 'contain',
                                    borderRadius: 3,
                                    flexShrink: 0,
                                  }}
                                />
                              )}
                              <Typography
                                sx={{
                                  fontSize: 14,
                                  color: '#FFFFFF',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {selectedGame.name}
                              </Typography>
                            </Box>
                          )}
                          {videoTags.length > 0 && (
                            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 0.5 }}>
                              {videoTags.map((tag) => (
                                <TagChip
                                  key={tag.id}
                                  name={tag.name}
                                  color={tag.color}
                                  href={`${APP_ORIGIN}/tags/${tag.id}`}
                                  size="small"
                                />
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

                    {/* Game search (edit mode only) */}
                    {editMode && (authenticated || getSetting('ui_config')?.allow_public_game_tag) && (
                      <Box>
                        {selectedGame ? (
                          <Box
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 1,
                              bgcolor: '#FFFFFF0D',
                              border: '1px solid #FFFFFF26',
                              borderRadius: '8px',
                              px: 1.5,
                              py: 1,
                            }}
                          >
                            {selectedGame.icon_url && (
                              <img
                                src={selectedGame.icon_url}
                                alt=""
                                onError={(e) => {
                                  e.currentTarget.style.display = 'none'
                                }}
                                style={{ width: 20, height: 20, objectFit: 'contain', borderRadius: 3, flexShrink: 0 }}
                              />
                            )}
                            <Typography
                              sx={{
                                fontSize: 14,
                                color: 'white',
                                flex: 1,
                              }}
                            >
                              {selectedGame.name}
                            </Typography>
                            <IconButton
                              size="small"
                              onClick={handleUnlinkGame}
                              sx={{ color: '#FFFFFF66', '&:hover': { color: 'white' }, p: 0.25 }}
                            >
                              <CloseIcon sx={{ fontSize: 16 }} />
                            </IconButton>
                          </Box>
                        ) : (
                          <Box
                            sx={{
                              ...rowBoxSx,
                              py: 0,
                              overflow: 'hidden',
                              '& .MuiInputBase-root': { color: 'white', px: 0 },
                              '& input::placeholder': { color: '#FFFFFF66', opacity: 1 },
                              '& .MuiSvgIcon-root': { color: '#FFFFFF66' },
                            }}
                          >
                            <GameSearch
                              onGameLinked={handleGameLinked}
                              onError={(err) =>
                                setAlert({
                                  open: true,
                                  type: 'error',
                                  message: err.response?.data || 'Error linking game',
                                })
                              }
                              placeholder="Search for a game..."
                            />
                          </Box>
                        )}
                      </Box>
                    )}

                    {/* Tags (edit mode only) */}
                    {editMode && authenticated && (
                      <Box>
                        <Typography sx={labelSx}>Tags</Typography>
                        <Autocomplete
                          multiple
                          freeSolo
                          componentsProps={{ root: { sx: { '& .MuiAutocomplete-tag': { my: 0.25 } } } }}
                          sx={{ '& .MuiOutlinedInput-root': { gap: 0.5 } }}
                          options={allTags.filter((t) => !videoTags.find((vt) => vt.id === t.id))}
                          getOptionLabel={(option) => (typeof option === 'string' ? option : option.name)}
                          value={videoTags}
                          inputValue={tagInputValue}
                          onInputChange={(_, v) => setTagInputValue(v)}
                          onChange={(_, newValues) => {
                            if (newValues.length > videoTags.length) {
                              const added = newValues[newValues.length - 1]
                              if (typeof added === 'string') {
                                handleAddTag({ name: added })
                              } else {
                                handleAddTag(added)
                              }
                            }
                          }}
                          renderTags={(value) =>
                            value.map((tag) => (
                              <TagChip
                                key={tag.id}
                                name={tag.name}
                                color={tag.color}
                                size="small"
                                onDelete={() => handleRemoveTag(tag.id)}
                              />
                            ))
                          }
                          renderInput={(params) => (
                            <TextField
                              {...params}
                              size="small"
                              placeholder={videoTags.length === 0 ? 'Add a tag...' : ''}
                              sx={inputSx}
                              inputProps={{ ...params.inputProps, maxLength: 12 }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && tagInputValue.trim()) {
                                  e.preventDefault()
                                  const existing = allTags.find(
                                    (t) => t.name.toLowerCase() === tagInputValue.trim().toLowerCase(),
                                  )
                                  handleAddTag(existing || { name: tagInputValue.trim() })
                                }
                                if (e.key === ',') {
                                  e.preventDefault()
                                  const parts = tagInputValue
                                    .split(',')
                                    .map((s) => s.trim())
                                    .filter(Boolean)
                                  setTagInputValue('')
                                  parts.forEach((p) => {
                                    const existing = allTags.find((t) => t.name.toLowerCase() === p.toLowerCase())
                                    handleAddTag(existing || { name: p })
                                  })
                                }
                              }}
                            />
                          )}
                        />
                      </Box>
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
                        {(() => {
                          const info = vid.info
                          const ops = tonemapCaps?.operators || []
                          const value = stagedTonemap || info.tonemap || tonemapCaps?.auto_default || ''
                          const selectedOp = ops.find((o) => o.id === value)
                          const canApply =
                            Boolean(value) &&
                            Boolean(selectedOp?.available) &&
                            !tonemapProcessing &&
                            (value !== info.tonemap || !info.has_sdr)
                          const status = tonemapProcessing
                            ? {
                                text: `Converting to SDR with ${TONEMAP_LABELS[info.tonemap] || info.tonemap}…`,
                                color: '#4AA3FF',
                              }
                            : info.sdr_error
                              ? { text: `SDR copy failed: ${info.sdr_error}`, color: '#FF6B6B' }
                              : info.has_sdr
                                ? {
                                    text: `Plays as SDR · ${TONEMAP_LABELS[info.tonemap] || info.tonemap}`,
                                    color: '#4CC08A',
                                  }
                                : {
                                    text: 'Plays the HDR original, which looks washed out on most displays',
                                    color: '#FFFFFF80',
                                  }
                          return (
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                                <Chip
                                  label="HDR"
                                  size="small"
                                  sx={{
                                    height: 18,
                                    fontSize: 10,
                                    color: '#F0824A',
                                    border: '1px solid #F0824A',
                                    bgcolor: 'transparent',
                                    '& .MuiChip-label': { px: 0.75 },
                                  }}
                                />
                                <Typography sx={{ fontSize: 12, color: status.color }}>{status.text}</Typography>
                              </Box>
                              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                                <select
                                  value={value}
                                  disabled={tonemapProcessing || ops.length === 0}
                                  onChange={(e) => setStagedTonemap(e.target.value)}
                                  aria-label="Tone map operator"
                                  style={{
                                    background: '#FFFFFF0D',
                                    color: 'white',
                                    border: '1px solid #FFFFFF26',
                                    borderRadius: 8,
                                    padding: '6px 8px',
                                    fontSize: 13,
                                    flex: 1,
                                    minWidth: 120,
                                  }}
                                >
                                  {ops.length === 0 && (
                                    <option value="">
                                      {tonemapCaps ? 'No tone map filters in this ffmpeg' : 'Loading…'}
                                    </option>
                                  )}
                                  {ops.map((o) => (
                                    <option key={o.id} value={o.id} disabled={!o.available}>
                                      {TONEMAP_LABELS[o.id] || o.id}
                                      {o.id === tonemapCaps?.auto_default ? ' (default)' : ''}
                                      {o.available ? '' : ' – unavailable'}
                                    </option>
                                  ))}
                                </select>
                                <Button
                                  size="small"
                                  variant="outlined"
                                  disabled={!canApply}
                                  onClick={() => applyTonemap(value)}
                                  sx={smallBtnSx}
                                >
                                  Apply
                                </Button>
                                <Button
                                  size="small"
                                  variant="outlined"
                                  disabled={tonemapProcessing || ops.length === 0}
                                  onClick={() => setCompareOpen(true)}
                                  sx={smallBtnSx}
                                >
                                  Compare…
                                </Button>
                              </Box>
                              {info.tonemap &&
                                !tonemapProcessing &&
                                (removeTonemapConfirm ? (
                                  <Box
                                    sx={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 1,
                                      flexWrap: 'wrap',
                                      p: 1,
                                      borderRadius: '8px',
                                      bgcolor: '#F0824A14',
                                      border: '1px solid #F0824A44',
                                    }}
                                  >
                                    <Typography sx={{ fontSize: 12, flex: 1, minWidth: 160 }}>
                                      Delete the SDR copy and play the HDR original again?
                                    </Typography>
                                    <Button
                                      size="small"
                                      variant="outlined"
                                      onClick={() => setRemoveTonemapConfirm(false)}
                                      sx={smallBtnSx}
                                    >
                                      Keep
                                    </Button>
                                    <Button
                                      size="small"
                                      variant="outlined"
                                      onClick={removeTonemap}
                                      sx={{
                                        ...smallBtnSx,
                                        color: '#F5A37C',
                                        borderColor: '#F0824A66',
                                        '&:hover': { borderColor: '#F0824A', bgcolor: '#F0824A1F' },
                                      }}
                                    >
                                      Remove
                                    </Button>
                                  </Box>
                                ) : (
                                  <Button
                                    size="small"
                                    variant="text"
                                    onClick={() => setRemoveTonemapConfirm(true)}
                                    sx={{
                                      alignSelf: 'flex-start',
                                      fontSize: 12,
                                      textTransform: 'none',
                                      color: '#F5A37C',
                                      px: 0.5,
                                    }}
                                  >
                                    Remove tone map
                                  </Button>
                                ))}
                            </Box>
                          )
                        })()}
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
                  </Box>

                  <Divider sx={{ borderColor: '#FFFFFF14', flexShrink: 0 }} />

                  {/* Action buttons footer */}
                  <Box
                    sx={{
                      px: 2.5,
                      py: 2,
                      flexShrink: 0,
                      display: 'flex',
                      gap: 1,
                      flexWrap: 'wrap',
                    }}
                  >
                    {authenticated && (
                      <Tooltip title={privateView ? 'Make public' : 'Make private'}>
                        <IconButton
                          size="small"
                          onClick={handlePrivacyChange}
                          sx={{ ...actionBtnSx, color: privateView ? '#FF6B6B' : '#FFFFFFB3' }}
                        >
                          {privateView ? (
                            <VisibilityOffIcon sx={{ fontSize: 20 }} />
                          ) : (
                            <VisibilityIcon sx={{ fontSize: 20 }} />
                          )}
                        </IconButton>
                      </Tooltip>
                    )}

                    <Tooltip title="Copy link">
                      <IconButton
                        size="small"
                        onClick={() => {
                          copyToClipboard(`${PURL}${vid.video_id}`)
                          setAlert({ type: 'info', message: 'Link copied to clipboard', open: true })
                        }}
                        sx={actionBtnSx}
                      >
                        <LinkIcon sx={{ fontSize: 20 }} />
                      </IconButton>
                    </Tooltip>

                    <Tooltip title="Copy timestamp link">
                      <IconButton size="small" onClick={copyTimestamp} sx={actionBtnSx}>
                        <AccessTimeIcon sx={{ fontSize: 20 }} />
                      </IconButton>
                    </Tooltip>

                    {authenticated &&
                      (editMode ? (
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={update}
                          sx={{
                            ml: 'auto',
                            fontSize: 12,
                            fontWeight: 400,
                            color: updateable ? '#3399FF' : '#FFFFFF',
                            textTransform: 'uppercase',
                            letterSpacing: '0.08em',
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
                        <Button
                          size="small"
                          onClick={() => setEditMode(true)}
                          variant="outlined"
                          sx={{
                            ml: 'auto',
                            fontSize: 12,
                            fontWeight: 400,
                            color: '#FFFFFF',
                            textTransform: 'uppercase',
                            letterSpacing: '0.08em',
                            borderColor: '#FFFFFF44',
                            borderRadius: '8px',
                            '&:hover': { borderColor: '#FFFFFF99', bgcolor: '#FFFFFF11' },
                          }}
                        >
                          Edit
                        </Button>
                      ))}
                  </Box>
                </Box>
              </Box>

              {/* ── Waveform Cropper (edit mode only) ────────────────────────── */}
              {editMode && authenticated && (
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
              )}
            </Paper>
          </motion.div>
        </Box>
      </Modal>
      {vid && (
        <TonemapCompareModal
          open={compareOpen}
          onClose={() => setCompareOpen(false)}
          videoId={vid.video_id}
          videoInfo={vid.info}
          capabilities={tonemapCaps}
          getCurrentTime={() => playerRef.current?.currentTime() ?? 0}
          onApply={applyTonemap}
          onRemove={removeTonemap}
          busy={tonemapProcessing}
        />
      )}
    </>
  )
}

export default VideoModal
