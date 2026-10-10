import * as React from 'react'
import { Grid, Box, IconButton } from '@mui/material'
import Typography from '@mui/material/Typography'
import Tooltip from '@mui/material/Tooltip'
import { motion } from 'framer-motion'
import adminSSE from '../../services/AdminSSE'
import SyncIcon from '@mui/icons-material/Sync'

const formatEta = (seconds) => {
  if (!seconds || seconds < 0) return null
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  if (mins > 0) return `${mins}m ${secs}s left`
  return `${secs}s left`
}

const styles = {
  card: {
    m: 1,
    border: '1px solid rgba(194, 224, 255, 0.18)',
    borderRadius: '8px',
    display: 'flex',
    alignItems: 'center',
    backgroundColor: 'transparent',
    ':hover': { backgroundColor: 'rgba(194, 224, 255, 0.08)' },
  },
  cardExpanded: { width: 222, px: 2, py: 1.5 },
  cardCollapsed: { width: 42, height: 40, justifyContent: 'center' },
  textPrimary: { fontFamily: 'monospace', fontWeight: 600, fontSize: 12, color: '#EBEBEB' },
  textSecondary: { fontFamily: 'monospace', fontSize: 10, color: '#999' },
  textAccent: { color: '#2684FF' },
  truncate: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  progressTrack: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(194, 224, 255, 0.1)',
    overflow: 'hidden',
  },
}

const TranscodingStatus = ({ open, authenticated }) => {
  const [status, setStatus] = React.useState(null)
  const [stoppedMessage, setStoppedMessage] = React.useState(null)

  React.useEffect(() => {
    const handleCancel = () => {
      setStatus(null)
      setStoppedMessage('Transcoding stopped')
      setTimeout(() => setStoppedMessage(null), 3000)
    }
    window.addEventListener('transcodingCancelled', handleCancel)
    return () => {
      window.removeEventListener('transcodingCancelled', handleCancel)
    }
  }, [])

  React.useEffect(() => {
    if (!authenticated) return
    return adminSSE.subscribeTranscoding((data) => {
      setStatus(data?.is_running ? data : null)
    })
  }, [authenticated])

  if (!status && !stoppedMessage) return null

  if (stoppedMessage && open) {
    return (
      <Box sx={{ ...styles.card, ...styles.cardExpanded }}>
        <Grid container alignItems="center">
          <Grid item>
            <Typography sx={styles.textPrimary}>{stoppedMessage}</Typography>
          </Grid>
        </Grid>
      </Box>
    )
  }

  if (open) {
    return (
      <Tooltip title={status.current_video || 'Not transcoding'} arrow placement="right">
        <Box sx={{ ...styles.card, ...styles.cardExpanded }}>
          <Grid container alignItems="center">
            <Grid item xs={12} sx={{ overflow: 'hidden' }}>
              <Typography sx={styles.textPrimary}>
                {status.total === 0 ? (
                  'Preparing transcode...'
                ) : (
                  <>
                    {status.resolution === 'SDR' ? 'Tone mapping:' : 'Transcoding:'}{' '}
                    <Box component="span" sx={styles.textAccent}>
                      {status.current + status.completed_tasks}/
                      {status.total + status.completed_tasks + status.queue_tasks}
                    </Box>
                  </>
                )}
              </Typography>
              {status.current_video && (
                <Typography sx={{ ...styles.textSecondary, ...styles.truncate }}>{status.current_video}</Typography>
              )}
              {typeof status.percent === 'number' && (
                <Box sx={{ mt: 1, width: '100%' }}>
                  <Box sx={styles.progressTrack}>
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${status.percent}%` }}
                      transition={{ duration: 0.6, ease: [0.25, 0.1, 0.25, 1] }}
                      style={{
                        height: '100%',
                        backgroundColor: '#2684FF',
                        borderRadius: 4,
                      }}
                    />
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.5 }}>
                    <Typography sx={styles.textSecondary}>
                      {status.percent.toFixed(0)}%{status.eta_seconds ? ` • ${formatEta(status.eta_seconds)}` : ''}
                    </Typography>
                    {status.resolution && (
                      <Typography sx={{ ...styles.textSecondary, ...styles.textAccent, fontWeight: 600 }}>
                        {status.resolution === 'SDR' ? 'HDR → SDR' : status.resolution}
                      </Typography>
                    )}
                  </Box>
                </Box>
              )}
            </Grid>
          </Grid>
        </Box>
      </Tooltip>
    )
  }

  const tooltipText =
    status.total === 0
      ? 'Preparing transcode...'
      : `${status.resolution === 'SDR' ? 'Tone mapping' : 'Transcoding'}: ${status.current + status.completed_tasks}/${status.total + status.completed_tasks + status.queue_tasks}${status.current_video ? `\n${status.current_video}` : ''}`

  return (
    <Tooltip title={tooltipText} arrow placement="right">
      <Box sx={{ ...styles.card, ...styles.cardCollapsed }}>
        <IconButton sx={{ p: 0.5, pointerEvents: 'all' }}>
          <SyncIcon
            sx={{
              color: '#EBEBEB',
              animation: 'spin 1.5s linear infinite',
              '@keyframes spin': {
                '0%': { transform: 'rotate(360deg)' },
                '100%': { transform: 'rotate(0deg)' },
              },
            }}
          />
        </IconButton>
      </Box>
    </Tooltip>
  )
}

export default TranscodingStatus
