import React from 'react'
import ReactDOM from 'react-dom'
import { motion } from 'framer-motion'
import {
  Box,
  IconButton,
  Button,
  ButtonGroup,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Typography,
  Autocomplete,
  TextField,
  useTheme,
  useMediaQuery,
} from '@mui/material'
import { useParams } from 'react-router-dom'
import Select from 'react-select'
import EditIcon from '@mui/icons-material/Edit'
import CheckIcon from '@mui/icons-material/Check'
import DeleteIcon from '@mui/icons-material/Delete'
import LinkIcon from '@mui/icons-material/Link'
import { GameService, VideoService, ImageService } from '../services'
import { recordAssetBust, applyAssetBusts } from '../services/GameService'
import { getGameAssetUrl } from '../common/utils'
import CompactVideoCard from '../components/cards/CompactVideoCard'
import VideoModal from '../components/modal/VideoModal'
import CompactImageCard from '../components/cards/CompactImageCard'
import EditImageModal from '../components/modal/EditImageModal'
import GameVideosHeader from '../components/game/GameVideosHeader'
import GameSearch from '../components/game/GameSearch'
import LoadingSpinner from '../components/ui/LoadingSpinner'
import EditGameAssetsModal from '../components/modal/EditGameAssetsModal'
import CustomGameModal from '../components/modal/CustomGameModal'
import SnackbarAlert from '../components/alert/SnackbarAlert'
import { SORT_OPTIONS, SORT_SELECT_WIDTH } from '../common/constants'
import { sortSelectTheme as selectSortTheme } from '../common/reactSelectThemes'

const PAGE_SIZE = 48

const GameVideos = ({ cardSize, authenticated, searchText }) => {
  const { gameId } = useParams()
  const theme = useTheme()
  const isMdDown = useMediaQuery(theme.breakpoints.down('md'))

  const [videos, setVideos] = React.useState([])
  const [filteredVideos, setFilteredVideos] = React.useState([])
  const [images, setImages] = React.useState([])
  const [filteredImages, setFilteredImages] = React.useState([])
  const [modalImage, setModalImage] = React.useState(null)
  const [videoModal, setVideoModal] = React.useState({ open: false })
  const [search, setSearch] = React.useState(searchText)
  const [game, setGame] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [sortOrder, setSortOrder] = React.useState(SORT_OPTIONS?.[0] || { value: 'newest', label: 'Newest' })
  const [toolbarTarget, setToolbarTarget] = React.useState(null)
  const [alert, setAlert] = React.useState({ open: false })

  // Edit mode
  const [editMode, setEditMode] = React.useState(false)
  const [selectedVideos, setSelectedVideos] = React.useState(new Set())
  const [selectedImages, setSelectedImages] = React.useState(new Set())
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)
  const [linkGameDialogOpen, setLinkGameDialogOpen] = React.useState(false)
  const [games, setGames] = React.useState([])
  const [selectedGame, setSelectedGame] = React.useState(null)
  const [showAddNewGame, setShowAddNewGame] = React.useState(false)

  // Cover art editing
  const [editingAssets, setEditingAssets] = React.useState(false)

  const [visibleCount, setVisibleCount] = React.useState(PAGE_SIZE)
  const sentinelRef = React.useRef()

  if (searchText !== search) {
    setSearch(searchText)
    const re = new RegExp(searchText, 'i')
    setFilteredVideos(videos.filter((v) => v.info?.title?.search(re) >= 0))
    setFilteredImages(images.filter((img) => img.info?.title?.search(re) >= 0))
  }

  React.useEffect(() => {
    Promise.all([GameService.getGames(), GameService.getGameVideos(gameId), GameService.getGameImages(gameId)])
      .then(([gamesRes, videosRes, imagesRes]) => {
        const foundGame = applyAssetBusts(gamesRes.data).find((g) => g.steamgriddb_id === parseInt(gameId))
        setGame(foundGame)
        const fetchedVideos = videosRes.data || []
        setVideos(fetchedVideos)
        setFilteredVideos(fetchedVideos)
        const fetchedImages = imagesRes.data || []
        setImages(fetchedImages)
        setFilteredImages(fetchedImages)
        setLoading(false)
      })
      .catch((err) => {
        console.error('Error fetching game media:', err)
        setLoading(false)
      })
  }, [gameId])

  React.useEffect(() => {
    setToolbarTarget(document.getElementById('navbar-toolbar-extra'))
  }, [])

  React.useEffect(() => {
    const searchContainer = document.getElementById('navbar-search-container')
    if (searchContainer) {
      searchContainer.style.display = editMode && isMdDown ? 'none' : ''
    }
  }, [editMode, isMdDown])

  // ── Edit mode handlers ────────────────────────────────────────────────────

  const handleEditModeToggle = () => {
    setEditMode(!editMode)
    if (editMode) {
      setSelectedVideos(new Set())
      setSelectedImages(new Set())
    }
  }

  const handleVideoSelect = (videoId) => {
    const next = new Set(selectedVideos)
    if (next.has(videoId)) next.delete(videoId)
    else next.add(videoId)
    setSelectedVideos(next)
  }

  const handleImageSelect = (imageId) => {
    const next = new Set(selectedImages)
    if (next.has(imageId)) next.delete(imageId)
    else next.add(imageId)
    setSelectedImages(next)
  }

  const handleDeleteConfirm = async () => {
    try {
      const deletions = [
        ...Array.from(selectedVideos).map((id) => VideoService.delete(id)),
        ...Array.from(selectedImages).map((id) => ImageService.delete(id)),
      ]
      await Promise.all(deletions)
      const count = selectedVideos.size + selectedImages.size
      setAlert({ open: true, type: 'success', message: `Deleted ${count} item${count > 1 ? 's' : ''}` })
      const [videosRes, imagesRes] = await Promise.all([
        GameService.getGameVideos(gameId),
        GameService.getGameImages(gameId),
      ])
      const fetchedVideos = videosRes.data || []
      setVideos(fetchedVideos)
      setFilteredVideos(fetchedVideos)
      const fetchedImages = imagesRes.data || []
      setImages(fetchedImages)
      setFilteredImages(fetchedImages)
      setSelectedVideos(new Set())
      setSelectedImages(new Set())
      setDeleteDialogOpen(false)
      setEditMode(false)
    } catch (err) {
      setAlert({ open: true, type: 'error', message: err.response?.data || 'Error deleting items' })
    }
  }

  const handleLinkGameClick = async () => {
    try {
      const res = await GameService.getGames()
      setGames(res.data)
      setLinkGameDialogOpen(true)
      setShowAddNewGame(false)
      setSelectedGame(null)
    } catch (err) {
      setAlert({ open: true, type: 'error', message: err.response?.data || 'Error fetching games' })
    }
  }

  const handleLinkGameConfirm = async () => {
    if (!selectedGame) return
    try {
      const links = [
        ...Array.from(selectedVideos).map((id) => GameService.linkVideoToGame(id, selectedGame.id)),
        ...Array.from(selectedImages).map((id) => ImageService.linkGame(id, selectedGame.id)),
      ]
      await Promise.all(links)
      const count = selectedVideos.size + selectedImages.size
      setAlert({
        open: true,
        type: 'success',
        message: `Linked ${count} item${count > 1 ? 's' : ''} to ${selectedGame.name}`,
      })
      setSelectedVideos(new Set())
      setSelectedImages(new Set())
      setLinkGameDialogOpen(false)
      setSelectedGame(null)
      setEditMode(false)
    } catch (err) {
      setAlert({ open: true, type: 'error', message: err.response?.data || 'Error linking items' })
    }
  }

  const handleNewGameCreated = async (newGame) => {
    try {
      const links = [
        ...Array.from(selectedVideos).map((id) => GameService.linkVideoToGame(id, newGame.id)),
        ...Array.from(selectedImages).map((id) => ImageService.linkGame(id, newGame.id)),
      ]
      await Promise.all(links)
      const count = selectedVideos.size + selectedImages.size
      setAlert({
        open: true,
        type: 'success',
        message: `Linked ${count} item${count > 1 ? 's' : ''} to ${newGame.name}`,
      })
      setSelectedVideos(new Set())
      setSelectedImages(new Set())
      setLinkGameDialogOpen(false)
      setShowAddNewGame(false)
      setEditMode(false)
    } catch (err) {
      setAlert({ open: true, type: 'error', message: err.response?.data || 'Error linking items to new game' })
    }
  }

  // ── Cover art handlers ────────────────────────────────────────────────────

  const handleAssetSaved = () => {
    const bust = Date.now()
    const parsedGameId = parseInt(gameId)
    recordAssetBust(parsedGameId)
    window.dispatchEvent(new CustomEvent('gameAssetsUpdated', { detail: { steamgriddbId: parsedGameId, bust } }))
    setEditingAssets(false)
    setGame((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        hero_url: getGameAssetUrl(prev.steamgriddb_id, 'hero_1', bust),
        banner_url: getGameAssetUrl(prev.steamgriddb_id, 'hero_2', bust),
        logo_url: getGameAssetUrl(prev.steamgriddb_id, 'logo_1', bust),
        icon_url: getGameAssetUrl(prev.steamgriddb_id, 'icon_1', bust),
      }
    })
  }

  const handleCustomGameSaved = (saved) => {
    setGame((prev) => (prev ? { ...prev, name: saved.name, release_date: saved.release_date } : prev))
    handleAssetSaved()
    setAlert({ open: true, type: 'success', message: `Updated ${saved.name}` })
  }

  // ── Sorting ───────────────────────────────────────────────────────────────

  const sortedVideos = React.useMemo(() => {
    if (!filteredVideos || !Array.isArray(filteredVideos)) return []
    return [...filteredVideos].sort((a, b) => {
      if (sortOrder.value === 'most_views') return (b.view_count || 0) - (a.view_count || 0)
      if (sortOrder.value === 'least_views') return (a.view_count || 0) - (b.view_count || 0)
      if (sortOrder.value === 'name_asc' || sortOrder.value === 'name_desc') {
        const cmp = (a.info?.title || '').toLowerCase().localeCompare((b.info?.title || '').toLowerCase())
        return sortOrder.value === 'name_asc' ? cmp : -cmp
      }
      const dateA = a.recorded_at ? new Date(a.recorded_at) : new Date(0)
      const dateB = b.recorded_at ? new Date(b.recorded_at) : new Date(0)
      return sortOrder.value === 'newest' ? dateB - dateA : dateA - dateB
    })
  }, [filteredVideos, sortOrder])

  // Mixed sorted list of videos + images for the game page
  const sortedMedia = React.useMemo(() => {
    const tagged = [
      ...sortedVideos.map((v) => ({
        type: 'video',
        item: v,
        date: v.recorded_at ? new Date(v.recorded_at) : new Date(0),
        views: v.view_count || 0,
      })),
      ...(filteredImages || []).map((img) => ({
        type: 'image',
        item: img,
        date: img.created_at ? new Date(img.created_at) : new Date(0),
        views: img.view_count || 0,
      })),
    ]
    return tagged.sort((a, b) => {
      if (sortOrder.value === 'most_views') return b.views - a.views
      if (sortOrder.value === 'least_views') return a.views - b.views
      if (sortOrder.value === 'name_asc' || sortOrder.value === 'name_desc') {
        const cmp = (a.item.info?.title || '').toLowerCase().localeCompare((b.item.info?.title || '').toLowerCase())
        return sortOrder.value === 'name_asc' ? cmp : -cmp
      }
      return sortOrder.value === 'newest' ? b.date - a.date : a.date - b.date
    })
  }, [sortedVideos, filteredImages, sortOrder])

  React.useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [sortedMedia])

  React.useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, sortedMedia.length))
      },
      { rootMargin: '400px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [sortedMedia.length])

  const totalSelected = selectedVideos.size + selectedImages.size

  const allMediaSelected = sortedMedia.length > 0 && totalSelected === sortedMedia.length

  const handleSelectAllToggle = () => {
    if (allMediaSelected) {
      setSelectedVideos(new Set())
      setSelectedImages(new Set())
    } else {
      setSelectedVideos(new Set(sortedMedia.filter((m) => m.type === 'video').map((m) => m.item.video_id)))
      setSelectedImages(new Set(sortedMedia.filter((m) => m.type === 'image').map((m) => m.item.image_id)))
    }
  }

  const handleImageOpen = React.useCallback((image) => setModalImage(image), [])

  const handleImageModalClose = (update) => {
    if (update) {
      setImages((prev) =>
        prev.map((img) => {
          if (img.image_id !== modalImage?.image_id) return img
          return {
            ...img,
            info: {
              ...img.info,
              ...(update.title !== undefined && { title: update.title }),
              ...(update.private !== undefined && { private: update.private }),
            },
            ...(update.game !== undefined && { game: update.game }),
            ...(update.created_at !== undefined && { created_at: update.created_at }),
            ...(update.uploader !== undefined && { uploader: update.uploader }),
          }
        }),
      )
      setFilteredImages((prev) =>
        prev.map((img) => {
          if (img.image_id !== modalImage?.image_id) return img
          return {
            ...img,
            info: {
              ...img.info,
              ...(update.title !== undefined && { title: update.title }),
              ...(update.private !== undefined && { private: update.private }),
            },
            ...(update.game !== undefined && { game: update.game }),
            ...(update.created_at !== undefined && { created_at: update.created_at }),
            ...(update.uploader !== undefined && { uploader: update.uploader }),
          }
        }),
      )
    }
    setModalImage(null)
  }

  const handleVideoUpdate = ({ id, ...rest }) => {
    const apply = (vs) => vs.map((v) => (v.video_id === id ? { ...v, info: { ...v.info, ...rest } } : v))
    setVideos(apply)
    setFilteredVideos(apply)
  }

  const handleImageModalNext = React.useCallback(() => {
    setModalImage((cur) => {
      if (!cur) return cur
      const imageItems = sortedMedia.filter((m) => m.type === 'image').map((m) => m.item)
      const idx = imageItems.findIndex((img) => img.image_id === cur.image_id)
      return idx >= 0 && idx < imageItems.length - 1 ? imageItems[idx + 1] : cur
    })
  }, [sortedMedia])

  const handleImageModalPrev = React.useCallback(() => {
    setModalImage((cur) => {
      if (!cur) return cur
      const imageItems = sortedMedia.filter((m) => m.type === 'image').map((m) => m.item)
      const idx = imageItems.findIndex((img) => img.image_id === cur.image_id)
      return idx > 0 ? imageItems[idx - 1] : cur
    })
  }, [sortedMedia])

  if (loading) return <LoadingSpinner />

  const isAllSelected = allMediaSelected

  return (
    <>
      <SnackbarAlert severity={alert.type} open={alert.open} setOpen={(open) => setAlert({ ...alert, open })}>
        {alert.message}
      </SnackbarAlert>

      {toolbarTarget &&
        ReactDOM.createPortal(
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'nowrap', minWidth: 0 }}>
            {!(editMode && isMdDown) && (
              <Box sx={{ minWidth: SORT_SELECT_WIDTH, flexShrink: 0 }}>
                <Select
                  value={sortOrder}
                  options={SORT_OPTIONS}
                  onChange={setSortOrder}
                  styles={selectSortTheme}
                  menuPortalTarget={document.body}
                  menuPosition="fixed"
                  blurInputOnSelect
                  isSearchable={false}
                />
              </Box>
            )}
            {authenticated && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'nowrap', minWidth: 0 }}>
                {editMode && (
                  <ButtonGroup
                    variant="contained"
                    sx={{
                      height: 38,
                      flexShrink: 1,
                      minWidth: 0,
                      '& .MuiButton-root': {
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        px: { xs: 1, sm: 2 },
                      },
                    }}
                  >
                    <Button color="primary" onClick={handleSelectAllToggle}>
                      {isAllSelected ? 'Select None' : 'Select All'}
                    </Button>
                    <Button
                      color="primary"
                      startIcon={<LinkIcon />}
                      onClick={handleLinkGameClick}
                      disabled={totalSelected === 0}
                    >
                      Link{totalSelected > 0 && !isMdDown ? ` (${totalSelected})` : null}
                    </Button>
                    <Button
                      color="error"
                      startIcon={<DeleteIcon />}
                      onClick={() => setDeleteDialogOpen(true)}
                      disabled={totalSelected === 0}
                    >
                      Delete{totalSelected > 0 && !isMdDown ? ` (${totalSelected})` : null}
                    </Button>
                  </ButtonGroup>
                )}
                <IconButton
                  onClick={handleEditModeToggle}
                  sx={{
                    bgcolor: editMode ? 'primary.main' : '#001E3C',
                    borderRadius: '8px',
                    height: '38px',
                    flexShrink: 0,
                    border: !editMode ? '1px solid #2684FF' : 'none',
                    '&:hover': { bgcolor: editMode ? 'primary.dark' : '#FFFFFF33' },
                  }}
                >
                  {editMode ? <CheckIcon /> : <EditIcon />}
                </IconButton>
              </Box>
            )}
          </Box>,
          toolbarTarget,
        )}

      <GameVideosHeader game={game} editMode={editMode} onEditAssets={() => setEditingAssets(true)} />
      <VideoModal
        open={videoModal.open}
        onClose={() => setVideoModal({ open: false })}
        videoId={videoModal.id}
        feedView={false}
        authenticated={authenticated}
        updateCallback={handleVideoUpdate}
        onSuggestionSelect={(id) => setVideoModal({ open: true, id })}
        onNext={() => {
          const videoItems = sortedMedia.filter((m) => m.type === 'video').map((m) => m.item)
          const i = videoItems.findIndex((v) => v.video_id === videoModal.id)
          if (i < videoItems.length - 1) setVideoModal({ open: true, id: videoItems[i + 1].video_id })
        }}
        onPrev={() => {
          const videoItems = sortedMedia.filter((m) => m.type === 'video').map((m) => m.item)
          const i = videoItems.findIndex((v) => v.video_id === videoModal.id)
          if (i > 0) setVideoModal({ open: true, id: videoItems[i - 1].video_id })
        }}
      />
      <EditImageModal
        open={Boolean(modalImage)}
        onClose={handleImageModalClose}
        image={modalImage}
        alertHandler={setAlert}
        authenticated={authenticated}
        onNext={handleImageModalNext}
        onPrev={handleImageModalPrev}
      />

      <Box sx={{ px: 2 }}>
        {sortedMedia.length === 0 ? (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              py: 8,
              gap: 2,
              border: '1px solid #FFFFFF14',
              borderRadius: '16px',
              background: '#00000040',
            }}
          >
            <Typography sx={{ fontWeight: 700, fontSize: 20, color: 'white' }}>No media found</Typography>
          </Box>
        ) : (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${cardSize}px), 1fr))`,
              gap: 2,
            }}
          >
            {sortedMedia.slice(0, visibleCount).map((media, index) => (
              <motion.div
                key={media.type === 'video' ? `v-${media.item.video_id}` : `i-${media.item.image_id}`}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: Math.min(index % PAGE_SIZE, 12) * 0.04 }}
              >
                {media.type === 'video' ? (
                  <CompactVideoCard
                    video={media.item}
                    openVideoHandler={(id) => setVideoModal({ open: true, id })}
                    alertHandler={setAlert}
                    authenticated={authenticated}
                    editMode={editMode}
                    selected={selectedVideos.has(media.item.video_id)}
                    onSelect={handleVideoSelect}
                    onRemoveFromView={(id) => {
                      setVideos((vs) => vs.filter((v) => v.video_id !== id))
                      setFilteredVideos((vs) => vs.filter((v) => v.video_id !== id))
                    }}
                    removeOnMove={true}
                    showTypeIndicator={true}
                  />
                ) : (
                  <CompactImageCard
                    image={media.item}
                    openImageHandler={handleImageOpen}
                    alertHandler={setAlert}
                    authenticated={authenticated}
                    editMode={editMode}
                    selected={selectedImages.has(media.item.image_id)}
                    onSelect={handleImageSelect}
                    onRemoveFromView={(id) => {
                      setImages((imgs) => imgs.filter((img) => img.image_id !== id))
                      setFilteredImages((imgs) => imgs.filter((img) => img.image_id !== id))
                    }}
                    showTypeIndicator={true}
                  />
                )}
              </motion.div>
            ))}
          </Box>
        )}
        <div ref={sentinelRef} style={{ height: 1 }} />
      </Box>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>
          Delete {totalSelected} Item{totalSelected > 1 ? 's' : ''}?
        </DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete the selected {totalSelected > 1 ? `${totalSelected} items` : 'item'}? This
            will permanently delete the file{totalSelected > 1 ? 's' : ''}.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleDeleteConfirm} variant="contained" color="error">
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Link to Game Dialog */}
      <Dialog
        open={linkGameDialogOpen}
        onClose={() => {
          setLinkGameDialogOpen(false)
          setSelectedGame(null)
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          Link {totalSelected} Item{totalSelected !== 1 ? 's' : ''} to Game
        </DialogTitle>
        <DialogContent sx={{ pt: 3 }}>
          {!showAddNewGame ? (
            <Autocomplete
              options={[...games, { id: 'add-new', name: 'Add a new game...', isAddNew: true }]}
              getOptionLabel={(option) => option.name || ''}
              value={selectedGame}
              onChange={(_, newValue) => {
                if (newValue?.isAddNew) {
                  setShowAddNewGame(true)
                  setSelectedGame(null)
                } else setSelectedGame(newValue)
              }}
              renderInput={(params) => <TextField {...params} placeholder="Select a game..." />}
              renderOption={(props, option) => (
                <Box
                  component="li"
                  {...props}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    fontStyle: option.isAddNew ? 'italic' : 'normal',
                    color: option.isAddNew ? 'primary.main' : 'inherit',
                  }}
                >
                  {option.icon_url && (
                    <img
                      src={option.icon_url}
                      alt={option.name}
                      style={{ width: 32, height: 32, objectFit: 'contain' }}
                    />
                  )}
                  <Typography>{option.name}</Typography>
                </Box>
              )}
            />
          ) : (
            <GameSearch
              onGameLinked={handleNewGameCreated}
              onError={(err) =>
                setAlert({ open: true, type: 'error', message: err.response?.data || 'Error adding game' })
              }
              onWarning={(msg) => setAlert({ open: true, type: 'warning', message: msg })}
              placeholder="Search SteamGridDB..."
            />
          )}
        </DialogContent>
        <DialogActions>
          {showAddNewGame && (
            <Button onClick={() => setShowAddNewGame(false)} sx={{ mr: 'auto' }}>
              Back to List
            </Button>
          )}
          <Button
            onClick={() => {
              setLinkGameDialogOpen(false)
              setSelectedGame(null)
            }}
          >
            Cancel
          </Button>
          {!showAddNewGame && (
            <Button onClick={handleLinkGameConfirm} variant="contained" disabled={!selectedGame}>
              Link
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* Cover Art Modal (SteamGridDB games pick from a pool, custom games upload) */}
      <EditGameAssetsModal
        game={game}
        open={editingAssets && !game?.custom}
        onClose={() => setEditingAssets(false)}
        onSaved={handleAssetSaved}
        bannerOnly
      />
      <CustomGameModal
        game={game?.custom ? game : null}
        open={editingAssets && Boolean(game?.custom)}
        onClose={() => setEditingAssets(false)}
        onSaved={handleCustomGameSaved}
      />
    </>
  )
}

export default GameVideos
