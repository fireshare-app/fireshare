import React from 'react'
import ReactDOM from 'react-dom'
import {
  Box,
  Grid,
  IconButton,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Typography,
  Autocomplete,
  TextField,
  CircularProgress,
  InputAdornment,
  useTheme,
  useMediaQuery,
} from '@mui/material'
import EditIcon from '@mui/icons-material/Edit'
import DeleteIcon from '@mui/icons-material/Delete'
import CheckIcon from '@mui/icons-material/Check'
import LinkIcon from '@mui/icons-material/Link'
import LocalOfferIcon from '@mui/icons-material/LocalOffer'
import VideoCards from '../components/cards/VideoCards'
import LoadingSpinner from '../components/ui/LoadingSpinner'
import { VideoService, GameService, TagService } from '../services'
import Select from 'react-select'
import SnackbarAlert from '../components/alert/SnackbarAlert'
import TagChip from '../components/ui/TagChip'

import { folderSelectTheme as selectFolderTheme } from '../common/reactSelectThemes'
import OutlinedIconButton from '../components/ui/OutlinedIconButton'
import MarqueeSingleValue, { MarqueeOption } from '../components/ui/MarqueeSingleValue'
import ToolbarFilterMenu from '../components/nav/ToolbarFilterMenu'
import {
  SORT_OPTIONS,
  PRIVACY_OPTIONS,
  SORT_SELECT_WIDTH,
  PRIVACY_SELECT_WIDTH,
  TAG_SELECT_WIDTH,
} from '../common/constants'
import TagFilter, { hasAllTags, useTagFilter } from '../components/nav/TagFilter'
import { inputSx, dialogPaperSx, dialogTitleSx } from '../common/modalStyles'

const Dashboard = ({
  authenticated,
  searchText,
  cardSize,
  selectedFolder,
  onFolderChange,
  onFoldersLoaded,
  showFolderDropdown,
  uploadTick,
}) => {
  const [videos, setVideos] = React.useState([])
  const [search, setSearch] = React.useState(searchText)
  const [filteredVideos, setFilteredVideos] = React.useState([])
  const [folderList, setFolderList] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [dateSortOrder, setDateSortOrder] = React.useState(SORT_OPTIONS?.[0] || { value: 'newest', label: 'Newest' })
  const [privacyFilter, setPrivacyFilter] = React.useState(PRIVACY_OPTIONS[0])

  const [alert, setAlert] = React.useState({ open: false })

  const [prevCardSize, setPrevCardSize] = React.useState(cardSize)

  // Edit mode state
  const [editMode, setEditMode] = React.useState(false)
  const [selectedVideos, setSelectedVideos] = React.useState(new Set())
  const lastSelectedIdRef = React.useRef(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)
  const [linkGameDialogOpen, setLinkGameDialogOpen] = React.useState(false)
  const [allGames, setAllGames] = React.useState([])
  const [selectedGame, setSelectedGame] = React.useState(null)
  const [gameOptions, setGameOptions] = React.useState([])
  const [gameSearchLoading, setGameSearchLoading] = React.useState(false)
  const [gameCreating, setGameCreating] = React.useState(false)
  const [gameInput, setGameInput] = React.useState('')
  const [refreshKey, setRefreshKey] = React.useState(0)
  const [tagDialogOpen, setTagDialogOpen] = React.useState(false)
  const [allTags, setAllTags] = React.useState([])
  const [selectedTagsForBulk, setSelectedTagsForBulk] = React.useState([])
  const [tagInputValueBulk, setTagInputValueBulk] = React.useState('')
  const [toolbarTarget, setToolbarTarget] = React.useState(null)
  const { options: tagOptions, selected: tagFilter, setSelected: handleTagChange } = useTagFilter(videos)
  const theme = useTheme()
  const isMdDown = useMediaQuery(theme.breakpoints.down('md'))
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'))

  if (searchText !== search) {
    setSearch(searchText)
    const tagMatches = searchText.match(/#(\w+)/g) || []
    const tagNames = tagMatches.map((t) => t.slice(1).toLowerCase())
    const textQuery = searchText.replace(/#\w+/g, '').trim()
    setFilteredVideos(
      videos.filter((v) => {
        const titleMatch =
          !textQuery ||
          v.info.title.search(new RegExp(textQuery, 'i')) >= 0 ||
          (v.game?.name && v.game.name.search(new RegExp(textQuery, 'i')) >= 0)
        const tagMatch = tagNames.every(
          (tagName) =>
            v.tags &&
            v.tags.some((t) => t.name.toLowerCase() === tagName || t.name.replace(/_/g, ' ').toLowerCase() === tagName),
        )
        return titleMatch && tagMatch
      }),
    )
  }
  if (cardSize !== prevCardSize) {
    setPrevCardSize(cardSize)
  }

  function fetchVideos() {
    const fetchFn = authenticated ? VideoService.getVideos() : VideoService.getPublicVideos()
    fetchFn
      .then((res) => {
        setVideos(res.data.videos)
        setFilteredVideos(res.data.videos)
        const tfolders = []
        res.data.videos.forEach((v) => {
          const split = v.path
            .split('/')
            .slice(0, -1)
            .filter((f) => f !== '')
          if (split.length > 0 && !tfolders.includes(split[0])) {
            tfolders.push(split[0])
          }
        })
        tfolders.sort((a, b) => (a.toLowerCase() > b.toLowerCase() ? 1 : -1)).unshift('All Videos')
        if (onFoldersLoaded) onFoldersLoaded(tfolders)
        setFolderList(tfolders)
        setLoading(false)
      })
      .catch((err) => {
        setLoading(false)
        setAlert({
          open: true,
          type: 'error',
          message: typeof err.response?.data === 'string' ? err.response.data : 'Unknown Error',
        })
        console.log(err)
      })
  }

  const videoCountRef = React.useRef(0)

  React.useEffect(() => {
    fetchVideos()
    // eslint-disable-next-line
  }, [])

  React.useEffect(() => {
    if (uploadTick === 0) return
    // scan-video runs as a background subprocess so the video isn't in the DB
    // immediately when the upload HTTP response returns. Poll until the count grows.
    videoCountRef.current = videos.length
    let attempts = 0
    const interval = setInterval(() => {
      attempts++
      const fetchFn = authenticated ? VideoService.getVideos() : VideoService.getPublicVideos()
      fetchFn.then((res) => {
        const fetched = res.data.videos
        if (fetched.length > videoCountRef.current || attempts >= 8) {
          clearInterval(interval)
          setVideos(fetched)
          setFilteredVideos(fetched)
          const tfolders = []
          fetched.forEach((v) => {
            const split = v.path
              .split('/')
              .slice(0, -1)
              .filter((f) => f !== '')
            if (split.length > 0 && !tfolders.includes(split[0])) tfolders.push(split[0])
          })
          tfolders.sort((a, b) => (a.toLowerCase() > b.toLowerCase() ? 1 : -1)).unshift('All Videos')
          if (onFoldersLoaded) onFoldersLoaded(tfolders)
          setFolderList(tfolders)
        }
      })
    }, 2000)
    return () => clearInterval(interval)
    // eslint-disable-next-line
  }, [uploadTick])

  React.useEffect(() => {
    setToolbarTarget(document.getElementById('navbar-toolbar-extra'))
  }, [])

  // Hide search bar when in edit mode on md and smaller
  React.useEffect(() => {
    const searchContainer = document.getElementById('navbar-search-container')
    if (searchContainer) {
      searchContainer.style.display = editMode && isMdDown ? 'none' : ''
    }
  }, [editMode, isMdDown])


  // Use folder from Navbar props (falls back to All Videos)
  const folder = selectedFolder || { value: 'All Videos', label: 'All Videos' }

  // Get the filtered videos based on folder selection
  const displayVideos = React.useMemo(() => {
    if (!filteredVideos) return filteredVideos

    const folderFiltered =
      folder.value === 'All Videos'
        ? filteredVideos
        : filteredVideos.filter(
            (v) => 
              v.path
                .split('/')
                .slice(0, -1)
                .filter((f) => f !== '')[0] === folder.value,
          )

    return folderFiltered.filter(
      (v) =>
        (privacyFilter.value === 'all' || v.info?.private === (privacyFilter.value === 'private')) &&
        hasAllTags(v, tagFilter),
    )
  }, [filteredVideos, folder, privacyFilter, tagFilter])

  // Sort videos by recorded date or views
  const sortedVideos = React.useMemo(() => {
    if (!displayVideos) return []

    return [...displayVideos].sort((a, b) => {
      if (dateSortOrder.value === 'most_views') {
        return (b.view_count || 0) - (a.view_count || 0)
      } else if (dateSortOrder.value === 'least_views') {
        return (a.view_count || 0) - (b.view_count || 0)
      } else if (dateSortOrder.value === 'name_asc' || dateSortOrder.value === 'name_desc') {
        const nameA = (a.info?.title || '').toLowerCase()
        const nameB = (b.info?.title || '').toLowerCase()
        const cmp = nameA.localeCompare(nameB)
        return dateSortOrder.value === 'name_asc' ? cmp : -cmp
      } else {
        const dateA = a.recorded_at ? new Date(a.recorded_at) : new Date(0)
        const dateB = b.recorded_at ? new Date(b.recorded_at) : new Date(0)
        return dateSortOrder.value === 'newest' ? dateB - dateA : dateA - dateB
      }
    })
  }, [displayVideos, dateSortOrder])

  const handleEditModeToggle = () => {
    setEditMode(!editMode)
    if (editMode) {
      setSelectedVideos(new Set())
    }
    lastSelectedIdRef.current = null
  }

  const allSelected = sortedVideos.length > 0 && selectedVideos.size === sortedVideos.length

  const handleSelectAllToggle = () => {
    if (allSelected) {
      setSelectedVideos(new Set())
    } else {
      setSelectedVideos(new Set(sortedVideos.map((v) => v.video_id)))
    }
  }

  const handleVideoSelect = (videoId, shiftKey = false) => {
    const newSelected = new Set(selectedVideos)
    const anchorId = lastSelectedIdRef.current
    if (shiftKey && anchorId !== null && anchorId !== videoId) {
      const ids = sortedVideos.map((v) => v.video_id)
      const anchorIndex = ids.indexOf(anchorId)
      const clickedIndex = ids.indexOf(videoId)
      if (anchorIndex !== -1 && clickedIndex !== -1) {
        // Apply the anchor's state to the whole range, so shift-click extends
        // a selection or a deselection depending on the last action
        const selecting = newSelected.has(anchorId)
        const [start, end] = anchorIndex < clickedIndex ? [anchorIndex, clickedIndex] : [clickedIndex, anchorIndex]
        for (let i = start; i <= end; i++) {
          if (selecting) newSelected.add(ids[i])
          else newSelected.delete(ids[i])
        }
        lastSelectedIdRef.current = videoId
        setSelectedVideos(newSelected)
        return
      }
    }
    if (newSelected.has(videoId)) {
      newSelected.delete(videoId)
    } else {
      newSelected.add(videoId)
    }
    lastSelectedIdRef.current = videoId
    setSelectedVideos(newSelected)
  }

  const handleDeleteClick = () => {
    setDeleteDialogOpen(true)
  }

  const handleDeleteConfirm = async () => {
    try {
      const deletePromises = Array.from(selectedVideos).map((videoId) => VideoService.delete(videoId))
      await Promise.all(deletePromises)

      setAlert({
        open: true,
        type: 'success',
        message: `Successfully deleted ${selectedVideos.size} video${selectedVideos.size > 1 ? 's' : ''}`,
      })

      // Refresh videos list
      fetchVideos()

      // Reset state
      setSelectedVideos(new Set())
      setDeleteDialogOpen(false)
      setEditMode(false)
    } catch (err) {
      console.error('Error deleting videos:', err)
      setAlert({
        open: true,
        type: 'error',
        message: err.response?.data || 'Error deleting videos',
      })
    }
  }

  const handleDeleteCancel = () => {
    setDeleteDialogOpen(false)
  }

  const handleLinkGameClick = async () => {
    // Fetch games when opening dialog
    try {
      const res = await GameService.getGames()
      const games = res.data || []
      setAllGames(games)
      setGameOptions(games.map((g) => ({ ...g, _source: 'db' })))
      setLinkGameDialogOpen(true)
      setSelectedGame(null)
      setGameInput('')
    } catch (err) {
      console.error('Error fetching games:', err)
      setAlert({
        open: true,
        type: 'error',
        message: err.response?.data || 'Error fetching games',
      })
    }
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
      return
    }
    if (newValue._source === 'db') {
      setSelectedGame(newValue)
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
    } catch {
      setSelectedGame(null)
    }
    setGameCreating(false)
  }

  const handleLinkGameConfirm = async () => {
    if (!selectedGame) return

    try {
      const linkPromises = Array.from(selectedVideos).map((videoId) =>
        GameService.linkVideoToGame(videoId, selectedGame.id),
      )
      await Promise.all(linkPromises)

      setAlert({
        open: true,
        type: 'success',
        message: `Successfully linked ${selectedVideos.size} video${selectedVideos.size > 1 ? 's' : ''} to ${selectedGame.name}`,
      })

      // Refresh videos and force cards to re-fetch game data
      fetchVideos()
      setRefreshKey((k) => k + 1)

      // Reset state
      setSelectedVideos(new Set())
      setLinkGameDialogOpen(false)
      setSelectedGame(null)
      setEditMode(false)
    } catch (err) {
      console.error('Error linking videos to game:', err)
      setAlert({
        open: true,
        type: 'error',
        message: err.response?.data || 'Error linking videos to game',
      })
    }
  }

  const handleLinkGameCancel = () => {
    setLinkGameDialogOpen(false)
    setSelectedGame(null)
    setGameOptions([])
    setGameInput('')
  }

  const handleTagClick = async () => {
    try {
      const res = await TagService.getTags()
      setAllTags(res.data)
      setTagDialogOpen(true)
      setSelectedTagsForBulk([])
      setTagInputValueBulk('')
    } catch (err) {
      console.error('Error fetching tags:', err)
    }
  }

  const handleTagConfirm = async () => {
    if (selectedTagsForBulk.length === 0) return
    try {
      const videoIds = Array.from(selectedVideos)
      for (const tag of selectedTagsForBulk) {
        let tagId = tag.id
        if (!tagId) {
          const res = await TagService.createTag({ name: tag.name })
          tagId = res.data.id
        }
        await TagService.bulkAssign(tagId, videoIds)
      }
      const tagNames = selectedTagsForBulk.map((t) => t.name).join(', ')
      setAlert({
        open: true,
        type: 'success',
        message: `Tagged ${selectedVideos.size} video${selectedVideos.size > 1 ? 's' : ''} with "${tagNames}"`,
      })
      fetchVideos()
      setRefreshKey((k) => k + 1)
      setSelectedVideos(new Set())
      setTagDialogOpen(false)
      setEditMode(false)
    } catch (err) {
      console.error('Error tagging videos:', err)
      setAlert({ open: true, type: 'error', message: err.response?.data || 'Error tagging videos' })
    }
  }

  const handleTagCancel = () => {
    setTagDialogOpen(false)
    setSelectedTagsForBulk([])
  }

  // Same filters the desktop toolbar shows inline, described for the collapsed
  // mobile menu. The defaults drive the "filters are active" dot on the button.
  const mobileFilters = [
    showFolderDropdown &&
      folderList.length > 1 && {
        key: 'folder',
        label: 'Folder',
        value: selectedFolder,
        options: folderList.map((f) => ({ value: f, label: f })),
        onChange: onFolderChange,
        defaultValue: 'All Videos',
        selectProps: { components: { SingleValue: MarqueeSingleValue, Option: MarqueeOption } },
      },
    tagOptions.length > 0 && {
      key: 'tags',
      label: 'Tags',
      value: tagFilter,
      render: <TagFilter options={tagOptions} value={tagFilter} onChange={handleTagChange} />,
    },
    {
      key: 'sort',
      label: 'Sort by',
      value: dateSortOrder,
      options: SORT_OPTIONS,
      onChange: setDateSortOrder,
      defaultValue: SORT_OPTIONS[0].value,
    },
    authenticated && {
      key: 'privacy',
      label: 'Visibility',
      value: privacyFilter,
      options: PRIVACY_OPTIONS,
      onChange: setPrivacyFilter,
      defaultValue: PRIVACY_OPTIONS[0].value,
    },
  ]

  return (
    <>
      <SnackbarAlert severity={alert.type} open={alert.open} setOpen={(open) => setAlert({ ...alert, open })}>
        {alert.message}
      </SnackbarAlert>
      {toolbarTarget &&
        ReactDOM.createPortal(
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'nowrap', minWidth: 0 }}>
            {!(editMode && isMdDown) &&
              (isMobile ? (
                <ToolbarFilterMenu filters={mobileFilters} />
              ) : (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
                  {showFolderDropdown && folderList.length > 1 && (
                    <Box sx={{ minWidth: 150, maxWidth: 200, flexShrink: 0 }}>
                      <Select
                        value={selectedFolder}
                        options={folderList.map((f) => ({ value: f, label: f }))}
                        onChange={onFolderChange}
                        styles={selectFolderTheme}
                        menuPortalTarget={document.body}
                        menuPosition="fixed"
                        blurInputOnSelect
                        isSearchable={false}
                        components={{ SingleValue: MarqueeSingleValue, Option: MarqueeOption }}
                      />
                    </Box>
                  )}
                  {tagOptions.length > 0 && (
                    <Box sx={{ width: TAG_SELECT_WIDTH, flexShrink: 0 }}>
                      <TagFilter options={tagOptions} value={tagFilter} onChange={handleTagChange} />
                    </Box>
                  )}
                  <Box sx={{ minWidth: SORT_SELECT_WIDTH }}>
                    <Select
                      value={dateSortOrder}
                      options={SORT_OPTIONS}
                      onChange={setDateSortOrder}
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
                        onChange={setPrivacyFilter}
                        styles={selectFolderTheme}
                        menuPortalTarget={document.body}
                        menuPosition="fixed"
                        blurInputOnSelect
                        isSearchable={false}
                      />
                    </Box>
                  )}
                </Box>
              ))}
            {authenticated && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'nowrap', minWidth: 0 }}>
                {editMode && (
                  <Box sx={{ display: 'flex', gap: 1, flexShrink: 1, minWidth: 0 }}>
                    <OutlinedIconButton onClick={handleSelectAllToggle}>
                      {allSelected ? 'Select None' : 'Select All'}
                    </OutlinedIconButton>
                    <OutlinedIconButton
                      icon={<LinkIcon sx={{ fontSize: 16 }} />}
                      onClick={handleLinkGameClick}
                      disabled={selectedVideos.size === 0}
                    >
                      {!isMdDown ? `Link${selectedVideos.size > 0 ? ` (${selectedVideos.size})` : ''}` : null}
                    </OutlinedIconButton>
                    <OutlinedIconButton
                      icon={<LocalOfferIcon sx={{ fontSize: 16 }} />}
                      onClick={handleTagClick}
                      disabled={selectedVideos.size === 0}
                    >
                      {!isMdDown ? `Tag${selectedVideos.size > 0 ? ` (${selectedVideos.size})` : ''}` : null}
                    </OutlinedIconButton>
                    <OutlinedIconButton
                      icon={<DeleteIcon sx={{ fontSize: 16 }} />}
                      onClick={handleDeleteClick}
                      disabled={selectedVideos.size === 0}
                      sx={{ color: selectedVideos.size > 0 ? '#FF6B6B' : undefined, borderColor: selectedVideos.size > 0 ? '#FF6B6B66' : undefined }}
                    >
                      {!isMdDown ? `Delete${selectedVideos.size > 0 ? ` (${selectedVideos.size})` : ''}` : null}
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
      <Box>
        <Grid container item justifyContent="center">
          <Grid item xs={12}>
            <Box>
              <Box>
                {loading && <LoadingSpinner />}
                {!loading && (
                  <VideoCards
                    key={refreshKey}
                    videos={sortedVideos}
                    authenticated={authenticated}
                    feedView={!authenticated}
                    size={cardSize}
                    editMode={editMode}
                    selectedVideos={selectedVideos}
                    onVideoSelect={handleVideoSelect}
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
          Delete {selectedVideos.size} Video{selectedVideos.size > 1 ? 's' : ''}?
        </DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete the selected video{selectedVideos.size > 1 ? 's' : ''}? This will
            permanently delete the video file{selectedVideos.size > 1 ? 's' : ''}.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDeleteCancel}>Cancel</Button>
          <Button onClick={handleDeleteConfirm} variant="contained" color="error">
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Link to Game Dialog */}
      <Dialog open={linkGameDialogOpen} onClose={handleLinkGameCancel} maxWidth="sm" fullWidth>
        <DialogTitle>
          Link {selectedVideos.size} Clip{selectedVideos.size !== 1 ? 's' : ''} to Game
        </DialogTitle>
        <DialogContent sx={{ pt: '20px !important' }}>
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
                label="Game"
                size="small"
                placeholder="Search for a game..."
                InputProps={{
                  ...params.InputProps,
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
        </DialogContent>
        <DialogActions>
          <Button onClick={handleLinkGameCancel}>Cancel</Button>
          <Button onClick={handleLinkGameConfirm} variant="contained" disabled={!selectedGame}>
            Link
          </Button>
        </DialogActions>
      </Dialog>

      {/* Tag Selected Dialog */}
      <Dialog open={tagDialogOpen} onClose={handleTagCancel} maxWidth="sm" fullWidth PaperProps={{ sx: dialogPaperSx }}>
        <DialogTitle sx={dialogTitleSx}>
          Tag {selectedVideos.size} Clip{selectedVideos.size !== 1 ? 's' : ''}
        </DialogTitle>
        <DialogContent sx={{ pt: 3 }}>
          <Autocomplete
            multiple
            freeSolo
            componentsProps={{ root: { sx: { '& .MuiAutocomplete-tag': { my: 0.25 } } } }}
            sx={{ ...inputSx, '& .MuiOutlinedInput-root': { ...inputSx['& .MuiOutlinedInput-root'], gap: 0.5 } }}
            options={allTags.filter((t) => !selectedTagsForBulk.find((s) => s.id === t.id))}
            getOptionLabel={(option) => (typeof option === 'string' ? option : option.name)}
            value={selectedTagsForBulk}
            inputValue={tagInputValueBulk}
            onInputChange={(_, v) => setTagInputValueBulk(v)}
            onChange={(_, newValues) => {
              const seen = new Set()
              setSelectedTagsForBulk(
                newValues
                  .map((v) => (typeof v === 'string' ? { name: v } : v))
                  .filter((t) => {
                    const key = (t.name || '').toLowerCase()
                    if (!key || seen.has(key)) return false
                    seen.add(key)
                    return true
                  }),
              )
              setTagInputValueBulk('')
            }}
            renderTags={(value, getTagProps) =>
              value.map((tag, idx) => {
                const { onDelete } = getTagProps({ index: idx })
                return (
                  <TagChip
                    key={tag.id ?? `new-${idx}`}
                    name={tag.name}
                    color={tag.color}
                    size="small"
                    onDelete={onDelete}
                  />
                )
              })
            }
            renderInput={(params) => (
              <TextField
                {...params}
                placeholder={selectedTagsForBulk.length === 0 ? 'Select or create tags...' : ''}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ',') && tagInputValueBulk.trim()) {
                    e.preventDefault()
                    const parts = tagInputValueBulk
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                    setTagInputValueBulk('')
                    setSelectedTagsForBulk((prev) => {
                      const merged = [...prev]
                      parts.forEach((p) => {
                        if (!merged.find((t) => (t.name || '').toLowerCase() === p.toLowerCase())) {
                          const found = allTags.find((t) => t.name.toLowerCase() === p.toLowerCase())
                          merged.push(found || { name: p })
                        }
                      })
                      return merged
                    })
                  }
                }}
              />
            )}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleTagCancel} sx={{ borderRadius: '8px', color: 'white' }}>
            Cancel
          </Button>
          <Button
            onClick={handleTagConfirm}
            variant="contained"
            disabled={selectedTagsForBulk.length === 0}
            sx={{ borderRadius: '8px', bgcolor: '#3399FF', '&:hover': { bgcolor: '#1976D2' } }}
          >
            Tag
          </Button>
        </DialogActions>
      </Dialog>

    </>
  )
}

export default Dashboard
