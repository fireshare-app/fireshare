import React from 'react'
import {
  Box,
  Grid,
  Paper,
  Stack,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Autocomplete,
  TextField,
  Chip,
  CircularProgress,
  InputAdornment,
  Checkbox,
  FormControlLabel,
  Link,
} from '@mui/material'
import CloudUploadIcon from '@mui/icons-material/CloudUpload'
import styled from '@emotion/styled'
import { keyframes } from '@emotion/react'
import { VideoService, GameService, TagService } from '../../services'
import { appendLastModified, getSetting, uploadErrorReason } from '../../common/utils'

const FINISHED_STATUSES = new Set(['done', 'error', 'duplicate'])
const isFinished = (item) => FINISHED_STATUSES.has(item.status)

function summarizeBatch(succeeded, duplicates, failed, total) {
  if (duplicates.length === 0 && failed === 0) {
    return succeeded === 1
      ? 'Your upload will be available in a few seconds.'
      : `${succeeded} uploads will be available in a few seconds.`
  }
  if (succeeded === 0 && failed === 0) {
    return duplicates.length === 1
      ? `${duplicates[0].file.name} is already in the library.`
      : `All ${duplicates.length} of those videos are already in the library.`
  }
  const parts = []
  if (duplicates.length > 0) parts.push(`${duplicates.length} already in the library`)
  if (failed > 0) parts.push(`${failed} failed`)
  return `${succeeded} of ${total} uploads succeeded — ${parts.join(', ')}.`
}

// Links to the existing copies of duplicate uploads. They open in a new tab so
// the page the uploader is sitting on is left alone.
function renderDuplicateLinks(items) {
  const link = (item, label) => (
    <Link
      href={item.duplicate.url}
      target="_blank"
      rel="noopener"
      color="inherit"
      underline="always"
      sx={{ fontWeight: 700 }}
    >
      {label}
    </Link>
  )
  if (items.length === 1) return link(items[0], 'Open the existing video')
  return (
    <>
      Open the existing videos:{' '}
      {items.map((item, idx) => (
        <React.Fragment key={item.id}>
          {idx > 0 && ', '}
          {link(item, item.duplicate.title || item.file.name)}
        </React.Fragment>
      ))}
    </>
  )
}

function checkUploadLimit(file, handleAlert) {
  const limitMb = getSetting('upload_limit_mb') || 0
  if (limitMb > 0 && file.size > limitMb * 1024 * 1024) {
    handleAlert?.({ type: 'error', message: `File exceeds the ${limitMb} MB upload limit for this demo.`, open: true })
    return false
  }
  return true
}
import { dialogTitleSx, inputSx, labelSx, checkboxSx, helperTextSx } from '../../common/modalStyles'
import { useMobileFullScreenDialog } from '../../common/utils'
import logo from '../../assets/logo.png'

const Input = styled('input')({
  display: 'none',
})

const numberFormat = new Intl.NumberFormat('en-US')

const logoPulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
`

const borderSpin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`

const shimmer = keyframes`
  0% { background-position: -400px 0; }
  100% { background-position: 400px 0; }
`

const fadeIn = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
`

const maskCss = {
  maskImage: `url(${logo})`,
  maskSize: 'contain',
  maskRepeat: 'no-repeat',
  maskPosition: 'center',
  WebkitMaskImage: `url(${logo})`,
  WebkitMaskSize: 'contain',
  WebkitMaskRepeat: 'no-repeat',
  WebkitMaskPosition: 'center',
}

function LogoProgress({ progress, size = 44 }) {
  const isProcessing = progress >= 1
  const fillPct = isProcessing ? 100 : progress * 100
  return (
    <Box sx={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      {/* White base — full logo shape */}
      <Box sx={{ position: 'absolute', inset: 0, bgcolor: 'white', ...maskCss }} />
      {/* Colored fill — clips from top, grows upward */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(to top, #FF6B00, #FF2E80, #BC00E6)',
          clipPath: `inset(${100 - fillPct}% 0 0 0)`,
          transition: isProcessing ? 'none' : 'clip-path 0.6s cubic-bezier(0.25, 0.1, 0.25, 1)',
          animation: isProcessing ? `${logoPulse} 1.5s ease-in-out infinite` : 'none',
          ...maskCss,
        }}
      />
    </Box>
  )
}

const UploadCard = React.forwardRef(function UploadCard(
  { authenticated, handleAlert, mini, onUploadComplete, dropOnly = false },
  ref,
) {
  const mobileFullScreen = useMobileFullScreenDialog()

  // Upload queue — supports multiple concurrent uploads, each with its own progress
  const [uploadQueue, setUploadQueue] = React.useState([])
  const startedUploadsRef = React.useRef(new Set())
  const uiConfig = getSetting('ui_config')

  // Pre-upload metadata dialog
  const [pendingFiles, setPendingFiles] = React.useState([])
  // Per-file editable display titles, parallel to pendingFiles (batch uploads only)
  const [pendingTitles, setPendingTitles] = React.useState([])
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [allGames, setAllGames] = React.useState([])
  const [allTags, setAllTags] = React.useState([])
  const [selectedGame, setSelectedGame] = React.useState(null)
  const [selectedTags, setSelectedTags] = React.useState([])
  const [tagInput, setTagInput] = React.useState('')
  const [gameOptions, setGameOptions] = React.useState([])
  const [gameSearchLoading, setGameSearchLoading] = React.useState(false)
  const [gameCreating, setGameCreating] = React.useState(false)
  const [gameInput, setGameInput] = React.useState('')
  const [uploadToGameFolder, setUploadToGameFolder] = React.useState(false)
  const [titleInput, setTitleInput] = React.useState('')
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [titleDraft, setTitleDraft] = React.useState('')
  const [thumbnail, setThumbnail] = React.useState(null)
  const [thumbnailReady, setThumbnailReady] = React.useState(false)
  const [previewUrl, setPreviewUrl] = React.useState(null)
  const [previewPlayable, setPreviewPlayable] = React.useState(false)
  const [availableFolders, setAvailableFolders] = React.useState([])
  const [selectedFolder, setSelectedFolder] = React.useState('')
  const previewUrlRef = React.useRef(null)

  const intakeFiles = (files) => {
    const accepted = (files || []).filter((f) => checkUploadLimit(f, handleAlert))
    if (accepted.length === 0) return
    openMetadataDialog(accepted)
  }

  React.useImperativeHandle(ref, () => ({
    openFile(file) {
      intakeFiles(file ? [file] : [])
    },
    openFiles(files) {
      intakeFiles(files)
    },
  }))

  const clearPreviewUrl = React.useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setPreviewUrl(null)
    setPreviewPlayable(false)
  }, [])

  const createPreviewUrl = React.useCallback(
    (file) => {
      clearPreviewUrl()
      const url = URL.createObjectURL(file)
      previewUrlRef.current = url
      setPreviewUrl(url)
      setPreviewPlayable(true)
    },
    [clearPreviewUrl],
  )

  React.useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    },
    [],
  )

  const extractThumbnail = (file) => {
    setThumbnail(null)
    setThumbnailReady(false)
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.src = url
    video.addEventListener('loadeddata', () => {
      video.currentTime = Math.min(video.duration * 0.1, 5)
    })
    video.addEventListener('seeked', () => {
      requestAnimationFrame(() => {
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        canvas.getContext('2d').drawImage(video, 0, 0)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
        URL.revokeObjectURL(url)
        setThumbnail(dataUrl)
        setThumbnailReady(true)
      })
    })
    video.addEventListener('error', () => {
      setThumbnailReady(true)
      URL.revokeObjectURL(url)
    })
    video.load()
  }

  const openMetadataDialog = (files) => {
    setPendingFiles(files)
    setPendingTitles(files.map((f) => f.name.replace(/\.[^/.]+$/, '')))
    setSelectedGame(null)
    setSelectedTags([])
    setTagInput('')
    setGameInput('')
    setGameOptions([])
    setUploadToGameFolder(false)
    setTitleInput('')
    setEditingTitle(false)
    setTitleDraft('')

    createPreviewUrl(files[0])
    extractThumbnail(files[0])
    const foldersFetch = authenticated
      ? VideoService.getUploadFolders()
      : uiConfig?.allow_public_folder_selection
        ? VideoService.getPublicUploadFolders()
        : Promise.resolve({ data: { folders: [], default_folder: '' } })
    Promise.all([GameService.getGames(), TagService.getTags(), foldersFetch])
      .then(([gRes, tRes, fRes]) => {
        const games = gRes.data || []
        setAllGames(games)
        setGameOptions(games.map((g) => ({ ...g, _source: 'db' })))
        setAllTags(tRes.data || [])
        const folders = fRes.data?.folders || []
        const defaultFolder = fRes.data?.default_folder || ''
        const folderSet = new Set(folders)
        if (defaultFolder && !folderSet.has(defaultFolder)) folderSet.add(defaultFolder)
        const finalFolders = [...folderSet]
        setAvailableFolders(finalFolders)
        setSelectedFolder(finalFolders.includes(defaultFolder) ? defaultFolder : finalFolders[0] || '')
      })
      .catch(() => {
        setAllGames([])
        setGameOptions([])
        setAllTags([])
        setAvailableFolders([])
        setSelectedFolder('')
      })
    setDialogOpen(true)
  }

  const parseTagInput = (raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

  const handleDialogConfirm = async () => {
    // Flush any pending typed input (user didn't press Enter or comma)
    let tagsToProcess = [...selectedTags]
    if (tagInput.trim()) {
      parseTagInput(tagInput).forEach((p) => {
        const existing = allTags.find((t) => t.name.toLowerCase() === p.toLowerCase())
        if (!tagsToProcess.find((t) => t.name.toLowerCase() === p.toLowerCase())) {
          tagsToProcess.push(existing || { name: p })
        }
      })
      setTagInput('')
    }
    // Create any new (freeSolo) tags that don't have an id yet
    const resolvedTags = await Promise.all(
      tagsToProcess.map(async (t) => {
        if (t.id) return t
        const res = await TagService.createTag({ name: t.name })
        return res.data
      }),
    )
    const metadata = {
      tag_ids: resolvedTags.length ? resolvedTags.map((t) => t.id).join(',') : null,
      game_id: selectedGame ? selectedGame.id : null,
      folder: (uploadToGameFolder && selectedGame ? selectedGame.name : selectedFolder) || null,
    }
    const isBatch = pendingFiles.length > 1
    const items = pendingFiles.map((file, idx) => ({
      id: `${Date.now()}-${idx}-${file.name}`,
      file,
      // Single file uses the big inline title; batches use the per-file title inputs
      metadata: { ...metadata, title: (isBatch ? pendingTitles[idx]?.trim() : titleInput.trim()) || null },
      progress: 0,
      rate: null,
      status: 'queued',
    }))
    setDialogOpen(false)
    setPendingFiles([])
    setUploadQueue((prev) => [...prev, ...items])
    if (isBatch) clearPreviewUrl()
  }

  const handleDialogCancel = () => {
    setDialogOpen(false)
    setPendingFiles([])
    setSelectedGame(null)
    setSelectedTags([])
    setTagInput('')
    setGameOptions([])
    setGameInput('')
    setUploadToGameFolder(false)
    setTitleInput('')
    setEditingTitle(false)
    setThumbnail(null)
    setThumbnailReady(false)
    clearPreviewUrl()
  }

  const handleGameInputChange = async (_, value) => {
    setGameInput(value)
    if (!value || value.length < 2) {
      setGameOptions(allGames.map((g) => ({ ...g, _source: 'db' })))
      return
    }
    setGameSearchLoading(true)
    try {
      const sgdbResults = (await GameService.searchSteamGrid(value)).data || []
      const dbMatches = allGames
        .filter((g) => g.name.toLowerCase().includes(value.toLowerCase()))
        .map((g) => ({ ...g, _source: 'db' }))
      const existingSgdbIds = new Set(allGames.map((g) => g.steamgriddb_id).filter(Boolean))
      const newFromSgdb = sgdbResults.filter((r) => !existingSgdbIds.has(r.id)).map((r) => ({ ...r, _source: 'sgdb' }))
      setGameOptions([...dbMatches, ...newFromSgdb])
    } catch {
      setGameOptions(allGames.map((g) => ({ ...g, _source: 'db' })))
    }
    setGameSearchLoading(false)
  }

  const handleGameChange = async (_, newValue) => {
    if (!newValue) {
      setSelectedGame(null)
      setUploadToGameFolder(false)
      return
    }
    if (newValue._source === 'db') {
      setSelectedGame(newValue)
      setUploadToGameFolder(true)
      return
    }
    // New game from SteamGridDB — create it in the DB
    setGameCreating(true)
    try {
      const assets = (await GameService.getGameAssets(newValue.id)).data
      const gameData = {
        steamgriddb_id: newValue.id,
        name: newValue.name,
        release_date: newValue.release_date ? new Date(newValue.release_date * 1000).toISOString().split('T')[0] : null,
        hero_url: assets.hero_url,
        logo_url: assets.logo_url,
        icon_url: assets.icon_url,
      }
      const created = (await GameService.createGame(gameData)).data
      setAllGames((prev) => [...prev, created])
      setSelectedGame({ ...created, _source: 'db' })
      setUploadToGameFolder(true)
    } catch {
      setSelectedGame(null)
    }
    setGameCreating(false)
  }

  const changeHandler = (event) => {
    intakeFiles(Array.from(event.target.files || []))
    // Allow re-selecting the same file(s) later
    event.target.value = ''
  }

  const updateQueueItem = (id, patch) => {
    setUploadQueue((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  // Function to handle the drop event
  const dropHandler = (event) => {
    event.preventDefault()
    intakeFiles(Array.from(event.dataTransfer.files || []))
  }

  // Prevent default behavior for drag events to enable dropping files
  const dragOverHandler = (event) => {
    event.preventDefault()
  }

  const runUpload = async (item) => {
    const { file, metadata } = item
    const chunkSize = 90 * 1024 * 1024 // 90MB chunk size
    const { tag_ids, game_id, folder, title } = metadata

    // Per-item throttled progress reporting
    let lastUpdate = 0
    const reportProgress = (progress, rate) => {
      if (progress < 0 || progress > 1) return
      const now = Date.now()
      if (progress === 1 || now - lastUpdate >= 1000) {
        lastUpdate = now
        updateQueueItem(item.id, {
          progress,
          rate: rate ? { ...rate } : null,
          status: progress >= 1 ? 'processing' : 'uploading',
        })
      }
    }
    const reportProgressChunked = (progress, progressTotal, rate) => {
      if (progressTotal >= 0 && progressTotal <= 1) reportProgress(progressTotal, rate)
      else reportProgress(progress, rate)
    }

    const appendMetadata = (formData) => {
      if (tag_ids) formData.append('tag_ids', tag_ids)
      if (game_id) formData.append('game_id', game_id)
      if (folder) formData.append('folder', folder)
      if (title) formData.append('title', title)
    }

    try {
      if (file.size > chunkSize) {
        const totalChunks = Math.ceil(file.size / chunkSize)

        const fileInfo = `${file.name}-${file.size}-${file.lastModified}`
        let checksum
        if (crypto.subtle) {
          checksum = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fileInfo)).then((buf) =>
            Array.from(new Uint8Array(buf))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(''),
          )
        } else {
          // Fallback for non-secure contexts (plain HTTP over network IP).
          // A simple hash is sufficient here — it only correlates upload chunks.
          let h = 0
          for (let i = 0; i < fileInfo.length; i++) {
            h = (Math.imul(31, h) + fileInfo.charCodeAt(i)) | 0
          }
          checksum = (h >>> 0).toString(16).padStart(8, '0')
        }

        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
          const start = chunkIndex * chunkSize
          const end = Math.min(start + chunkSize, file.size)
          const chunk = file.slice(start, end)

          const formData = new FormData()
          formData.append('blob', chunk, file.name)
          formData.append('chunkPart', chunkIndex + 1)
          formData.append('totalChunks', totalChunks)
          formData.append('checkSum', checksum)
          formData.append('fileName', file.name)
          formData.append('fileSize', file.size.toString())
          appendLastModified(formData, file)
          formData.append('fileType', file.type)
          appendMetadata(formData)

          authenticated
            ? await VideoService.uploadChunked(formData, reportProgressChunked, file.size, start)
            : await VideoService.publicUploadChunked(formData, reportProgressChunked, file.size, start)
        }
      } else {
        const formData = new FormData()
        formData.append('file', file)
        appendLastModified(formData, file)
        appendMetadata(formData)
        if (authenticated) {
          await VideoService.upload(formData, reportProgress)
        } else {
          await VideoService.publicUpload(formData, reportProgress)
        }
      }
      updateQueueItem(item.id, { status: 'done', progress: 1 })
      if (onUploadComplete) onUploadComplete()
    } catch (err) {
      // The server hashes every upload and answers 409 when that content is
      // already in the library. It has removed its copy; nothing more to do.
      const duplicate = err?.response?.status === 409 ? err.response.data : null
      if (duplicate?.video_id) {
        updateQueueItem(item.id, { status: 'duplicate', progress: 1, duplicate })
        return
      }
      updateQueueItem(item.id, { status: 'error' })
      const reason = uploadErrorReason(err)
      handleAlert({
        type: 'error',
        message: reason
          ? `Failed to upload ${file.name}: ${reason}`
          : `An error occurred while uploading ${file.name}.`,
        open: true,
      })
    }
  }

  const MAX_CONCURRENT_UPLOADS = 3

  React.useEffect(() => {
    if (uploadQueue.length === 0) return

    // Start queued uploads up to the concurrency limit
    const active = uploadQueue.filter((i) => i.status === 'uploading' || i.status === 'processing').length
    let slots = MAX_CONCURRENT_UPLOADS - active
    for (const item of uploadQueue) {
      if (slots <= 0) break
      if (item.status !== 'queued' || startedUploadsRef.current.has(item.id)) continue
      startedUploadsRef.current.add(item.id)
      slots--
      updateQueueItem(item.id, { status: 'uploading' })
      runUpload(item)
    }

    // Once every upload has finished, show a single summary alert and reset the card
    if (uploadQueue.every(isFinished)) {
      const succeeded = uploadQueue.filter((i) => i.status === 'done').length
      const duplicates = uploadQueue.filter((i) => i.status === 'duplicate')
      const failed = uploadQueue.length - succeeded - duplicates.length
      if (succeeded > 0 || duplicates.length > 0) {
        handleAlert({
          type: failed > 0 ? 'warning' : succeeded > 0 ? 'success' : 'info',
          message: (
            <>
              {summarizeBatch(succeeded, duplicates, failed, uploadQueue.length)}
              {duplicates.length > 0 && <> {renderDuplicateLinks(duplicates)}</>}
            </>
          ),
          // A message with a link in it needs to stay up long enough to click.
          autoHideDuration: duplicates.length > 0 ? 10000 : 3500,
          open: true,
        })
      }
      startedUploadsRef.current.clear()
      setUploadQueue([])
      setThumbnail(null)
      setThumbnailReady(false)
      clearPreviewUrl()
    }
    // eslint-disable-next-line
  }, [uploadQueue])

  const isBatchPending = pendingFiles.length > 1
  const filenameStem = pendingFiles[0] ? pendingFiles[0].name.replace(/\.[^/.]+$/, '') : ''
  const displayTitle = titleInput || filenameStem || 'Untitled'

  // Derived upload state across the whole queue
  const isUploading = uploadQueue.length > 0
  const totalQueueBytes = uploadQueue.reduce((sum, i) => sum + i.file.size, 0)
  const loadedQueueBytes = uploadQueue.reduce(
    // Anything past the uploading stage (processing, done, or failed) counts as fully transferred
    (sum, i) =>
      sum + (i.status === 'queued' || i.status === 'uploading' ? i.progress * i.file.size : i.file.size),
    0,
  )
  const aggregateProgress = totalQueueBytes > 0 ? Math.min(loadedQueueBytes / totalQueueBytes, 1) : 0
  const finishedCount = uploadQueue.filter(isFinished).length
  const allSent = isUploading && uploadQueue.every((i) => i.status !== 'queued' && i.status !== 'uploading')
  const singleUpload = uploadQueue.length === 1 ? uploadQueue[0] : null

  const inlineTitleEl = isBatchPending ? (
    <Box sx={{ mb: 2 }}>
      <Typography
        sx={{
          fontWeight: 800,
          fontSize: 22,
          lineHeight: 1.3,
          color: 'white',
          fontFamily: '"Montserrat",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
        }}
      >
        {pendingFiles.length} videos
      </Typography>
      <Typography sx={{ fontSize: 12, color: '#FFFFFF66', mt: 0.25 }}>
        Game, folder and tags below will be applied to all {pendingFiles.length} videos.
      </Typography>
    </Box>
  ) : (
    <Box sx={{ mb: 2 }}>
      {editingTitle ? (
        <input
          autoFocus
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={() => {
            setTitleInput(titleDraft.trim())
            setEditingTitle(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.target.blur()
            if (e.key === 'Escape') {
              setTitleDraft(titleInput)
              setEditingTitle(false)
            }
          }}
          maxLength={200}
          style={{
            width: '100%',
            background: '#FFFFFF1F',
            border: 'none',
            borderRadius: '6px',
            outline: 'none',
            color: 'white',
            fontWeight: 800,
            fontSize: 22,
            lineHeight: 1.3,
            padding: '2px 6px',
            boxSizing: 'border-box',
            fontFamily: '"Montserrat",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
          }}
        />
      ) : (
        <Box
          onClick={() => {
            setTitleDraft(titleInput)
            setEditingTitle(true)
          }}
          sx={{
            display: 'flex',
            alignItems: 'center',
            cursor: 'text',
            borderRadius: '6px',
            px: '6px',
            mx: '-6px',
            transition: 'background 0.15s',
            '&:hover': { background: '#FFFFFF1F' },
          }}
        >
          <Typography
            sx={{
              fontWeight: 800,
              fontSize: 22,
              lineHeight: 1.3,
              color: titleInput || filenameStem ? 'white' : '#FFFFFF55',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: '"Montserrat",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
            }}
          >
            {displayTitle}
          </Typography>
        </Box>
      )}
    </Box>
  )

  const updatePendingTitle = (idx, value) => {
    setPendingTitles((prev) => {
      const next = [...prev]
      next[idx] = value
      return next
    })
  }

  const pendingFilesCaption = isBatchPending ? (
    <Box sx={{ mt: 1.25 }}>
      <Typography sx={{ ...labelSx, mb: 0.75 }}>Titles</Typography>
      <Box
        sx={{
          maxHeight: 150,
          overflowY: 'auto',
          pr: 0.5,
          display: 'flex',
          flexDirection: 'column',
          gap: 0.75,
          '&::-webkit-scrollbar': { width: 4 },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': {
            background: 'rgba(194, 224, 255, 0.15)',
            borderRadius: 2,
          },
          '&::-webkit-scrollbar-thumb:hover': {
            background: 'rgba(194, 224, 255, 0.3)',
          },
        }}
      >
        {pendingFiles.map((f, idx) => (
          <Box
            key={`${f.name}-${idx}`}
            component="input"
            value={pendingTitles[idx] ?? ''}
            placeholder={f.name.replace(/\.[^/.]+$/, '')}
            onChange={(e) => updatePendingTitle(idx, e.target.value)}
            maxLength={200}
            title={f.name}
            sx={{
              width: '100%',
              boxSizing: 'border-box',
              background: '#FFFFFF0D',
              border: '1px solid #FFFFFF14',
              borderRadius: '6px',
              outline: 'none',
              color: 'white',
              fontSize: 12.5,
              lineHeight: 1.4,
              padding: '5px 8px',
              fontFamily: 'inherit',
              transition: 'border-color 0.15s, background 0.15s',
              '&::placeholder': { color: '#FFFFFF4D' },
              '&:focus': { borderColor: '#2684FF80', background: '#FFFFFF14' },
            }}
          />
        ))}
      </Box>
    </Box>
  ) : (
    <Typography
      sx={{
        mt: 1,
        fontSize: 11,
        color: '#FFFFFF4D',
        textAlign: 'center',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {pendingFiles[0]?.name}
    </Typography>
  )

  const renderLocalVideoPreview = (sx = {}) =>
    previewUrl && previewPlayable ? (
      <Box
        component="video"
        src={previewUrl}
        poster={thumbnail || undefined}
        muted
        autoPlay
        loop
        playsInline
        disablePictureInPicture
        controlsList="nofullscreen nodownload noremoteplayback"
        onCanPlay={(event) => {
          const playPromise = event.currentTarget.play()
          if (playPromise?.catch) playPromise.catch(() => {})
        }}
        onContextMenu={(e) => e.preventDefault()}
        onError={() => setPreviewPlayable(false)}
        sx={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: 'block',
          ...sx,
        }}
      />
    ) : null

  const canUpload = authenticated ? !!uiConfig?.show_admin_upload : !!uiConfig?.allow_public_upload
  if (!canUpload) return null

  if (dropOnly) {
    return (
      <Dialog open={dialogOpen} onClose={handleDialogCancel} maxWidth="md" fullWidth {...mobileFullScreen}>
        <DialogTitle sx={{ px: 3, pt: 2.5, pb: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <CloudUploadIcon sx={{ color: '#2684FF', fontSize: 24, flexShrink: 0 }} />
            <Typography sx={{ ...dialogTitleSx, fontSize: 16 }}>{isBatchPending ? `Upload ${pendingFiles.length} Videos` : 'Upload Video'}</Typography>
          </Box>
        </DialogTitle>
        <DialogContent sx={{ pt: '16px !important', px: 3 }}>
          {inlineTitleEl}
          {/* Side by side on desktop; stacked on a phone, where the dialog is fullscreen
              and a half-width column would squeeze the fields for no reason. */}
          <Box
            sx={{
              display: 'flex',
              flexDirection: { xs: 'column', sm: 'row' },
              gap: 3,
              alignItems: { xs: 'stretch', sm: 'flex-start' },
            }}
          >
            {/* Thumbnail — left column */}
            <Box sx={{ flex: { xs: 'none', sm: 1 }, width: '100%' }}>
              <Box
                sx={{
                  width: '100%',
                  aspectRatio: '16/9',
                  borderRadius: '8px',
                  overflow: 'hidden',
                  bgcolor: '#FFFFFF0D',
                  border: '1px solid #FFFFFF14',
                  position: 'relative',
                }}
              >
                {thumbnailReady && thumbnail && (
                  <Box
                    component="img"
                    src={thumbnail}
                    alt="thumbnail"
                    sx={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      display: 'block',
                      animation: `${fadeIn} 0.6s ease`,
                    }}
                  />
                )}
                {renderLocalVideoPreview({
                  position: 'absolute',
                  inset: 0,
                  animation: `${fadeIn} 0.3s ease`,
                })}
                {!thumbnailReady && (!previewUrl || !previewPlayable) && (
                  <Box
                    sx={{
                      position: 'absolute',
                      inset: 0,
                      background: 'linear-gradient(90deg, #FFFFFF08 25%, #FFFFFF18 50%, #FFFFFF08 75%)',
                      backgroundSize: '800px 100%',
                      animation: `${shimmer} 1.4s ease-in-out infinite`,
                    }}
                  />
                )}
                {thumbnailReady && !thumbnail && (!previewUrl || !previewPlayable) && (
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                    <CloudUploadIcon sx={{ color: '#FFFFFF33', fontSize: 32 }} />
                  </Box>
                )}
              </Box>
              {pendingFilesCaption}
            </Box>

            {/* Form fields — right column */}
            <Box
              sx={{
                flex: { xs: 'none', sm: 1 },
                width: '100%',
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              {/* Game selector */}
              <Box>
                <Typography sx={labelSx}>Game</Typography>
                <Autocomplete
                  options={gameOptions}
                  getOptionLabel={(o) => o.name || ''}
                  groupBy={(o) => (o._source === 'db' ? 'Already in library' : 'From SteamGridDB')}
                  value={selectedGame}
                  inputValue={gameInput}
                  onInputChange={handleGameInputChange}
                  onChange={handleGameChange}
                  loading={gameSearchLoading}
                  disabled={gameCreating}
                  filterOptions={(x) => x}
                  isOptionEqualToValue={(option, value) =>
                    option.id === value.id || (option.steamgriddb_id && option.steamgriddb_id === value.steamgriddb_id)
                  }
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      size="small"
                      placeholder="Search for a game..."
                      sx={inputSx}
                      InputProps={{
                        ...params.InputProps,
                        startAdornment: selectedGame?.icon_url ? (
                          <>
                            <InputAdornment position="start" sx={{ ml: 0.5, mr: 0 }}>
                              <img
                                src={selectedGame.icon_url}
                                alt=""
                                onError={(e) => {
                                  e.currentTarget.style.display = 'none'
                                }}
                                style={{ width: 18, height: 18, objectFit: 'contain', borderRadius: 3 }}
                              />
                            </InputAdornment>
                            {params.InputProps.startAdornment}
                          </>
                        ) : (
                          params.InputProps.startAdornment
                        ),
                        endAdornment: (
                          <>
                            {(gameSearchLoading || gameCreating) && (
                              <InputAdornment position="end">
                                <CircularProgress size={16} sx={{ mr: 1 }} />
                              </InputAdornment>
                            )}
                            {params.InputProps.endAdornment}
                          </>
                        ),
                      }}
                    />
                  )}
                  renderOption={(props, option) => (
                    <Box
                      component="li"
                      sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
                      {...props}
                      key={`${option._source}-${option.id}`}
                    >
                      {option.icon_url && (
                        <img
                          src={option.icon_url}
                          alt=""
                          onError={(e) => {
                            e.currentTarget.style.display = 'none'
                          }}
                          style={{ width: 20, height: 20, objectFit: 'contain', borderRadius: 3, flexShrink: 0 }}
                        />
                      )}
                      {option.name}
                      {option._source === 'sgdb' &&
                        option.release_date &&
                        ` (${new Date(option.release_date * 1000).getFullYear()})`}
                    </Box>
                  )}
                />
                {selectedGame && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={uploadToGameFolder}
                        onChange={(e) => setUploadToGameFolder(e.target.checked)}
                        size="small"
                        sx={checkboxSx}
                      />
                    }
                    label={<Typography sx={helperTextSx}>Auto-sort into game folder</Typography>}
                    sx={{ mt: 0.5, ml: 0 }}
                  />
                )}
              </Box>
              <Box sx={{ opacity: uploadToGameFolder && selectedGame ? 0.5 : 1 }}>
                <Typography sx={labelSx}>Upload Folder</Typography>
                <Autocomplete
                  options={availableFolders}
                  value={uploadToGameFolder && selectedGame ? selectedGame.name : selectedFolder || null}
                  onChange={(_, value) => setSelectedFolder(value || '')}
                  disableClearable={uploadToGameFolder ? true : !!selectedFolder}
                  disabled={uploadToGameFolder && !!selectedGame}
                  renderInput={(params) => <TextField {...params} size="small" sx={inputSx} />}
                />
              </Box>
              <Box>
                <Typography sx={labelSx}>Tags</Typography>
                <Autocomplete
                  multiple
                  freeSolo
                  options={allTags.filter((t) => !selectedTags.find((s) => s.id === t.id))}
                  getOptionLabel={(o) => (typeof o === 'string' ? o : o.name)}
                  value={selectedTags}
                  inputValue={tagInput}
                  onInputChange={(_, v) => setTagInput(v)}
                  onChange={(_, values) => {
                    setSelectedTags(values.map((v) => (typeof v === 'string' ? { name: v } : v)))
                    setTagInput('')
                  }}
                  renderTags={(value, getTagProps) =>
                    value.map((option, index) => (
                      <Chip
                        key={index}
                        label={option.name}
                        size="small"
                        {...getTagProps({ index })}
                        sx={{
                          bgcolor: option.color ? `${option.color}33` : '#FFFFFF14',
                          color: 'white',
                          '& .MuiChip-deleteIcon': { color: '#FFFFFF66', '&:hover': { color: 'white' } },
                        }}
                      />
                    ))
                  }
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      size="small"
                      placeholder="Add tags..."
                      sx={inputSx}
                      inputProps={{ ...params.inputProps, maxLength: 12 }}
                      onKeyDown={(e) => {
                        if (e.key === ',') {
                          e.preventDefault()
                          const parts = parseTagInput(tagInput)
                          if (parts.length > 0) {
                            setSelectedTags((prev) => {
                              const merged = [...prev]
                              parts.forEach((p) => {
                                if (!merged.find((t) => t.name.toLowerCase() === p.toLowerCase())) {
                                  const existing = allTags.find((t) => t.name.toLowerCase() === p.toLowerCase())
                                  merged.push(existing || { name: p })
                                }
                              })
                              return merged
                            })
                            setTagInput('')
                          }
                        }
                      }}
                    />
                  )}
                />
              </Box>
            </Box>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5, pt: 1 }}>
          <Button
            onClick={handleDialogCancel}
            sx={{ color: '#FFFFFF80', '&:hover': { color: 'white', bgcolor: '#FFFFFF0F' } }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleDialogConfirm}
            variant="contained"
            sx={{
              background: 'linear-gradient(90deg, #BC00E6, #FF3729)',
              '&:hover': { background: 'linear-gradient(90deg, #CC10F6, #FF4739)' },
              fontWeight: 600,
              px: 3,
            }}
          >
            Upload
          </Button>
        </DialogActions>
      </Dialog>
    )
  }

  return (
    <>
      <Grid item sx={{ mx: 1, mt: 2 }}>
        <label htmlFor="icon-button-file">
          {/* Add onDrop and onDragOver handlers */}
          <Box
            sx={{
              position: 'relative',
              borderRadius: '13px',
              padding: isUploading ? '2px' : '0px',
              overflow: 'hidden',
              transition: 'padding 0.2s',
              '&::before': {
                content: '""',
                display: isUploading ? 'block' : 'none',
                position: 'absolute',
                inset: '-100%',
                background: 'conic-gradient(#BC00E6DF, #FF3729D9, #0084ff, #BC00E6DF)',
                animation: `${borderSpin} 1s linear infinite`,
              },
            }}
          >
            <Paper
              sx={{
                position: 'relative',
                width: '100%',
                // Grow to fit the per-file list when uploading multiple videos
                height: mini ? '56px' : uploadQueue.length > 1 ? 'auto' : '90px',
                minHeight: mini ? '56px' : '90px',
                cursor: 'pointer',
                background: '#001224',
                overflow: 'hidden',
                border: '2px solid',
                borderColor: isUploading ? 'transparent' : 'rgba(38, 132, 255, 0.25)',
                borderRadius: '12px',
                transition: 'border-color 0.2s, background 0.2s',
                '&:hover': {
                  borderColor: isUploading ? 'transparent' : 'rgba(38, 132, 255, 0.5)',
                  background: isUploading ? 'rgb(0, 32, 73)' : 'rgba(38, 132, 255, 0.1)',
                },
              }}
              onDrop={dropHandler}
              onDragOver={dragOverHandler}
            >
              {isUploading && !mini && previewUrl && previewPlayable && (
                <>
                  {renderLocalVideoPreview({
                    position: 'absolute',
                    inset: 0,
                    opacity: 0.72,
                    pointerEvents: 'none',
                  })}
                  <Box
                    sx={{
                      position: 'absolute',
                      inset: 0,
                      background: 'linear-gradient(90deg, rgba(0, 18, 36, 0.92), rgba(0, 18, 36, 0.58))',
                      pointerEvents: 'none',
                    }}
                  />
                </>
              )}
              <Box sx={{ display: 'flex', height: '100%' }} justifyContent="center" alignItems="center">
                <Stack
                  sx={{ zIndex: 1, position: 'relative', width: '100%' }}
                  alignItems="center"
                  justifyContent="center"
                  spacing={0.5}
                >
                  <Input
                    id="icon-button-file"
                    accept="video/mp4,video/webm,video/mov"
                    type="file"
                    name="file"
                    multiple
                    onChange={changeHandler}
                  />

                  {!isUploading && !mini && (
                    <>
                      <CloudUploadIcon sx={{ fontSize: 32, color: '#fff' }} />
                      <Typography sx={{ fontSize: 12, color: '#ffffff77', fontWeight: 500, letterSpacing: 0.2 }}>
                        Upload Videos
                      </Typography>
                    </>
                  )}
                  {!isUploading && mini && <CloudUploadIcon sx={{ fontSize: 20, color: '#fff' }} />}
                  {isUploading && (
                    <>
                      {!mini ? (
                        <Box sx={{ width: '100%', px: 2, py: uploadQueue.length > 1 ? 1.5 : 0 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                            <LogoProgress
                              progress={singleUpload ? singleUpload.progress : aggregateProgress}
                              size={48}
                            />
                            <Box sx={{ minWidth: 0 }}>
                              <Typography
                                sx={{
                                  fontWeight: 700,
                                  fontSize: 14,
                                  color: 'white',
                                  lineHeight: 1.3,
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {allSent
                                  ? 'Processing...'
                                  : `Uploading ${(100 * (singleUpload ? singleUpload.progress : aggregateProgress)).toFixed(0)}%`}
                              </Typography>
                              <Typography
                                sx={{ fontSize: 11, color: '#FFFFFFAA', lineHeight: 1.3, whiteSpace: 'nowrap' }}
                              >
                                {allSent
                                  ? 'Please wait...'
                                  : singleUpload
                                    ? singleUpload.rate
                                      ? `${numberFormat.format(singleUpload.rate.loaded.toFixed(0))} / ${numberFormat.format(singleUpload.rate.total.toFixed(0))} MB`
                                      : 'Starting...'
                                    : `${finishedCount} of ${uploadQueue.length} complete`}
                              </Typography>
                            </Box>
                          </Box>
                          {uploadQueue.length > 1 && (
                            <Box
                              sx={{
                                mt: 1.25,
                                maxHeight: 132,
                                overflowY: 'auto',
                                pr: 0.5,
                                '&::-webkit-scrollbar': { width: 4 },
                                '&::-webkit-scrollbar-track': { background: 'transparent' },
                                '&::-webkit-scrollbar-thumb': {
                                  background: 'rgba(194, 224, 255, 0.15)',
                                  borderRadius: 2,
                                },
                                '&::-webkit-scrollbar-thumb:hover': {
                                  background: 'rgba(194, 224, 255, 0.3)',
                                },
                              }}
                            >
                              {uploadQueue.map((item) => (
                                <Box key={item.id} sx={{ mb: 0.75 }}>
                                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                    <Typography
                                      sx={{
                                        flex: 1,
                                        minWidth: 0,
                                        fontSize: 10.5,
                                        color: '#FFFFFF99',
                                        textAlign: 'left',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        lineHeight: 1.4,
                                      }}
                                    >
                                      {item.file.name}
                                    </Typography>
                                    <Typography
                                      sx={{
                                        fontSize: 10.5,
                                        fontWeight: 700,
                                        lineHeight: 1.4,
                                        flexShrink: 0,
                                        color:
                                          item.status === 'error'
                                            ? '#FF6B6B'
                                            : item.status === 'duplicate'
                                              ? '#FFD166'
                                              : item.status === 'done'
                                                ? '#6BFF95'
                                                : '#FFFFFFCC',
                                      }}
                                    >
                                      {item.status === 'queued'
                                        ? 'Queued'
                                        : item.status === 'processing'
                                          ? 'Processing'
                                          : item.status === 'done'
                                            ? 'Done'
                                            : item.status === 'error'
                                              ? 'Failed'
                                              : item.status === 'duplicate'
                                                ? 'Already exists'
                                                : `${(100 * item.progress).toFixed(0)}%`}
                                    </Typography>
                                  </Box>
                                  <Box
                                    sx={{
                                      mt: 0.4,
                                      height: '3px',
                                      borderRadius: '2px',
                                      bgcolor: '#FFFFFF1A',
                                      overflow: 'hidden',
                                    }}
                                  >
                                    <Box
                                      sx={{
                                        height: '100%',
                                        width: `${(100 * (item.status === 'done' || item.status === 'processing' ? 1 : item.progress)).toFixed(1)}%`,
                                        borderRadius: '2px',
                                        background:
                                          item.status === 'error'
                                            ? '#FF6B6B'
                                            : item.status === 'duplicate'
                                              ? '#FFD166'
                                              : 'linear-gradient(90deg, #BC00E6, #FF2E80, #FF6B00)',
                                        transition: 'width 0.6s cubic-bezier(0.25, 0.1, 0.25, 1)',
                                      }}
                                    />
                                  </Box>
                                </Box>
                              ))}
                            </Box>
                          )}
                        </Box>
                      ) : (
                        <Typography sx={{ fontWeight: 700, fontSize: 12, color: 'white' }}>
                          {aggregateProgress < 1 ? `${(100 * aggregateProgress).toFixed(0)}%` : '100%'}
                        </Typography>
                      )}
                    </>
                  )}
                </Stack>
              </Box>
            </Paper>
          </Box>
        </label>
      </Grid>

      {/* Pre-upload metadata dialog */}
      <Dialog open={dialogOpen} onClose={handleDialogCancel} maxWidth="md" fullWidth {...mobileFullScreen}>
        <DialogTitle sx={{ px: 3, pt: 2.5, pb: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <CloudUploadIcon sx={{ color: '#fff', fontSize: 24, flexShrink: 0 }} />
            <Typography sx={{ ...dialogTitleSx, fontSize: 16 }}>{isBatchPending ? `Upload ${pendingFiles.length} Videos` : 'Upload Video'}</Typography>
          </Box>
        </DialogTitle>
        <DialogContent sx={{ pt: '16px !important', px: 3 }}>
          {inlineTitleEl}
          {/* Side by side on desktop; stacked on a phone, where the dialog is fullscreen
              and a half-width column would squeeze the fields for no reason. */}
          <Box
            sx={{
              display: 'flex',
              flexDirection: { xs: 'column', sm: 'row' },
              gap: 3,
              alignItems: { xs: 'stretch', sm: 'flex-start' },
            }}
          >
            {/* Thumbnail — left column */}
            <Box sx={{ flex: { xs: 'none', sm: 1 }, width: '100%' }}>
              <Box
                sx={{
                  width: '100%',
                  aspectRatio: '16/9',
                  borderRadius: '8px',
                  overflow: 'hidden',
                  bgcolor: '#FFFFFF0D',
                  border: '1px solid #FFFFFF14',
                  position: 'relative',
                }}
              >
                {thumbnailReady && thumbnail && (
                  <Box
                    component="img"
                    src={thumbnail}
                    alt="thumbnail"
                    sx={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      display: 'block',
                      animation: `${fadeIn} 0.6s ease`,
                    }}
                  />
                )}
                {renderLocalVideoPreview({
                  position: 'absolute',
                  inset: 0,
                  animation: `${fadeIn} 0.3s ease`,
                })}
                {!thumbnailReady && (!previewUrl || !previewPlayable) && (
                  <Box
                    sx={{
                      position: 'absolute',
                      inset: 0,
                      background: 'linear-gradient(90deg, #FFFFFF08 25%, #FFFFFF18 50%, #FFFFFF08 75%)',
                      backgroundSize: '800px 100%',
                      animation: `${shimmer} 1.4s ease-in-out infinite`,
                    }}
                  />
                )}
                {thumbnailReady && !thumbnail && (!previewUrl || !previewPlayable) && (
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                    <CloudUploadIcon sx={{ color: '#FFFFFF33', fontSize: 32 }} />
                  </Box>
                )}
              </Box>
              {pendingFilesCaption}
            </Box>

            {/* Form fields — right column */}
            <Box
              sx={{
                flex: { xs: 'none', sm: 1 },
                width: '100%',
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              {/* Game selector */}
              <Box>
                <Typography sx={labelSx}>Game</Typography>
                <Autocomplete
                  options={gameOptions}
                  getOptionLabel={(o) => o.name || ''}
                  groupBy={(o) => (o._source === 'db' ? 'Already in library' : 'From SteamGridDB')}
                  value={selectedGame}
                  inputValue={gameInput}
                  onInputChange={handleGameInputChange}
                  onChange={handleGameChange}
                  loading={gameSearchLoading}
                  disabled={gameCreating}
                  filterOptions={(x) => x}
                  isOptionEqualToValue={(option, value) =>
                    option.id === value.id || (option.steamgriddb_id && option.steamgriddb_id === value.steamgriddb_id)
                  }
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      size="small"
                      placeholder="Search for a game..."
                      sx={inputSx}
                      InputProps={{
                        ...params.InputProps,
                        startAdornment: selectedGame?.icon_url ? (
                          <>
                            <InputAdornment position="start" sx={{ ml: 0.5, mr: 0 }}>
                              <img
                                src={selectedGame.icon_url}
                                alt=""
                                onError={(e) => {
                                  e.currentTarget.style.display = 'none'
                                }}
                                style={{ width: 18, height: 18, objectFit: 'contain', borderRadius: 3 }}
                              />
                            </InputAdornment>
                            {params.InputProps.startAdornment}
                          </>
                        ) : (
                          params.InputProps.startAdornment
                        ),
                        endAdornment: (
                          <>
                            {(gameSearchLoading || gameCreating) && (
                              <InputAdornment position="end">
                                <CircularProgress size={16} sx={{ mr: 1 }} />
                              </InputAdornment>
                            )}
                            {params.InputProps.endAdornment}
                          </>
                        ),
                      }}
                    />
                  )}
                  renderOption={(props, option) => (
                    <Box
                      component="li"
                      sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
                      {...props}
                      key={`${option._source}-${option.id}`}
                    >
                      {option.icon_url && (
                        <img
                          src={option.icon_url}
                          alt=""
                          onError={(e) => {
                            e.currentTarget.style.display = 'none'
                          }}
                          style={{ width: 20, height: 20, objectFit: 'contain', borderRadius: 3, flexShrink: 0 }}
                        />
                      )}
                      {option.name}
                      {option._source === 'sgdb' &&
                        option.release_date &&
                        ` (${new Date(option.release_date * 1000).getFullYear()})`}
                    </Box>
                  )}
                />
                {selectedGame && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={uploadToGameFolder}
                        onChange={(e) => setUploadToGameFolder(e.target.checked)}
                        size="small"
                        sx={checkboxSx}
                      />
                    }
                    label={<Typography sx={helperTextSx}>Auto-sort into game folder</Typography>}
                    sx={{ mt: 0.5, ml: 0 }}
                  />
                )}
              </Box>

              {/* Folder selector */}
              <Box sx={{ opacity: uploadToGameFolder && selectedGame ? 0.5 : 1 }}>
                <Typography sx={labelSx}>Upload Folder</Typography>
                <Autocomplete
                  options={availableFolders}
                  value={uploadToGameFolder && selectedGame ? selectedGame.name : selectedFolder || null}
                  onChange={(_, value) => setSelectedFolder(value || '')}
                  disableClearable={uploadToGameFolder ? true : !!selectedFolder}
                  disabled={uploadToGameFolder && !!selectedGame}
                  renderInput={(params) => <TextField {...params} size="small" sx={inputSx} />}
                />
              </Box>

              {/* Tag selector */}
              <Box>
                <Typography sx={labelSx}>Tags</Typography>
                <Autocomplete
                  multiple
                  freeSolo
                  options={allTags.filter((t) => !selectedTags.find((s) => s.id === t.id))}
                  getOptionLabel={(o) => (typeof o === 'string' ? o : o.name)}
                  value={selectedTags}
                  inputValue={tagInput}
                  onInputChange={(_, v) => setTagInput(v)}
                  onChange={(_, values) => {
                    const resolved = values.map((v) => (typeof v === 'string' ? { name: v } : v))
                    setSelectedTags(resolved)
                    setTagInput('')
                  }}
                  renderTags={(value, getTagProps) =>
                    value.map((option, index) => (
                      <Chip
                        key={index}
                        label={option.name}
                        size="small"
                        {...getTagProps({ index })}
                        sx={{
                          bgcolor: option.color ? `${option.color}33` : '#FFFFFF14',
                          color: 'white',
                          '& .MuiChip-deleteIcon': { color: '#FFFFFF66', '&:hover': { color: 'white' } },
                        }}
                      />
                    ))
                  }
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      size="small"
                      placeholder="Add tags..."
                      sx={inputSx}
                      inputProps={{ ...params.inputProps, maxLength: 12 }}
                      onKeyDown={(e) => {
                        if (e.key === ',') {
                          e.preventDefault()
                          const parts = parseTagInput(tagInput)
                          if (parts.length > 0) {
                            setSelectedTags((prev) => {
                              const merged = [...prev]
                              parts.forEach((p) => {
                                if (!merged.find((t) => t.name.toLowerCase() === p.toLowerCase())) {
                                  const existing = allTags.find((t) => t.name.toLowerCase() === p.toLowerCase())
                                  merged.push(existing || { name: p })
                                }
                              })
                              return merged
                            })
                            setTagInput('')
                          }
                        }
                      }}
                    />
                  )}
                />
              </Box>
            </Box>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5, pt: 1 }}>
          <Button
            onClick={handleDialogCancel}
            sx={{ color: '#FFFFFF80', '&:hover': { color: 'white', bgcolor: '#FFFFFF0F' } }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleDialogConfirm}
            variant="contained"
            sx={{
              background: 'linear-gradient(90deg, #BC00E6, #FF3729)',
              '&:hover': { background: 'linear-gradient(90deg, #CC10F6, #FF4739)' },
              fontWeight: 600,
              px: 3,
            }}
          >
            Upload
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
})

export default UploadCard
