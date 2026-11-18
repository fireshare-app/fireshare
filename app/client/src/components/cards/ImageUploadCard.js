import React from 'react'
import {
  Box,
  Grid,
  Paper,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Autocomplete,
  Checkbox,
  FormControlLabel,
  TextField,
  CircularProgress,
  InputAdornment,
  LinearProgress,
} from '@mui/material'
import CloudUploadIcon from '@mui/icons-material/CloudUpload'
import ImageIcon from '@mui/icons-material/Image'
import styled from '@emotion/styled'
import { ImageService, GameService } from '../../services'
import { appendLastModified, getSetting, uploadErrorReason } from '../../common/utils'
import { dialogTitleSx, inputSx, labelSx } from '../../common/modalStyles'
import { useMobileFullScreenDialog } from '../../common/utils'

const Input = styled('input')({ display: 'none' })

const ACCEPTED_IMAGE_TYPES = 'image/jpeg,image/png,image/webp,image/gif'

const ImageUploadCard = React.forwardRef(function ImageUploadCard(
  { authenticated, handleAlert, onUploadComplete, mini },
  ref,
) {
  const mobileFullScreen = useMobileFullScreenDialog()

  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [pendingFiles, setPendingFiles] = React.useState([])
  const [allGames, setAllGames] = React.useState([])
  const [selectedGame, setSelectedGame] = React.useState(null)
  const [gameOptions, setGameOptions] = React.useState([])
  const [gameInput, setGameInput] = React.useState('')
  const [gameSearchLoading, setGameSearchLoading] = React.useState(false)
  const [gameCreating, setGameCreating] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const [uploadIndex, setUploadIndex] = React.useState(0)
  const [uploadProgress, setUploadProgress] = React.useState(0)
  const [previews, setPreviews] = React.useState([])
  const [availableFolders, setAvailableFolders] = React.useState([])
  const [selectedFolder, setSelectedFolder] = React.useState('')
  const [uploadToGameFolder, setUploadToGameFolder] = React.useState(false)

  React.useImperativeHandle(ref, () => ({
    openFiles(files) {
      openDialog(Array.from(files))
    },
  }))

  const openDialog = (files) => {
    if (!files || files.length === 0) return
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    setPendingFiles(imageFiles)
    // Generate previews
    const urls = imageFiles.map((f) => URL.createObjectURL(f))
    setPreviews(urls)
    setSelectedGame(null)
    setGameInput('')
    setGameOptions([])
    setUploadToGameFolder(false)
    const foldersFetch = authenticated
      ? ImageService.getUploadFolders()
      : uiConfig?.allow_public_folder_selection
        ? ImageService.getPublicUploadFolders()
        : Promise.resolve({ data: { folders: [], default_folder: '' } })
    Promise.all([GameService.getGames(), foldersFetch])
      .then(([gRes, fRes]) => {
        const games = gRes.data || []
        setAllGames(games)
        setGameOptions(games.map((g) => ({ ...g, _source: 'db' })))
        const folders = fRes.data?.folders || []
        const defaultFolder = fRes.data?.default_folder || ''
        // Ensure the default folder is always in the list
        const folderSet = new Set(folders)
        if (defaultFolder && !folderSet.has(defaultFolder)) folderSet.add(defaultFolder)
        const finalFolders = [...folderSet]
        setAvailableFolders(finalFolders)
        setSelectedFolder(finalFolders.includes(defaultFolder) ? defaultFolder : finalFolders[0] || '')
      })
      .catch(() => {
        setAllGames([])
        setGameOptions([])
        setAvailableFolders([])
        setSelectedFolder('')
      })
    setDialogOpen(true)
  }

  const handleFilePick = (e) => {
    const files = Array.from(e.target.files || [])
    openDialog(files)
    e.target.value = ''
  }

  // Revoke preview object URLs on close
  const cleanup = () => {
    previews.forEach((url) => URL.revokeObjectURL(url))
    setPreviews([])
    setPendingFiles([])
    setUploading(false)
    setUploadIndex(0)
    setUploadProgress(0)
  }

  const handleCancel = () => {
    cleanup()
    setDialogOpen(false)
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
      const existingIds = new Set(allGames.map((g) => g.steamgriddb_id).filter(Boolean))
      const newFromSgdb = sgdbResults.filter((r) => !existingIds.has(r.id)).map((r) => ({ ...r, _source: 'sgdb' }))
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

  const handleUpload = async () => {
    setUploading(true)
    const game_id = selectedGame?.id || null
    let successCount = 0

    for (let i = 0; i < pendingFiles.length; i++) {
      setUploadIndex(i)
      setUploadProgress(0)
      const file = pendingFiles[i]
      const formData = new FormData()
      formData.append('file', file)
      appendLastModified(formData, file)
      if (game_id) formData.append('game_id', game_id)
      const folder = (uploadToGameFolder && selectedGame ? selectedGame.name : selectedFolder) || null
      if (folder) formData.append('folder', folder)
      try {
        const uploadFn = authenticated ? ImageService.upload : ImageService.publicUpload
        await uploadFn(formData, (progress) => setUploadProgress(progress))
        successCount++
      } catch (err) {
        const reason = uploadErrorReason(err)
        const message = reason ? `Failed to upload ${file.name}: ${reason}` : `Failed to upload ${file.name}`
        handleAlert({ type: 'error', message, open: true })
      }
    }

    if (successCount > 0) {
      handleAlert({
        type: 'success',
        message: `${successCount} image${successCount > 1 ? 's' : ''} uploaded — they'll appear shortly.`,
        autohideDuration: 3500,
        open: true,
      })
      if (onUploadComplete) onUploadComplete()
    }
    cleanup()
    setDialogOpen(false)
  }

  const uiConfig = getSetting('ui_config')
  const canUpload = authenticated ? !!uiConfig?.show_admin_upload : !!uiConfig?.allow_public_upload
  if (!canUpload) return null

  return (
    <>
      {/* Sidebar upload button */}
      <Grid item sx={{ mx: 1, mt: 1 }}>
        <label htmlFor="image-upload-input">
          <Input accept={ACCEPTED_IMAGE_TYPES} id="image-upload-input" type="file" multiple onChange={handleFilePick} />
          <Paper
            sx={{
              width: '100%',
              height: mini ? '52px' : '86px',
              cursor: 'pointer',
              background: '#001224',
              overflow: 'hidden',
              border: '2px solid',
              borderColor: 'rgba(188, 0, 230, 0.25)',
              borderRadius: '12px',
              transition: 'border-color 0.2s, background 0.2s',
              '&:hover': {
                borderColor: 'rgba(188, 0, 230, 0.5)',
                background: 'rgba(188, 0, 230, 0.1)',
              },
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1,
            }}
          >
            <ImageIcon sx={{ fontSize: mini ? 18 : 22, color: '#fff' }} />
            {!mini && (
              <Typography sx={{ fontSize: 12, color: '#ffffff77', fontWeight: 500, letterSpacing: 0.2 }}>
                Upload Images
              </Typography>
            )}
          </Paper>
        </label>
      </Grid>

      {/* Pre-upload metadata dialog */}
      <Dialog
        open={dialogOpen}
        onClose={uploading ? undefined : handleCancel}
        maxWidth="sm"
        fullWidth
        {...mobileFullScreen}
      >
        <DialogTitle sx={{ px: 3, pt: 2.5, pb: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <ImageIcon sx={{ color: '#fff', fontSize: 24, flexShrink: 0 }} />
            <Typography sx={{ ...dialogTitleSx, fontSize: 16 }}>
              Upload {pendingFiles.length} Image{pendingFiles.length !== 1 ? 's' : ''}
            </Typography>
          </Box>
        </DialogTitle>
        <DialogContent sx={{ pt: '16px !important' }}>
          {/* Preview grid */}
          {previews.length > 0 && (
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))',
                gap: 1,
                mb: 2.5,
                maxHeight: 200,
                overflowY: 'auto',
              }}
            >
              {previews.map((url, i) => (
                <Box
                  key={i}
                  component="img"
                  src={url}
                  sx={{
                    width: '100%',
                    aspectRatio: '1',
                    objectFit: 'cover',
                    borderRadius: '6px',
                    border: uploading && i === uploadIndex ? '2px solid #BC00E6' : '2px solid transparent',
                  }}
                />
              ))}
            </Box>
          )}

          {/* Upload progress */}
          {uploading && (
            <Box sx={{ mb: 2 }}>
              <Typography sx={{ fontSize: 12, color: '#FFFFFF77', mb: 0.5 }}>
                Uploading {uploadIndex + 1} of {pendingFiles.length}…
              </Typography>
              <LinearProgress
                variant="determinate"
                value={uploadProgress * 100}
                sx={{
                  borderRadius: 4,
                  height: 6,
                  bgcolor: '#FFFFFF14',
                  '& .MuiLinearProgress-bar': { bgcolor: '#BC00E6' },
                }}
              />
            </Box>
          )}

          {/* Game selector */}
          <Box sx={{ mb: 2 }}>
            <Typography sx={labelSx}>Game (applies to all)</Typography>
            <Autocomplete
              options={gameOptions}
              getOptionLabel={(o) => o.name || ''}
              groupBy={(o) => (o._source === 'db' ? 'Already in library' : 'From SteamGridDB')}
              value={selectedGame}
              inputValue={gameInput}
              onInputChange={handleGameInputChange}
              onChange={handleGameChange}
              loading={gameSearchLoading}
              disabled={gameCreating || uploading}
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
                    sx={{ color: '#FFFFFF44', '&.Mui-checked': { color: '#BC00E6' } }}
                  />
                }
                label={<Typography sx={{ fontSize: 12, color: '#FFFFFF77' }}>Auto-sort into game folder</Typography>}
                sx={{ mt: 0.5, ml: 0 }}
              />
            )}
          </Box>

          {/* Folder selector */}
          <Box sx={{ mb: 2, opacity: uploadToGameFolder && selectedGame ? 0.5 : 1 }}>
            <Typography sx={labelSx}>Upload Folder</Typography>
            <Autocomplete
              options={availableFolders}
              value={uploadToGameFolder && selectedGame ? selectedGame.name : selectedFolder || null}
              onChange={(_, value) => setSelectedFolder(value || '')}
              disableClearable={uploadToGameFolder ? true : !!selectedFolder}
              disabled={(uploadToGameFolder && !!selectedGame) || uploading}
              renderInput={(params) => <TextField {...params} size="small" sx={inputSx} />}
            />
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5, gap: 1 }}>
          <Button onClick={handleCancel} disabled={uploading} sx={{ color: '#FFFFFF77' }}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleUpload}
            disabled={uploading}
            startIcon={uploading ? <CircularProgress size={16} color="inherit" /> : <CloudUploadIcon />}
            sx={{
              background: 'linear-gradient(90deg, #BC00E6, #FF3729)',
              '&:hover': { background: 'linear-gradient(90deg, #CC10F6, #FF4739)' },
              fontWeight: 600,
            }}
          >
            {uploading ? 'Uploading…' : `Upload ${pendingFiles.length} Image${pendingFiles.length !== 1 ? 's' : ''}`}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
})

export default ImageUploadCard
