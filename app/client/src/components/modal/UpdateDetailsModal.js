import * as React from 'react'
import {
  Modal,
  Box,
  Typography,
  Button,
  Stack,
  TextField,
  InputAdornment,
  IconButton,
  Divider,
  Chip,
  Autocomplete,
  CircularProgress,
} from '@mui/material'
import TagChip from '../ui/TagChip'
import CloseIcon from '@mui/icons-material/Close'
import CheckIcon from '@mui/icons-material/Check'
import RefreshIcon from '@mui/icons-material/Refresh'
import LockIcon from '@mui/icons-material/Lock'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import { VideoService, GameService, TagService } from '../../services'
import Api from '../../services/Api'
import GameSearch from '../game/GameSearch'
import DateField from './DateField'
import { UploaderSelect, useUploaderCandidates } from '../user/UploaderPicker'
import { labelSx, inputSx, rowBoxSx, dialogPaperSx } from '../../common/modalStyles'
import TonemapControls from './TonemapControls'

const modalSx = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 500,
  maxWidth: 'calc(100vw - 32px)',
  maxHeight: 'calc(100svh - 32px)',
  overflowY: 'auto',
  p: 4,
  ...dialogPaperSx,
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const LabeledField = ({ label, children }) => (
  <Box>
    <Typography sx={labelSx}>{label}</Typography>
    {children}
  </Box>
)

const LinkedGameField = ({ game, onLink, onUnlink, alertHandler }) => {
  if (game) {
    return (
      <Box sx={rowBoxSx}>
        {game.icon_url && (
          <img
            src={game.icon_url}
            alt=""
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
            style={{ width: 28, height: 28, borderRadius: 4, objectFit: 'contain' }}
          />
        )}
        <Typography sx={{ color: 'white', fontSize: 14, flex: 1 }}>{game.name}</Typography>
        <IconButton size="small" onClick={onUnlink} sx={{ color: '#FFFFFF66', '&:hover': { color: 'white' }, p: 0.5 }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
    )
  }

  return (
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
        onGameLinked={onLink}
        onError={() => alertHandler?.({ open: true, type: 'error', message: 'Failed to find game.' })}
        onWarning={(msg) => alertHandler?.({ open: true, type: 'warning', message: msg })}
        placeholder="Search for a game..."
        sx={{ flex: 1 }}
      />
    </Box>
  )
}

const TagsField = ({ localTags, allTags, tagInput, setTagInput, setLocalTags, inputSx }) => (
  <Autocomplete
    multiple
    freeSolo
    componentsProps={{ root: { sx: { '& .MuiAutocomplete-tag': { my: 0.25 } } } }}
    sx={{ '& .MuiOutlinedInput-root': { gap: 0.5 } }}
    options={allTags.filter((t) => !localTags.find((lt) => lt.id === t.id))}
    getOptionLabel={(o) => (typeof o === 'string' ? o : o.name)}
    value={localTags}
    inputValue={tagInput}
    onInputChange={(_, v) => setTagInput(v)}
    onChange={(_, values) => {
      const seen = new Set()
      setLocalTags(
        values
          .map((v) => (typeof v === 'string' ? { name: v } : v))
          .filter((t) => {
            const key = (t.name || '').toLowerCase()
            if (!key || seen.has(key)) return false
            seen.add(key)
            return true
          }),
      )
      setTagInput('')
    }}
    renderTags={(value, getTagProps) =>
      value.map((tag, idx) => {
        const { onDelete } = getTagProps({ index: idx })
        return (
          <TagChip key={tag.id ?? `new-${idx}`} name={tag.name} color={tag.color} size="small" onDelete={onDelete} />
        )
      })
    }
    renderInput={(params) => (
      <TextField
        {...params}
        size="small"
        placeholder="Add clip tags..."
        sx={inputSx}
        inputProps={{ ...params.inputProps, maxLength: 12 }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
            e.preventDefault()
            const parts = tagInput
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
            setTagInput('')
            setLocalTags((prev) => {
              const merged = [...prev]
              parts.forEach((p) => {
                if (!merged.find((t) => (t.name || '').toLowerCase() === p.toLowerCase())) {
                  merged.push(allTags.find((t) => t.name.toLowerCase() === p.toLowerCase()) || { name: p })
                }
              })
              return merged
            })
          }
        }}
      />
    )}
  />
)

const PasswordField = ({ videoId, hasPassword, onPasswordChange, alertHandler }) => {
  const [customInput, setCustomInput] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [reveal, setReveal] = React.useState(null)

  const handleSet = async () => {
    if (!customInput.trim()) return
    setLoading(true)
    try {
      await VideoService.setPassword(videoId, customInput.trim())
      setCustomInput('')
      onPasswordChange(true)
      alertHandler?.({ open: true, type: 'success', message: 'Password set.' })
    } catch {
      alertHandler?.({ open: true, type: 'error', message: 'Failed to set password.' })
    }
    setLoading(false)
  }

  const handleGenerate = async () => {
    setLoading(true)
    try {
      const res = await VideoService.generatePassword(videoId)
      setReveal(res.data?.generated_password)
      onPasswordChange(true)
    } catch {
      alertHandler?.({ open: true, type: 'error', message: 'Failed to generate password.' })
    }
    setLoading(false)
  }

  const handleClear = async () => {
    setLoading(true)
    try {
      await VideoService.removePassword(videoId)
      setReveal(null)
      onPasswordChange(false)
      alertHandler?.({ open: true, type: 'info', message: 'Password removed.' })
    } catch {
      alertHandler?.({ open: true, type: 'error', message: 'Failed to remove password.' })
    }
    setLoading(false)
  }

  const adornmentBtnSx = { color: '#FFFFFF66', '&:hover': { color: 'white' }, p: 0.5 }

  if (reveal) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <TextField
          value={reveal}
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
                    navigator.clipboard.writeText(reveal)
                    alertHandler?.({ open: true, type: 'info', message: 'Copied to clipboard.' })
                  }}
                  sx={adornmentBtnSx}
                >
                  <ContentCopyIcon sx={{ fontSize: 16 }} />
                </IconButton>
                <IconButton size="small" onClick={() => setReveal(null)} sx={adornmentBtnSx}>
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
              {loading ? (
                <CircularProgress size={16} sx={{ color: '#FFFFFF66' }} />
              ) : (
                <IconButton
                  size="small"
                  onClick={handleClear}
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
      value={customInput}
      onChange={(e) => setCustomInput(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && handleSet()}
      placeholder="Set a password..."
      size="small"
      fullWidth
      sx={inputSx}
      InputProps={{
        endAdornment: (
          <InputAdornment position="end" sx={{ gap: 0.25 }}>
            {loading ? (
              <CircularProgress size={16} sx={{ color: '#FFFFFF66' }} />
            ) : (
              <>
                <IconButton
                  size="small"
                  onClick={handleGenerate}
                  sx={{ ...adornmentBtnSx, '&:hover': { color: '#90CAF9' } }}
                >
                  <RefreshIcon sx={{ fontSize: 16 }} />
                </IconButton>
                <IconButton size="small" onClick={handleSet} disabled={!customInput.trim()} sx={adornmentBtnSx}>
                  <CheckIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </>
            )}
          </InputAdornment>
        ),
      }}
    />
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

const UpdateDetailsModal = ({
  open,
  close,
  videoId,
  currentTitle,
  currentDescription,
  currentRecordedAt,
  currentGame,
  currentHasPassword,
  currentUploader,
  // The video's info (is_hdr, tonemap, has_sdr...) and how to push tone map changes
  // back, so the Dynamic Range controls can live here too.
  currentInfo,
  onInfoChange,
  alertHandler,
}) => {
  const [title, setTitle] = React.useState(currentTitle)
  const [description, setDescription] = React.useState(currentDescription)
  const [selectedDate, setSelectedDate] = React.useState(null)
  const [selectedTime, setSelectedTime] = React.useState('')
  const [linkedGame, setLinkedGame] = React.useState(currentGame || null)
  const [loading, setLoading] = React.useState(false)
  const [localTags, setLocalTags] = React.useState([])
  const [allTags, setAllTags] = React.useState([])
  const [tagInput, setTagInput] = React.useState('')
  const [hasPassword, setHasPassword] = React.useState(currentHasPassword || false)
  const [uploader, setUploader] = React.useState(currentUploader?.username ?? null)
  const initialTagsRef = React.useRef([])
  const { users: uploaderCandidates, forbidden: uploaderForbidden } = useUploaderCandidates(open)

  React.useEffect(() => {
    if (!open) return
    setTitle(currentTitle)
    setDescription(currentDescription)
    setLinkedGame(currentGame || null)
    setHasPassword(currentHasPassword || false)
    setUploader(currentUploader?.username ?? null)
    setTagInput('')
    Promise.all([TagService.getVideoTags(videoId), TagService.getTags()])
      .then(([videoTagsRes, allTagsRes]) => {
        const tags = videoTagsRes.data || []
        initialTagsRef.current = tags
        setLocalTags(tags)
        setAllTags(allTagsRes.data || [])
      })
      .catch(() => {})
    if (!currentRecordedAt) {
      setSelectedDate(null)
      setSelectedTime('')
      return
    }
    const d = new Date(currentRecordedAt)
    const pad = (n) => n.toString().padStart(2, '0')
    setSelectedDate(d)
    setSelectedTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`)
  }, [open])

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

  const handleSave = async () => {
    setLoading(true)
    try {
      await VideoService.updateDetails(videoId, {
        title: title || currentTitle,
        description: description ?? currentDescription,
        recorded_at: getRecordedAtISO(),
      })

      // Apply tag changes: diff localTags vs what was on the video when modal opened
      const initialTags = initialTagsRef.current
      const toRemove = initialTags.filter((it) => !localTags.find((lt) => lt.id && lt.id === it.id))
      const toAdd = localTags.filter((lt) => !initialTags.find((it) => it.id && it.id === lt.id))
      const toCreate = toAdd.filter((t) => !t.id)
      const toLink = toAdd.filter((t) => !!t.id)

      const createdTags = await Promise.all(
        toCreate.map(async (t) => {
          const res = await TagService.createTag({ name: t.name })
          return res.data
        }),
      )
      await Promise.all([
        ...toLink.map((t) => TagService.addTagToVideo(videoId, t.id)),
        ...createdTags.map((t) => TagService.addTagToVideo(videoId, t.id)),
        ...toRemove.map((t) => TagService.removeTagFromVideo(videoId, t.id)),
      ])

      const finalTags = [...localTags.filter((lt) => lt.id && !toRemove.find((t) => t.id === lt.id)), ...createdTags]

      // Attribution goes through the admin bulk route rather than the details
      // PUT, which deliberately whitelists only title/description/private.
      const uploaderChanged = !uploaderForbidden && uploader !== (currentUploader?.username ?? null)
      let finalUploader = currentUploader ?? null
      if (uploaderChanged) {
        await Api().post('/api/admin/files/bulk-set-uploader', {
          video_ids: [videoId],
          username: uploader,
        })
        finalUploader = uploader
          ? uploaderCandidates.find((u) => u.username === uploader) || { username: uploader }
          : null
      }

      alertHandler?.({ open: true, type: 'success', message: 'Video details updated!' })
      close({
        title: title || currentTitle,
        description: description ?? currentDescription,
        game: linkedGame,
        tags: finalTags,
        ...(uploaderChanged && { uploader: finalUploader }),
      })
    } catch (err) {
      alertHandler?.({ open: true, type: 'error', message: err.response?.data || 'An unknown error occurred.' })
    }
    setLoading(false)
  }

  const handleGameLinked = async (game) => {
    try {
      await GameService.linkVideoToGame(videoId, game.id)
      setLinkedGame(game)
      alertHandler?.({ open: true, type: 'success', message: `Linked to ${game.name}` })
    } catch (err) {
      alertHandler?.({ open: true, type: 'error', message: 'Failed to link game.' })
    }
  }

  const handleGameUnlink = async () => {
    try {
      await GameService.unlinkVideoFromGame(videoId)
      setLinkedGame(null)
      alertHandler?.({ open: true, type: 'info', message: 'Game unlinked.' })
    } catch (err) {
      alertHandler?.({ open: true, type: 'error', message: 'Failed to unlink game.' })
    }
  }

  return (
    <Modal open={open} onClose={() => close(null)}>
      <Box sx={modalSx}>
        <Typography variant="h6" sx={{ fontWeight: 800, color: 'white', mb: 3 }}>
          Edit Video
        </Typography>

        <Stack spacing={2.5}>
          <LabeledField label="Title">
            <TextField value={title ?? ''} onChange={(e) => setTitle(e.target.value)} fullWidth sx={inputSx} />
          </LabeledField>

          <LabeledField label="Description">
            <TextField
              value={description ?? ''}
              onChange={(e) => setDescription(e.target.value)}
              multiline
              rows={3}
              fullWidth
              sx={inputSx}
            />
          </LabeledField>

          <LabeledField label="Recorded Date">
            <DateField
              selectedDate={selectedDate}
              selectedTime={selectedTime}
              onDateChange={setSelectedDate}
              onTimeChange={setSelectedTime}
            />
          </LabeledField>

          <Divider sx={{ borderColor: '#FFFFFF14' }} />

          <LabeledField label="Linked Game">
            <LinkedGameField
              game={linkedGame}
              onLink={handleGameLinked}
              onUnlink={handleGameUnlink}
              alertHandler={alertHandler}
            />
          </LabeledField>

          <LabeledField label="Tags">
            <TagsField
              localTags={localTags}
              allTags={allTags}
              tagInput={tagInput}
              setTagInput={setTagInput}
              setLocalTags={setLocalTags}
              inputSx={inputSx}
            />
          </LabeledField>

          {!uploaderForbidden && (
            <>
              <Divider sx={{ borderColor: '#FFFFFF14' }} />

              <LabeledField label="Uploader">
                <UploaderSelect users={uploaderCandidates} value={uploader} onChange={setUploader} disabled={loading} />
              </LabeledField>
            </>
          )}

          {currentInfo?.is_hdr && (
            <>
              <Divider sx={{ borderColor: '#FFFFFF14' }} />

              <LabeledField label="Dynamic Range">
                <TonemapControls
                  videoId={videoId}
                  videoInfo={currentInfo}
                  onInfoChange={onInfoChange}
                  alertHandler={alertHandler}
                />
              </LabeledField>
            </>
          )}

          <Divider sx={{ borderColor: '#FFFFFF14' }} />

          <LabeledField label="Password Protection">
            <PasswordField
              videoId={videoId}
              hasPassword={hasPassword}
              onPasswordChange={setHasPassword}
              alertHandler={alertHandler}
            />
          </LabeledField>
        </Stack>

        <Stack direction="row" spacing={1.5} sx={{ mt: 4 }}>
          <Button
            fullWidth
            variant="outlined"
            onClick={() => close(null)}
            disabled={loading}
            sx={{ color: 'white', borderColor: 'white', '&:hover': { borderColor: 'white', bgcolor: '#FFFFFF12' } }}
          >
            Cancel
          </Button>
          <Button
            fullWidth
            variant="contained"
            onClick={handleSave}
            disabled={loading}
            sx={{ bgcolor: '#3399FF', '&:hover': { bgcolor: '#1976D2' } }}
          >
            {loading ? 'Saving…' : 'Save'}
          </Button>
        </Stack>
      </Box>
    </Modal>
  )
}

export default UpdateDetailsModal
