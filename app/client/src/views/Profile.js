import React from 'react'
import { useParams, Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import ShareIcon from '@mui/icons-material/Share'
import EditIcon from '@mui/icons-material/Edit'
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import VideoLibraryIcon from '@mui/icons-material/VideoLibrary'
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import PersonOffIcon from '@mui/icons-material/PersonOff'
import SportsEsportsIcon from '@mui/icons-material/SportsEsports'
import { CopyToClipboard } from 'react-copy-to-clipboard'

import { UserService } from '../services'
import VideoCards from '../components/cards/VideoCards'
import ImageCards from '../components/cards/ImageCards'
import SnackbarAlert from '../components/alert/SnackbarAlert'
import ImageModal from '../components/modal/ImageModal'
import UserAvatar, { gradientFor } from '../components/user/UserAvatar'
import { dialogTitleSx, inputSx, helperTextSx } from '../common/modalStyles'
import { applyImageUpdate, useMobileFullScreenDialog } from '../common/utils'

/** Short "how long ago" label for the profile subtext. */
const relativeTime = (iso) => {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return null
  const seconds = Math.max(0, Math.round((Date.now() - then.getTime()) / 1000))
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ]
  for (const [unit, size] of units) {
    const n = Math.floor(seconds / size)
    if (n >= 1) return `${n} ${unit}${n === 1 ? '' : 's'} ago`
  }
  return 'just now'
}

const BANNER_W = 1920
const BANNER_H = 620

const BIO_MAX = 280
const DISPLAY_NAME_MAX = 64

const StatBlock = ({ value, label, tone }) => (
  <Box>
    <Typography
      sx={{
        fontFamily: 'monospace',
        fontSize: 21,
        fontWeight: 700,
        lineHeight: 1.2,
        fontVariantNumeric: 'tabular-nums',
        color: tone || '#fff',
      }}
    >
      {value}
    </Typography>
    <Typography
      sx={{
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: '0.09em',
        textTransform: 'uppercase',
        color: 'rgba(255,255,255,0.4)',
      }}
    >
      {label}
    </Typography>
  </Box>
)

const Profile = ({ authenticated }) => {
  const { username } = useParams()
  const mobileFullScreen = useMobileFullScreenDialog()

  const [profile, setProfile] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [notFound, setNotFound] = React.useState(false)
  const [tab, setTab] = React.useState(0)
  const [videos, setVideos] = React.useState(null)
  const [images, setImages] = React.useState(null)
  const [games, setGames] = React.useState(null)
  // logo_url is always populated when a game has a steamgriddb id, even if the
  // asset was never downloaded. Track failures so the card can fall back to the
  // game's name instead of rendering an unlabelled tile.
  const [brokenLogos, setBrokenLogos] = React.useState(() => new Set())
  const [alert, setAlert] = React.useState({ open: false })
  // ImageCards has no modal of its own (unlike VideoCards), so the viewer is
  // owned here, the same way ImageFeed owns it.
  const [modalImage, setModalImage] = React.useState(null)
  const [modalImageEdit, setModalImageEdit] = React.useState(false)
  // Game art is served from the SteamGridDB asset cache, which may not have been
  // downloaded (no API key, or a game with no art). Track load failure so the
  // gradient underneath stays visible instead of showing a broken image.
  const [bannerBroken, setBannerBroken] = React.useState(false)

  const [editOpen, setEditOpen] = React.useState(false)
  const [displayNameDraft, setDisplayNameDraft] = React.useState('')
  const [bioDraft, setBioDraft] = React.useState('')
  const [publicDraft, setPublicDraft] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const fileInputRef = React.useRef(null)
  const bannerInputRef = React.useRef(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setNotFound(false)
    try {
      const { data } = await UserService.getProfile(username)
      setProfile(data)
    } catch (err) {
      if (err.response?.status === 404) setNotFound(true)
      else setAlert({ open: true, type: 'error', message: 'Could not load this profile.' })
    }
    setLoading(false)
  }, [username])

  React.useEffect(() => {
    load()
  }, [load])

  React.useEffect(() => {
    setBannerBroken(false)
  }, [username])

  // Media is fetched per tab, on first visit only.
  React.useEffect(() => {
    if (!profile) return
    if (tab === 0 && videos === null) {
      UserService.getProfileVideos(username)
        .then((res) => setVideos(res.data.videos || []))
        .catch(() => setVideos([]))
    }
    if (tab === 1 && images === null) {
      UserService.getProfileImages(username)
        .then((res) => setImages(res.data.images || []))
        .catch(() => setImages([]))
    }
    if (tab === 2 && games === null) {
      UserService.getProfileGames(username)
        .then((res) => setGames(res.data || []))
        .catch(() => setGames([]))
    }
  }, [tab, profile, username, videos, images, games])

  const handleImageOpen = React.useCallback((image, options) => {
    setModalImage(image)
    setModalImageEdit(Boolean(options?.edit))
  }, [])

  const handleImageNext = React.useCallback(() => {
    setModalImage((cur) => {
      if (!cur || !images) return cur
      const i = images.findIndex((img) => img.image_id === cur.image_id)
      return i >= 0 && i < images.length - 1 ? images[i + 1] : cur
    })
  }, [images])

  const handleImagePrev = React.useCallback(() => {
    setModalImage((cur) => {
      if (!cur || !images) return cur
      const i = images.findIndex((img) => img.image_id === cur.image_id)
      return i > 0 ? images[i - 1] : cur
    })
  }, [images])

  const handleImageModalClose = (update) => {
    if (update && modalImage) {
      setImages((prev) =>
        (prev || []).map((img) =>
          img.image_id !== modalImage.image_id
            ? img
            : applyImageUpdate(img, update),
        ),
      )
    }
    setModalImage(null)
  }

  const openEdit = () => {
    setDisplayNameDraft(profile.display_name || '')
    setBioDraft(profile.bio || '')
    setPublicDraft(profile.profile_public !== false)
    setEditOpen(true)
  }

  const saveProfile = async () => {
    setSaving(true)
    try {
      await UserService.updateProfile({
        display_name: displayNameDraft,
        bio: bioDraft,
        profile_public: publicDraft,
      })
      setEditOpen(false)
      setAlert({ open: true, type: 'success', message: 'Profile updated.' })
      await load()
    } catch (err) {
      setAlert({
        open: true,
        type: 'error',
        message: err.response?.data?.error || 'Could not save your profile.',
      })
    }
    setSaving(false)
  }

  const handleAvatarPicked = async (event) => {
    const file = event.target.files?.[0]
    // Reset immediately so picking the same file twice still fires a change event.
    event.target.value = ''
    if (!file) return

    setUploading(true)
    try {
      await UserService.uploadAvatar(file)
      setAlert({ open: true, type: 'success', message: 'Profile picture updated.' })
      await load()
    } catch (err) {
      setAlert({
        open: true,
        type: 'error',
        message: err.response?.data?.error || 'Could not upload that image.',
      })
    }
    setUploading(false)
  }

  const handleBannerPicked = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setUploading(true)
    try {
      await UserService.uploadBanner(file)
      setBannerBroken(false)
      setAlert({ open: true, type: 'success', message: 'Banner updated.' })
      await load()
    } catch (err) {
      setAlert({
        open: true,
        type: 'error',
        message: err.response?.data?.error || 'Could not upload that image.',
      })
    }
    setUploading(false)
  }

  const removeBanner = async () => {
    setUploading(true)
    try {
      await UserService.deleteBanner()
      setBannerBroken(false)
      setAlert({ open: true, type: 'info', message: 'Banner removed.' })
      await load()
    } catch (err) {
      setAlert({ open: true, type: 'error', message: 'Could not remove your banner.' })
    }
    setUploading(false)
  }

  const removeAvatar = async () => {
    setUploading(true)
    try {
      await UserService.deleteAvatar()
      setAlert({ open: true, type: 'info', message: 'Profile picture removed.' })
      await load()
    } catch (err) {
      setAlert({ open: true, type: 'error', message: 'Could not remove your picture.' })
    }
    setUploading(false)
  }

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (notFound || !profile) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 2,
          py: 10,
          px: 3,
          // The route renders with mainPadding={0} so the profile banner can bleed
          // to the edges, which leaves this card to supply its own inset on all
          // four sides rather than just the horizontal ones.
          m: 3,
          border: '1px solid #FFFFFF14',
          borderRadius: '16px',
          background: '#00000040',
        }}
      >
        <PersonOffIcon sx={{ fontSize: 56, color: '#FFFFFF33' }} />
        <Box sx={{ textAlign: 'center' }}>
          <Typography sx={{ fontWeight: 700, fontSize: 20, color: 'white', mb: 0.5 }}>
            Profile not available
          </Typography>
          <Typography sx={{ fontSize: 14, color: '#FFFFFF66' }}>
            This user does not exist, or their profile is not shared.
          </Typography>
        </Box>
        <Button component={RouterLink} to="/videos" variant="outlined" sx={{ mt: 1 }}>
          Back to videos
        </Button>
      </Box>
    )
  }

  const { stats } = profile
  const isSelf = profile.is_self
  const [gFrom, gTo] = gradientFor(profile.username)
  const shareUrl = `${window.location.origin}/u/${profile.username}`
  const hasNoAvatar = !profile.has_avatar
  const bannerGame = profile.banner_game
  // Precedence: an uploaded banner, then the most-uploaded game's art, then the
  // generated gradient underneath.
  const bannerArt = bannerBroken
    ? null
    : profile.banner_url || bannerGame?.banner_url || bannerGame?.hero_url || null
  const bannerIsGameArt = !profile.banner_url && Boolean(bannerArt)
  const lastUpload = profile.last_upload_at ? relativeTime(profile.last_upload_at) : null

  return (
    <Box sx={{ pb: 5 }}>
      <SnackbarAlert severity={alert.type} open={alert.open} setOpen={(open) => setAlert({ ...alert, open })}>
        {alert.message}
      </SnackbarAlert>

      <ImageModal
        open={Boolean(modalImage)}
        onClose={handleImageModalClose}
        image={modalImage}
        startInEditMode={modalImageEdit}
        alertHandler={setAlert}
        authenticated={authenticated}
        onNext={handleImageNext}
        onPrev={handleImagePrev}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={handleAvatarPicked}
        style={{ display: 'none' }}
      />
      <input
        ref={bannerInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={handleBannerPicked}
        style={{ display: 'none' }}
      />

      {/* Banner: the most-uploaded game's art where it exists, over a per-user
          gradient that doubles as the fallback. */}
      <Box sx={{ position: 'relative', height: 200, overflow: 'hidden' }}>
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            opacity: 0.7,
            background: `
              radial-gradient(120% 150% at 12% 0%, ${gFrom}CC 0%, transparent 55%),
              radial-gradient(90% 130% at 82% 20%, ${gTo}99 0%, transparent 60%),
              linear-gradient(105deg, #0A1929 0%, #14385C 45%, #1E4976 70%, #0A1929 100%)
            `,
          }}
        />
        {bannerArt && (
          <Box
            component="img"
            src={bannerArt}
            alt=""
            onError={() => setBannerBroken(true)}
            sx={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'center',
              // Matches the treatment GameVideosHeader gives the same artwork.
              opacity: 0.7,
              pointerEvents: 'none',
            }}
          />
        )}
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(to bottom, rgba(0,30,60,0.15) 0%, rgba(0,30,60,0.6) 55%, #001E3C 100%)',
          }}
        />
        {bannerIsGameArt && (
          <Box
            component={RouterLink}
            to={`/games/${bannerGame.steamgriddb_id}`}
            sx={{
              position: 'absolute',
              left: 24,
              top: 20,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.75,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.07em',
              textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.62)',
              textDecoration: 'none',
              '&:hover': { color: '#fff' },
            }}
          >
            <SportsEsportsIcon sx={{ fontSize: 13 }} />
            {bannerGame.name}
          </Box>
        )}
        {/* The theme gives every size="small" Button a -8px left margin, which
            would cancel this row's gap exactly. Reset it so the gap applies. */}
        <Box
          sx={{
            position: 'absolute',
            top: 16,
            right: 20,
            display: 'flex',
            gap: 1,
            '& .MuiButton-root': { ml: 0 },
          }}
        >
          <CopyToClipboard text={shareUrl}>
            <Button
              size="small"
              startIcon={<ShareIcon />}
              onClick={() => setAlert({ open: true, type: 'info', message: 'Profile link copied' })}
              sx={{
                bgcolor: 'rgba(10,25,41,0.78)',
                border: '1px solid #1E4976',
                color: '#fff',
                backdropFilter: 'blur(6px)',
                '&:hover': { bgcolor: '#132F4C' },
              }}
            >
              Share profile
            </Button>
          </CopyToClipboard>
          {profile.can_edit && (
            <Button
              size="small"
              startIcon={<EditIcon />}
              onClick={openEdit}
              sx={{
                background: 'linear-gradient(90deg, #BC00E6, #FF3729)',
                color: '#fff',
                '&:hover': { background: 'linear-gradient(90deg, #CC10F6, #FF4739)' },
              }}
            >
              Edit profile
            </Button>
          )}
        </Box>
      </Box>

      {/* Identity */}
      <Box
        sx={{
          display: 'flex',
          alignItems: { xs: 'flex-start', sm: 'flex-end' },
          flexDirection: { xs: 'column', sm: 'row' },
          gap: { xs: 1.5, sm: 2.5 },
          px: 3,
          mt: '-52px',
          position: 'relative',
        }}
      >
        <Box sx={{ position: 'relative', flexShrink: 0 }}>
          <UserAvatar
            user={profile}
            size={104}
            radius="20px"
            sx={{ border: '3px solid #001E3C', boxShadow: '0 8px 28px rgba(0,0,0,0.45)' }}
          />
          {isSelf && (
            <Tooltip title={hasNoAvatar ? 'Add a profile picture' : 'Change profile picture'}>
              <IconButton
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                sx={{
                  position: 'absolute',
                  bottom: -4,
                  right: -4,
                  width: 34,
                  height: 34,
                  bgcolor: '#132F4C',
                  border: '2px solid #001E3C',
                  color: '#66B2FF',
                  '&:hover': { bgcolor: '#173A5E' },
                }}
              >
                {uploading ? (
                  <CircularProgress size={16} />
                ) : (
                  <PhotoCameraIcon sx={{ fontSize: 17 }} />
                )}
              </IconButton>
            </Tooltip>
          )}
        </Box>

        <Box sx={{ minWidth: 0, pb: 0.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.25, flexWrap: 'wrap' }}>
            <Typography
              sx={{ fontSize: 27, fontWeight: 800, letterSpacing: '-0.02em', textWrap: 'balance' }}
            >
              {profile.name}
            </Typography>
            <Typography sx={{ fontFamily: 'monospace', fontSize: 14, color: '#66B2FF' }}>
              @{profile.username}
            </Typography>
            {profile.profile_public === false && (
              <Chip
                size="small"
                icon={<VisibilityOffIcon sx={{ fontSize: 14 }} />}
                label="Not shared"
                sx={{
                  height: 22,
                  fontSize: 10,
                  fontWeight: 800,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  bgcolor: '#132F4C',
                  border: '1px solid #1E4976',
                  color: '#B2BAC2',
                }}
              />
            )}
          </Box>
          {profile.bio && (
            <Typography sx={{ mt: 0.9, color: '#B2BAC2', fontSize: 13.5, maxWidth: '62ch' }}>
              {profile.bio}
            </Typography>
          )}
          {(profile.created_at || lastUpload) && (
            <Typography sx={{ mt: 0.75, fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
              {profile.created_at && (
                <>
                  Joined{' '}
                  {new Date(profile.created_at).toLocaleDateString('en-US', {
                    month: 'long',
                    year: 'numeric',
                  })}
                </>
              )}
              {profile.created_at && lastUpload && ' · '}
              {lastUpload && `Last upload ${lastUpload}`}
            </Typography>
          )}
        </Box>
      </Box>

      {/* First-run prompt: only for your own avatar-less profile. */}
      {isSelf && hasNoAvatar && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            mx: 3,
            mt: 2.5,
            p: '11px 14px',
            border: '1px solid #1E4976',
            borderLeft: '3px solid #3399FF',
            borderRadius: '8px',
            background: 'rgba(19,47,76,0.5)',
            flexWrap: 'wrap',
          }}
        >
          <Typography sx={{ fontSize: 13, color: '#B2BAC2', flex: 1, minWidth: 200 }}>
            <b style={{ color: '#fff', fontWeight: 600 }}>Add a profile picture.</b> Right now your
            uploads show a lettered placeholder next to them.
          </Typography>
          <Button
            size="small"
            variant="outlined"
            startIcon={<PhotoCameraIcon />}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            // Cancels the theme's -8px on small buttons, which would otherwise
            // eat most of this row's gap.
            sx={{ ml: 0 }}
          >
            Choose image
          </Button>
        </Box>
      )}

      {/* Stats */}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3.25, px: 3, pt: 2.75 }}>
        <StatBlock value={stats.videos} label="Videos" />
        <StatBlock value={stats.images} label="Images" />
        <StatBlock value={stats.total_views.toLocaleString()} label="Total views" />
        <StatBlock value={stats.games} label="Games" />
        {profile.showing_private && stats.private_videos + stats.private_images > 0 && (
          <StatBlock
            value={stats.private_videos + stats.private_images}
            label="Private"
            tone="#FF6B6B"
          />
        )}
      </Box>

      {/* Tabs */}
      <Box sx={{ px: 3, mt: 2.5, borderBottom: '1px solid rgba(194,224,255,0.08)' }}>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          sx={{
            minHeight: 0,
            '& .MuiTab-root': { textTransform: 'none', fontWeight: 600, minHeight: 44, px: 0, mr: 3.25 },
          }}
        >
          <Tab
            icon={<VideoLibraryIcon sx={{ fontSize: 17 }} />}
            iconPosition="start"
            label={`Videos (${stats.videos})`}
          />
          <Tab
            icon={<PhotoLibraryIcon sx={{ fontSize: 17 }} />}
            iconPosition="start"
            label={`Images (${stats.images})`}
          />
          <Tab
            icon={<SportsEsportsIcon sx={{ fontSize: 17 }} />}
            iconPosition="start"
            label={`Games (${stats.games})`}
          />
        </Tabs>
      </Box>

      {/* Media — the existing feed components, filtered to this uploader. */}
      <Box sx={{ px: 3, pt: 2 }}>
        {tab === 0 &&
          (videos === null ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
              <CircularProgress />
            </Box>
          ) : (
            <VideoCards
              videos={videos}
              feedView={!authenticated}
              authenticated={authenticated}
              size={300}
              hideUploader
            />
          ))}
        {tab === 1 &&
          (images === null ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
              <CircularProgress />
            </Box>
          ) : (
            <ImageCards
              images={images}
              authenticated={authenticated}
              feedView={!authenticated}
              size={300}
              onImageOpen={handleImageOpen}
              hideUploader
            />
          ))}
        {tab === 2 &&
          (games === null ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
              <CircularProgress />
            </Box>
          ) : games.length === 0 ? (
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 1,
                py: 7,
                border: '1px solid #FFFFFF14',
                borderRadius: '16px',
                background: '#00000040',
              }}
            >
              <SportsEsportsIcon sx={{ fontSize: 48, color: '#FFFFFF33' }} />
              <Typography sx={{ fontWeight: 700, fontSize: 18 }}>No games yet</Typography>
              <Typography sx={{ fontSize: 13.5, color: '#FFFFFF66' }}>
                Uploads tagged with a game will show up here.
              </Typography>
            </Box>
          ) : (
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))',
                gap: 2,
              }}
            >
              {games.map((game) => (
                <Box
                  key={game.id}
                  component={RouterLink}
                  to={`/games/${game.steamgriddb_id}`}
                  sx={{
                    position: 'relative',
                    height: 170,
                    borderRadius: 2,
                    overflow: 'hidden',
                    display: 'block',
                    textDecoration: 'none',
                    bgcolor: '#00000066',
                    transition: 'transform 0.2s ease, box-shadow 0.2s ease',
                    '&:hover': { transform: 'scale(1.04)', boxShadow: '0 8px 24px #00000080' },
                    '&:focus-visible': { outline: '2px solid #3399FF', outlineOffset: 2 },
                  }}
                >
                  {game.hero_url && (
                    <Box
                      component="img"
                      src={game.hero_url}
                      alt=""
                      onError={(e) => {
                        e.currentTarget.style.display = 'none'
                      }}
                      sx={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        filter: 'brightness(0.7)',
                      }}
                    />
                  )}
                  {game.logo_url && !brokenLogos.has(game.id) ? (
                    <Box
                      component="img"
                      src={game.logo_url}
                      alt={game.name}
                      onError={() =>
                        setBrokenLogos((prev) => new Set(prev).add(game.id))
                      }
                      sx={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        maxWidth: '65%',
                        maxHeight: '65%',
                        objectFit: 'contain',
                        zIndex: 1,
                      }}
                    />
                  ) : (
                    <Typography
                      sx={{
                        position: 'absolute',
                        inset: 0,
                        display: 'grid',
                        placeItems: 'center',
                        px: 2,
                        textAlign: 'center',
                        fontWeight: 800,
                        fontSize: 18,
                        color: '#fff',
                        textShadow: '0 2px 8px rgba(0,0,0,0.8)',
                      }}
                    >
                      {game.name}
                    </Typography>
                  )}
                  <Box
                    sx={{
                      position: 'absolute',
                      left: 10,
                      bottom: 10,
                      zIndex: 2,
                      display: 'flex',
                      gap: 0.75,
                      fontFamily: 'monospace',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {game.video_count > 0 && (
                      <Box sx={{ bgcolor: '#000000BF', borderRadius: '4px', px: 0.75, color: '#fff' }}>
                        {game.video_count} video{game.video_count === 1 ? '' : 's'}
                      </Box>
                    )}
                    {game.image_count > 0 && (
                      <Box sx={{ bgcolor: '#000000BF', borderRadius: '4px', px: 0.75, color: '#fff' }}>
                        {game.image_count} image{game.image_count === 1 ? '' : 's'}
                      </Box>
                    )}
                  </Box>
                </Box>
              ))}
            </Box>
          ))}
      </Box>

      {/* Edit dialog */}
      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        fullWidth
        maxWidth="sm"
        {...mobileFullScreen}
      >
        <DialogTitle sx={dialogTitleSx}>Edit profile</DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <UserAvatar user={profile} size={64} radius="14px" />
              <Stack direction="row" spacing={1}>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<PhotoCameraIcon />}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  {profile.has_avatar ? 'Replace' : 'Upload'}
                </Button>
                {profile.has_avatar && (
                  <Button
                    size="small"
                    color="error"
                    startIcon={<DeleteOutlineIcon />}
                    onClick={removeAvatar}
                    disabled={uploading}
                  >
                    Remove
                  </Button>
                )}
              </Stack>
            </Box>

            <Box>
              <Typography sx={{ fontSize: 12.5, fontWeight: 700, color: '#B2BAC2', mb: 1 }}>
                BANNER
              </Typography>
              <Box
                sx={{
                  position: 'relative',
                  height: 84,
                  borderRadius: '8px',
                  overflow: 'hidden',
                  border: '1px solid #1E4976',
                  background: `
                    radial-gradient(120% 150% at 12% 0%, ${gFrom}CC 0%, transparent 55%),
                    linear-gradient(105deg, #0A1929 0%, #14385C 45%, #1E4976 70%, #0A1929 100%)
                  `,
                }}
              >
                {bannerArt && (
                  <Box
                    component="img"
                    src={bannerArt}
                    alt=""
                    sx={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      opacity: 0.7,
                    }}
                  />
                )}
                <Typography
                  sx={{
                    position: 'absolute',
                    left: 10,
                    bottom: 8,
                    fontSize: 10.5,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: 'rgba(255,255,255,0.7)',
                  }}
                >
                  {profile.banner_url
                    ? 'Your image'
                    : bannerIsGameArt
                      ? `From ${bannerGame.name}`
                      : 'No banner'}
                </Typography>
              </Box>
              <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<PhotoCameraIcon />}
                  onClick={() => bannerInputRef.current?.click()}
                  disabled={uploading}
                >
                  {profile.has_banner ? 'Replace' : 'Upload'}
                </Button>
                {profile.has_banner && (
                  <Button
                    size="small"
                    color="error"
                    startIcon={<DeleteOutlineIcon />}
                    onClick={removeBanner}
                    disabled={uploading}
                  >
                    Remove
                  </Button>
                )}
              </Stack>
              <Typography sx={{ mt: 0.75, fontSize: 11.5, color: 'rgba(255,255,255,0.45)' }}>
                Wide images work best — around {BANNER_W} &times; {BANNER_H} (roughly 3:1). Anything
                else is centre-cropped to fit, so keep the important part in the middle.
                {bannerIsGameArt || !profile.has_banner
                  ? ' Leave this empty to use art from the game you upload most.'
                  : ''}
              </Typography>
            </Box>

            <TextField
              label="Display name"
              placeholder={profile.username}
              value={displayNameDraft}
              onChange={(e) => setDisplayNameDraft(e.target.value.slice(0, DISPLAY_NAME_MAX))}
              fullWidth
              sx={inputSx}
              helperText={`Shown instead of @${profile.username}. Leave empty to use your username.`}
              FormHelperTextProps={{ sx: helperTextSx }}
            />

            <TextField
              label="Bio"
              value={bioDraft}
              onChange={(e) => setBioDraft(e.target.value.slice(0, BIO_MAX))}
              fullWidth
              multiline
              minRows={2}
              maxRows={4}
              sx={inputSx}
              helperText={`${bioDraft.length} / ${BIO_MAX}`}
              FormHelperTextProps={{ sx: helperTextSx }}
            />

            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                p: 1.5,
                border: '1px solid #1E4976',
                borderRadius: '8px',
              }}
            >
              <Switch checked={publicDraft} onChange={(e) => setPublicDraft(e.target.checked)} />
              <Box>
                <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>
                  Share my profile page
                </Typography>
                <Typography sx={{ fontSize: 12, color: '#B2BAC2' }}>
                  {publicDraft
                    ? `Anyone with the link can see your public uploads at /u/${profile.username}.`
                    : 'Your profile page is hidden. Individual share links keep working.'}
                </Typography>
              </Box>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOpen(false)} sx={{ color: '#B2BAC2' }}>
            Cancel
          </Button>
          <Button onClick={saveProfile} variant="contained" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

export default Profile
