import React, { useRef } from 'react'
import { saveProgress, getResumeTime } from '../common/videoProgress'
import { useLocation, useParams } from 'react-router-dom'
import { Button, CircularProgress, Divider, IconButton, TextField, Tooltip, Typography, Box } from '@mui/material'
import { Helmet } from 'react-helmet'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import AccessTimeIcon from '@mui/icons-material/AccessTime'
import LockIcon from '@mui/icons-material/Lock'
import SnackbarAlert from '../components/alert/SnackbarAlert'
import NotFound from './NotFound'
import { VideoService, GameService } from '../services'
import { getServedBy, getUrl, getPublicWatchUrl, copyToClipboard, getVideoSources } from '../common/utils'
import { loadUiConfig } from '../common/uiConfig'
import VideoJSPlayer from '../components/player/VideoJSPlayer'
import UploaderMention from '../components/user/UploaderMention'

const URL = getUrl()
const PURL = getPublicWatchUrl()
const SERVED_BY = getServedBy()
const APP_ORIGIN = window.location.origin

const actionBtnSx = {
  color: '#FFFFFFB3',
  bgcolor: '#FFFFFF0D',
  border: '1px solid #FFFFFF1A',
  borderRadius: '8px',
  p: 1,
  '&:hover': { bgcolor: '#FFFFFF1A', color: 'white' },
}

const rowBoxSx = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.5,
  bgcolor: '#FFFFFF0D',
  border: '1px solid #FFFFFF26',
  borderRadius: '8px',
  px: 1.5,
  py: 1,
}

function useQuery() {
  const { search } = useLocation()

  return React.useMemo(() => new URLSearchParams(search), [search])
}

const Watch = ({ authenticated }) => {
  const { id } = useParams()
  const query = useQuery()
  const time = query.get('t')
  const [details, setDetails] = React.useState(null)
  const [notFound, setNotFound] = React.useState(false)
  const [views, setViews] = React.useState()
  const [viewAdded, setViewAdded] = React.useState(false)
  const [selectedGame, setSelectedGame] = React.useState(null)
  const [gamePillColor, setGamePillColor] = React.useState(null)
  const [unlocked, setUnlocked] = React.useState(false)
  const [passwordInput, setPasswordInput] = React.useState('')
  const [passwordError, setPasswordError] = React.useState(null)
  const [passwordLoading, setPasswordLoading] = React.useState(false)
  // The public config, which holds the default quality. The player waits for it: on a
  // first visit nothing is cached yet, and the starting quality is taken at mount.
  const [uiConfig, setUiConfig] = React.useState(null)

  const videoPlayerRef = useRef(null)
  const lastSavedRef = useRef(0)
  const [alert, setAlert] = React.useState({ open: false })

  React.useEffect(() => {
    async function fetch() {
      try {
        const resp = (await VideoService.getDetails(id)).data
        const videoViews = (await VideoService.getViews(id)).data
        setDetails(resp)
        setViews(videoViews)
        setUnlocked(authenticated || !resp.info?.has_password || resp.info?.session_unlocked === true)
        if (!resp.info?.duration || resp.info?.duration < 10) {
          setViewAdded(true)
          VideoService.addView(id).catch((err) => console.error(err))
        }
        try {
          const gameData = (await GameService.getVideoGame(id)).data
          setSelectedGame(gameData || null)
        } catch {
          setSelectedGame(null)
        }
      } catch (err) {
        if (err.response && err.response.status === 404) {
          setNotFound({
            title: "We're Sorry...",
            body: "But the video you're looking for was not found.",
          })
        } else {
          setNotFound({
            title: 'Oops!',
            body: 'Something somewhere went wrong.',
          })
        }
      }
    }
    if (details == null) fetch()
  }, [details, id])

  React.useEffect(() => {
    let cancelled = false
    loadUiConfig()
      .catch((err) => {
        console.error(err)
        return {}
      })
      .then((config) => {
        if (!cancelled) setUiConfig(config)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Built once per video rather than on every render. Picking the other Source variant
  // by hand is remembered, and a list rebuilt from that would reorder under the player
  // and send it back to its starting source.
  const sources = React.useMemo(
    () =>
      details && uiConfig
        ? getVideoSources(id, details.info, details.extension || '.mp4', {
            defaultQuality: uiConfig.default_quality,
          })
        : null,
    [id, details, uiConfig],
  )

  React.useEffect(() => {
    if (!selectedGame?.icon_url) {
      setGamePillColor(null)
      return
    }

    const img = new Image()
    img.crossOrigin = 'anonymous'

    img.onload = () => {
      const SIZE = 64
      const canvas = document.createElement('canvas')
      canvas.width = SIZE
      canvas.height = SIZE
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, SIZE, SIZE)

      const { data } = ctx.getImageData(0, 0, SIZE, SIZE)
      let bestColor = null
      let bestSaturation = -1

      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3]
        if (alpha < 128) continue

        const r = data[i] / 255
        const g = data[i + 1] / 255
        const b = data[i + 2] / 255

        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        const lightness = (max + min) / 2

        if (lightness < 0.15 || lightness > 0.92) continue

        const chroma = max - min
        const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1))

        if (saturation > bestSaturation) {
          bestSaturation = saturation
          bestColor = [data[i], data[i + 1], data[i + 2]]
        }
      }

      setGamePillColor(bestSaturation > 0.2 ? bestColor : null)
    }

    img.onerror = () => setGamePillColor(null)
    img.src = selectedGame.icon_url
  }, [selectedGame?.icon_url])

  const getCurrentTime = () => {
    if (videoPlayerRef.current && typeof videoPlayerRef.current.currentTime === 'function') {
      const time = videoPlayerRef.current.currentTime()
      return time && !isNaN(time) ? time : 0
    }
    return 0
  }

  const copyTimestamp = () => {
    const currentTime = getCurrentTime()
    copyToClipboard(`${PURL}${details?.video_id}?t=${currentTime}`)
    setAlert({
      type: 'info',
      message: 'Time stamped link copied to clipboard',
      open: true,
    })
  }

  const handleTimeUpdate = (e) => {
    if (!viewAdded && e.playedSeconds >= 10) {
      setViewAdded(true)
      VideoService.addView(id).catch((err) => console.error(err))
    }
    const now = Date.now()
    if (now - lastSavedRef.current > 5000) {
      lastSavedRef.current = now
      saveProgress(id, e.playedSeconds, details?.info?.duration)
    }
  }

  const getPosterUrl = () => {
    if (SERVED_BY === 'nginx') {
      return `${URL}/_content/derived/${id}/thumbnail`
    }
    return `${URL}/api/video/poster?id=${id}`
  }

  const handleUnlock = async () => {
    if (!passwordInput) return
    setPasswordLoading(true)
    setPasswordError(null)
    try {
      await VideoService.unlockVideo(id, passwordInput)
      setUnlocked(true)
    } catch (err) {
      setPasswordError(err.response?.status === 403 ? 'Incorrect password.' : 'An error occurred.')
      setPasswordLoading(false)
    }
  }

  if (notFound) return <NotFound title={notFound.title} body={notFound.body} />
  if (!details) return null

  return (
    <>
      <SnackbarAlert severity={alert.type} open={alert.open} setOpen={(open) => setAlert({ ...alert, open })}>
        {alert.message}
      </SnackbarAlert>
      {/*
        Every child here has to be a plain element: react-helmet reads each
        child's `type` as a tag name, and a Fragment's type is a Symbol, which
        threw "Cannot convert a Symbol value to a string" and took the whole
        page down for any video without a password. Repeat the condition per tag
        rather than grouping them.

        Meta values also go in `content`, not `value` — react-helmet only carries
        over the attributes a meta tag actually has, so `value` produced tags
        that said nothing. Crawlers read the server-rendered /w/ page anyway
        (templates/metadata.html), but these should still be right.
      */}
      <Helmet>
        <title>{details?.info?.title}</title>
        <meta name="description" content={details?.info?.description} />
        <meta name="author" content={details?.uploader?.name || ''} />
        <meta property="og:type" content="video" />
        <meta property="og:url" content={window.location.href} />
        <meta property="og:title" content={details?.info?.title} />
        {details?.info?.description && <meta property="og:description" content={details?.info?.description} />}
        <meta property="og:image" content={`${URL}/api/video/poster?id=${id}`} />
        {!details?.info?.has_password && (
          <meta
            property="og:video"
            content={
              SERVED_BY === 'nginx'
                ? `${URL}/_content/video/${id}${details?.extension || '.mp4'}`
                : `${URL}/api/video?id=${id}`
            }
          />
        )}
        {!details?.info?.has_password && <meta property="og:video:width" content={details?.info?.width} />}
        {!details?.info?.has_password && <meta property="og:video:height" content={details?.info?.height} />}
        <meta property="og:site_name" content="Fireshare" />
      </Helmet>
      <div style={{ display: 'flex', height: '100vh', flexDirection: 'column' }}>
        {unlocked ? (
          <Box
            style={{ flex: '1 1 auto', minHeight: 0, width: '100%', position: 'relative', backgroundColor: '#000' }}
            sx={{ '& > div': { borderRadius: 0 } }}
          >
            {sources && (
              <VideoJSPlayer
                sources={sources}
                poster={getPosterUrl()}
                autoplay={true}
                controls={true}
                onTimeUpdate={handleTimeUpdate}
                onReady={(player) => {
                  videoPlayerRef.current = player
                }}
                startTime={time ? parseFloat(time) : getResumeTime(id, details?.info?.duration)}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
                fluid={false}
                fill={true}
              />
            )}
          </Box>
        ) : (
          <Box
            style={{ flex: '1 1 auto', minHeight: 0, width: '100%', position: 'relative', backgroundColor: '#000' }}
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundImage: `url(${getPosterUrl()})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              overflow: 'hidden',
            }}
          >
            {/* Dim overlay */}
            <Box sx={{ position: 'absolute', inset: 0, bgcolor: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(6px)' }} />
            {/* Unlock form */}
            <Box
              sx={{
                position: 'relative',
                zIndex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
                width: '100%',
                maxWidth: 360,
                px: 3,
              }}
            >
              <LockIcon sx={{ fontSize: 48, color: '#fff' }} />
              <Typography variant="h6" sx={{ fontWeight: 700, color: 'white', textAlign: 'center' }}>
                Password Protected
              </Typography>
              <Typography sx={{ fontSize: 14, color: '#FFFFFFB3', textAlign: 'center' }}>
                Enter the password to watch this video.
              </Typography>
              <TextField
                fullWidth
                type="password"
                placeholder="Password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
                autoFocus
                error={!!passwordError}
                helperText={passwordError || ''}
                sx={{
                  '& .MuiOutlinedInput-root': {
                    color: 'white',
                    bgcolor: '#FFFFFF0D',
                    '& fieldset': { borderColor: '#FFFFFF33' },
                    '&:hover fieldset': { borderColor: '#FFFFFF66' },
                    '&.Mui-focused fieldset': { borderColor: '#90CAF9' },
                  },
                  '& .MuiFormHelperText-root': { color: '#EF5350' },
                }}
              />
              <Button
                fullWidth
                variant="contained"
                onClick={handleUnlock}
                disabled={passwordLoading || !passwordInput}
                sx={{ bgcolor: '#1565C0', '&:hover': { bgcolor: '#0D47A1' }, py: 1.25 }}
              >
                {passwordLoading ? <CircularProgress size={22} sx={{ color: 'white' }} /> : 'Unlock'}
              </Button>
            </Box>
          </Box>
        )}
        <Box
          sx={{
            flexShrink: 0,
            bgcolor: '#041223',
            borderTop: '1px solid #FFFFFF14',
            px: { xs: 2, sm: 3 },
            py: 2,
            display: 'flex',
            flexDirection: 'column',
            gap: 1.5,
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 2,
              flexWrap: 'wrap',
            }}
          >
            {/* Left: title + views/date */}
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, flex: 1, minWidth: 200 }}>
              <Typography
                sx={{
                  fontWeight: 900,
                  fontSize: { xs: 16, sm: 21 },
                  color: 'white',
                  lineHeight: 1.3,
                  letterSpacing: '-0.03em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {details?.info?.title || 'Untitled'}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                {views != null && (
                  <Typography sx={{ fontSize: 14, color: '#FFFFFF55' }}>
                    {views.toLocaleString()} {views === 1 ? 'view' : 'views'}
                  </Typography>
                )}
                {details?.recorded_at && (
                  <>
                    <Typography sx={{ fontSize: 14, color: '#FFFFFF55' }}>|</Typography>
                    <Typography sx={{ fontSize: 14, color: '#FFFFFF55' }}>
                      {new Date(details.recorded_at).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </Typography>
                  </>
                )}
                {details?.uploader && (
                  <>
                    <Typography sx={{ fontSize: 14, color: '#FFFFFF55' }}>|</Typography>
                    <UploaderMention uploader={details.uploader} size={20} />
                  </>
                )}
              </Box>
            </Box>

            {/* Right: game pill */}
            {selectedGame && (
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, flexShrink: 0 }}>
                <Box
                  component={selectedGame.steamgriddb_id ? 'a' : 'div'}
                  href={selectedGame.steamgriddb_id ? `${APP_ORIGIN}/games/${selectedGame.steamgriddb_id}` : undefined}
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.75,
                    bgcolor: gamePillColor ? `rgba(${gamePillColor.join(',')}, 0.15)` : '#FFFFFF14',
                    border: `1px solid ${gamePillColor ? `rgba(${gamePillColor.join(',')}, 0.5)` : '#FFFFFF26'}`,
                    borderRadius: '8px',
                    px: 1,
                    py: 0.35,
                    textDecoration: 'none',
                    ...(selectedGame.steamgriddb_id && {
                      cursor: 'pointer',
                      '&:hover': {
                        bgcolor: gamePillColor ? `rgba(${gamePillColor.join(',')}, 0.4)` : '#FFFFFF22',
                      },
                    }),
                  }}
                >
                  {selectedGame.icon_url && (
                    <img
                      src={selectedGame.icon_url}
                      alt=""
                      style={{ width: 20, height: 20, objectFit: 'contain', borderRadius: 3, flexShrink: 0 }}
                    />
                  )}
                  <Typography sx={{ fontSize: 12, color: 'white', whiteSpace: 'nowrap' }}>
                    {selectedGame.name}
                  </Typography>
                </Box>
              </Box>
            )}
          </Box>

          {details?.info?.description && (
            <Typography sx={{ fontSize: 14, color: '#FFFFFFB3', lineHeight: 1.6 }}>
              {details.info.description}
            </Typography>
          )}

          <Divider sx={{ borderColor: '#FFFFFF14' }} />

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box sx={{ ...rowBoxSx, flex: 1 }}>
              <Typography
                sx={{
                  flex: 1,
                  fontSize: 12,
                  color: '#FFFFFF66',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: 'monospace',
                }}
              >
                {`${PURL}${details?.video_id}`}
              </Typography>
              <Tooltip title="Copy link">
                <IconButton
                  size="small"
                  onClick={() => {
                    copyToClipboard(`${PURL}${details?.video_id}`)
                    setAlert({ type: 'info', message: 'Link copied to clipboard', open: true })
                  }}
                  sx={{ color: '#FFFFFF66', '&:hover': { color: 'white' }, p: 0.5, flexShrink: 0 }}
                >
                  <ContentCopyIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </Box>
            <Tooltip title="Copy timestamp">
              <IconButton size="small" onClick={copyTimestamp} sx={actionBtnSx}>
                <AccessTimeIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </div>
    </>
  )
}

export default Watch
