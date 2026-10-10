import React from 'react'
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  Menu,
  MenuItem,
  NativeSelect,
  Stack,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import SnackbarAlert from '../components/alert/SnackbarAlert'
import { TONEMAP_LABELS } from '../components/modal/TonemapCompareModal'
import SaveIcon from '@mui/icons-material/Save'
import SensorsIcon from '@mui/icons-material/Sensors'
import RssFeedIcon from '@mui/icons-material/RssFeed'
import SendIcon from '@mui/icons-material/Send'
import SportsEsportsIcon from '@mui/icons-material/SportsEsports'
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth'
import UpdateIcon from '@mui/icons-material/Update'
import SyncAltIcon from '@mui/icons-material/SyncAlt'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import FolderIcon from '@mui/icons-material/Folder'
import FolderCopyIcon from '@mui/icons-material/FolderCopy'
import ImageIcon from '@mui/icons-material/Image'
import CloseIcon from '@mui/icons-material/Close'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import StopIcon from '@mui/icons-material/Stop'
import { ConfigService, VideoService, GameService, ImageService, LibraryService } from '../services'
import { setSetting, getSetting } from '../common/utils'
import LightTooltip from '../components/ui/LightTooltip'
import GameSearch from '../components/game/GameSearch'
import SecuritySettings from '../components/settings/SecuritySettings'
import UploadTokens from '../components/settings/UploadTokens'
import ChangePassword from '../components/settings/ChangePassword'
import UserManagement from '../components/settings/UserManagement'
import SidebarPagesEditor from '../components/settings/SidebarPagesEditor'
import RelinkMovedFilesDialog from '../components/settings/RelinkMovedFilesDialog'
import { resolveSidebarPages, sidebarPagesPatch } from '../common/sidebarPages'

import _ from 'lodash'
import { WarningService, adminSSE } from '../services'

const isValidDiscordWebhook = (url) => {
  const regex = /^https:\/\/discord\.com\/api\/webhooks\/\d{17,20}\/[\w-]{60,}$/
  return regex.test(url)
}
const isValidGenericWebhook = (url) => {
  const regex = /^https?:\/\/[^\s\/$.?#].[^\s]*$/
  return regex.test(url)
}
const isValidJson = (str) => {
  try {
    JSON.parse(str)
    return true
  } catch (e) {
    return false
  }
}
const jsonPlaceholder = `#Example JSON Data:
{
  "title": "Fireshare",
  "body": "New Fireshare Video Uploaded!",
  "type": "info" 
}`

// Server configuration panes are administrator-only. Folder Rules and Actions
// follow the permission that governs the routes they drive, so a curator holding
// manage_games / manage_library can reach them. Security is open to everyone,
// because that is where any account manages its own password and 2FA.
const TAB_DEFS = [
  { key: 'general', label: 'General', mobileLabel: 'Privacy & Upload', admin: true },
  { key: 'sidebar', label: 'Sidebar', mobileLabel: 'Sidebar', admin: true },
  { key: 'integrations', label: 'Integrations', mobileLabel: 'Integrations', admin: true },
  { key: 'transcoding', label: 'Transcoding', mobileLabel: 'Transcoding', admin: true },
  { key: 'folders', label: 'Folder Rules', mobileLabel: 'Folder Rules', perm: 'manage_games' },
  // Scan Games is gated on manage_games server-side while the rest of the tab
  // is manage_library, so either permission reveals the tab and the buttons
  // inside it are gated individually.
  { key: 'actions', label: 'Actions', mobileLabel: 'Actions', perm: ['manage_library', 'manage_games'] },
  { key: 'users', label: 'Users', mobileLabel: 'Users', admin: true },
  { key: 'security', label: 'Security', mobileLabel: 'Security' },
]

const missingCountLabel = ({ videos, images }) => {
  const parts = []
  if (videos) parts.push(`${videos} ${videos === 1 ? 'video' : 'videos'}`)
  if (images) parts.push(`${images} ${images === 1 ? 'image' : 'images'}`)
  return parts.join(' and ')
}

const Settings = ({ isAdmin, currentUser, can = () => false }) => {
  const theme = useTheme()
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'))
  const demoMode = getSetting('is_demo_user')
  const [alert, setAlert] = React.useState({ open: false })
  const [config, setConfig] = React.useState()
  const [updatedConfig, setUpdatedConfig] = React.useState({})
  const [updateable, setUpdateable] = React.useState(false)
  const [discordUrl, setDiscordUrl] = React.useState('')
  const [webhookUrl, setWebhookUrl] = React.useState('')
  const [webhookJson, setWebhookJson] = React.useState('') //needed?
  const [showSteamGridKey, setShowSteamGridKey] = React.useState(false)
  const [relinkOpen, setRelinkOpen] = React.useState(false)
  const [missingMedia, setMissingMedia] = React.useState(null)
  const visibleTabs = React.useMemo(
    () =>
      TAB_DEFS.filter((t) => {
        if (t.admin) return Boolean(isAdmin)
        if (t.perm) return Boolean(isAdmin) || [].concat(t.perm).some((k) => can(k))
        return true
      }),
    [isAdmin, can],
  )

  // Keyed rather than indexed: an index would point at a different pane
  // depending on which tabs this account is allowed to see.
  const [activeTab, setActiveTab] = React.useState(() => (isAdmin ? 'general' : 'security'))

  // If the visible set changes under us (permissions refreshed), fall back to a
  // tab that still exists instead of rendering an empty panel.
  React.useEffect(() => {
    if (visibleTabs.length && !visibleTabs.some((t) => t.key === activeTab)) {
      setActiveTab(visibleTabs[0].key)
    }
  }, [visibleTabs, activeTab])
  // What tone map operators this server's ffmpeg can run, for the HDR default select.
  const [tonemapCaps, setTonemapCaps] = React.useState(null)
  const [transcodingStatus, setTranscodingStatus] = React.useState({
    enabled: false,
    gpu_enabled: false,
    is_running: false,
  })
  const [folderRules, setFolderRules] = React.useState([])
  const [deleteMenuAnchor, setDeleteMenuAnchor] = React.useState(null)
  const [deleteMenuRuleId, setDeleteMenuRuleId] = React.useState(null)
  const [editingFolder, setEditingFolder] = React.useState(null)
  const [imageFolderRules, setImageFolderRules] = React.useState([])
  const [deleteImageMenuAnchor, setDeleteImageMenuAnchor] = React.useState(null)
  const [deleteImageMenuRuleId, setDeleteImageMenuRuleId] = React.useState(null)
  const [editingImageFolder, setEditingImageFolder] = React.useState(null)
  const [folderSubTab, setFolderSubTab] = React.useState(0)
  const isDiscordUsed = discordUrl.trim() !== ''
  const isWebhookUsed = webhookUrl.trim() !== ''

  const handleTestDiscordWebhook = async () => {
    const urlToTest = discordUrl || updatedConfig.integrations?.discord_webhook_url
    if (!urlToTest) {
      setAlert({ open: true, message: 'Please enter a Discord Webhook URL first', type: 'error' })
      return
    }
    try {
      const response = await fetch('/api/test-discord-webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          webhook_url: urlToTest,
          video_url: 'https://fireshare.test.worked',
        }),
      })
      const result = await response.json()
      if (response.ok) {
        setAlert({ open: true, message: 'Discord Test Sent!', type: 'success' })
      } else {
        setAlert({ open: true, message: result.error || 'Discord test failed', type: 'error' })
      }
    } catch (err) {
      console.error('Connection failed:', err)
      setAlert({ open: true, message: 'Network error connecting to server', type: 'error' })
    }
  }

  const handleTestWebhook = async () => {
    let payloadToTest = {}
    try {
      payloadToTest = webhookJson ? JSON.parse(webhookJson) : updatedConfig.integrations?.generic_webhook_payload || {}
    } catch (e) {
      setAlert({ open: true, message: 'Invalid JSON in payload field', type: 'error' })
      return
    }
    const testData = {
      webhook_url: webhookUrl,
      video_url: 'https://fireshare.test.worked',
      payload: payloadToTest,
    }
    if (!webhookUrl) {
      setAlert({ open: true, message: 'Please enter a Webhook URL first', type: 'error' })
      return
    }
    try {
      const response = await fetch('/api/test-webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(testData),
      })

      const result = await response.json()
      if (response.ok) {
        setAlert({ open: true, message: 'Test Webhook Sent!', type: 'success' })
      } else {
        setAlert({ open: true, message: result.error || 'Failed to send test', type: 'error' })
      }
    } catch (err) {
      console.error('Connection failed:', err)
      setAlert({ open: true, message: 'Network error connecting to server', type: 'error' })
    }
  }

  // Only request what this account is allowed to have: the full config and the
  // startup warnings are administrator-only, and folder rules follow
  // manage_games. Asking regardless would just log 403s on every visit for an
  // account that can only open the Security tab.
  //
  // Hoisted out of the effect so they can be its dependencies. They are plain
  // booleans on purpose: `can` is rebuilt on every AuthWrapper render, so
  // depending on the function itself would refetch constantly and overwrite
  // whatever the operator was editing in the form.
  const canSeeConfig = Boolean(isAdmin)
  const canSeeFolderRules = Boolean(isAdmin) || can('manage_games')
  // The Actions buttons answer to two different permissions; showing one the
  // account does not hold would just render a button that 403s.
  const canScanLibrary = Boolean(isAdmin) || can('manage_library')
  const canScanGames = canSeeFolderRules

  // How much the library has lost track of, shown beside the relink action.
  const refreshMissingMedia = React.useCallback(() => {
    LibraryService.relinkStatus()
      .then((res) => setMissingMedia(res.data.missing || null))
      .catch(() => setMissingMedia(null))
  }, [])
  React.useEffect(() => {
    if (activeTab === 'actions' && canScanLibrary) refreshMissingMedia()
  }, [activeTab, canScanLibrary, refreshMissingMedia])

  React.useEffect(() => {
    async function fetch() {
      try {
        const [conf, rulesRes, imageRulesRes] = await Promise.all([
          canSeeConfig ? ConfigService.getAdminConfig() : Promise.resolve(null),
          canSeeFolderRules ? GameService.getFolderRules() : Promise.resolve(null),
          canSeeFolderRules ? GameService.getImageFolderRules() : Promise.resolve(null),
        ])
        // Folder rules first: a curator can open that tab without being an
        // administrator, so they must survive the config early-return below.
        if (rulesRes) setFolderRules(rulesRes.data)
        if (imageRulesRes) setImageFolderRules(imageRulesRes.data)

        if (!conf) return
        setConfig(conf.data)
        setUpdatedConfig(conf.data)
        // Set transcoding enabled/gpu from config (only changes on container restart)
        if (conf.data.transcoding_status) {
          setTranscodingStatus((prev) => ({
            ...prev,
            enabled: conf.data.transcoding_status.enabled,
            gpu_enabled: conf.data.transcoding_status.gpu_enabled,
          }))
          // SSE will provide real-time is_running updates
        }
        await checkForWarnings()
      } catch (err) {
        console.error(err)
      }
    }
    fetch()
    // Refetch if this account's access changes while Settings stays mounted:
    // AuthWrapper rechecks /api/loggedin on a timer and on tab focus.
  }, [canSeeConfig, canSeeFolderRules])

  React.useEffect(() => {
    if (activeTab === 'folders') {
      Promise.all([GameService.getFolderRules(), GameService.getImageFolderRules()])
        .then(([res, imgRes]) => {
          setFolderRules(res.data)
          setImageFolderRules(imgRes.data)
        })
        .catch((err) => console.error(err))
    }
  }, [activeTab])

  React.useEffect(() => {
    if (config && updatedConfig) {
      setUpdateable(!_.isEqual(config, updatedConfig))
    }
  }, [updatedConfig, config])

  // Subscribe to SSE for real-time transcoding status
  React.useEffect(() => {
    if (!transcodingStatus.enabled) return
    return adminSSE.subscribeTranscoding((data) => {
      setTranscodingStatus((prev) => ({ ...prev, is_running: data.is_running }))
    })
  }, [transcodingStatus.enabled])

  React.useEffect(() => {
    if (!transcodingStatus.enabled) return
    VideoService.getTonemapCapabilities()
      .then((res) => setTonemapCaps(res.data))
      .catch(() => setTonemapCaps({ operators: [], auto_default: null }))
  }, [transcodingStatus.enabled])

  React.useEffect(() => {
    if (updatedConfig.integrations?.discord_webhook_url) {
      setDiscordUrl(updatedConfig.integrations.discord_webhook_url)
    }
  }, [updatedConfig])

  React.useEffect(() => {
    if (updatedConfig.integrations) {
      if (updatedConfig.integrations.generic_webhook_url) {
        setWebhookUrl(updatedConfig.integrations.generic_webhook_url)
      }

      if (updatedConfig.integrations.generic_webhook_payload) {
        const jsonString = JSON.stringify(updatedConfig.integrations.generic_webhook_payload, null, 2)
        setWebhookJson(jsonString)
      }
    }
  }, [updatedConfig])

  const handleSave = async () => {
    try {
      await ConfigService.updateConfig(updatedConfig)
      setUpdateable(false)
      setConfig(_.cloneDeep(updatedConfig))
      setSetting('ui_config', updatedConfig.ui_config)
      window.dispatchEvent(new Event('ui_config_updated'))
      setAlert({ open: true, message: 'Settings Updated! Changes may take a minute to take effect.', type: 'success' })
    } catch (err) {
      console.error(err)
      setAlert({ open: true, message: err.response?.data || 'Error saving settings', type: 'error' })
    }
  }

  const handleCopyRssFeedUrl = () => {
    const url = `${window.location.origin}/api/feed/rss`
    navigator.clipboard.writeText(url)
    setAlert({
      open: true,
      type: 'info',
      message: 'URL copied to clipboard',
    })
  }

  const handleScan = async () => {
    try {
      await VideoService.scan()
      setAlert({
        open: true,
        type: 'info',
        message: 'Scan initiated. This could take a few minutes.',
      })
    } catch (err) {
      setAlert({
        open: true,
        type: 'error',
        message: err.response?.data || 'Unknown Error',
      })
    }
  }

  const handleScanImages = async () => {
    try {
      await ImageService.scan()
      setAlert({
        open: true,
        type: 'info',
        message: 'Image scan initiated. This could take a few minutes.',
      })
    } catch (err) {
      setAlert({
        open: true,
        type: 'error',
        message: err.response?.data || 'Unknown Error',
      })
    }
  }

  const handleScanGames = async () => {
    try {
      const response = await VideoService.scanGames()
      if (response.status === 202) {
        // Scan started - GameScanStatus will update via AdminSSE
      }
    } catch (err) {
      if (err.response?.status === 409) {
        setAlert({
          open: true,
          type: 'warning',
          message: 'A game scan is already in progress.',
        })
      } else {
        setAlert({
          open: true,
          type: 'error',
          message: err.response?.data?.error || 'Failed to start game scan',
        })
      }
    }
  }

  const handleScanDates = async () => {
    try {
      const response = await VideoService.scanDates()
      setAlert({
        open: true,
        type: 'success',
        message: `Date scan complete! Extracted ${response.data.dates_extracted} dates from ${response.data.videos_scanned} videos.`,
      })
    } catch (err) {
      setAlert({
        open: true,
        type: 'error',
        message: err.response?.data?.error || 'Failed to scan videos for dates',
      })
    }
  }

  const handleRescanDates = async () => {
    try {
      const response = await VideoService.rescanDates()
      setAlert({
        open: true,
        type: 'success',
        message: 'Date rescan started. This may take a few minutes depending on library size.',
      })
    } catch (err) {
      setAlert({
        open: true,
        type: 'error',
        message: err.response?.data?.error || 'Failed to rescan dates',
      })
    }
  }

  const handleScanFolders = async () => {
    try {
      const response = await VideoService.scanFolders()
      setAlert({
        open: true,
        type: 'success',
        message: `Folder scan complete! ${response.data.reassigned} item(s) reassigned, ${response.data.folders_removed} empty folder(s) removed.`,
      })
    } catch (err) {
      setAlert({
        open: true,
        type: 'error',
        message: err.response?.data?.error || 'Failed to scan folders',
      })
    }
  }

  const handleDeleteFolderRule = async (unlinkVideos = false) => {
    const ruleId = deleteMenuRuleId
    setDeleteMenuAnchor(null)
    setDeleteMenuRuleId(null)
    if (!ruleId) return

    try {
      await GameService.deleteFolderRule(ruleId, unlinkVideos)
      const rulesRes = await GameService.getFolderRules()
      setFolderRules(rulesRes.data)
      setAlert({
        open: true,
        type: 'success',
        message: unlinkVideos ? 'Folder rule deleted and videos unlinked' : 'Folder rule deleted',
      })
    } catch (err) {
      setAlert({
        open: true,
        type: 'error',
        message: err.response?.data?.error || 'Failed to delete folder rule',
      })
    }
  }

  const handleUpdateFolderRule = async (folderPath, game) => {
    try {
      await GameService.createFolderRule(folderPath, game.id)
      const rulesRes = await GameService.getFolderRules()
      setFolderRules(rulesRes.data)
      setEditingFolder(null)
      setAlert({
        open: true,
        type: 'success',
        message: `Updated: ${folderPath} → ${game.name}`,
      })
    } catch (err) {
      setAlert({
        open: true,
        type: 'error',
        message: err.response?.data?.error || 'Failed to update folder rule',
      })
    }
  }

  const handleDeleteImageFolderRule = async (unlinkImages = false) => {
    const ruleId = deleteImageMenuRuleId
    setDeleteImageMenuAnchor(null)
    setDeleteImageMenuRuleId(null)
    if (!ruleId) return

    try {
      await GameService.deleteImageFolderRule(ruleId, unlinkImages)
      const rulesRes = await GameService.getImageFolderRules()
      setImageFolderRules(rulesRes.data)
      setAlert({
        open: true,
        type: 'success',
        message: unlinkImages ? 'Folder rule deleted and images unlinked' : 'Folder rule deleted',
      })
    } catch (err) {
      setAlert({
        open: true,
        type: 'error',
        message: err.response?.data?.error || 'Failed to delete image folder rule',
      })
    }
  }

  const handleUpdateImageFolderRule = async (folderPath, game) => {
    try {
      await GameService.createImageFolderRule(folderPath, game.id)
      const rulesRes = await GameService.getImageFolderRules()
      setImageFolderRules(rulesRes.data)
      setEditingImageFolder(null)
      setAlert({
        open: true,
        type: 'success',
        message: `Updated: ${folderPath} → ${game.name}`,
      })
    } catch (err) {
      setAlert({
        open: true,
        type: 'error',
        message: err.response?.data?.error || 'Failed to update image folder rule',
      })
    }
  }

  const checkForWarnings = async () => {
    let warnings = await WarningService.getAdminWarnings()

    if (Object.keys(warnings.data).length === 0) return

    for (const warning of warnings.data) {
      // Check if this is the SteamGridDB warning
      if (warning.includes('SteamGridDB API key not configured')) {
        setAlert({
          open: true,
          type: 'warning',
          message: (
            <span>
              {warning.replace('Click here to set it up.', '')}
              <a
                href="#steamgrid-settings"
                onClick={(e) => {
                  e.preventDefault()
                  setActiveTab('transcoding')
                  setTimeout(() => {
                    document
                      .getElementById('steamgrid-api-key-field')
                      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    document.getElementById('steamgrid-api-key-field')?.focus()
                  }, 100)
                }}
                style={{ color: '#2684FF', textDecoration: 'underline', cursor: 'pointer', marginLeft: '4px' }}
              >
                Click here to set it up.
              </a>
            </span>
          ),
        })
      } else {
        setAlert({
          open: true,
          type: 'warning',
          message: warning,
        })
      }
      await new Promise((r) => setTimeout(r, 2000)) //Without this a second Warning would instantly overwrite the first...
    }
  }

  return (
    <>
      <SnackbarAlert severity={alert.type} open={alert.open} setOpen={(open) => setAlert({ ...alert, open })}>
        {alert.message}
      </SnackbarAlert>
      <RelinkMovedFilesDialog
        open={relinkOpen}
        onClose={(changed) => {
          setRelinkOpen(false)
          if (changed) refreshMissingMedia()
        }}
        alertHandler={setAlert}
      />
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, maxHeight: 'calc(100vh - 50px)' }}>
        {/* Mobile: select box at top */}
        {isMobile ? (
          <FormControl fullWidth sx={{ px: 2, pt: 2, pb: 1, flexShrink: 0 }}>
            <NativeSelect
              value={activeTab}
              onChange={(e) => setActiveTab(e.target.value)}
              sx={{
                color: 'white',
                fontWeight: 600,
                '& option': { background: '#0a1929' },
                '&::before': { borderColor: 'divider' },
              }}
            >
              {visibleTabs.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.mobileLabel}
                </option>
              ))}
            </NativeSelect>
          </FormControl>
        ) : (
          /* Desktop: Vertical Tabs */
          <Tabs
            orientation="vertical"
            value={activeTab}
            onChange={(_, v) => setActiveTab(v)}
            sx={{
              borderRight: 1,
              borderColor: 'divider',
              minWidth: 160,
              flexShrink: 0,
              '& .MuiTab-root': {
                textTransform: 'none',
                fontWeight: 600,
                alignItems: 'flex-start',
                textAlign: 'left',
              },
            }}
          >
            {visibleTabs.map((t) => (
              <Tab key={t.key} value={t.key} label={t.label} />
            ))}
          </Tabs>
        )}

        {/* Tab Content Panel */}
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            px: { xs: 2, sm: 4 },
            py: 2,
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          {/* fieldset[disabled] propagates to all child inputs/buttons in demo mode */}
          <fieldset
            disabled={demoMode}
            style={{
              border: 'none',
              padding: 0,
              margin: 0,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              overflow: 'hidden',
            }}
          >
            {/* Scrollable content area */}
            <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
              {/* General Settings */}
              {activeTab === 'general' && (
                <Stack spacing={2} sx={{ maxWidth: 500, pt: 2 }}>
                  <Box>
                    <LightTooltip
                      title={updatedConfig.app_config?.video_defaults?.private ? 'Private' : 'Public'}
                      placement="top"
                      enterDelay={500}
                      leaveDelay={500}
                      enterNextDelay={1000}
                    >
                      <ToggleButton
                        size="small"
                        value="check"
                        selected={updatedConfig.app_config?.video_defaults?.private || true}
                        onChange={() => {
                          setUpdatedConfig((prev) => ({
                            ...prev,
                            app_config: {
                              ...prev.app_config,
                              video_defaults: { private: !prev.app_config.video_defaults.private },
                              image_defaults: { private: !prev.app_config.video_defaults.private },
                            },
                          }))
                        }}
                        sx={{ mr: 2 }}
                      >
                        {updatedConfig.app_config?.video_defaults?.private && <VisibilityOffIcon />}
                        {!updatedConfig.app_config?.video_defaults?.private && <VisibilityIcon />}
                      </ToggleButton>
                    </LightTooltip>

                    <Typography variant="overline" sx={{ fontWeight: 700, fontSize: 14 }}>
                      Default Media Privacy
                    </Typography>
                  </Box>
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={updatedConfig.ui_config?.show_admin_upload || false}
                        onChange={(e) =>
                          setUpdatedConfig((prev) => ({
                            ...prev,
                            ui_config: { ...prev.ui_config, show_admin_upload: e.target.checked },
                          }))
                        }
                      />
                    }
                    label="Show Admin Upload Card"
                  />
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={updatedConfig.app_config?.allow_public_upload || false}
                        onChange={(e) =>
                          setUpdatedConfig((prev) => ({
                            ...prev,
                            app_config: { ...prev.app_config, allow_public_upload: e.target.checked },
                          }))
                        }
                      />
                    }
                    label="Allow Public Upload"
                  />
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={updatedConfig.app_config?.allow_public_folder_selection || false}
                        disabled={!updatedConfig.app_config?.allow_public_upload}
                        onChange={(e) =>
                          setUpdatedConfig((prev) => ({
                            ...prev,
                            app_config: { ...prev.app_config, allow_public_folder_selection: e.target.checked },
                          }))
                        }
                      />
                    }
                    label="Allow Public Upload Folder Selection"
                  />
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={updatedConfig.app_config?.allow_public_game_tag || false}
                        disabled={!updatedConfig.app_config?.allow_public_upload}
                        onChange={(e) =>
                          setUpdatedConfig((prev) => ({
                            ...prev,
                            app_config: { ...prev.app_config, allow_public_game_tag: e.target.checked },
                          }))
                        }
                      />
                    }
                    label="Allow Public Game Tagging"
                  />
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={updatedConfig.ui_config?.autoplay || false}
                        onChange={(e) =>
                          setUpdatedConfig((prev) => ({
                            ...prev,
                            ui_config: {
                              ...prev.ui_config,
                              autoplay: e.target.checked,
                            },
                          }))
                        }
                      />
                    }
                    label="Auto Play Videos"
                  />
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={updatedConfig.ui_config?.show_suggestions !== false}
                        onChange={(e) =>
                          setUpdatedConfig((prev) => ({
                            ...prev,
                            ui_config: {
                              ...prev.ui_config,
                              show_suggestions: e.target.checked,
                            },
                          }))
                        }
                      />
                    }
                    label="Show Suggested Videos"
                  />
                  <TextField
                    size="small"
                    label="Shareable Link Domain"
                    value={updatedConfig.ui_config?.shareable_link_domain || ''}
                    onChange={(e) =>
                      setUpdatedConfig((prev) => ({
                        ...prev,
                        ui_config: { ...prev.ui_config, shareable_link_domain: e.target.value },
                      }))
                    }
                  />
                  <TextField
                    size="small"
                    label="Public Upload Folder Name"
                    value={updatedConfig.app_config?.public_upload_folder_name || ''}
                    disabled={!updatedConfig.app_config?.allow_public_upload}
                    onChange={(e) =>
                      setUpdatedConfig((prev) => ({
                        ...prev,
                        app_config: { ...prev.app_config, public_upload_folder_name: e.target.value },
                      }))
                    }
                  />
                  <TextField
                    size="small"
                    label="Admin Upload Folder Name"
                    value={updatedConfig.app_config?.admin_upload_folder_name || ''}
                    onChange={(e) =>
                      setUpdatedConfig((prev) => ({
                        ...prev,
                        app_config: { ...prev.app_config, admin_upload_folder_name: e.target.value },
                      }))
                    }
                  />
                </Stack>
              )}

              {/* Sidebar */}
              {activeTab === 'sidebar' && (
                <Stack spacing={2} sx={{ maxWidth: 500 }}>
                  <SidebarPagesEditor
                    pages={resolveSidebarPages(updatedConfig.ui_config)}
                    onChange={(pages) =>
                      setUpdatedConfig((prev) => ({
                        ...prev,
                        ui_config: { ...prev.ui_config, ...sidebarPagesPatch(pages) },
                      }))
                    }
                  />
                  <Divider sx={{ my: 1 }} />
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={updatedConfig.ui_config?.show_folder_dropdown === true}
                        onChange={(e) =>
                          setUpdatedConfig((prev) => ({
                            ...prev,
                            ui_config: { ...prev.ui_config, show_folder_dropdown: e.target.checked },
                          }))
                        }
                      />
                    }
                    label="Folder Dropdown"
                  />
                </Stack>
              )}

              {/* Integrations */}
              {activeTab === 'integrations' && (
                <Stack spacing={2} sx={{ maxWidth: 500, pt: 2 }}>
                  <header>Notifications</header>
                  <TextField
                    size="small"
                    label="Discord Webhook URL"
                    value={discordUrl}
                    error={discordUrl !== '' && !isValidDiscordWebhook(discordUrl)}
                    helperText={
                      discordUrl !== '' && !isValidDiscordWebhook(discordUrl) ? (
                        'Webhook Format should look like: https://discord.com/api/webhooks/12345/fj8903k'
                      ) : (
                        <span>
                          Get Discord Webhook for you Server Channel -{' '}
                          <a
                            href="https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks"
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: '#2684FF', textDecoration: 'none' }}
                          >
                            Docs
                          </a>
                        </span>
                      )
                    }
                    onChange={(e) => {
                      const url = e.target.value
                      setDiscordUrl(url)
                      setUpdatedConfig((prev) => ({
                        ...prev,
                        integrations: {
                          ...prev.integrations,
                          discord_webhook_url: url,
                        },
                      }))
                    }}
                  />
                  <Button
                    variant="outlined"
                    startIcon={<SendIcon />}
                    onClick={handleTestDiscordWebhook}
                    sx={{
                      borderColor: 'rgba(255, 255, 255, 0.23)',
                      color: '#fff',
                      '&:hover': {
                        borderColor: '#fff',
                        backgroundColor: 'rgba(255, 255, 255, 0.08)',
                      },
                    }}
                  >
                    Test Discord
                  </Button>

                  <Divider />

                  <TextField
                    size="small"
                    label="Generic Webhook URL"
                    value={webhookUrl}
                    error={webhookUrl !== '' && !isValidGenericWebhook(webhookUrl)}
                    helperText={
                      <span>
                        Used for API POST to Generic Webhook Endpoint -{' '}
                        <a
                          href="https://zapier.com/blog/what-are-webhooks/"
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: '#2684FF', textDecoration: 'none' }}
                        >
                          Example
                        </a>
                      </span>
                    }
                    onChange={(e) => {
                      const url = e.target.value
                      setWebhookUrl(url)
                      setUpdatedConfig((prev) => ({
                        ...prev,
                        integrations: {
                          ...prev.integrations,
                          generic_webhook_url: url,
                        },
                      }))
                    }}
                  />
                  <TextField
                    fullWidth
                    multiline
                    rows={6}
                    size="small"
                    label="Generic Webhook JSON Payload"
                    value={webhookJson}
                    placeholder={jsonPlaceholder}
                    error={webhookJson !== '' && !isValidJson(webhookJson)}
                    helperText={
                      webhookJson !== '' && !isValidJson(webhookJson)
                        ? 'Invalid JSON format'
                        : 'Add Valid JSON, with data from the docs of your webhook provider'
                    }
                    onChange={(e) => {
                      const val = e.target.value
                      setWebhookJson(val)
                      if (isValidJson(val)) {
                        setUpdatedConfig((prev) => ({
                          ...prev,
                          integrations: {
                            ...prev.integrations,
                            generic_webhook_payload: JSON.parse(val),
                          },
                        }))
                      }
                    }}
                  />
                  <Button
                    variant="outlined"
                    startIcon={<SendIcon />}
                    onClick={handleTestWebhook}
                    sx={{
                      borderColor: 'rgba(255, 255, 255, 0.23)',
                      color: '#fff',
                      '&:hover': {
                        borderColor: '#fff',
                        backgroundColor: 'rgba(255, 255, 255, 0.08)',
                      },
                    }}
                  >
                    Test Webhook
                  </Button>

                  <Divider />

                  <header>Game Tagging</header>
                  <TextField
                    id="steamgrid-api-key-field"
                    size="small"
                    label="SteamGridDB API Key"
                    type={showSteamGridKey ? 'text' : 'password'}
                    value={updatedConfig.integrations?.steamgriddb_api_key || ''}
                    helperText={
                      <span>
                        Get a free API key at{' '}
                        <a
                          href="https://www.steamgriddb.com/profile/preferences/api"
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: '#2684FF', textDecoration: 'none' }}
                        >
                          SteamGridDB
                        </a>
                      </span>
                    }
                    onChange={(e) => {
                      setUpdatedConfig((prev) => ({
                        ...prev,
                        integrations: {
                          ...prev.integrations,
                          steamgriddb_api_key: e.target.value,
                        },
                      }))
                    }}
                    InputProps={{
                      endAdornment: (
                        <Box
                          sx={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                          onClick={() => setShowSteamGridKey(!showSteamGridKey)}
                        >
                          {showSteamGridKey ? <VisibilityOffIcon /> : <VisibilityIcon />}
                        </Box>
                      ),
                    }}
                  />
                  <Divider />
                  <header>RSS</header>
                  <TextField
                    size="small"
                    label="RSS Feed Title"
                    value={updatedConfig.rss_config?.title || ''}
                    onChange={(e) =>
                      setUpdatedConfig((prev) => ({
                        ...prev,
                        rss_config: { ...(prev.rss_config || {}), title: e.target.value },
                      }))
                    }
                  />
                  <TextField
                    size="small"
                    label="RSS Feed Description"
                    multiline
                    rows={2}
                    value={updatedConfig.rss_config?.description || ''}
                    onChange={(e) =>
                      setUpdatedConfig((prev) => ({
                        ...prev,
                        rss_config: { ...(prev.rss_config || {}), description: e.target.value },
                      }))
                    }
                  />
                  <Button
                    variant="outlined"
                    startIcon={<RssFeedIcon />}
                    fullWidth
                    onClick={handleCopyRssFeedUrl}
                    sx={{ borderColor: 'rgba(255, 255, 255, 0.23)', color: '#fff' }}
                  >
                    Copy RSS Feed URL
                  </Button>
                </Stack>
              )}

              {/* Transcoding */}
              {activeTab === 'transcoding' && (
                <Stack spacing={2} sx={{ maxWidth: 500, pt: 2 }}>
                  <Typography variant="body2" color="text.secondary">
                    Transcoding will convert your videos to multiple quality levels to allow for additional quality
                    selection options when streaming from Fireshare.
                  </Typography>
                  {!transcodingStatus.enabled ? (
                    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                      <Tooltip title="Set ENABLE_TRANSCODING=true in your docker container to enable.">
                        <Chip label="Disabled" color="error" size="small" sx={{ cursor: 'default' }} />
                      </Tooltip>
                    </Box>
                  ) : (
                    <>
                      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center', mb: 1 }}>
                        <Chip label="Enabled" color="success" size="small" />
                        {transcodingStatus.gpu_enabled && <Chip label="GPU Enabled" color="info" size="small" />}
                        {transcodingStatus.is_running && <Chip label="Running" color="warning" size="small" />}
                      </Box>
                      <FormControl fullWidth size="small">
                        <InputLabel variant="standard" htmlFor="encoder-preference">
                          Encoder Preference
                        </InputLabel>
                        <NativeSelect
                          value={updatedConfig.transcoding?.encoder_preference || 'auto'}
                          inputProps={{ id: 'encoder-preference' }}
                          onChange={(e) =>
                            setUpdatedConfig((prev) => ({
                              ...prev,
                              transcoding: { ...prev.transcoding, encoder_preference: e.target.value },
                            }))
                          }
                        >
                          <option value="auto">Auto</option>
                          <option value="h264">H.264</option>
                          <option value="av1">AV1</option>
                        </NativeSelect>
                      </FormControl>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography variant="body2">Resolutions:</Typography>
                        <FormControlLabel
                          control={
                            <Checkbox
                              size="small"
                              checked={updatedConfig.transcoding?.enable_1080p !== false}
                              onChange={(e) =>
                                setUpdatedConfig((prev) => ({
                                  ...prev,
                                  transcoding: { ...prev.transcoding, enable_1080p: e.target.checked },
                                }))
                              }
                            />
                          }
                          label="1080p"
                        />
                        <FormControlLabel
                          control={
                            <Checkbox
                              size="small"
                              checked={updatedConfig.transcoding?.enable_720p !== false}
                              onChange={(e) =>
                                setUpdatedConfig((prev) => ({
                                  ...prev,
                                  transcoding: { ...prev.transcoding, enable_720p: e.target.checked },
                                }))
                              }
                            />
                          }
                          label="720p"
                        />
                        <FormControlLabel
                          control={
                            <Checkbox
                              size="small"
                              checked={updatedConfig.transcoding?.enable_480p !== false}
                              onChange={(e) =>
                                setUpdatedConfig((prev) => ({
                                  ...prev,
                                  transcoding: { ...prev.transcoding, enable_480p: e.target.checked },
                                }))
                              }
                            />
                          }
                          label="480p"
                        />
                      </Box>
                      <FormControlLabel
                        control={
                          <Checkbox
                            size="small"
                            checked={updatedConfig.transcoding?.auto_transcode !== false}
                            onChange={(e) =>
                              setUpdatedConfig((prev) => ({
                                ...prev,
                                transcoding: { ...prev.transcoding, auto_transcode: e.target.checked },
                              }))
                            }
                          />
                        }
                        label="Automatically transcode new videos"
                      />
                      <FormControl fullWidth size="small">
                        <InputLabel variant="standard" htmlFor="tonemap-default">
                          HDR Tone Map
                        </InputLabel>
                        <NativeSelect
                          value={updatedConfig.transcoding?.tonemap_default || 'auto'}
                          inputProps={{ id: 'tonemap-default' }}
                          onChange={(e) =>
                            setUpdatedConfig((prev) => ({
                              ...prev,
                              transcoding: { ...prev.transcoding, tonemap_default: e.target.value },
                            }))
                          }
                        >
                          <option value="auto">
                            Auto{tonemapCaps ? ` (${tonemapCaps.auto_default || 'none available'})` : ''}
                          </option>
                          {(tonemapCaps?.operators || []).map((op) => (
                            <option key={op.id} value={op.id} disabled={!op.available}>
                              {TONEMAP_LABELS[op.id] || op.id}
                              {op.note ? ` – ${op.note}` : ''}
                            </option>
                          ))}
                        </NativeSelect>
                      </FormControl>
                      <Typography variant="caption" sx={{ color: 'text.secondary', mt: -1 }}>
                        The operator used when an HDR video is converted to SDR. Auto picks bt.2390 on a GPU and hable
                        otherwise. Each video can still be compared and changed from its editor.
                      </Typography>
                      <FormControlLabel
                        control={
                          <Checkbox
                            size="small"
                            checked={updatedConfig.transcoding?.auto_tonemap === true}
                            onChange={(e) =>
                              setUpdatedConfig((prev) => ({
                                ...prev,
                                transcoding: { ...prev.transcoding, auto_tonemap: e.target.checked },
                              }))
                            }
                          />
                        }
                        label="Automatically tone map HDR videos to SDR"
                      />
                      <Box sx={{ display: 'flex', gap: 1 }}>
                        {!transcodingStatus.is_running ? (
                          <Button
                            variant="contained"
                            startIcon={<PlayArrowIcon />}
                            onClick={async () => {
                              try {
                                await ConfigService.startTranscoding()
                              } catch (err) {
                                setAlert({
                                  open: true,
                                  message: err.response?.data || 'Failed to start',
                                  type: 'error',
                                })
                              }
                            }}
                            fullWidth
                          >
                            Transcode All Videos
                          </Button>
                        ) : (
                          <Button
                            variant="contained"
                            color="error"
                            startIcon={<StopIcon />}
                            onClick={async () => {
                              try {
                                await ConfigService.cancelTranscoding()
                                window.dispatchEvent(new Event('transcodingCancelled'))
                              } catch (err) {
                                setAlert({
                                  open: true,
                                  message: err.response?.data || 'Failed to cancel',
                                  type: 'error',
                                })
                              }
                            }}
                            fullWidth
                          >
                            Cancel Transcoding
                          </Button>
                        )}
                      </Box>
                    </>
                  )}
                </Stack>
              )}

              {/* Folder Rules */}
              {activeTab === 'folders' && (
                <Stack spacing={2} sx={{ maxWidth: 500, mt: -1 }}>
                  <Tabs
                    value={folderSubTab}
                    onChange={(_, v) => setFolderSubTab(v)}
                    sx={{
                      '& .MuiTab-root': { textTransform: 'none', fontWeight: 600 },
                    }}
                  >
                    <Tab label="Video Folder Rules" />
                    <Tab label="Image Folder Rules" />
                  </Tabs>

                  {/* Video Folder Rules */}
                  {folderSubTab === 0 && (
                    <>
                      <Box sx={{ textAlign: 'center' }}>
                        <Typography variant="body2" color="text.secondary">
                          Videos in these folders will be linked to the selected game. Modify these if your setup is not
                          detected automatically.
                        </Typography>
                      </Box>
                      {folderRules.length === 0 ? (
                        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
                          No shared folders found.
                        </Typography>
                      ) : (
                        <Box sx={{ maxHeight: 800, overflowY: 'auto', pr: 1 }}>
                          <Stack spacing={1}>
                            {folderRules.map((item) => (
                              <Box
                                key={item.folder_path}
                                sx={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  p: 1.5,
                                  borderRadius: '8px',
                                  bgcolor: '#FFFFFF0D',
                                }}
                              >
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flex: 1 }}>
                                  <FolderIcon sx={{ color: '#FFFFFF66' }} />
                                  <Box sx={{ flex: 1 }}>
                                    <Typography sx={{ fontSize: 14, fontWeight: 600, color: 'white' }}>
                                      {item.folder_path}
                                      <Typography component="span" sx={{ fontSize: 12, ml: 1, color: '#FFFFFF55' }}>
                                        ({item.video_count} videos)
                                      </Typography>
                                    </Typography>
                                    {editingFolder === item.folder_path ? (
                                      <Box sx={{ mt: 0.5, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                        <Box sx={{ flex: 1 }}>
                                          <GameSearch
                                            placeholder="Search for a game..."
                                            onGameLinked={(game) => handleUpdateFolderRule(item.folder_path, game)}
                                            onError={() =>
                                              setAlert({ open: true, type: 'error', message: 'Failed to search games' })
                                            }
                                            onWarning={(msg) => setAlert({ open: true, type: 'warning', message: msg })}
                                          />
                                        </Box>
                                        <IconButton
                                          size="small"
                                          onClick={() => setEditingFolder(null)}
                                          sx={{ color: '#FFFFFF66' }}
                                        >
                                          <CloseIcon fontSize="small" />
                                        </IconButton>
                                      </Box>
                                    ) : item.rule ? (
                                      <Typography
                                        sx={{
                                          fontSize: 12,
                                          color: '#3399FF',
                                          cursor: 'pointer',
                                          '&:hover': { textDecoration: 'underline' },
                                        }}
                                        onClick={() => setEditingFolder(item.folder_path)}
                                      >
                                        → {item.rule.game?.name || 'Unknown game'}
                                      </Typography>
                                    ) : item.suggested_game ? (
                                      <Typography
                                        sx={{
                                          fontSize: 12,
                                          color: '#FFB74D',
                                          cursor: 'pointer',
                                          '&:hover': { textDecoration: 'underline' },
                                        }}
                                        onClick={() => handleUpdateFolderRule(item.folder_path, item.suggested_game)}
                                      >
                                        Suggested: {item.suggested_game.name} (click to apply)
                                      </Typography>
                                    ) : (
                                      <Typography
                                        sx={{
                                          fontSize: 12,
                                          color: '#FFFFFF55',
                                          cursor: 'pointer',
                                          '&:hover': { textDecoration: 'underline' },
                                        }}
                                        onClick={() => setEditingFolder(item.folder_path)}
                                      >
                                        No game linked - click to add
                                      </Typography>
                                    )}
                                  </Box>
                                </Box>
                                {item.rule && (
                                  <IconButton
                                    size="small"
                                    onClick={(e) => {
                                      setDeleteMenuAnchor(e.currentTarget)
                                      setDeleteMenuRuleId(item.rule.id)
                                    }}
                                    sx={{ color: '#FFFFFF66' }}
                                  >
                                    <MoreVertIcon fontSize="small" />
                                  </IconButton>
                                )}
                              </Box>
                            ))}
                          </Stack>
                        </Box>
                      )}
                      <Menu
                        anchorEl={deleteMenuAnchor}
                        open={Boolean(deleteMenuAnchor)}
                        onClose={() => {
                          setDeleteMenuAnchor(null)
                          setDeleteMenuRuleId(null)
                        }}
                      >
                        <MenuItem onClick={() => handleDeleteFolderRule(false)}>Delete rule only</MenuItem>
                        <MenuItem onClick={() => handleDeleteFolderRule(true)}>Delete rule & unlink videos</MenuItem>
                      </Menu>
                    </>
                  )}

                  {/* Image Folder Rules */}
                  {folderSubTab === 1 && (
                    <>
                      <Box sx={{ textAlign: 'center' }}>
                        <Typography variant="body2" color="text.secondary">
                          Images in these folders will be linked to the selected game. Modify these if your setup is not
                          detected automatically.
                        </Typography>
                      </Box>
                      {imageFolderRules.length === 0 ? (
                        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
                          No shared folders found.
                        </Typography>
                      ) : (
                        <Box sx={{ maxHeight: 800, overflowY: 'auto', pr: 1 }}>
                          <Stack spacing={1}>
                            {imageFolderRules.map((item) => (
                              <Box
                                key={item.folder_path}
                                sx={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  p: 1.5,
                                  borderRadius: '8px',
                                  bgcolor: '#FFFFFF0D',
                                }}
                              >
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flex: 1 }}>
                                  <ImageIcon sx={{ color: '#FFFFFF66' }} />
                                  <Box sx={{ flex: 1 }}>
                                    <Typography sx={{ fontSize: 14, fontWeight: 600, color: 'white' }}>
                                      {item.folder_path}
                                      <Typography component="span" sx={{ fontSize: 12, ml: 1, color: '#FFFFFF55' }}>
                                        ({item.image_count} images)
                                      </Typography>
                                    </Typography>
                                    {editingImageFolder === item.folder_path ? (
                                      <Box sx={{ mt: 0.5, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                        <Box sx={{ flex: 1 }}>
                                          <GameSearch
                                            placeholder="Search for a game..."
                                            onGameLinked={(game) => handleUpdateImageFolderRule(item.folder_path, game)}
                                            onError={() =>
                                              setAlert({ open: true, type: 'error', message: 'Failed to search games' })
                                            }
                                            onWarning={(msg) => setAlert({ open: true, type: 'warning', message: msg })}
                                          />
                                        </Box>
                                        <IconButton
                                          size="small"
                                          onClick={() => setEditingImageFolder(null)}
                                          sx={{ color: '#FFFFFF66' }}
                                        >
                                          <CloseIcon fontSize="small" />
                                        </IconButton>
                                      </Box>
                                    ) : item.rule ? (
                                      <Typography
                                        sx={{
                                          fontSize: 12,
                                          color: '#3399FF',
                                          cursor: 'pointer',
                                          '&:hover': { textDecoration: 'underline' },
                                        }}
                                        onClick={() => setEditingImageFolder(item.folder_path)}
                                      >
                                        → {item.rule.game?.name || 'Unknown game'}
                                      </Typography>
                                    ) : item.suggested_game ? (
                                      <Typography
                                        sx={{
                                          fontSize: 12,
                                          color: '#FFB74D',
                                          cursor: 'pointer',
                                          '&:hover': { textDecoration: 'underline' },
                                        }}
                                        onClick={() =>
                                          handleUpdateImageFolderRule(item.folder_path, item.suggested_game)
                                        }
                                      >
                                        Suggested: {item.suggested_game.name} (click to apply)
                                      </Typography>
                                    ) : (
                                      <Typography
                                        sx={{
                                          fontSize: 12,
                                          color: '#FFFFFF55',
                                          cursor: 'pointer',
                                          '&:hover': { textDecoration: 'underline' },
                                        }}
                                        onClick={() => setEditingImageFolder(item.folder_path)}
                                      >
                                        No game linked - click to add
                                      </Typography>
                                    )}
                                  </Box>
                                </Box>
                                {item.rule && (
                                  <IconButton
                                    size="small"
                                    onClick={(e) => {
                                      setDeleteImageMenuAnchor(e.currentTarget)
                                      setDeleteImageMenuRuleId(item.rule.id)
                                    }}
                                    sx={{ color: '#FFFFFF66' }}
                                  >
                                    <MoreVertIcon fontSize="small" />
                                  </IconButton>
                                )}
                              </Box>
                            ))}
                          </Stack>
                        </Box>
                      )}
                      <Menu
                        anchorEl={deleteImageMenuAnchor}
                        open={Boolean(deleteImageMenuAnchor)}
                        onClose={() => {
                          setDeleteImageMenuAnchor(null)
                          setDeleteImageMenuRuleId(null)
                        }}
                      >
                        <MenuItem onClick={() => handleDeleteImageFolderRule(false)}>Delete rule only</MenuItem>
                        <MenuItem onClick={() => handleDeleteImageFolderRule(true)}>
                          Delete rule & unlink images
                        </MenuItem>
                      </Menu>
                    </>
                  )}
                </Stack>
              )}

              {/* Actions */}
              {activeTab === 'actions' && (
                <Stack spacing={2} sx={{ maxWidth: 500, pt: 2 }}>
                  {canScanLibrary && (
                    <>
                  <Button
                    variant="contained"
                    startIcon={<SensorsIcon />}
                    onClick={handleScan}
                    size="large"
                    sx={{ width: '100%', maxWidth: 400 }}
                  >
                    Scan for New Videos
                  </Button>
                  <Button
                    variant="contained"
                    startIcon={<ImageIcon />}
                    onClick={handleScanImages}
                    size="large"
                    sx={{ width: '100%', maxWidth: 400 }}
                  >
                    Scan for New Images
                  </Button>
                    </>
                  )}
                  {canScanGames && (
                  <Button
                    variant="contained"
                    startIcon={<SportsEsportsIcon />}
                    onClick={handleScanGames}
                    size="large"
                    sx={{ width: '100%', maxWidth: 400 }}
                  >
                    Scan for Missing Games
                  </Button>
                  )}
                  {canScanLibrary && (
                    <>
                  <Button
                    variant="contained"
                    startIcon={<CalendarMonthIcon />}
                    onClick={handleScanDates}
                    size="large"
                    sx={{ width: '100%', maxWidth: 400 }}
                  >
                    Scan for Missing Dates
                  </Button>
                  <Button
                    variant="contained"
                    startIcon={<FolderCopyIcon />}
                    onClick={handleScanFolders}
                    size="large"
                    sx={{ width: '100%', maxWidth: 400 }}
                  >
                    Scan for Folders
                  </Button>
                  <Button
                    variant="contained"
                    startIcon={<UpdateIcon />}
                    onClick={handleRescanDates}
                    size="large"
                    sx={{ width: '100%', maxWidth: 400 }}
                  >
                    Rescan Image / Video Dates
                  </Button>
                    </>
                  )}
                  {canScanLibrary && (
                    <>
                      <Divider sx={{ width: '100%', maxWidth: 400, my: 1 }} />
                      <Button
                        variant="outlined"
                        startIcon={<SyncAltIcon />}
                        onClick={() => setRelinkOpen(true)}
                        size="large"
                        sx={{ width: '100%', maxWidth: 400 }}
                      >
                        Find Moved Files
                      </Button>
                      <Typography sx={{ fontSize: 13, color: '#B2BAC2', maxWidth: 400, lineHeight: 1.5 }}>
                        {missingMedia && missingMedia.videos + missingMedia.images > 0 ? (
                          <>
                            <Box component="span" sx={{ color: 'white', fontWeight: 600 }}>
                              {missingCountLabel(missingMedia)}
                            </Box>{' '}
                            {missingMedia.videos + missingMedia.images === 1 ? 'is' : 'are'} missing from{' '}
                            {missingMedia.videos + missingMedia.images === 1 ? 'its' : 'their'} last known location.
                            This hashes every file that is not indexed where it sits to find where they went.
                          </>
                        ) : (
                          'Finds videos and images that were moved on disk outside Fireshare and points their records at the new location. Nothing is currently missing.'
                        )}
                      </Typography>
                    </>
                  )}
                </Stack>
              )}

              {/* Security */}
              {activeTab === 'users' && <UserManagement />}

              {activeTab === 'security' && (
                <Stack spacing={4} sx={{ pt: 1 }}>
                  <ChangePassword />
                  <Divider />
                  <SecuritySettings />
                  {/* Only an account that may upload has anything to mint a token for;
                      the routes behind this pane enforce the same permission. */}
                  {(isAdmin || can('upload')) && (
                    <>
                      <Divider />
                      <UploadTokens />
                    </>
                  )}
                </Stack>
              )}
            </Box>

            {/* Save button pinned to bottom */}
            {activeTab !== 'folders' && activeTab !== 'actions' && activeTab !== 'security' && activeTab !== 'users' && (
              <Box sx={{ pt: 2, maxWidth: 500, flexShrink: 0 }}>
                <Divider sx={{ mb: 2 }} />
                <Tooltip title={demoMode ? 'Settings cannot be changed in demo mode' : ''} placement="top">
                  <span>
                    <Button
                      variant="contained"
                      startIcon={<SaveIcon />}
                      disabled={!updateable || (!isValidDiscordWebhook(discordUrl) && isDiscordUsed)}
                      onClick={handleSave}
                      fullWidth
                    >
                      Save Changes
                    </Button>
                  </span>
                </Tooltip>
              </Box>
            )}
          </fieldset>
        </Box>
      </Box>
    </>
  )
}

export default Settings
