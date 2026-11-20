import React from 'react'
import ReactDOM from 'react-dom'
import { Box, ToggleButton, ToggleButtonGroup, Typography, useMediaQuery, useTheme } from '@mui/material'
import Select from 'react-select'
import CompactVideoCard from '../components/cards/CompactVideoCard'
import MasonryImageCard from '../components/cards/MasonryImageCard'
import VideoModal from '../components/modal/VideoModal'
import ImageModal from '../components/modal/ImageModal'
import { applyImageUpdate } from '../common/utils'
import LoadingSpinner from '../components/ui/LoadingSpinner'
import SnackbarAlert from '../components/alert/SnackbarAlert'
import ToolbarFilterMenu from '../components/nav/ToolbarFilterMenu'
import { VideoService, ImageService } from '../services'
import { folderSelectTheme } from '../common/reactSelectThemes'
import {
  SORT_OPTIONS,
  PRIVACY_OPTIONS,
  SORT_SELECT_WIDTH,
  PRIVACY_SELECT_WIDTH,
  TAG_SELECT_WIDTH,
} from '../common/constants'
import TagFilter, { hasAllTags, useTagFilter } from '../components/nav/TagFilter'

const TYPE_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'video', label: 'Videos' },
  { value: 'image', label: 'Photos' },
]

const GAP = 12
// CompactVideoCard is a 16:9 poster plus an info block (title, game and meta
// rows with their padding) that renders at roughly this height. The estimate
// only decides which column a card lands in, so a few pixels either way is fine.
const VIDEO_INFO_HEIGHT = 90

// The moment a piece of media is "from": when a clip was recorded when the
// filename says so, otherwise when it appeared; an image's created_at already
// prefers the capture date from its metadata.
const dateOf = (item) => {
  const raw = item.kind === 'video' ? item.raw.recorded_at || item.raw.created_at : item.raw.created_at
  return raw ? new Date(raw) : null
}

const dayKey = (date) =>
  date ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : 'undated'

function dayLabel(date) {
  if (!date) return 'No date'
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const daysAgo = Math.round((startOfToday - startOfDay) / 86400000)
  if (daysAgo === 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  if (daysAgo > 1 && daysAgo < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
  }
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

const countLabel = (items) => {
  const videos = items.filter((i) => i.kind === 'video').length
  const photos = items.length - videos
  return [
    videos > 0 && `${videos} ${videos === 1 ? 'video' : 'videos'}`,
    photos > 0 && `${photos} ${photos === 1 ? 'photo' : 'photos'}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const estimateHeight = (item, columnWidth) => {
  if (item.kind === 'video') return Math.round((columnWidth * 9) / 16) + VIDEO_INFO_HEIGHT
  const w = item.raw.info?.width
  const h = item.raw.info?.height
  return Math.round(w && h ? (columnWidth * h) / w : (columnWidth * 9) / 16)
}

// Mounts its card once it comes within reach of the viewport. Until then a box
// of the estimated height holds the column's shape so the layout does not jump.
function LazyCard({ height, children }) {
  const ref = React.useRef()
  const [active, setActive] = React.useState(false)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setActive(true)
          observer.disconnect()
        }
      },
      { rootMargin: '800px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return (
    <div
      ref={ref}
      style={{
        minHeight: active ? undefined : height,
        borderRadius: 12,
        backgroundColor: active ? 'transparent' : 'rgba(30, 60, 130, 0.12)',
      }}
    >
      {active && children}
    </div>
  )
}

// The waterfall: each card drops into the shortest column so far, ties going to
// the leftmost, so a run of equal 16:9 videos reads left to right like the grid
// on the Videos page while photos of any shape still pack tightly.
function Waterfall({ items, columnCount, columnWidth, renderItem }) {
  const columns = React.useMemo(() => {
    const heights = new Array(columnCount).fill(0)
    const cols = Array.from({ length: columnCount }, () => [])
    items.forEach((item) => {
      let c = 0
      for (let k = 1; k < columnCount; k++) if (heights[k] < heights[c] - 0.5) c = k
      const height = estimateHeight(item, columnWidth)
      cols[c].push({ item, height })
      heights[c] += height + GAP
    })
    return cols
  }, [items, columnCount, columnWidth])

  return (
    <Box sx={{ display: 'flex', gap: `${GAP}px`, alignItems: 'flex-start' }}>
      {columns.map((col, index) => (
        <Box key={index} sx={{ display: 'flex', flexDirection: 'column', gap: `${GAP}px`, width: columnWidth, flexShrink: 0 }}>
          {col.map(({ item, height }) => (
            <LazyCard key={`${item.kind}:${item.id}`} height={height}>
              {renderItem(item)}
            </LazyCard>
          ))}
        </Box>
      ))}
    </Box>
  )
}

const Home = ({ authenticated, searchText, cardSize, uploadTick }) => {
  const [videos, setVideos] = React.useState([])
  const [images, setImages] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [alert, setAlert] = React.useState({ open: false })
  const [typeFilter, setTypeFilter] = React.useState(TYPE_OPTIONS[0])
  const [sortOrder, setSortOrder] = React.useState(SORT_OPTIONS[0])
  const [privacyFilter, setPrivacyFilter] = React.useState(PRIVACY_OPTIONS[0])
  const [toolbarTarget, setToolbarTarget] = React.useState(null)
  const [videoModal, setVideoModal] = React.useState({ open: false, id: null })
  const [modalImage, setModalImage] = React.useState(null)
  const [modalImageEdit, setModalImageEdit] = React.useState(false)
  const [width, setWidth] = React.useState(0)
  const containerRef = React.useRef()
  const countRef = React.useRef(0)
  const theme = useTheme()
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'))

  React.useEffect(() => {
    setToolbarTarget(document.getElementById('navbar-toolbar-extra'))
  }, [])

  const fetchAll = React.useCallback(async () => {
    const videoReq = authenticated ? VideoService.getVideos() : VideoService.getPublicVideos()
    const imageReq = authenticated ? ImageService.getImages() : ImageService.getPublicImages()
    const [videoRes, imageRes] = await Promise.allSettled([videoReq, imageReq])
    if (videoRes.status === 'rejected' && imageRes.status === 'rejected') {
      const err = videoRes.reason
      throw new Error(typeof err?.response?.data === 'string' ? err.response.data : 'Unknown Error')
    }
    return {
      videos: videoRes.status === 'fulfilled' ? videoRes.value.data.videos || [] : [],
      images: imageRes.status === 'fulfilled' ? imageRes.value.data.images || [] : [],
    }
  }, [authenticated])

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchAll()
      .then(({ videos: v, images: i }) => {
        if (cancelled) return
        setVideos(v)
        setImages(i)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setLoading(false)
        setAlert({ open: true, type: 'error', message: err.message })
      })
    return () => {
      cancelled = true
    }
  }, [fetchAll])

  // An upload is indexed by a background process, so the new file is not in
  // the database when the upload response arrives. Poll until the count grows.
  React.useEffect(() => {
    if (!uploadTick) return
    countRef.current = videos.length + images.length
    let attempts = 0
    const interval = setInterval(() => {
      attempts++
      fetchAll()
        .then(({ videos: v, images: i }) => {
          if (v.length + i.length > countRef.current || attempts >= 8) {
            clearInterval(interval)
            setVideos(v)
            setImages(i)
          }
        })
        .catch(() => {
          if (attempts >= 8) clearInterval(interval)
        })
    }, 2000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadTick])

  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect?.width || 0
      if (w) setWidth(w)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [loading])

  const items = React.useMemo(
    () => [
      ...videos.map((v) => ({ kind: 'video', id: v.video_id, raw: v })),
      ...images.map((i) => ({ kind: 'image', id: i.image_id, raw: i })),
    ],
    [videos, images],
  )

  const allMedia = React.useMemo(() => items.map((item) => item.raw), [items])
  const { options: tagOptions, selected: tagFilter, setSelected: handleTagChange } = useTagFilter(allMedia)

  const displayItems = React.useMemo(() => {
    const tagMatches = (searchText || '').match(/#(\w+)/g) || []
    const tagNames = tagMatches.map((t) => t.slice(1).toLowerCase())
    const textQuery = (searchText || '').replace(/#\w+/g, '').trim()
    const pattern = textQuery ? new RegExp(escapeRegExp(textQuery), 'i') : null

    const filtered = items.filter((item) => {
      if (typeFilter.value !== 'all' && item.kind !== typeFilter.value) return false
      if (privacyFilter.value !== 'all' && item.raw.info?.private !== (privacyFilter.value === 'private')) return false
      const title = item.raw.info?.title || ''
      const gameName = item.raw.game?.name || ''
      if (pattern && !pattern.test(title) && !pattern.test(gameName)) return false
      if (!hasAllTags(item.raw, tagFilter)) return false
      return tagNames.every((tagName) =>
        (item.raw.tags || []).some(
          (t) => t.name.toLowerCase() === tagName || t.name.replace(/_/g, ' ').toLowerCase() === tagName,
        ),
      )
    })

    return filtered.sort((a, b) => {
      switch (sortOrder.value) {
        case 'most_views':
          return (b.raw.view_count || 0) - (a.raw.view_count || 0)
        case 'least_views':
          return (a.raw.view_count || 0) - (b.raw.view_count || 0)
        case 'name_asc':
        case 'name_desc': {
          const cmp = (a.raw.info?.title || '').toLowerCase().localeCompare((b.raw.info?.title || '').toLowerCase())
          return sortOrder.value === 'name_asc' ? cmp : -cmp
        }
        default: {
          const dateA = dateOf(a) || new Date(0)
          const dateB = dateOf(b) || new Date(0)
          return sortOrder.value === 'newest' ? dateB - dateA : dateA - dateB
        }
      }
    })
  }, [items, searchText, typeFilter, privacyFilter, sortOrder, tagFilter])

  // Day headers only make sense on a chronological sort. Sorted by views or
  // name the feed is one continuous waterfall.
  const groups = React.useMemo(() => {
    if (sortOrder.value !== 'newest' && sortOrder.value !== 'oldest') {
      return displayItems.length ? [{ key: 'all', label: null, items: displayItems }] : []
    }
    const out = []
    let current = null
    displayItems.forEach((item) => {
      const date = dateOf(item)
      const key = dayKey(date)
      if (!current || current.key !== key) {
        current = { key, label: dayLabel(date), items: [] }
        out.push(current)
      }
      current.items.push(item)
    })
    return out
  }, [displayItems, sortOrder])

  // A phone gets one full-width column, the same as every other page.
  const minColumn = cardSize || 300
  const columnCount = width && !isMobile ? Math.max(1, Math.floor((width + GAP) / (minColumn + GAP))) : 1
  const columnWidth = width ? Math.floor((width - GAP * (columnCount - 1)) / columnCount) : minColumn

  const videoList = React.useMemo(() => displayItems.filter((i) => i.kind === 'video').map((i) => i.raw), [displayItems])
  const imageList = React.useMemo(() => displayItems.filter((i) => i.kind === 'image').map((i) => i.raw), [displayItems])

  const handleAlert = React.useCallback((a) => setAlert(a), [])
  const openVideo = React.useCallback((id) => setVideoModal({ open: true, id }), [])
  const openImage = React.useCallback((image, options) => {
    setModalImage(image)
    setModalImageEdit(Boolean(options?.edit))
  }, [])
  const removeVideo = React.useCallback((id) => setVideos((prev) => prev.filter((v) => v.video_id !== id)), [])
  const removeImage = React.useCallback((id) => setImages((prev) => prev.filter((i) => i.image_id !== id)), [])

  const handleVideoUpdate = (update) => {
    const { id, ...rest } = update
    setVideos((prev) => prev.map((v) => (v.video_id === id ? { ...v, info: { ...v.info, ...rest } } : v)))
  }

  const stepVideo = (direction) => {
    const index = videoList.findIndex((v) => v.video_id === videoModal.id)
    const next = videoList[index + direction]
    if (next) setVideoModal({ open: true, id: next.video_id })
  }

  const stepImage = (direction) => {
    setModalImage((current) => {
      if (!current) return current
      const index = imageList.findIndex((i) => i.image_id === current.image_id)
      return imageList[index + direction] || current
    })
  }

  const handleImageModalClose = (update) => {
    if (update && modalImage) {
      setImages((prev) =>
        prev.map((img) =>
          img.image_id !== modalImage.image_id
            ? img
            : applyImageUpdate(img, update),
        ),
      )
    }
    setModalImage(null)
  }

  const renderItem = (item) =>
    item.kind === 'video' ? (
      <CompactVideoCard
        video={item.raw}
        openVideoHandler={openVideo}
        alertHandler={handleAlert}
        authenticated={authenticated}
        onRemoveFromView={removeVideo}
      />
    ) : (
      <MasonryImageCard
        image={item.raw}
        openImageHandler={openImage}
        alertHandler={handleAlert}
        authenticated={authenticated}
        onRemoveFromView={removeImage}
        showTypeIndicator
      />
    )

  const mobileFilters = [
    {
      key: 'type',
      label: 'Show',
      value: typeFilter,
      options: TYPE_OPTIONS,
      onChange: setTypeFilter,
      defaultValue: TYPE_OPTIONS[0].value,
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
      value: sortOrder,
      options: SORT_OPTIONS,
      onChange: setSortOrder,
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
          <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 0.5, sm: 1 }, flexWrap: 'nowrap', minWidth: 0 }}>
            {isMobile ? (
              <ToolbarFilterMenu filters={mobileFilters} />
            ) : (
              <>
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  value={typeFilter.value}
                  onChange={(_, value) => value && setTypeFilter(TYPE_OPTIONS.find((o) => o.value === value))}
                  aria-label="Show"
                  sx={{ height: 38, flexShrink: 0, '& .MuiToggleButton-root': { px: 1.5, fontSize: 13, fontWeight: 600 } }}
                >
                  {TYPE_OPTIONS.map((o) => (
                    <ToggleButton key={o.value} value={o.value}>
                      {o.label}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
                {tagOptions.length > 0 && (
                  <Box sx={{ width: TAG_SELECT_WIDTH, flexShrink: 0 }}>
                    <TagFilter options={tagOptions} value={tagFilter} onChange={handleTagChange} />
                  </Box>
                )}
                <Box sx={{ minWidth: SORT_SELECT_WIDTH }}>
                  <Select
                    value={sortOrder}
                    options={SORT_OPTIONS}
                    onChange={setSortOrder}
                    styles={folderSelectTheme}
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
                      styles={folderSelectTheme}
                      menuPortalTarget={document.body}
                      menuPosition="fixed"
                      blurInputOnSelect
                      isSearchable={false}
                    />
                  </Box>
                )}
              </>
            )}
          </Box>,
          toolbarTarget,
        )}

      <VideoModal
        open={videoModal.open}
        onClose={() => setVideoModal({ open: false, id: null })}
        videoId={videoModal.id}
        feedView={!authenticated}
        authenticated={authenticated}
        updateCallback={handleVideoUpdate}
        onNext={() => stepVideo(1)}
        onPrev={() => stepVideo(-1)}
        onSuggestionSelect={(id) => setVideoModal({ open: true, id })}
      />
      <ImageModal
        open={Boolean(modalImage)}
        onClose={handleImageModalClose}
        image={modalImage}
        startInEditMode={modalImageEdit}
        alertHandler={setAlert}
        authenticated={authenticated}
        onNext={() => stepImage(1)}
        onPrev={() => stepImage(-1)}
      />

      {loading && <LoadingSpinner />}
      {!loading && (
        <Box ref={containerRef} sx={{ width: '100%' }}>
          {groups.length === 0 && (
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 1,
                py: 8,
                px: 3,
                border: '1px solid #FFFFFF14',
                borderRadius: '16px',
                background: '#00000040',
                textAlign: 'center',
              }}
            >
              <Typography sx={{ fontWeight: 700, fontSize: 20, color: 'white' }}>Nothing here yet</Typography>
              <Typography sx={{ fontSize: 14, color: '#FFFFFF66' }}>
                {items.length === 0
                  ? 'Videos and photos show up here together as they are uploaded or scanned in.'
                  : 'Nothing matches the current search and filters.'}
              </Typography>
            </Box>
          )}
          {width > 0 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {groups.map((group) => (
                <Box key={group.key} component="section" sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                  {group.label && (
                    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.25, px: { xs: 0.5, sm: 0 } }}>
                      <Typography component="h2" sx={{ m: 0, fontSize: 18, fontWeight: 700, color: '#E7EBF0' }}>
                        {group.label}
                      </Typography>
                      <Typography sx={{ fontSize: 13, color: '#B2BAC2' }}>{countLabel(group.items)}</Typography>
                    </Box>
                  )}
                  <Waterfall
                    items={group.items}
                    columnCount={columnCount}
                    columnWidth={columnWidth}
                    renderItem={renderItem}
                  />
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}
    </>
  )
}

export default Home
