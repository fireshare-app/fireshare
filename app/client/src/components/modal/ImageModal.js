import * as React from 'react'
import { Box, Button, IconButton, TextField, Tooltip, Typography, useMediaQuery, useTheme } from '@mui/material'
import LinkIcon from '@mui/icons-material/Link'
import DownloadIcon from '@mui/icons-material/Download'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'
import { ImageService, TagService } from '../../services'
import Api from '../../services/Api'
import {
  applyImageUpdate,
  copyLink,
  downloadFile,
  downloadName,
  getImageApiUrl,
  getImageUrl,
  getPublicImageUrl,
  getSetting,
  mediaTitle,
} from '../../common/utils'
import TagChip from '../ui/TagChip'
import DateField from './DateField'
import { UploaderSelect, useUploaderCandidates } from '../user/UploaderPicker'
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

// Date and time fields from a stored timestamp, and back to the naive local ISO
// string the server stores as entered, without any timezone conversion.
const splitDate = (iso) => {
  if (!iso) return [null, '']
  const d = new Date(iso)
  const pad = (n) => n.toString().padStart(2, '0')
  return [d, `${pad(d.getHours())}:${pad(d.getMinutes())}`]
}

const joinDate = (dateVal, timeVal) => {
  if (!dateVal) return null
  const d = new Date(dateVal)
  if (timeVal) {
    const [h, m] = timeVal.split(':')
    d.setHours(+h, +m, 0, 0)
  }
  const pad = (n) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
}

/**
 * An image in the same modal a video gets: the image on a black stage at its
 * own aspect ratio, and the side panel with its title, views, date, uploader,
 * game, tags and description. Editing sits behind the Edit button, as it does
 * for a video. Title, description and date are saved together with Save; game,
 * tags, visibility and uploader take effect as soon as they change.
 *
 * onClose receives what changed, for the page to merge into its list.
 */
const ImageModal = ({ open, onClose, image, alertHandler, authenticated, onNext, onPrev, startInEditMode = false }) => {
  const theme = useTheme()
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'))
  const [details, setDetails] = React.useState(null)
  const [editMode, setEditMode] = React.useState(false)
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [selectedDate, setSelectedDate] = React.useState(null)
  const [selectedTime, setSelectedTime] = React.useState('')
  const [privateView, setPrivateView] = React.useState(false)
  const [selectedGame, setSelectedGame] = React.useState(null)
  const [tags, setTags] = React.useState([])
  const [allTags, setAllTags] = React.useState([])
  const [uploader, setUploader] = React.useState(null)
  const [saving, setSaving] = React.useState(false)
  const [imgLoaded, setImgLoaded] = React.useState(false)
  const [showSwipeHint, setShowSwipeHint] = React.useState(false)
  const [panningDisabled, setPanningDisabled] = React.useState(true)
  const { users: uploaderCandidates, forbidden: uploaderForbidden } = useUploaderCandidates(open && authenticated)
  // Everything saved while the modal was open, reported to the page on close.
  const changesRef = React.useRef({})
  const wasOpenRef = React.useRef(false)
  const transformRef = React.useRef(null)
  const prevZoomedRef = React.useRef(false)

  const imageId = image?.image_id
  const shown = details || image
  // nginx serves the WebP as a plain file, with no fallback, so an image without
  // one would show as its title. The API sends the original instead.
  const [webpFailedFor, setWebpFailedFor] = React.useState(null)
  const fullImageUrl = webpFailedFor === imageId ? getImageApiUrl(imageId) : getImageUrl(imageId)
  const canTagGames = authenticated || getSetting('ui_config')?.allow_public_game_tag

  // The saved values, which the edit fields start from and Cancel returns to.
  const savedTitle = mediaTitle(shown)
  const savedDescription = shown?.info?.description || ''
  const savedCreatedAt = shown?.created_at || null

  const resetDrafts = React.useCallback((source) => {
    setTitle(source?.info?.title || mediaTitle(source))
    setDescription(source?.info?.description || '')
    const [d, t] = splitDate(source?.created_at)
    setSelectedDate(d)
    setSelectedTime(t)
  }, [])

  React.useEffect(() => {
    if (!open || !image) {
      wasOpenRef.current = false
      setDetails(null)
      setEditMode(false)
      setImgLoaded(false)
      setShowSwipeHint(false)
      setPanningDisabled(true)
      changesRef.current = {}
      return
    }
    let cancelled = false
    setDetails(null)
    resetDrafts(image)
    setPrivateView(image.info?.private || false)
    setSelectedGame(image.game || null)
    setTags(image.tags || [])
    setUploader(image.uploader?.username ?? null)
    if (!wasOpenRef.current) setEditMode(Boolean(startInEditMode && authenticated))
    else setEditMode(false)

    ImageService.addView(image.image_id).catch(() => {})
    ImageService.getDetails(image.image_id)
      .then((res) => {
        if (cancelled) return
        const d = res.data
        setDetails(d)
        resetDrafts(d)
        setPrivateView(d.info?.private || false)
        setSelectedGame(d.game || null)
        setTags(d.tags || [])
        setUploader(d.uploader?.username ?? null)
      })
      .catch(() => {})
    if (authenticated) {
      TagService.getTags()
        .then((res) => !cancelled && setAllTags(res.data || []))
        .catch(() => {})
    }

    if (!wasOpenRef.current) {
      wasOpenRef.current = true
      setImgLoaded(false)
      const preload = new window.Image()
      preload.onload = () => !cancelled && setImgLoaded(true)
      preload.onerror = () => {
        if (cancelled) return
        setWebpFailedFor(image.image_id)
        setImgLoaded(true)
      }
      preload.src = fullImageUrl
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, image?.image_id])

  // Arrow key navigation, except while editing
  React.useEffect(() => {
    if (!open || editMode) return
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.key === 'ArrowRight') onNext?.()
      if (e.key === 'ArrowLeft') onPrev?.()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, editMode, onNext, onPrev])

  // Show swipe hint briefly when modal first opens
  React.useEffect(() => {
    if (!open || !isMobile) return
    setShowSwipeHint(true)
    const t = setTimeout(() => setShowSwipeHint(false), 3000)
    return () => clearTimeout(t)
  }, [open, isMobile])

  // Reset zoom + pan whenever the displayed image changes
  React.useEffect(() => {
    transformRef.current?.resetTransform()
    prevZoomedRef.current = false
    setPanningDisabled(true)
  }, [imageId])

  // Swipe navigation — only fires when fully zoomed out and no multitouch occurred
  const touchStartRef = React.useRef(null)
  const wasMultitouchRef = React.useRef(false)
  const handleTouchStart = React.useCallback((e) => {
    if (e.touches.length === 1) {
      touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      wasMultitouchRef.current = false
    } else {
      wasMultitouchRef.current = true
    }
  }, [])
  const handleTouchEnd = React.useCallback(
    (e) => {
      if (!touchStartRef.current || editMode) return
      const scale = transformRef.current?.state?.scale ?? 1
      if (scale > 1 || wasMultitouchRef.current) {
        touchStartRef.current = null
        return
      }
      const dx = e.changedTouches[0].clientX - touchStartRef.current.x
      const dy = e.changedTouches[0].clientY - touchStartRef.current.y
      touchStartRef.current = null
      if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return
      setShowSwipeHint(false)
      if (dx < 0) onNext?.()
      else onPrev?.()
    },
    [editMode, onNext, onPrev],
  )

  // Keeps a saved change for the page and shows it here straight away.
  const recordChange = (change) => {
    changesRef.current = { ...changesRef.current, ...change }
    setDetails((d) => applyImageUpdate(d || image, change))
  }

  const handleClose = () => onClose(changesRef.current)

  const createdAt = joinDate(selectedDate, selectedTime)
  // Compared at the minute the date field shows, so an untouched date is not
  // sent back and does not lose its seconds.
  const dateChanged = createdAt !== joinDate(...splitDate(savedCreatedAt))
  const dirty = title !== savedTitle || description !== savedDescription || dateChanged

  const handleSave = async () => {
    if (!dirty) {
      setEditMode(false)
      return
    }
    setSaving(true)
    const payload = {
      title: title.trim() || mediaTitle({ path: shown.path }),
      description,
      ...(dateChanged && { created_at: createdAt }),
    }
    try {
      await ImageService.updateDetails(imageId, payload)
      recordChange(payload)
      setTitle(payload.title)
      setEditMode(false)
      alertHandler?.({ open: true, type: 'success', message: 'Details updated.' })
    } catch (err) {
      alertHandler?.({ open: true, type: 'error', message: 'Failed to save changes.' })
    }
    setSaving(false)
  }

  const handleCancel = () => {
    resetDrafts(shown)
    setEditMode(false)
  }

  const handlePrivacyToggle = async () => {
    try {
      await ImageService.updatePrivacy(imageId, !privateView)
      recordChange({ private: !privateView })
      alertHandler?.({
        open: true,
        type: privateView ? 'info' : 'warning',
        message: privateView ? 'Added to your public feed' : 'Removed from your public feed',
      })
      setPrivateView((v) => !v)
    } catch (err) {
      alertHandler?.({ open: true, type: 'error', message: 'Failed to update privacy.' })
    }
  }

  const handleGameLinked = async (game, warning) => {
    try {
      await ImageService.linkGame(imageId, game.id)
      setSelectedGame(game)
      recordChange({ game })
      alertHandler?.({
        open: true,
        type: warning ? 'warning' : 'success',
        message: warning ? `Linked to ${game.name}. ${warning}` : `Linked to ${game.name}`,
      })
    } catch (err) {
      alertHandler?.({ open: true, type: 'error', message: 'Failed to link game' })
    }
  }

  const handleUnlinkGame = async () => {
    try {
      await ImageService.unlinkGame(imageId)
      setSelectedGame(null)
      recordChange({ game: null })
      alertHandler?.({ open: true, type: 'info', message: 'Game link removed' })
    } catch (err) {
      alertHandler?.({ open: true, type: 'error', message: 'Failed to unlink game' })
    }
  }

  const handleAddTag = async (tag) => {
    if (!tag) return
    try {
      let tagToAdd = tag
      if (!tag.id) {
        const res = await TagService.createTag({ name: tag.name })
        tagToAdd = res.data
        setAllTags((prev) => [...prev, res.data])
      }
      if (tags.some((t) => t.id === tagToAdd.id)) return
      await ImageService.addTag(imageId, tagToAdd.id)
      const next = [...tags, tagToAdd]
      setTags(next)
      recordChange({ tags: next })
    } catch (err) {
      alertHandler?.({ open: true, type: 'error', message: 'Failed to add tag.' })
    }
  }

  const handleRemoveTag = async (tagId) => {
    try {
      await ImageService.removeTag(imageId, tagId)
      const next = tags.filter((t) => t.id !== tagId)
      setTags(next)
      recordChange({ tags: next })
    } catch (err) {
      alertHandler?.({ open: true, type: 'error', message: 'Failed to remove tag.' })
    }
  }

  // Attribution goes through the admin bulk route rather than the image details
  // PUT, which does not accept an uploader — reassigning ownership is an
  // administrator's call, not part of editing a caption.
  const handleUploaderChange = async (username) => {
    const previous = uploader
    setUploader(username)
    try {
      await Api().post('/api/admin/image-files/bulk-set-uploader', { image_ids: [imageId], username })
      const mention = username ? uploaderCandidates.find((u) => u.username === username) || { username } : null
      recordChange({ uploader: mention })
      alertHandler?.({
        open: true,
        type: 'success',
        message: username ? `Attributed to ${username}` : 'Uploader cleared',
      })
    } catch (err) {
      setUploader(previous)
      alertHandler?.({ open: true, type: 'error', message: 'Failed to update uploader.' })
    }
  }

  if (!image) return null

  const viewActions = (
    <>
      {authenticated && (
        <Tooltip title={privateView ? 'Make public' : 'Make private'}>
          <IconButton
            size="small"
            aria-label={privateView ? 'Make public' : 'Make private'}
            onClick={handlePrivacyToggle}
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
          onClick={() => copyLink(`${getPublicImageUrl()}${imageId}`, alertHandler)}
          sx={actionBtnSx}
        >
          <LinkIcon sx={{ fontSize: 20 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Download">
        <IconButton
          size="small"
          aria-label="Download"
          onClick={() =>
            downloadFile(ImageService.getOriginalUrl(imageId), downloadName(savedTitle, shown.extension))
          }
          sx={actionBtnSx}
        >
          <DownloadIcon sx={{ fontSize: 20 }} />
        </IconButton>
      </Tooltip>
      {authenticated && (
        <Button size="small" variant="outlined" onClick={() => setEditMode(true)} sx={panelButtonSx}>
          Edit
        </Button>
      )}
    </>
  )

  const editActions = (
    <>
      <Button
        size="small"
        onClick={handleCancel}
        disabled={saving}
        sx={{ ...panelButtonSx, borderColor: 'transparent', '&:hover': { bgcolor: '#FFFFFF11' } }}
      >
        Cancel
      </Button>
      <Button
        size="small"
        variant="outlined"
        onClick={handleSave}
        disabled={saving}
        sx={{
          ...panelButtonSx,
          ml: 0,
          color: dirty ? '#3399FF' : '#FFFFFF',
          borderColor: dirty ? '#3399FF88' : '#FFFFFF44',
          '&:hover': { borderColor: dirty ? '#3399FF' : '#FFFFFF99', bgcolor: dirty ? '#3399FF11' : '#FFFFFF11' },
          ...(dirty && { animation: 'blink-blue 0.5s ease-in-out infinite alternate' }),
        }}
      >
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </>
  )

  const viewBody = (
    <>
      <Box>
        <MediaTitle>{savedTitle}</MediaTitle>
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', mt: 0.5, gap: 2 }}>
          <MediaMetaRow viewCount={shown.view_count} date={savedCreatedAt} uploader={shown.uploader} />
          <GamePill game={selectedGame} />
          {tags.length > 0 && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 0.5 }}>
              {tags.map((tag) => (
                <TagChip key={tag.id} name={tag.name} color={tag.color} size="small" />
              ))}
            </Box>
          )}
        </Box>
      </Box>
      {savedDescription && (
        <Typography sx={{ fontSize: 14, color: '#FFFFFF', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
          {savedDescription}
        </Typography>
      )}
    </>
  )

  const editBody = (
    <>
      <Box>
        <Typography sx={labelSx}>Title</Typography>
        <TextField
          fullWidth
          size="small"
          value={title}
          placeholder="Image title"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          autoFocus
          sx={inputSx}
        />
      </Box>
      <Box>
        <Typography sx={labelSx}>Description</Typography>
        <TextField
          fullWidth
          multiline
          rows={4}
          size="small"
          placeholder="Enter an image description..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          inputProps={{ maxLength: 2048 }}
          sx={inputSx}
        />
      </Box>
      {canTagGames && (
        <GameField
          game={selectedGame}
          onLinked={handleGameLinked}
          onUnlink={handleUnlinkGame}
          onError={(err) =>
            alertHandler?.({ open: true, type: 'error', message: err.response?.data || 'Error linking game' })
          }
        />
      )}
      <TagsField tags={tags} allTags={allTags} onAdd={handleAddTag} onRemove={handleRemoveTag} />
      <Box>
        <Typography sx={labelSx}>Created Date</Typography>
        <DateField
          selectedDate={selectedDate}
          selectedTime={selectedTime}
          onDateChange={setSelectedDate}
          onTimeChange={setSelectedTime}
        />
      </Box>
      <Box>
        <Typography sx={labelSx}>Visibility</Typography>
        <Box
          component="button"
          type="button"
          onClick={handlePrivacyToggle}
          sx={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            bgcolor: '#FFFFFF0D',
            border: '1px solid #FFFFFF26',
            borderRadius: '8px',
            px: 1.5,
            py: 1,
            cursor: 'pointer',
            font: 'inherit',
            textAlign: 'left',
            '&:hover': { borderColor: '#FFFFFF55' },
          }}
        >
          {privateView ? (
            <VisibilityOffIcon sx={{ color: '#FF6B6B', fontSize: 20 }} />
          ) : (
            <VisibilityIcon sx={{ color: '#4caf50', fontSize: 20 }} />
          )}
          <Typography sx={{ color: 'white', fontSize: 14, flex: 1 }}>{privateView ? 'Private' : 'Public'}</Typography>
        </Box>
      </Box>
      {!uploaderForbidden && (
        <Box>
          <Typography sx={labelSx}>Uploader</Typography>
          <UploaderSelect users={uploaderCandidates} value={uploader} onChange={handleUploaderChange} />
        </Box>
      )}
    </>
  )

  const stage = (
    <Box
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <TransformWrapper
        onInit={(ref) => {
          transformRef.current = ref
        }}
        minScale={1}
        maxScale={5}
        centerOnInit
        limitToBounds
        doubleClick={{ mode: 'toggle' }}
        panning={{ disabled: panningDisabled, velocityDisabled: true }}
        onTransform={(ref) => {
          const zoomed = ref.state.scale > 1
          if (zoomed !== prevZoomedRef.current) {
            prevZoomedRef.current = zoomed
            setPanningDisabled(!zoomed)
          }
        }}
      >
        <TransformComponent
          wrapperStyle={{ width: '100%', height: '100%' }}
          contentStyle={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <img
            src={fullImageUrl}
            alt={savedTitle}
            onLoad={() => setImgLoaded(true)}
            onError={() => setWebpFailedFor(imageId)}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              display: 'block',
              userSelect: 'none',
            }}
          />
        </TransformComponent>
      </TransformWrapper>

      {/* Swipe hint — bouncing chevrons, mobile only */}
      {showSwipeHint && isMobile && (
        <>
          <Box
            sx={{
              position: 'absolute',
              left: 12,
              top: '50%',
              pointerEvents: 'none',
              zIndex: 10,
              animation: 'bounceLeft 1s ease-in-out infinite',
              '@keyframes bounceLeft': {
                '0%, 100%': { transform: 'translateY(-50%) translateX(0)' },
                '50%': { transform: 'translateY(-50%) translateX(-8px)' },
              },
            }}
          >
            <ChevronLeftIcon
              sx={{ color: 'white', fontSize: 44, opacity: 0.75, filter: 'drop-shadow(0 0 4px rgba(0,0,0,0.8))' }}
            />
          </Box>
          <Box
            sx={{
              position: 'absolute',
              right: 12,
              top: '50%',
              pointerEvents: 'none',
              zIndex: 10,
              animation: 'bounceRight 1s ease-in-out infinite',
              '@keyframes bounceRight': {
                '0%, 100%': { transform: 'translateY(-50%) translateX(0)' },
                '50%': { transform: 'translateY(-50%) translateX(8px)' },
              },
            }}
          >
            <ChevronRightIcon
              sx={{ color: 'white', fontSize: 44, opacity: 0.75, filter: 'drop-shadow(0 0 4px rgba(0,0,0,0.8))' }}
            />
          </Box>
        </>
      )}
    </Box>
  )

  return (
    <MediaModalShell
      open={open && imgLoaded}
      onClose={handleClose}
      aspectRatio={aspectRatioOf(shown.info)}
      stageSx={{ bgcolor: '#000' }}
      stage={stage}
      panel={
        <MediaPanel
          label={editMode ? 'Editing' : 'Viewing'}
          onClose={handleClose}
          actions={editMode ? editActions : viewActions}
        >
          {editMode ? editBody : viewBody}
        </MediaPanel>
      }
    />
  )
}

export default ImageModal
