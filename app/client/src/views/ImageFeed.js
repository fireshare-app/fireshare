import React from 'react'
import ReactDOM from 'react-dom'
import {
  Box,
  Grid,
  Button,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Typography,
  useTheme,
  useMediaQuery,
} from '@mui/material'
import EditIcon from '@mui/icons-material/Edit'
import CheckIcon from '@mui/icons-material/Check'
import DeleteIcon from '@mui/icons-material/Delete'
import CasinoIcon from '@mui/icons-material/Casino'
import DoneAllIcon from '@mui/icons-material/DoneAll'
import RemoveDoneIcon from '@mui/icons-material/RemoveDone'
import Select from 'react-select'
import ImageCards from '../components/cards/ImageCards'
import ImageModal from '../components/modal/ImageModal'
import { applyImageUpdate } from '../common/utils'
import { ImageService } from '../services'
import LoadingSpinner from '../components/ui/LoadingSpinner'
import SnackbarAlert from '../components/alert/SnackbarAlert'
import { folderSelectTheme as selectFolderTheme } from '../common/reactSelectThemes'
import OutlinedIconButton from '../components/ui/OutlinedIconButton'
import MarqueeSingleValue, { MarqueeOption } from '../components/ui/MarqueeSingleValue'
import { SORT_OPTIONS, PRIVACY_OPTIONS, SORT_SELECT_WIDTH, PRIVACY_SELECT_WIDTH } from '../common/constants'
import ToolbarFilterMenu from '../components/nav/ToolbarFilterMenu'

const ImageFeed = ({ authenticated, searchText, cardSize, selectedImageFolder, onImageFoldersLoaded, onImageFolderChange, showFolderDropdown, uploadTick }) => {
  const [images, setImages] = React.useState([])
  const [filteredImages, setFilteredImages] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const imageCountRef = React.useRef(0)
  const [search, setSearch] = React.useState(searchText)
  const [alert, setAlert] = React.useState({ open: false })
  const [modalImage, setModalImage] = React.useState(null)
  const [modalImageEdit, setModalImageEdit] = React.useState(false)
  const [sortOrder, setSortOrder] = React.useState(SORT_OPTIONS?.[0] || { value: 'newest', label: 'Newest' })
  const [privacyFilter, setPrivacyFilter] = React.useState(PRIVACY_OPTIONS[0])
  const [randomized, setRandomized] = React.useState(false)
  const [randomizedImages, setRandomizedImages] = React.useState([])
  const [randomizeKey, setRandomizeKey] = React.useState(0)
  const [sortKey, setSortKey] = React.useState(0)
  const [imageFolderList, setImageFolderList] = React.useState([])
  const [toolbarTarget, setToolbarTarget] = React.useState(null)

  // Edit mode state
  const [editMode, setEditMode] = React.useState(false)
  const [selectedImages, setSelectedImages] = React.useState(new Set())
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)
  const theme = useTheme()
  const isMdDown = useMediaQuery(theme.breakpoints.down('md'))
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'))

  React.useEffect(() => {
    setToolbarTarget(document.getElementById('navbar-toolbar-extra'))
  }, [])

  if (searchText !== search) {
    setSearch(searchText)
    const tagMatches = (searchText || '').match(/#(\w+)/g) || []
    const tagNames = tagMatches.map((t) => t.slice(1).toLowerCase())
    const textQuery = (searchText || '').replace(/#\w+/g, '').trim()
    setFilteredImages(
      images.filter((img) => {
        const titleMatch =
          !textQuery ||
          img.info?.title?.search(new RegExp(textQuery, 'i')) >= 0 ||
          (img.game?.name && img.game.name.search(new RegExp(textQuery, 'i')) >= 0)
        const tagMatch = tagNames.every(
          (tagName) =>
            img.tags &&
            img.tags.some(
              (t) => t.name.toLowerCase() === tagName || t.name.replace(/_/g, ' ').toLowerCase() === tagName,
            ),
        )
        return titleMatch && tagMatch
      }),
    )
  }

  function fetchImages() {
    const fetchFn = authenticated ? ImageService.getImages : ImageService.getPublicImages
    fetchFn()
      .then((res) => {
        setImages(res.data.images)
        setFilteredImages(res.data.images)
        const tfolders = []
        res.data.images.forEach((img) => {
          const split = img.path
            .split('/')
            .slice(0, -1)
            .filter((f) => f !== '')
          if (split.length > 0 && !tfolders.includes(split[0])) {
            tfolders.push(split[0])
          }
        })
        tfolders.sort((a, b) => (a.toLowerCase() > b.toLowerCase() ? 1 : -1)).unshift('All Images')
        if (onImageFoldersLoaded) onImageFoldersLoaded(tfolders)
        setImageFolderList(tfolders)
        setLoading(false)
      })
      .catch((err) => {
        setLoading(false)
        setAlert({
          open: true,
          type: 'error',
          message: typeof err.response?.data === 'string' ? err.response.data : 'Unknown Error',
        })
      })
  }

  React.useEffect(() => {
    fetchImages()
    // eslint-disable-next-line
  }, [authenticated])

  React.useEffect(() => {
    if (uploadTick === 0) return
    imageCountRef.current = images.length
    let attempts = 0
    const interval = setInterval(() => {
      attempts++
      const fetchFn = authenticated ? ImageService.getImages : ImageService.getPublicImages
      fetchFn().then((res) => {
        const fetched = res.data.images
        if (fetched.length > imageCountRef.current || attempts >= 8) {
          clearInterval(interval)
          setImages(fetched)
          setFilteredImages(fetched)
          const tfolders = []
          fetched.forEach((img) => {
            const split = img.path
              .split('/')
              .slice(0, -1)
              .filter((f) => f !== '')
            if (split.length > 0 && !tfolders.includes(split[0])) tfolders.push(split[0])
          })
          tfolders.sort((a, b) => (a.toLowerCase() > b.toLowerCase() ? 1 : -1)).unshift('All Images')
          if (onImageFoldersLoaded) onImageFoldersLoaded(tfolders)
          setImageFolderList(tfolders)
        }
      })
    }, 2000)
    return () => clearInterval(interval)
    // eslint-disable-next-line
  }, [uploadTick])

  const folder = selectedImageFolder || { value: 'All Images', label: 'All Images' }

  const prevFolderRef = React.useRef(folder.value)
  React.useEffect(() => {
    if (prevFolderRef.current !== folder.value) {
      prevFolderRef.current = folder.value
      setRandomizeKey((k) => k + 1)
      window.scrollTo({ top: 0 })
    }
  }, [folder.value])

  const displayImages = React.useMemo(() => {
    if (!filteredImages) return filteredImages

    const folderFiltered =
      folder.value === 'All Images'
        ? filteredImages
        : filteredImages.filter(
            (img) =>
              img.path
                .split('/')
                .slice(0, -1)
                .filter((f) => f !== '')[0] === folder.value,
          )

    if (privacyFilter.value === 'all') return folderFiltered
    return folderFiltered.filter((img) => img.info?.private === (privacyFilter.value === 'private'))
  }, [filteredImages, folder, privacyFilter])

  const sortedImages = React.useMemo(() => {
    if (!displayImages) return []
    return [...displayImages].sort((a, b) => {
      if (sortOrder.value === 'most_views') {
        return (b.view_count || 0) - (a.view_count || 0)
      } else if (sortOrder.value === 'least_views') {
        return (a.view_count || 0) - (b.view_count || 0)
      } else if (sortOrder.value === 'name_asc' || sortOrder.value === 'name_desc') {
        const nameA = (a.info?.title || '').toLowerCase()
        const nameB = (b.info?.title || '').toLowerCase()
        const cmp = nameA.localeCompare(nameB)
        return sortOrder.value === 'name_asc' ? cmp : -cmp
      } else {
        const dateA = a.created_at ? new Date(a.created_at) : new Date(0)
        const dateB = b.created_at ? new Date(b.created_at) : new Date(0)
        return sortOrder.value === 'newest' ? dateB - dateA : dateA - dateB
      }
    })
  }, [displayImages, sortOrder])

  const finalImages = randomized ? randomizedImages : sortedImages

  const handleSortChange = (option) => {
    setSortOrder(option)
    setRandomized(false)
    setSortKey((k) => k + 1)
    window.scrollTo({ top: 0 })
  }

  const handlePrivacyChange = (option) => {
    setPrivacyFilter(option)
    setRandomized(false)
    setSortKey((k) => k + 1)
    window.scrollTo({ top: 0 })
  }

  // Same filters the desktop toolbar shows inline, described for the collapsed
  // mobile menu. The defaults drive the "filters are active" dot on the button.
  const mobileFilters = [
    showFolderDropdown &&
      imageFolderList.length > 1 && {
        key: 'folder',
        label: 'Folder',
        value: selectedImageFolder,
        options: imageFolderList.map((f) => ({ value: f, label: f })),
        onChange: onImageFolderChange,
        defaultValue: 'All Images',
        selectProps: { components: { SingleValue: MarqueeSingleValue, Option: MarqueeOption } },
      },
    {
      key: 'sort',
      label: 'Sort by',
      value: sortOrder,
      options: SORT_OPTIONS,
      onChange: handleSortChange,
      defaultValue: SORT_OPTIONS[0].value,
    },
    authenticated && {
      key: 'privacy',
      label: 'Visibility',
      value: privacyFilter,
      options: PRIVACY_OPTIONS,
      onChange: handlePrivacyChange,
      defaultValue: PRIVACY_OPTIONS[0].value,
    },
  ]

  const handleRandomize = () => {
    const shuffled = [...displayImages].sort(() => Math.random() - 0.5)
    setRandomizedImages(shuffled)
    setRandomized(true)
    setRandomizeKey((k) => k + 1)
    window.scrollTo({ top: 0 })
  }

  const handleImageOpen = React.useCallback((image, options) => {
    setModalImage(image)
    setModalImageEdit(Boolean(options?.edit))
  }, [])

  // Edit mode handlers
  const handleEditModeToggle = () => {
    setEditMode(!editMode)
    if (editMode) setSelectedImages(new Set())
  }

  const handleImageSelect = React.useCallback((imageId) => {
    setSelectedImages((prev) => {
      const next = new Set(prev)
      if (next.has(imageId)) next.delete(imageId)
      else next.add(imageId)
      return next
    })
  }, [])

  const allSelected = finalImages.length > 0 && selectedImages.size === finalImages.length

  const handleSelectAllToggle = () => {
    if (allSelected) setSelectedImages(new Set())
    else setSelectedImages(new Set(finalImages.map((img) => img.image_id)))
  }

  const handleDeleteClick = () => setDeleteDialogOpen(true)
  const handleDeleteCancel = () => setDeleteDialogOpen(false)

  const handleDeleteConfirm = async () => {
    try {
      await Promise.all(Array.from(selectedImages).map((id) => ImageService.delete(id)))
      setAlert({
        open: true,
        type: 'success',
        message: `Deleted ${selectedImages.size} image${selectedImages.size > 1 ? 's' : ''}`,
      })
      fetchImages()
      setSelectedImages(new Set())
      setDeleteDialogOpen(false)
      setEditMode(false)
    } catch (err) {
      setAlert({
        open: true,
        type: 'error',
        message: err.response?.data || 'Error deleting images',
      })
    }
  }

  const handleNext = React.useCallback(() => {
    setModalImage((cur) => {
      if (!cur) return cur
      const idx = finalImages.findIndex((img) => img.image_id === cur.image_id)
      return idx >= 0 && idx < finalImages.length - 1 ? finalImages[idx + 1] : cur
    })
  }, [finalImages])

  const handlePrev = React.useCallback(() => {
    setModalImage((cur) => {
      if (!cur) return cur
      const idx = finalImages.findIndex((img) => img.image_id === cur.image_id)
      return idx > 0 ? finalImages[idx - 1] : cur
    })
  }, [finalImages])

  const handleModalClose = (update) => {
    if (update) {
      // Update the image in state with any changes from the modal
      const updateImage = (img) => {
        if (img.image_id !== modalImage.image_id) return img
        return applyImageUpdate(img, update)
      }
      setImages((prev) => prev.map(updateImage))
      setFilteredImages((prev) => prev.map(updateImage))
    }
    setModalImage(null)
  }

  return (
    <>
      <SnackbarAlert severity={alert.type} open={alert.open} setOpen={(open) => setAlert({ ...alert, open })}>
        {alert.message}
      </SnackbarAlert>
      {toolbarTarget &&
        ReactDOM.createPortal(
          <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 0.5, sm: 1 }, flexWrap: 'nowrap', minWidth: 0 }}>
            {!(editMode && isMdDown) && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 0.5, sm: 1 }, flexShrink: 0 }}>
                {isMobile ? (
                  <ToolbarFilterMenu filters={mobileFilters} />
                ) : (
                  <>
                    {showFolderDropdown && imageFolderList.length > 1 && (
                      <Box sx={{ minWidth: 150, maxWidth: 200, flexShrink: 0 }}>
                        <Select
                          value={selectedImageFolder}
                          options={imageFolderList.map((f) => ({ value: f, label: f }))}
                          onChange={onImageFolderChange}
                          styles={selectFolderTheme}
                          menuPortalTarget={document.body}
                          menuPosition="fixed"
                          blurInputOnSelect
                          isSearchable={false}
                          components={{ SingleValue: MarqueeSingleValue, Option: MarqueeOption }}
                        />
                      </Box>
                    )}
                    <Box sx={{ minWidth: SORT_SELECT_WIDTH }}>
                      <Select
                        value={sortOrder}
                        options={SORT_OPTIONS}
                        onChange={handleSortChange}
                        styles={selectFolderTheme}
                        menuPortalTarget={document.body}
                        menuPosition="fixed"
                        blurInputOnSelect
                        isSearchable={false}
                      />
                    </Box>
                    {authenticated && (
                      <Box sx={{ minWidth: PRIVACY_SELECT_WIDTH }}>
                        <Select
                          value={privacyFilter}
                          options={PRIVACY_OPTIONS}
                          onChange={handlePrivacyChange}
                          styles={selectFolderTheme}
                          menuPortalTarget={document.body}
                          menuPosition="fixed"
                          blurInputOnSelect
                          isSearchable={false}
                        />
                      </Box>
                    )}
                  </>
                )}
                <IconButton
                  onClick={handleRandomize}
                  title="Randomize order"
                  sx={{
                    border: '1px solid',
                    borderColor: randomized ? '#FFFFFF55' : '#FFFFFF33',
                    borderRadius: '8px',
                    height: '38px',
                    width: '38px',
                    flexShrink: 0,
                    bgcolor: randomized ? '#FFFFFF18' : 'transparent',
                    color: '#FFFFFFCC',
                    '&:hover': { borderColor: '#FFFFFF66', bgcolor: '#FFFFFF0D' },
                  }}
                >
                  <CasinoIcon fontSize="small" />
                </IconButton>
              </Box>
            )}
            {authenticated && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'nowrap', minWidth: 0 }}>
                {editMode && (
                  <Box sx={{ display: 'flex', gap: { xs: 0.5, sm: 1 }, flexShrink: 1, minWidth: 0 }}>
                    <OutlinedIconButton
                      onClick={handleSelectAllToggle}
                      icon={
                        isMdDown ? (
                          allSelected ? <RemoveDoneIcon sx={{ fontSize: 16 }} /> : <DoneAllIcon sx={{ fontSize: 16 }} />
                        ) : undefined
                      }
                      title={allSelected ? 'Select None' : 'Select All'}
                    >
                      {!isMdDown ? (allSelected ? 'Select None' : 'Select All') : null}
                    </OutlinedIconButton>
                    <OutlinedIconButton
                      icon={<DeleteIcon sx={{ fontSize: 16 }} />}
                      onClick={handleDeleteClick}
                      disabled={selectedImages.size === 0}
                      sx={{ color: selectedImages.size > 0 ? '#FF6B6B' : undefined, borderColor: selectedImages.size > 0 ? '#FF6B6B66' : undefined }}
                    >
                      {!isMdDown ? `Delete${selectedImages.size > 0 ? ` (${selectedImages.size})` : ''}` : null}
                    </OutlinedIconButton>
                  </Box>
                )}
                <IconButton
                  onClick={handleEditModeToggle}
                  sx={{
                    border: '1px solid',
                    borderColor: editMode ? '#FFFFFF55' : '#FFFFFF33',
                    borderRadius: '8px',
                    height: '38px',
                    width: '38px',
                    flexShrink: 0,
                    bgcolor: editMode ? '#FFFFFF18' : 'transparent',
                    color: '#FFFFFFCC',
                    '&:hover': { borderColor: '#FFFFFF66', bgcolor: '#FFFFFF0D' },
                  }}
                >
                  {editMode ? <CheckIcon /> : <EditIcon />}
                </IconButton>
              </Box>
            )}
          </Box>,
          toolbarTarget,
        )}
      <ImageModal
        open={Boolean(modalImage)}
        onClose={handleModalClose}
        image={modalImage}
        startInEditMode={modalImageEdit}
        alertHandler={setAlert}
        authenticated={authenticated}
        onNext={handleNext}
        onPrev={handlePrev}
      />
      <Box>
        <Grid container item justifyContent="center">
          <Grid item xs={12}>
            <Box>
              <Box>
                {loading && <LoadingSpinner />}
                {!loading && (
                  <ImageCards
                    key={`${randomizeKey}-${sortKey}`}
                    images={finalImages}
                    authenticated={authenticated}
                    feedView={!authenticated}
                    size={cardSize}
                    onImageOpen={handleImageOpen}
                    editMode={editMode}
                    selectedImages={selectedImages}
                    onImageSelect={handleImageSelect}
                  />
                )}
              </Box>
            </Box>
          </Grid>
        </Grid>
      </Box>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={handleDeleteCancel}>
        <DialogTitle>
          Delete {selectedImages.size} Image{selectedImages.size > 1 ? 's' : ''}?
        </DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete the selected image{selectedImages.size > 1 ? 's' : ''}? This will
            permanently delete the original file{selectedImages.size > 1 ? 's' : ''}.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDeleteCancel}>Cancel</Button>
          <Button onClick={handleDeleteConfirm} variant="contained" color="error">
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

export default ImageFeed
