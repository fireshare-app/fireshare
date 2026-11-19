import React from 'react'
import LinkIcon from '@mui/icons-material/Link'
import EditIcon from '@mui/icons-material/Edit'
import FolderIcon from '@mui/icons-material/Folder'
import DownloadIcon from '@mui/icons-material/Download'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import { copyLink, downloadFile, downloadName, getPublicImageUrl, mediaTitle } from '../../common/utils'
import { ImageService } from '../../services'
import DeleteImageModal from '../modal/DeleteImageModal'
import MoveMediaModal from '../modal/MoveMediaModal'

/**
 * What an image card can do, shared by the waterfall card and the game-page card
 * so the two offer the same ⋮ menu as a video card: Edit, Copy link, Move…,
 * Make private, Download and Delete.
 *
 * Returns the card's visibility, a toggle for the hover button, the menu items,
 * and the dialogs the menu opens, which the card renders.
 */
const useImageCardActions = ({ image, alertHandler, openImageHandler, onRemoveFromView, removeOnMove = false }) => {
  const [privateView, setPrivateView] = React.useState(image.info?.private)
  const [path, setPath] = React.useState(image.path)
  const [deleteModalOpen, setDeleteModalOpen] = React.useState(false)
  const [moveModalOpen, setMoveModalOpen] = React.useState(false)

  React.useEffect(() => setPrivateView(image.info?.private), [image.info?.private])
  React.useEffect(() => setPath(image.path), [image.path])

  const shareUrl = `${getPublicImageUrl()}${image.image_id}`

  const togglePrivacy = async (e) => {
    e?.stopPropagation()
    try {
      await ImageService.updatePrivacy(image.image_id, !privateView)
      alertHandler?.({
        type: privateView ? 'info' : 'warning',
        message: privateView ? 'Added to your public feed' : 'Removed from your public feed',
        open: true,
      })
      setPrivateView((v) => !v)
    } catch (err) {
      alertHandler?.({ open: true, type: 'error', message: 'Failed to update privacy' })
    }
  }

  const copy = (e) => {
    e?.stopPropagation()
    copyLink(shareUrl, alertHandler)
  }

  const menuItems = [
    {
      label: 'Edit',
      Icon: EditIcon,
      requiresAuth: true,
      onClick: () => openImageHandler?.({ ...image, path }, { edit: true }),
    },
    { label: 'Copy Link', Icon: LinkIcon, onClick: copy },
    { label: 'Move...', Icon: FolderIcon, requiresAuth: true, onClick: () => setMoveModalOpen(true) },
    {
      label: privateView ? 'Make public' : 'Make private',
      Icon: privateView ? VisibilityIcon : VisibilityOffIcon,
      requiresAuth: true,
      onClick: togglePrivacy,
    },
    {
      label: 'Download',
      Icon: DownloadIcon,
      onClick: () =>
        downloadFile(ImageService.getOriginalUrl(image.image_id), downloadName(mediaTitle(image), image.extension)),
    },
    {
      label: 'Delete',
      Icon: DeleteOutlineIcon,
      danger: true,
      requiresAuth: true,
      onClick: () => setDeleteModalOpen(true),
    },
  ]

  const modals = (
    <>
      <DeleteImageModal
        open={deleteModalOpen}
        onClose={(result) => {
          setDeleteModalOpen(false)
          if (result === 'delete') onRemoveFromView?.(image.image_id)
        }}
        imageId={image.image_id}
        alertHandler={alertHandler}
      />
      <MoveMediaModal
        open={moveModalOpen}
        mediaType="image"
        media={{ ...image, path }}
        alertHandler={alertHandler}
        onClose={(result, newFolder, newPath) => {
          setMoveModalOpen(false)
          if (result !== 'move') return
          if (removeOnMove) onRemoveFromView?.(image.image_id)
          else setPath(newPath || `${newFolder}/${path.split('/').pop()}`)
        }}
      />
    </>
  )

  return { privateView, togglePrivacy, copy, menuItems, modals }
}

export default useImageCardActions
