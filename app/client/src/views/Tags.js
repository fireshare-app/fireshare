import React from 'react'
import ReactDOM from 'react-dom'
import { motion } from 'framer-motion'
import TagChip from '../components/ui/TagChip'
import {
  Box,
  Grid,
  Typography,
  IconButton,
  Checkbox,
  Button,
  ButtonGroup,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  FormControlLabel,
  Popover,
  TextField,
  useTheme,
  useMediaQuery,
} from '@mui/material'
import EditIcon from '@mui/icons-material/Edit'
import DeleteIcon from '@mui/icons-material/Delete'
import CheckIcon from '@mui/icons-material/Check'
import AddIcon from '@mui/icons-material/Add'
import LocalOfferIcon from '@mui/icons-material/LocalOffer'
import { useNavigate } from 'react-router-dom'
import { SketchPicker } from 'react-color'
import { TagService } from '../services'
import SnackbarAlert from '../components/alert/SnackbarAlert'
import { getPosterUrl } from '../common/utils'
import LoadingSpinner from '../components/ui/LoadingSpinner'
import { labelSx, inputSx, dialogPaperSx, dialogTitleSx } from '../common/modalStyles'

const DEFAULT_TAG_COLOR = '#1a3a5c'

const normalizeTagColor = (hex) => {
  if (!hex || hex.length < 7) return hex
  const r = parseInt(hex.slice(1, 3), 16) / 255,
    g = parseInt(hex.slice(3, 5), 16) / 255,
    b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min
  let h = 0,
    s = 0,
    l = (max + min) / 2
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6
  }
  l = Math.max(0.15, Math.min(0.55, l))
  s = Math.min(s, 0.65)
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s,
    p = 2 * l - q
  const hf = (t) => {
    t = ((t % 1) + 1) % 1
    return Math.round(
      255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p),
    )
      .toString(16)
      .padStart(2, '0')
  }
  return `#${hf(h + 1 / 3)}${hf(h)}${hf(h - 1 / 3)}`
}

const cardBorderColor = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const factor = (Math.max(r, g, b) + Math.min(r, g, b)) / 510 < 0.25 ? 2.5 : 0.3
  return `#${[r, g, b]
    .map((c) =>
      Math.min(255, Math.round(c * factor))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

const Tags = ({ authenticated, searchText }) => {
  const [tags, setTags] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [editMode, setEditMode] = React.useState(false)
  const [selectedTags, setSelectedTags] = React.useState(new Set())
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)
  const [deleteAssociatedVideos, setDeleteAssociatedVideos] = React.useState(false)
  const [newTagDialogOpen, setNewTagDialogOpen] = React.useState(false)
  const [newTagName, setNewTagName] = React.useState('')
  const [newTagColor, setNewTagColor] = React.useState('#1a3a5c')
  const [colorPickerAnchorEl, setColorPickerAnchorEl] = React.useState(null)
  const [editingTag, setEditingTag] = React.useState(null)
  const [toolbarTarget, setToolbarTarget] = React.useState(null)
  const [alert, setAlert] = React.useState({ open: false })
  const navigate = useNavigate()
  const theme = useTheme()
  const isMdDown = useMediaQuery(theme.breakpoints.down('md'))

  const filteredTags = React.useMemo(() => {
    if (!searchText) return tags
    return tags.filter((t) => (t.name || '').toLowerCase().includes(searchText.toLowerCase()))
  }, [tags, searchText])

  const loadTags = React.useCallback(() => {
    TagService.getTags()
      .then((res) => {
        setTags(res.data)
        setLoading(false)
      })
      .catch((err) => {
        console.error('Error fetching tags:', err)
        setLoading(false)
      })
  }, [])

  React.useEffect(() => {
    loadTags()
  }, [loadTags])

  React.useEffect(() => {
    setToolbarTarget(document.getElementById('navbar-toolbar-extra'))
  }, [])

  React.useEffect(() => {
    const searchContainer = document.getElementById('navbar-search-container')
    if (searchContainer) {
      searchContainer.style.display = editMode && isMdDown ? 'none' : ''
    }
  }, [editMode, isMdDown])

  const handleEditModeToggle = () => {
    setEditMode(!editMode)
    if (editMode) setSelectedTags(new Set())
  }

  const allSelected = filteredTags.length > 0 && selectedTags.size === filteredTags.length

  const handleSelectAllToggle = () => {
    if (allSelected) {
      setSelectedTags(new Set())
    } else {
      setSelectedTags(new Set(filteredTags.map((t) => t.id)))
    }
  }

  const handleTagSelect = (tagId) => {
    const newSelected = new Set(selectedTags)
    if (newSelected.has(tagId)) {
      newSelected.delete(tagId)
    } else {
      newSelected.add(tagId)
    }
    setSelectedTags(newSelected)
  }

  const handleDeleteConfirm = async () => {
    const tagIds = Array.from(selectedTags)
    const results = await Promise.allSettled(tagIds.map((tagId) => TagService.deleteTag(tagId, deleteAssociatedVideos)))
    const failedIds = tagIds.filter((_, i) => results[i].status === 'rejected')
    loadTags()
    setDeleteDialogOpen(false)
    setDeleteAssociatedVideos(false)
    if (failedIds.length) {
      // The server refuses to delete videos the user cannot delete, so keep the
      // tags that were refused selected and say why.
      const err = results.find((r) => r.status === 'rejected').reason
      console.error('Error deleting tags:', err)
      setSelectedTags(new Set(failedIds))
      setAlert({ open: true, type: 'error', message: err.response?.data || 'Error deleting tags' })
      return
    }
    setSelectedTags(new Set())
    setEditMode(false)
  }

  const handleTagClick = (tagId) => {
    if (editMode) {
      handleTagSelect(tagId)
    } else {
      navigate(`/tags/${tagId}`)
    }
  }

  const handleCreateTag = async () => {
    if (!newTagName.trim()) return
    try {
      await TagService.createTag({ name: newTagName.trim(), color: newTagColor })
      loadTags()
      setNewTagDialogOpen(false)
      setEditingTag(null)
      setNewTagName('')
      setNewTagColor(DEFAULT_TAG_COLOR)
      setColorPickerAnchorEl(null)
    } catch (err) {
      console.error('Error creating tag:', err)
    }
  }

  const handleOpenEditTag = (e, tag) => {
    e.stopPropagation()
    setEditingTag(tag)
    setNewTagName(tag.name || '')
    setNewTagColor(tag.color || DEFAULT_TAG_COLOR)
    setNewTagDialogOpen(true)
  }

  const handleSaveTag = async () => {
    if (editingTag) {
      if (!newTagName.trim()) return
      try {
        await TagService.updateTag(editingTag.id, { name: newTagName.trim(), color: newTagColor })
        loadTags()
        setNewTagDialogOpen(false)
        setEditingTag(null)
        setNewTagName('')
        setNewTagColor(DEFAULT_TAG_COLOR)
        setColorPickerAnchorEl(null)
      } catch (err) {
        console.error('Error updating tag:', err)
      }
    } else {
      handleCreateTag()
    }
  }

  if (loading) return <LoadingSpinner />

  return (
    <>
      <SnackbarAlert severity={alert.type} open={alert.open} setOpen={(open) => setAlert({ ...alert, open })}>
        {alert.message}
      </SnackbarAlert>
      {toolbarTarget &&
        authenticated &&
        ReactDOM.createPortal(
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'nowrap', minWidth: 0 }}>
            {editMode && (
              <ButtonGroup
                variant="contained"
                sx={{
                  height: 38,
                  flexShrink: 1,
                  minWidth: 0,
                  borderRadius: '8px',
                  '& .MuiButton-root': {
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    px: { xs: 1, sm: 2 },
                  },
                }}
              >
                <Button color="primary" onClick={handleSelectAllToggle} sx={{ borderRadius: '8px 0 0 8px' }}>
                  {allSelected ? 'Select None' : 'Select All'}
                </Button>
                <Button
                  color="error"
                  startIcon={<DeleteIcon />}
                  onClick={() => setDeleteDialogOpen(true)}
                  disabled={selectedTags.size === 0}
                  sx={{ borderRadius: '0 8px 8px 0' }}
                >
                  Delete{selectedTags.size > 0 && !isMdDown ? ` (${selectedTags.size})` : null}
                </Button>
              </ButtonGroup>
            )}
            {!editMode && (
              <Button
                variant="outlined"
                startIcon={<AddIcon />}
                onClick={() => setNewTagDialogOpen(true)}
                sx={{
                  height: 38,
                  width: 120,
                  flexShrink: 0,
                  color: 'white',
                  borderRadius: '8px',
                  bgcolor: '#3399FF',
                  '&:hover': { bgcolor: '#1976D2' },
                }}
              >
                New Tag
              </Button>
            )}
            <IconButton
              onClick={handleEditModeToggle}
              sx={{
                bgcolor: editMode ? 'primary.main' : '#001E3C',
                borderRadius: '8px',
                height: '38px',
                flexShrink: 0,
                border: !editMode ? '1px solid #2684FF' : 'none',
                '&:hover': {
                  bgcolor: editMode ? 'primary.dark' : 'rgba(255, 255, 255, 0.2)',
                },
              }}
            >
              {editMode ? <CheckIcon /> : <EditIcon />}
            </IconButton>
          </Box>,
          toolbarTarget,
        )}
      <Box sx={{ p: 3 }}>
        {filteredTags.length === 0 ? (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            mt: 10,
            gap: 2,
          }}
        >
          <Box
            sx={{
              width: 80,
              height: 80,
              borderRadius: '50%',
              bgcolor: '#FFFFFF08',
              border: '1px solid #FFFFFF12',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <LocalOfferIcon sx={{ fontSize: 36, color: '#FFFFFF33' }} />
          </Box>
          <Typography sx={{ color: '#FFFFFF44', fontSize: 16, fontWeight: 500 }}>
            {searchText ? 'No tags match your search.' : 'No tags yet. Create one to get started.'}
          </Typography>
        </Box>
      ) : (
        <Grid container spacing={1.5}>
          {[...filteredTags]
            .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }))
            .map((tag, index) => {
              const isSelected = selectedTags.has(tag.id)
              const color = normalizeTagColor(tag.color || '#1a3a5c')

              return (
                <Grid item xs={12} sm={6} md={4} lg={3} xl={2} key={tag.id}>
                  <motion.div
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, delay: index * 0.035 }}
                  >
                    <Box
                      onClick={() => handleTagClick(tag.id)}
                      sx={{
                        position: 'relative',
                        height: 140,
                        borderRadius: 2,
                        overflow: 'hidden',
                        cursor: 'pointer',
                        border: isSelected ? '3px solid' : '2px solid',
                        borderColor: cardBorderColor(color),
                        ...(!tag.preview_video_id && { bgcolor: `${color}44` }),
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 0.25,
                        py: 2,
                        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
                        '&:hover': {
                          transform: 'scale(1.03)',
                          boxShadow: `inset 0 0 0 1px ${cardBorderColor(color)}, 0 8px 32px #00000088, 0 4px 20px ${color}44`,
                          '& .tag-edit-btn': { opacity: 1 },
                        },
                        boxShadow: `inset 0 0 0 1px ${cardBorderColor(color)}, 0 4px 16px #00000066`,
                      }}
                    >
                      {tag.preview_video_id && (
                        <>
                          <Box
                            sx={{
                              position: 'absolute',
                              inset: 0,
                              backgroundImage: `url(${getPosterUrl(tag.preview_video_id)})`,
                              backgroundSize: 'cover',
                              backgroundPosition: 'center',
                              filter: 'saturate(0.25)',
                              zIndex: 0,
                            }}
                          ></Box>
                          <Box
                            sx={{
                              position: 'absolute',
                              inset: 0,
                              bgcolor: color,
                              mixBlendMode: 'multiply',
                              zIndex: 0,
                            }}
                          ></Box>
                          <Box
                            sx={{
                              position: 'absolute',
                              inset: 0,
                              bgcolor: '#00000077',
                              zIndex: 0,
                            }}
                          ></Box>
                        </>
                      )}
                      {editMode && (
                        <Checkbox
                          checked={isSelected}
                          onChange={(e) => {
                            e.stopPropagation()
                            handleTagSelect(tag.id)
                          }}
                          sx={{
                            position: 'absolute',
                            top: 8,
                            left: 8,
                            zIndex: 2,
                            color: 'white',
                            bgcolor: '#00000080',
                            borderRadius: '4px',
                            '&.Mui-checked': { color: 'primary.main' },
                          }}
                        />
                      )}
                      {!editMode && (
                        <IconButton
                          className="tag-edit-btn"
                          onClick={(e) => handleOpenEditTag(e, tag)}
                          size="small"
                          sx={{
                            position: 'absolute',
                            top: 6,
                            right: 6,
                            zIndex: 2,
                            opacity: 0,
                            transition: 'opacity 0.2s ease',
                            bgcolor: '#00000080',
                            color: 'white',
                            '&:hover': { bgcolor: '#000000BB' },
                          }}
                        >
                          <EditIcon fontSize="small" />
                        </IconButton>
                      )}
                      <Box
                        sx={{
                          position: 'relative',
                          zIndex: 1,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: 0.25,
                          px: 2,
                          width: '100%',
                        }}
                      >
                        <Typography
                          sx={{
                            fontWeight: 800,
                            fontSize:
                              tag.name.length <= 4
                                ? 40
                                : tag.name.length <= 6
                                  ? 32
                                  : tag.name.length <= 8
                                    ? 26
                                    : tag.name.length <= 10
                                      ? 20
                                      : 17,
                            color: 'white',
                            textAlign: 'center',
                            lineHeight: 1.2,
                            fontFamily: '"Montserrat",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
                            width: '100%',
                          }}
                        >
                          {tag.name.replace(/_/g, ' ')}
                        </Typography>
                        <Typography
                          sx={{
                            fontSize: 13,
                            color: '#FFFFFFB3',
                            textAlign: 'center',
                            textTransform: 'uppercase',
                            letterSpacing: '0.08em',
                          }}
                        >
                          {tag.video_count ?? 0} video{tag.video_count !== 1 ? 's' : ''}
                        </Typography>
                      </Box>
                    </Box>
                  </motion.div>
                </Grid>
              )
            })}
        </Grid>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)} PaperProps={{ sx: dialogPaperSx }}>
        <DialogTitle sx={dialogTitleSx}>
          Delete {selectedTags.size} Tag{selectedTags.size > 1 ? 's' : ''}?
        </DialogTitle>
        <DialogContent>
          <Typography sx={{ mb: 2, fontSize: 14, color: '#FFFFFFB3' }}>
            Are you sure you want to delete the selected tag{selectedTags.size > 1 ? 's' : ''}?
          </Typography>
          <FormControlLabel
            control={
              <Checkbox
                checked={deleteAssociatedVideos}
                onChange={(e) => setDeleteAssociatedVideos(e.target.checked)}
                sx={{ color: 'error.main', '&.Mui-checked': { color: 'error.main' } }}
              />
            }
            label="Also delete associated videos"
          />
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setDeleteDialogOpen(false)
              setDeleteAssociatedVideos(false)
            }}
            sx={{ borderRadius: '8px', color: 'white', borderColor: 'white' }}
          >
            Cancel
          </Button>
          <Button onClick={handleDeleteConfirm} variant="contained" color="error" sx={{ borderRadius: '8px' }}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Create / Edit Tag Dialog */}
      <Dialog
        open={newTagDialogOpen}
        onClose={() => {
          setNewTagDialogOpen(false)
          setColorPickerAnchorEl(null)
        }}
        TransitionProps={{ onExited: () => setEditingTag(null) }}
        PaperProps={{ sx: dialogPaperSx }}
      >
        <DialogTitle sx={dialogTitleSx}>{editingTag ? 'Edit Tag' : 'Create New Tag'}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '20px !important', minWidth: 300 }}>
          <Box>
            <Typography sx={labelSx}>Tag Name</Typography>
            <TextField
              autoFocus
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveTag()}
              fullWidth
              sx={inputSx}
              inputProps={{ maxLength: 12 }}
            />
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Typography sx={labelSx}>Color</Typography>
            <Box
              onClick={(e) => setColorPickerAnchorEl(e.currentTarget)}
              sx={{
                width: 36,
                height: 36,
                borderRadius: 1,
                bgcolor: newTagColor,
                cursor: 'pointer',
                border: '2px solid rgba(255,255,255,0.3)',
              }}
            />
            <TagChip name={newTagName || 'Preview'} color={newTagColor} />
          </Box>
          <Popover
            open={Boolean(colorPickerAnchorEl)}
            anchorEl={colorPickerAnchorEl}
            onClose={() => setColorPickerAnchorEl(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
            transformOrigin={{ vertical: 'top', horizontal: 'left' }}
          >
            <SketchPicker
              color={newTagColor}
              onChangeComplete={(color) => setNewTagColor(color.hex)}
              styles={{
                default: {
                  picker: { background: '#1e1e2e', boxShadow: '0 4px 20px rgba(0,0,0,0.5)' },
                  label: { color: '#FFFFFFB3' },
                  hash: { color: '#FFFFFFB3', background: '#2a2a3e' },
                  input: { color: '#fff', background: '#2a2a3e', border: '1px solid #444', boxShadow: 'none' },
                },
              }}
            />
          </Popover>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setNewTagDialogOpen(false)
              setColorPickerAnchorEl(null)
            }}
            sx={{ borderRadius: '8px', color: 'white', borderColor: 'white' }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveTag}
            variant="contained"
            disabled={!newTagName.trim()}
            sx={{ borderRadius: '8px', bgcolor: '#3399FF', '&:hover': { bgcolor: '#1976D2' } }}
          >
            {editingTag ? 'Save' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>
      </Box>
    </>
  )
}

export default Tags
