import React from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { GameService } from '../../services'
import { dialogPaperSx, dialogTitleSx, fullScreenDialogPaperSx, helperTextSx, inputSx } from '../../common/modalStyles'
import AssetCropField, { ASSET_ORDER, ASSET_SPECS } from '../game/AssetCropField'

const emptyAssets = () => ({ hero: null, banner: null, logo: null, icon: null })

/**
 * Add a game by hand, or edit one that was added that way.
 *
 * With `game` null this creates a new custom game: a name plus a hero, logo and
 * icon are required, a banner is optional. With a custom `game` it edits that
 * game: every field is optional and only the slots given a new file are
 * replaced. `onSaved` receives the game as the server returned it.
 */
const CustomGameModal = ({ open, game, onClose, onSaved }) => {
  const isEdit = Boolean(game)
  const theme = useTheme()
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'))

  const [name, setName] = React.useState('')
  const [releaseDate, setReleaseDate] = React.useState('')
  const [assets, setAssets] = React.useState(emptyAssets)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState(null)

  React.useEffect(() => {
    if (!open) return
    setName(game?.name || '')
    setReleaseDate(game?.release_date || '')
    setAssets(emptyAssets())
    setSaving(false)
    setError(null)
  }, [open, game])

  const setAsset = (type) => (value) => setAssets((prev) => ({ ...prev, [type]: value }))

  const trimmedName = name.trim()
  const missing = ASSET_ORDER.filter(
    (type) => ASSET_SPECS[type].required && !assets[type] && !(isEdit && game?.[`${type}_url`]),
  )
  const hasNewAsset = ASSET_ORDER.some((type) => assets[type]?.file)
  const changed =
    !isEdit || hasNewAsset || trimmedName !== (game?.name || '') || (releaseDate || '') !== (game?.release_date || '')
  const canSave = Boolean(trimmedName) && missing.length === 0 && changed && !saving

  const handleSave = async () => {
    if (!canSave) return
    const form = new FormData()
    form.append('name', trimmedName)
    form.append('release_date', releaseDate || '')
    ASSET_ORDER.forEach((type) => {
      const value = assets[type]
      if (!value?.file) return
      form.append(type, value.file, value.file.name)
      // The rectangle is in the pixels of the image as this browser decoded it;
      // the natural size lets the server rescale it if it decodes differently.
      if (value.area) {
        form.append(
          `${type}_crop`,
          JSON.stringify({ ...value.area, naturalWidth: value.width, naturalHeight: value.height }),
        )
      }
    })

    setSaving(true)
    setError(null)
    try {
      const res = isEdit
        ? await GameService.updateCustomGame(game.steamgriddb_id, form)
        : await GameService.createCustomGame(form)
      onSaved(res.data)
    } catch (err) {
      const data = err?.response?.data
      setError((data && (data.error || (typeof data === 'string' ? data : null))) || 'Failed to save the game.')
      setSaving(false)
    }
  }

  const handleClose = () => {
    if (!saving) onClose()
  }

  const missingLabels = missing.map((type) => ASSET_SPECS[type].label.toLowerCase())

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      fullWidth
      maxWidth="sm"
      fullScreen={fullScreen}
      PaperProps={{ sx: fullScreen ? fullScreenDialogPaperSx : dialogPaperSx }}
    >
      <DialogTitle
        sx={{
          ...dialogTitleSx,
          px: 3,
          pt: 2.5,
          pb: 1.5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        {isEdit ? `Edit ${game.name}` : 'Add game'}
        <IconButton
          onClick={handleClose}
          size="small"
          disabled={saving}
          sx={{ color: '#FFFFFF66', '&:hover': { color: 'white', bgcolor: '#FFFFFF14' } }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ px: 3, pt: '8px !important', pb: 1 }}>
        <Stack spacing={2.5}>
          {!isEdit ? (
            <Typography sx={helperTextSx}>
              For games SteamGridDB does not have yet. Upload the artwork yourself; each image is cropped to its slot's
              shape and scaled to the recommended size.
            </Typography>
          ) : null}

          {error ? (
            <Alert severity="error" variant="outlined" onClose={() => setError(null)}>
              {error}
            </Alert>
          ) : null}

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 180px' }, gap: 2 }}>
            <TextField
              label="Name"
              size="small"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={saving}
              required
              autoFocus={!isEdit}
              inputProps={{ maxLength: 256 }}
              sx={inputSx}
              InputLabelProps={{ sx: { color: '#FFFFFF80' } }}
            />
            <TextField
              label="Release date"
              size="small"
              type="date"
              value={releaseDate}
              onChange={(e) => setReleaseDate(e.target.value)}
              disabled={saving}
              sx={{ ...inputSx, '& input': { colorScheme: 'dark' } }}
              InputLabelProps={{ shrink: true, sx: { color: '#FFFFFF80' } }}
            />
          </Box>

          {ASSET_ORDER.map((type, i) => (
            <React.Fragment key={type}>
              {i > 0 ? <Divider sx={{ borderColor: '#FFFFFF14' }} /> : null}
              <AssetCropField
                type={type}
                value={assets[type]}
                onChange={setAsset(type)}
                currentUrl={isEdit ? game?.[`${type}_url`] : null}
                disabled={saving}
              />
            </React.Fragment>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5, pt: 1.5, gap: 1 }}>
        {missing.length > 0 && trimmedName ? (
          <Typography sx={{ ...helperTextSx, fontSize: 12, mr: 'auto' }}>
            Add a {missingLabels.join(', ')} image to continue.
          </Typography>
        ) : null}
        <Button
          onClick={handleClose}
          disabled={saving}
          sx={{ color: '#FFFFFF80', '&:hover': { color: 'white', bgcolor: '#FFFFFF0F' } }}
        >
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          variant="contained"
          disabled={!canSave}
          sx={{ fontWeight: 600, px: 3, bgcolor: '#3399FF', '&:hover': { bgcolor: '#1976D2' } }}
        >
          {saving ? <CircularProgress size={16} sx={{ mr: 1, color: 'white' }} /> : null}
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add game'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default CustomGameModal
