import React, { useCallback } from 'react'
import { motion } from 'framer-motion'
import { Box, Button, Typography } from '@mui/material'
import SnackbarAlert from '../alert/SnackbarAlert'
import ImageIcon from '@mui/icons-material/Image'
import SensorsIcon from '@mui/icons-material/Sensors'
import MasonryImageCard, { imageAspectRatio } from './MasonryImageCard'
import { ImageService } from '../../services'

// Stable per-image delay derived from image ID so it doesn't change across re-renders
function stableDelay(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0
  }
  return (Math.abs(h) % 300) / 1000
}

// Each card is always in the DOM as a placeholder. When it scrolls near the
// viewport its full content mounts and fades in, keeping the masonry stable.
const LazyImageCard = ({
  hideUploader = false,
  img,
  listVersion,
  openImageHandler,
  alertHandler,
  authenticated,
  onRemoveFromView,
  editMode,
  selected,
  onSelect,
  removeOnMove,
}) => {
  const [activated, setActivated] = React.useState(false)
  const ref = React.useRef()

  React.useEffect(() => {
    const el = ref.current
    if (!el) return

    if (!activated) {
      const observerRef = { current: null }

      // Double-rAF ensures CSS columns layout has fully settled before we
      // measure positions — a single rAF fires before column reflow finishes.
      const rafId = requestAnimationFrame(() => {
        const rafId2 = requestAnimationFrame(() => {
          if (!el) return
          const rect = el.getBoundingClientRect()
          const inView = rect.top < window.innerHeight + 600 && rect.bottom > -600
          if (inView) {
            setActivated(true)
            return
          }
          observerRef.current = new IntersectionObserver(
            ([entry]) => {
              if (entry.isIntersecting) {
                setActivated(true)
                observerRef.current?.disconnect()
              }
            },
            { rootMargin: '600px' },
          )
          observerRef.current.observe(el)
        })
        rafIds.push(rafId2)
      })
      const rafIds = [rafId]

      return () => {
        rafIds.forEach(cancelAnimationFrame)
        observerRef.current?.disconnect()
      }
    } else {
      // Unload cards that drift more than 2× viewport height out of view.
      const margin = window.innerHeight * 2
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry.isIntersecting) setActivated(false)
        },
        { rootMargin: `${margin}px` },
      )
      observer.observe(el)
      return () => observer.disconnect()
    }
  }, [activated, listVersion])

  return (
    <div
      ref={ref}
      style={{
        breakInside: 'avoid',
        marginBottom: 8,
        width: '100%',
        aspectRatio: imageAspectRatio(img),
        overflow: 'hidden',
        backgroundColor: activated ? 'transparent' : 'rgba(30, 60, 130, 0.12)',
      }}
    >
      {activated && (
        <motion.div
          initial={{ opacity: 0, filter: 'blur(8px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          transition={{ duration: 0.5, delay: stableDelay(img.image_id) }}
          style={{ width: '100%' }}
        >
          <MasonryImageCard
            image={img}
            openImageHandler={openImageHandler}
            alertHandler={alertHandler}
            authenticated={authenticated}
            onRemoveFromView={onRemoveFromView}
            editMode={editMode}
            selected={selected}
            onSelect={onSelect}
            hideUploader={hideUploader}
            removeOnMove={removeOnMove}
          />
        </motion.div>
      )}
    </div>
  )
}

const ImageCards = React.memo(
  ({
    images,
    loadingIcon = null,
    feedView = false,
    authenticated,
    size,
    onImageOpen,
    editMode = false,
    selectedImages,
    onImageSelect,
    hideUploader = false,
    // On a page that lists one folder, an image moved elsewhere leaves the page.
    removeOnMove = false,
  }) => {
    const [imgs, setImages] = React.useState(images || [])
    const [alert, setAlert] = React.useState({ open: false })
    const [columnCount, setColumnCount] = React.useState(3)
    const [listVersion, setListVersion] = React.useState(0)
    const containerRef = React.useRef()

    React.useEffect(() => {
      setImages(images || [])
      setListVersion((v) => v + 1)
    }, [images])

    React.useEffect(() => {
      if (!imgs || imgs.length === 0) {
        setColumnCount(3)
        return
      }

      const el = containerRef.current
      if (!el) return

      const observer = new ResizeObserver(([entry]) => {
        const width = entry?.contentRect?.width || 0
        if (!width) return
        const colWidth = size || 300
        const cols = Math.max(1, Math.floor((width + 16) / (colWidth + 16)))
        setColumnCount(cols)
      })

      observer.observe(el)
      return () => observer.disconnect()
    }, [size, imgs])

    const memoizedHandleAlert = useCallback((a) => setAlert(a), [])

    const handleDelete = (id) => {
      setImages((prev) => prev.filter((img) => img.image_id !== id))
    }

    const openImage = (img, options) => {
      if (onImageOpen) onImageOpen(img, options)
    }

    const handleScan = () => {
      ImageService.scan().catch((err) =>
        setAlert({
          open: true,
          type: 'error',
          message: err.response?.data || 'Unknown Error',
        }),
      )
      setAlert({
        open: true,
        type: 'info',
        message: 'Image scan initiated. This could take a few minutes.',
      })
    }

    const EMPTY_STATE = () => (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          py: 8,
          px: 3,
          border: '1px solid #FFFFFF14',
          borderRadius: '16px',
          background: '#00000040',
        }}
      >
        {!loadingIcon && (
          <>
            <ImageIcon sx={{ fontSize: 56, color: '#FFFFFF33' }} />
            <Box sx={{ textAlign: 'center' }}>
              <Typography sx={{ fontWeight: 700, fontSize: 20, color: 'white', mb: 0.5 }}>No images found</Typography>
              {!feedView && (
                <Typography sx={{ fontSize: 14, color: '#FFFFFF66' }}>Scan your library to discover images</Typography>
              )}
            </Box>
            {!feedView && (
              <Button
                variant="contained"
                size="large"
                startIcon={<SensorsIcon />}
                onClick={handleScan}
                sx={{
                  background: 'linear-gradient(90deg, #BC00E6, #FF3729)',
                  '&:hover': { background: 'linear-gradient(90deg, #CC10F6, #FF4739)' },
                  fontWeight: 600,
                  px: 3,
                  mt: 1,
                }}
              >
                Scan Library
              </Button>
            )}
          </>
        )}
        {loadingIcon}
      </Box>
    )

    return (
      <Box>
        <SnackbarAlert
          severity={alert.type}
          open={alert.open}
          onClose={alert.onClose}
          setOpen={(open) => setAlert({ ...alert, open })}
        >
          {alert.message}
        </SnackbarAlert>

        {imgs.length === 0 && EMPTY_STATE()}
        {imgs.length > 0 && (
          <Box
            ref={containerRef}
            sx={{
              columnCount: columnCount,
              columnGap: '8px',
            }}
          >
            {imgs.map((img) => (
              <LazyImageCard
                key={img.image_id}
                img={img}
                listVersion={listVersion}
                openImageHandler={(image, options) =>
                  editMode && !options ? onImageSelect?.(img.image_id) : openImage(image || img, options)
                }
                alertHandler={memoizedHandleAlert}
                authenticated={authenticated}
                onRemoveFromView={handleDelete}
                editMode={editMode}
                selected={selectedImages?.has(img.image_id)}
                onSelect={onImageSelect}
                hideUploader={hideUploader}
                removeOnMove={removeOnMove}
              />
            ))}
          </Box>
        )}
      </Box>
    )
  },
)

export default ImageCards
