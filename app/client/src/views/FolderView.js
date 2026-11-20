import React from 'react'
import ReactDOM from 'react-dom'
import { Box, Typography } from '@mui/material'
import { useParams } from 'react-router-dom'
import Select from 'react-select'
import { FolderService } from '../services'
import VideoCards from '../components/cards/VideoCards'
import ImageCards from '../components/cards/ImageCards'
import ImageModal from '../components/modal/ImageModal'
import { applyImageUpdate } from '../common/utils'
import LoadingSpinner from '../components/ui/LoadingSpinner'
import SnackbarAlert from '../components/alert/SnackbarAlert'
import { SORT_OPTIONS, SORT_SELECT_WIDTH } from '../common/constants'
import { sortSelectTheme as selectSortTheme } from '../common/reactSelectThemes'

const FolderView = ({ authenticated, cardSize, searchText }) => {
  const { folderUuid } = useParams()
  const [folder, setFolder] = React.useState(null)
  const [media, setMedia] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [sortOrder, setSortOrder] = React.useState(SORT_OPTIONS[0])
  const [toolbarTarget, setToolbarTarget] = React.useState(null)
  const [toolbarLeftTarget, setToolbarLeftTarget] = React.useState(null)
  const [toolbarLeftMobileTarget, setToolbarLeftMobileTarget] = React.useState(null)
  const [modalImage, setModalImage] = React.useState(null)
  const [modalImageEdit, setModalImageEdit] = React.useState(false)
  const [alert, setAlert] = React.useState({ open: false })

  React.useEffect(() => {
    setLoading(true)
    FolderService.getFolder(folderUuid)
      .then((res) => {
        const folderData = res.data
        setFolder(folderData)
        return FolderService.getFolderMedia(folderUuid, folderData.media_type)
      })
      .then((res) => {
        setMedia(res?.data || [])
        setLoading(false)
      })
      .catch((err) => {
        console.error('Error fetching folder:', err)
        setLoading(false)
      })
  }, [folderUuid])

  React.useEffect(() => {
    const update = () => {
      setToolbarTarget(document.getElementById('navbar-toolbar-extra'))
      setToolbarLeftTarget(document.getElementById('navbar-toolbar-left'))
      setToolbarLeftMobileTarget(document.getElementById('navbar-toolbar-left-mobile'))
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  const filteredMedia = React.useMemo(() => {
    let result = media
    if (searchText) {
      const re = new RegExp(searchText, 'i')
      result = result.filter((m) => (m.info?.title || '').search(re) >= 0)
    }
    return [...result].sort((a, b) => {
      if (sortOrder.value === 'most_views') return (b.view_count || 0) - (a.view_count || 0)
      if (sortOrder.value === 'least_views') return (a.view_count || 0) - (b.view_count || 0)
      if (sortOrder.value === 'name_asc' || sortOrder.value === 'name_desc') {
        const cmp = (a.info?.title || '').toLowerCase().localeCompare((b.info?.title || '').toLowerCase())
        return sortOrder.value === 'name_asc' ? cmp : -cmp
      }
      const dateA = a.recorded_at ? new Date(a.recorded_at) : a.created_at ? new Date(a.created_at) : new Date(0)
      const dateB = b.recorded_at ? new Date(b.recorded_at) : b.created_at ? new Date(b.created_at) : new Date(0)
      return sortOrder.value === 'newest' ? dateB - dateA : dateA - dateB
    })
  }, [media, searchText, sortOrder])

  const handleImageOpen = React.useCallback((image, options) => {
    setModalImage(image)
    setModalImageEdit(Boolean(options?.edit))
  }, [])

  const handleImageModalClose = (update) => {
    if (update) {
      const updateImage = (img) => {
        if (img.image_id !== modalImage?.image_id) return img
        return applyImageUpdate(img, update)
      }
      setMedia((prev) => prev.map(updateImage))
    }
    setModalImage(null)
  }

  const handleImageModalNext = React.useCallback(() => {
    setModalImage((cur) => {
      if (!cur) return cur
      const idx = filteredMedia.findIndex((img) => img.image_id === cur.image_id)
      return idx >= 0 && idx < filteredMedia.length - 1 ? filteredMedia[idx + 1] : cur
    })
  }, [filteredMedia])

  const handleImageModalPrev = React.useCallback(() => {
    setModalImage((cur) => {
      if (!cur) return cur
      const idx = filteredMedia.findIndex((img) => img.image_id === cur.image_id)
      return idx > 0 ? filteredMedia[idx - 1] : cur
    })
  }, [filteredMedia])

  if (loading) return <LoadingSpinner />

  if (!folder) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          py: 8,
          gap: 2,
          m: 3,
          border: '1px solid #FFFFFF14',
          borderRadius: '16px',
          background: '#00000040',
        }}
      >
        <Typography sx={{ fontWeight: 700, fontSize: 20, color: 'white' }}>
          This folder doesn't exist or is private
        </Typography>
      </Box>
    )
  }

  const titleBlock = (
    <Box sx={{ minWidth: 0, maxWidth: 240, flexShrink: 1, overflow: 'hidden' }}>
      <Typography
        sx={{
          fontWeight: 700,
          fontSize: 16,
          color: 'white',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {folder.name}
      </Typography>
      <Typography sx={{ color: '#FFFFFFAA', fontSize: 12, whiteSpace: 'nowrap' }}>
        {folder.item_count} item{folder.item_count !== 1 ? 's' : ''}
      </Typography>
    </Box>
  )

  return (
    <Box>
      <SnackbarAlert severity={alert.type} open={alert.open} setOpen={(open) => setAlert({ ...alert, open })}>
        {alert.message}
      </SnackbarAlert>

      {folder.media_type === 'image' && (
        <ImageModal
          open={Boolean(modalImage)}
          onClose={handleImageModalClose}
          image={modalImage}
          startInEditMode={modalImageEdit}
          alertHandler={setAlert}
          authenticated={authenticated}
          onNext={handleImageModalNext}
          onPrev={handleImageModalPrev}
        />
      )}

      {toolbarLeftTarget && ReactDOM.createPortal(titleBlock, toolbarLeftTarget)}
      {toolbarLeftMobileTarget && ReactDOM.createPortal(titleBlock, toolbarLeftMobileTarget)}

      {toolbarTarget &&
        ReactDOM.createPortal(
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
          </Box>,
          toolbarTarget,
        )}

      <Box sx={{ px: 2, pt: 2 }}>
        {folder.media_type === 'image' ? (
          <ImageCards
            images={filteredMedia}
            authenticated={authenticated}
            feedView={!authenticated}
            size={cardSize}
            onImageOpen={handleImageOpen}
            removeOnMove
          />
        ) : (
          <VideoCards videos={filteredMedia} authenticated={authenticated} feedView={!authenticated} size={cardSize} />
        )}
      </Box>
    </Box>
  )
}

export default FolderView
