import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  InputAdornment,
  Modal,
  Popover,
  Stack,
  TextField,
  Tooltip,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove'
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder'
import SearchIcon from '@mui/icons-material/Search'
import FolderIcon from '@mui/icons-material/Folder'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import LockIcon from '@mui/icons-material/Lock'
import PersonIcon from '@mui/icons-material/Person'
import LockOpenIcon from '@mui/icons-material/LockOpen'
import ContentCutIcon from '@mui/icons-material/ContentCut'
import VideoSettingsIcon from '@mui/icons-material/VideoSettings'
import RefreshIcon from '@mui/icons-material/Refresh'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight'
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline'
import TuneIcon from '@mui/icons-material/Tune'
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import Select from 'react-select'
import { folderSelectTheme as selectFolderTheme } from '../../common/reactSelectThemes'
import MarqueeSingleValue, { MarqueeOption } from '../ui/MarqueeSingleValue'
import OutlinedIconButton from '../ui/OutlinedIconButton'
import FolderPrivacyToggle from './FolderPrivacyToggle'
import FolderLinkActions from './FolderLinkActions'
import { dialogPaperSx, dialogTitleSx, inputSx, labelSx, rowBoxSx } from '../../common/modalStyles'
import Api from '../../services/Api'
import {
  formatSize,
  formatTableDate,
  formatDuration,
  formatResolution,
  uploaderLabel,
  uploaderOptionLabel,
  uploaderSortKey,
} from '../../common/utils'
import UploaderMention from '../user/UploaderMention'
import UploaderPicker from '../user/UploaderPicker'

function sortFiles(files, column, dir) {
  const sorted = [...files]
  const mul = dir === 'asc' ? 1 : -1
  switch (column) {
    case 'name':
      return sorted.sort((a, b) => mul * (a.title || a.filename).localeCompare(b.title || b.filename))
    case 'size':
      return sorted.sort((a, b) => mul * ((a.size || 0) - (b.size || 0)))
    case 'total_size':
      return sorted.sort(
        (a, b) => mul * ((a.size || 0) + (a.derived_size || 0) - ((b.size || 0) + (b.derived_size || 0))),
      )
    case 'duration':
      return sorted.sort((a, b) => mul * ((a.duration || 0) - (b.duration || 0)))
    case 'uploader':
      return sorted.sort((a, b) => mul * uploaderSortKey(a.uploader).localeCompare(uploaderSortKey(b.uploader)))
    case 'date':
      return sorted.sort((a, b) => mul * (new Date(a.created_at || 0) - new Date(b.created_at || 0)))
    default:
      return sorted
  }
}

const headCellSx = {
  color: '#FFFFFF99',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  borderBottom: '1px solid #FFFFFF18',
  bgcolor: '#0e233a',
  py: 1.25,
  whiteSpace: 'nowrap',
}

const bodyCellSx = {
  borderBottom: '1px solid #FFFFFF0D',
  py: 0.75,
  fontSize: 13,
  color: '#FFFFFFCC',
}

const folderRowSx = {
  bgcolor: '#FFFFFF06',
  borderTop: '2px solid #FFFFFF1E',
  '&:first-of-type': { borderTop: 'none' },
}

// Columns that can be toggled visible/hidden
const TOGGLEABLE_COLUMNS = [
  'Duration',
  'Resolution',
  'Transcodes',
  'Cropped',
  'Privacy',
  'Password',
  'Uploader',
  'Date',
  'Total Size',
]

function smartClean(title) {
  let result = title || ''
  // Replace non-alphanumeric characters (except spaces) with spaces to split tokens
  result = result.replace(/[^a-zA-Z0-9 ]/g, ' ')
  // Collapse multiple spaces and trim
  result = result.replace(/\s+/g, ' ').trim()
  // Split into tokens, then strip all leading and trailing purely-numeric tokens
  // e.g. "2024 01 15 Warzone Clip" → strip "2024", "01", "15" from front
  // but "Warzone 2 Clip" keeps "2" because it's not at the boundary
  let tokens = result.split(' ')
  while (tokens.length > 0 && /^\d+$/.test(tokens[0])) tokens.shift()
  while (tokens.length > 0 && /^\d+$/.test(tokens[tokens.length - 1])) tokens.pop()
  result = tokens.join(' ').trim()
  // Title case: capitalize first letter of each word
  result = result.replace(/\b\w/g, (c) => c.toUpperCase())
  return result
}

function applyRenameOperation(title, op, find, replace, prefix, suffix) {
  let result = title || ''
  if (op === 'find_replace') {
    if (find) result = result.split(find).join(replace || '')
  } else if (op === 'strip_prefix') {
    if (prefix && result.startsWith(prefix)) result = result.slice(prefix.length)
  } else if (op === 'strip_suffix') {
    if (suffix && result.endsWith(suffix)) result = result.slice(0, -suffix.length)
  } else if (op === 'smart_clean') {
    result = smartClean(result)
  }
  return result
}

const VideoFileRow = React.memo(function VideoFileRow({ file, isSelected, onToggle, hiddenColumns }) {
  const displayName = file.title || file.filename
  const hasTranscodes = file.has_480p || file.has_720p || file.has_1080p
  return (
    <TableRow
      hover
      selected={isSelected}
      onClick={() => onToggle(file.video_id)}
      sx={{
        cursor: 'pointer',
        bgcolor: isSelected ? '#3399FF14' : 'transparent',
        '&:hover': { bgcolor: isSelected ? '#3399FF1E' : '#FFFFFF08' },
        '&.Mui-selected': { bgcolor: '#3399FF14' },
        '&.Mui-selected:hover': { bgcolor: '#3399FF1E' },
      }}
    >
      {/* Checkbox */}
      <TableCell
        padding="checkbox"
        sx={{ borderBottom: '1px solid #FFFFFF0D' }}
        onClick={(e) => {
          e.stopPropagation()
          onToggle(file.video_id)
        }}
      >
        <Checkbox
          size="small"
          checked={isSelected}
          onChange={() => {}}
          sx={{ color: '#FFFFFF44', '&.Mui-checked': { color: '#3399FF' } }}
        />
      </TableCell>

      {/* Privacy spacer */}
      <TableCell padding="checkbox" sx={{ ...bodyCellSx }} />

      {/* Name */}
      <TableCell sx={{ ...bodyCellSx, maxWidth: 300, overflow: 'hidden' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, overflow: 'hidden' }}>
          <Tooltip title={displayName} placement="top" enterDelay={600}>
            <Typography
              sx={{
                fontSize: 13,
                color: '#FFFFFFCC',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}
            >
              {displayName}
            </Typography>
          </Tooltip>
          <Tooltip title="Open in new tab">
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation()
                window.open(`/w/${file.video_id}`, '_blank')
              }}
              sx={{ color: '#FFFFFF33', p: 0.25, flexShrink: 0, '&:hover': { color: '#FFFFFF99' } }}
            >
              <OpenInNewIcon sx={{ fontSize: 13 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </TableCell>

      {/* Size */}
      <TableCell sx={{ ...bodyCellSx }}>
        <Tooltip
          arrow
          placement="top"
          title={
            file.derived_size > 0 ? (
              <Box>
                <Typography sx={{ fontSize: 12 }}>Derived: {formatSize(file.derived_size)}</Typography>
                <Typography sx={{ fontSize: 12 }}>
                  Total: {formatSize((file.size || 0) + (file.derived_size || 0))}
                </Typography>
              </Box>
            ) : (
              ''
            )
          }
        >
          <Typography sx={{ fontSize: 12, color: '#FFFFFF77' }}>{formatSize(file.size)}</Typography>
        </Tooltip>
      </TableCell>

      {/* Total Size */}
      {!hiddenColumns.has('Total Size') && (
        <TableCell sx={{ ...bodyCellSx }}>
          <Typography sx={{ fontSize: 12, color: '#FFFFFF77' }}>
            {formatSize((file.size || 0) + (file.derived_size || 0))}
          </Typography>
        </TableCell>
      )}

      {/* Duration */}
      {!hiddenColumns.has('Duration') && (
        <TableCell sx={{ ...bodyCellSx }}>
          <Typography sx={{ fontSize: 12, color: '#FFFFFF77' }}>{formatDuration(file.duration)}</Typography>
        </TableCell>
      )}

      {/* Resolution */}
      {!hiddenColumns.has('Resolution') && (
        <TableCell sx={{ ...bodyCellSx }}>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Chip
              label={formatResolution(file.width, file.height)}
              size="small"
              sx={{
                height: 17,
                fontSize: 10,
                bgcolor: '#FFFFFF12',
                color: '#FFFFFF66',
                '& .MuiChip-label': { px: 0.75 },
              }}
            />
          </Box>
        </TableCell>
      )}

      {/* Transcodes */}
      {!hiddenColumns.has('Transcodes') && (
        <TableCell sx={{ ...bodyCellSx }}>
          {hasTranscodes ? (
            <Box sx={{ display: 'flex', gap: 0.4, flexWrap: 'wrap' }}>
              {file.has_1080p && (
                <Chip
                  label="1080p"
                  size="small"
                  sx={{
                    height: 17,
                    fontSize: 10,
                    bgcolor: '#FFFFFF12',
                    color: '#FFFFFF66',
                    '& .MuiChip-label': { px: 0.75 },
                  }}
                />
              )}
              {file.has_720p && (
                <Chip
                  label="720p"
                  size="small"
                  sx={{
                    height: 17,
                    fontSize: 10,
                    bgcolor: '#FFFFFF12',
                    color: '#FFFFFF66',
                    '& .MuiChip-label': { px: 0.75 },
                  }}
                />
              )}
              {file.has_480p && (
                <Chip
                  label="480p"
                  size="small"
                  sx={{
                    height: 17,
                    fontSize: 10,
                    bgcolor: '#FFFFFF12',
                    color: '#FFFFFF66',
                    '& .MuiChip-label': { px: 0.75 },
                  }}
                />
              )}
            </Box>
          ) : (
            <Typography sx={{ fontSize: 11, color: '#FFFFFF33' }}>—</Typography>
          )}
        </TableCell>
      )}

      {/* Cropped */}
      {!hiddenColumns.has('Cropped') && (
        <TableCell sx={{ ...bodyCellSx }}>
          {file.has_crop || file.is_hdr ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              {file.has_crop && (
                <Chip
                  label="Cropped"
                  size="small"
                  sx={{
                    height: 17,
                    fontSize: 10,
                    bgcolor: '#FF990018',
                    color: '#FF9900BB',
                    border: '1px solid #FF990033',
                    '& .MuiChip-label': { px: 0.75 },
                  }}
                />
              )}
              {file.is_hdr && (
                <Chip
                  label={file.has_sdr ? 'SDR' : 'HDR'}
                  title={
                    file.has_sdr
                      ? `Tone mapped to SDR (${file.tonemap})`
                      : file.tonemap
                        ? 'HDR, converting to SDR'
                        : 'HDR source, plays as stored'
                  }
                  size="small"
                  sx={{
                    height: 17,
                    fontSize: 10,
                    bgcolor: file.has_sdr ? '#1DB95418' : '#F0824A18',
                    color: file.has_sdr ? '#1DB954' : '#F0824ABB',
                    border: `1px solid ${file.has_sdr ? '#1DB95433' : '#F0824A33'}`,
                    '& .MuiChip-label': { px: 0.75 },
                  }}
                />
              )}
            </Box>
          ) : (
            <Typography sx={{ fontSize: 11, color: '#FFFFFF33' }}>—</Typography>
          )}
        </TableCell>
      )}

      {/* Privacy */}
      {!hiddenColumns.has('Privacy') && (
        <TableCell sx={{ ...bodyCellSx }}>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Chip
              label={file.private ? 'Private' : 'Public'}
              size="small"
              sx={{
                height: 17,
                fontSize: 10,
                bgcolor: file.private ? '#FFFFFF12' : '#1DB95418',
                color: file.private ? '#FFFFFF66' : '#1DB954',
                border: '1px solid',
                borderColor: file.private ? '#FFFFFF22' : '#1DB95433',
                '& .MuiChip-label': { px: 0.75 },
              }}
            />
          </Box>
        </TableCell>
      )}

      {/* Password */}
      {!hiddenColumns.has('Password') && (
        <TableCell sx={{ ...bodyCellSx }}>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            {file.has_password ? (
              <LockIcon sx={{ fontSize: 14, color: '#FFFFFF66' }} />
            ) : (
              <Typography sx={{ fontSize: 11, color: '#FFFFFF33' }}>—</Typography>
            )}
          </Box>
        </TableCell>
      )}

      {/* Uploader */}
      {!hiddenColumns.has('Uploader') && (
        <TableCell sx={{ ...bodyCellSx, maxWidth: 170, overflow: 'hidden' }}>
          {file.uploader ? (
            <UploaderMention uploader={file.uploader} size={16} />
          ) : (
            <Typography sx={{ fontSize: 11, color: '#FFFFFF33' }}>Unattributed</Typography>
          )}
        </TableCell>
      )}

      {/* Date */}
      {!hiddenColumns.has('Date') && (
        <TableCell sx={{ ...bodyCellSx }}>
          <Tooltip title={file.recorded_at ? `Recorded: ${formatTableDate(file.recorded_at)}` : ''} placement="top">
            <Typography sx={{ fontSize: 12, color: '#FFFFFF55' }}>{formatTableDate(file.created_at)}</Typography>
          </Tooltip>
        </TableCell>
      )}
    </TableRow>
  )
})

export default function VideoFileManager({ setAlert }) {
  const theme = useTheme()
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'))
  // Helper function to check if a folder is protected from deletion
  const isProtectedFolder = (folderName) => {
    const protectedFolders = ['uploads', 'public uploads']
    return protectedFolders.includes((folderName || '').toLowerCase())
  }

  const [files, setFiles] = useState([])
  const [folders, setFolders] = useState([])
  const [loading, setLoading] = useState(true)

  const [search, setSearch] = useState('')
  const [folderFilter, setFolderFilter] = useState('__all__')
  const [gameFilter, setGameFilter] = useState('__all__')
  // '__all__', '__none__' for unattributed, or a username.
  const [uploaderFilter, setUploaderFilter] = useState('__all__')
  const [sortColumn, setSortColumn] = useState('date')
  const [sortDir, setSortDir] = useState('desc')

  const [selected, setSelected] = useState(new Set())
  const [selectedFolders, setSelectedFolders] = useState(new Set())
  const [collapsedFolders, setCollapsedFolders] = useState(new Set())
  const [hiddenColumns, setHiddenColumns] = useState(new Set())

  const toggleFolderCollapse = (folder) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      next.has(folder) ? next.delete(folder) : next.add(folder)
      return next
    })
  }

  // Dialog / modal open states
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [moveModalOpen, setMoveModalOpen] = useState(false)
  const [createFolderDialogOpen, setCreateFolderDialogOpen] = useState(false)
  const [removeTranscodesDialogOpen, setRemoveTranscodesDialogOpen] = useState(false)
  const [removeCropDialogOpen, setRemoveCropDialogOpen] = useState(false)
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [orphanDialogOpen, setOrphanDialogOpen] = useState(false)
  const [setPasswordDialogOpen, setSetPasswordDialogOpen] = useState(false)
  const [uploaderDialogOpen, setUploaderDialogOpen] = useState(false)
  const [uploaderChoice, setUploaderChoice] = useState(null)
  const [removePasswordDialogOpen, setRemovePasswordDialogOpen] = useState(false)
  const [bulkPasswordInput, setBulkPasswordInput] = useState('')
  const [colVisAnchor, setColVisAnchor] = useState(null)

  // Orphan state
  const [orphans, setOrphans] = useState([])
  const [orphanLoading, setOrphanLoading] = useState(false)

  // Rename form state
  const [renameOp, setRenameOp] = useState({ value: 'find_replace', label: 'Find & Replace' })
  const [renameFind, setRenameFind] = useState('')
  const [renameReplace, setRenameReplace] = useState('')
  const [renamePrefix, setRenamePrefix] = useState('')
  const [renameSuffix, setRenameSuffix] = useState('')

  // Form state
  const [moveTargetFolder, setMoveTargetFolder] = useState(null)
  const [newFolderName, setNewFolderName] = useState('')
  const [actionLoading, setActionLoading] = useState(false)

  const fetchFiles = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await Api().get('/api/admin/files')
      setFiles(data.files || [])
      setFolders(data.folders || [])
      setCollapsedFolders((prev) => {
        if (prev.size > 0) return prev
        const allFolderKeys = new Set((data.files || []).map((f) => f.folder || ''))
        ;(data.folders || []).forEach((f) => allFolderKeys.add(f))
        return allFolderKeys
      })
    } catch (err) {
      console.error(err)
      setAlert({ open: true, message: err.response?.data || 'Failed to load files', type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [setAlert])

  useEffect(() => {
    fetchFiles()
  }, [fetchFiles])

  const uniqueGames = useMemo(() => {
    const games = [...new Set(files.map((f) => f.game).filter(Boolean))].sort()
    return games
  }, [files])

  // Derived from the files themselves rather than /api/admin/uploaders: the
  // filter should only offer accounts that actually have videos here, and the
  // count then cannot disagree with what the table is showing.
  const uniqueUploaders = useMemo(() => {
    const byUsername = new Map()
    for (const f of files) {
      if (f.uploader?.username && !byUsername.has(f.uploader.username)) {
        byUsername.set(f.uploader.username, f.uploader)
      }
    }
    return [...byUsername.values()].sort((a, b) => uploaderSortKey(a).localeCompare(uploaderSortKey(b)))
  }, [files])

  const unattributedCount = useMemo(() => files.filter((f) => !f.uploader).length, [files])

  const uploaderFilterOptions = useMemo(
    () => [
      { value: '__all__', label: 'All Uploaders' },
      ...(unattributedCount > 0 ? [{ value: '__none__', label: 'Unattributed' }] : []),
      ...uniqueUploaders.map((u) => ({ value: u.username, label: uploaderOptionLabel(u) })),
    ],
    [uniqueUploaders, unattributedCount],
  )

  const uploaderFilterValue = useMemo(
    () => uploaderFilterOptions.find((o) => o.value === uploaderFilter) || uploaderFilterOptions[0],
    [uploaderFilterOptions, uploaderFilter],
  )

  // One-click route into the job this column exists for: how much of the library
  // still has no owner, and a jump straight to it.
  const unattributedActive = uploaderFilter === '__none__'
  const unattributedChip =
    unattributedCount > 0 ? (
      <Tooltip title={unattributedActive ? 'Show every uploader again' : 'Show only videos with no uploader'}>
        <Chip
          size="small"
          icon={<PersonIcon sx={{ fontSize: 14, color: 'inherit !important' }} />}
          label={`${unattributedCount} unattributed`}
          onClick={() => setUploaderFilter(unattributedActive ? '__all__' : '__none__')}
          sx={{
            height: 28,
            fontSize: 12,
            cursor: 'pointer',
            bgcolor: unattributedActive ? '#3399FF22' : '#FFFFFF0D',
            color: unattributedActive ? '#66B2FF' : '#FFFFFF88',
            border: '1px solid',
            borderColor: unattributedActive ? '#3399FF66' : '#FFFFFF1E',
            '&:hover': { bgcolor: unattributedActive ? '#3399FF30' : '#FFFFFF16' },
          }}
        />
      </Tooltip>
    ) : null

  const filteredFiles = useMemo(() => {
    let result = files

    if (folderFilter !== '__all__') {
      result = result.filter((f) => f.folder === folderFilter)
    }

    if (gameFilter !== '__all__') {
      result = result.filter((f) => f.game === gameFilter)
    }

    if (uploaderFilter === '__none__') {
      result = result.filter((f) => !f.uploader)
    } else if (uploaderFilter !== '__all__') {
      result = result.filter((f) => f.uploader?.username === uploaderFilter)
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter(
        (f) =>
          (f.title || '').toLowerCase().includes(q) ||
          (f.filename || '').toLowerCase().includes(q) ||
          uploaderLabel(f.uploader).toLowerCase().includes(q) ||
          (f.uploader?.username || '').toLowerCase().includes(q),
      )
    }

    return sortFiles(result, sortColumn, sortDir)
  }, [files, folderFilter, gameFilter, uploaderFilter, search, sortColumn, sortDir])

  // Group files by folder — always include every known folder, even empty ones
  const groupedFiles = useMemo(() => {
    const filesByFolder = new Map()
    for (const f of filteredFiles) {
      const key = f.folder || ''
      if (!filesByFolder.has(key)) filesByFolder.set(key, [])
      filesByFolder.get(key).push(f)
    }

    if (folderFilter !== '__all__') {
      return [[folderFilter, filesByFolder.get(folderFilter) || []]]
    }

    // Include empty folders only when no filters are active (search/game/uploader filters would hide them anyway)
    const includeEmpty = !search.trim() && gameFilter === '__all__' && uploaderFilter === '__all__'
    const allFolders = includeEmpty ? [...new Set([...folders, ...filesByFolder.keys()])] : [...filesByFolder.keys()]

    // Build [folder, files] pairs then sort folder groups by the "best" file
    // in each group according to the active sort, so that folder order reflects
    // the same sort the user applied (empty folders always go last alphabetically)
    const pairs = allFolders.map((f) => [f, filesByFolder.get(f) || []])
    pairs.sort(([aFolder, aFiles], [bFolder, bFiles]) => {
      if (aFiles.length === 0 && bFiles.length === 0) return aFolder.localeCompare(bFolder)
      if (aFiles.length === 0) return 1
      if (bFiles.length === 0) return -1
      // Each folder's files are already sorted; [0] is the "best" per sort dir
      const a = aFiles[0]
      const b = bFiles[0]
      const mul = sortDir === 'asc' ? 1 : -1
      switch (sortColumn) {
        case 'name': {
          const an = (a.title || a.filename || '').toLowerCase()
          const bn = (b.title || b.filename || '').toLowerCase()
          return mul * an.localeCompare(bn)
        }
        case 'size':
          return mul * ((a.size || 0) - (b.size || 0))
        case 'total_size':
          return mul * ((a.size || 0) + (a.derived_size || 0) - ((b.size || 0) + (b.derived_size || 0)))
        case 'duration':
          return mul * ((a.duration || 0) - (b.duration || 0))
        case 'uploader':
          return mul * uploaderSortKey(a.uploader).localeCompare(uploaderSortKey(b.uploader))
        case 'date':
          return mul * (new Date(a.created_at || 0) - new Date(b.created_at || 0))
        default:
          return aFolder.localeCompare(bFolder)
      }
    })
    return pairs
  }, [filteredFiles, folders, folderFilter, sortColumn, sortDir, search, gameFilter, uploaderFilter])

  const filteredIds = useMemo(() => new Set(filteredFiles.map((f) => f.video_id)), [filteredFiles])

  const allFilteredSelected = filteredFiles.length > 0 && filteredFiles.every((f) => selected.has(f.video_id))

  const someFilteredSelected = filteredFiles.some((f) => selected.has(f.video_id)) && !allFilteredSelected

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelected((prev) => {
        const next = new Set(prev)
        filteredIds.forEach((id) => next.delete(id))
        return next
      })
    } else {
      setSelected((prev) => {
        const next = new Set(prev)
        filteredIds.forEach((id) => next.add(id))
        return next
      })
    }
  }

  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const toggleSelectFolder = useCallback((folderName) => {
    setSelectedFolders((prev) => {
      const next = new Set(prev)
      next.has(folderName) ? next.delete(folderName) : next.add(folderName)
      return next
    })
  }, [])

  const selectedCount = selected.size + selectedFolders.size

  const onlyEmptyFoldersSelected = useMemo(
    () =>
      selected.size === 0 &&
      selectedFolders.size > 0 &&
      [...selectedFolders].every((f) => {
        const pair = groupedFiles.find(([folder]) => folder === f)
        return !pair || pair[1].length === 0
      }),
    [selected, selectedFolders, groupedFiles],
  )

  const handleSort = (column) => {
    if (sortColumn === column) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortColumn(column)
      setSortDir('desc')
    }
  }

  const selectedFiles = useMemo(() => files.filter((f) => selected.has(f.video_id)), [files, selected])

  const uniqueCurrentFolders = useMemo(
    () => new Set(selectedFiles.map((f) => f.folder).filter(Boolean)),
    [selectedFiles],
  )

  const moveFolderOptions = useMemo(() => {
    let opts = folders
    if (uniqueCurrentFolders.size === 1) {
      const cur = [...uniqueCurrentFolders][0]
      opts = folders.filter((f) => f !== cur)
    }
    return opts.map((f) => ({ value: f, label: `/videos/${f}/` }))
  }, [folders, uniqueCurrentFolders])

  const runBulkAction = useCallback(
    async (endpoint, body, successMsg) => {
      setActionLoading(true)
      try {
        const { data } = await Api().post(endpoint, body)
        const updatedCount = data.updated_videos ?? (data.updated ?? data.moved ?? data.deleted ?? []).length
        const errorCount = (data.errors ?? []).length
        if (errorCount > 0) {
          setAlert({
            open: true,
            message: `${successMsg}: ${updatedCount} succeeded, ${errorCount} error${errorCount !== 1 ? 's' : ''}`,
            type: 'warning',
          })
        } else {
          setAlert({ open: true, message: `${successMsg} (${updatedCount})`, type: 'success' })
        }
        setSelected(new Set())
        await fetchFiles()
        return true
      } catch (err) {
        console.error(err)
        setAlert({ open: true, message: err.response?.data || 'Action failed', type: 'error' })
        return false
      } finally {
        setActionLoading(false)
      }
    },
    [fetchFiles, setAlert],
  )

  const handleDelete = async () => {
    setActionLoading(true)
    try {
      const errors = []
      let deletedFiles = 0
      let deletedFolders = 0

      if (selected.size > 0) {
        const { data } = await Api().post('/api/admin/files/bulk-delete', { video_ids: [...selected] })
        deletedFiles = (data.deleted ?? []).length
        errors.push(...(data.errors ?? []))
      }

      if (selectedFolders.size > 0) {
        const { data } = await Api().post('/api/admin/folders/delete', { folders: [...selectedFolders] })
        deletedFolders = (data.deleted ?? []).length
        errors.push(...(data.errors ?? []))
      }

      const parts = []
      if (deletedFiles > 0) parts.push(`${deletedFiles} file${deletedFiles !== 1 ? 's' : ''}`)
      if (deletedFolders > 0) parts.push(`${deletedFolders} folder${deletedFolders !== 1 ? 's' : ''}`)
      const successMsg = parts.length > 0 ? `Deleted ${parts.join(' and ')}` : ''

      if (errors.length > 0) {
        const errorMsgs = [...new Set(errors.map((e) => e.error || 'Unknown error'))]
        const errorDetail = errorMsgs.join('; ')
        const message = successMsg ? `${successMsg} — ${errorDetail}` : errorDetail
        setAlert({ open: true, message, type: 'warning' })
      } else {
        setAlert({ open: true, message: successMsg || 'Nothing deleted', type: 'success' })
      }

      setSelected(new Set())
      setSelectedFolders(new Set())
      setDeleteDialogOpen(false)
      await fetchFiles()
    } catch (err) {
      console.error(err)
      setAlert({ open: true, message: err.response?.data || 'Delete failed', type: 'error' })
    } finally {
      setActionLoading(false)
    }
  }

  const handleMove = async () => {
    if (!moveTargetFolder) return
    setActionLoading(true)
    try {
      const { data } = await Api().post('/api/admin/files/bulk-move', {
        video_ids: [...selected],
        folder: moveTargetFolder.value,
      })
      const movedCount = (data.moved ?? []).length
      const errorCount = (data.errors ?? []).length
      if (errorCount > 0) {
        setAlert({
          open: true,
          message: `Moved ${movedCount}, ${errorCount} error${errorCount !== 1 ? 's' : ''}`,
          type: 'warning',
        })
      } else {
        setAlert({
          open: true,
          message: `Moved ${movedCount} file${movedCount !== 1 ? 's' : ''} to "${moveTargetFolder.value}"`,
          type: 'success',
        })
      }
      setSelected(new Set())
      setMoveModalOpen(false)
      setMoveTargetFolder(null)
      await fetchFiles()
    } catch (err) {
      setAlert({ open: true, message: err.response?.data || 'Move failed', type: 'error' })
    } finally {
      setActionLoading(false)
    }
  }

  const handleRemoveTranscodes = async () => {
    const ok = await runBulkAction(
      '/api/admin/files/bulk-remove-transcodes',
      { video_ids: [...selected] },
      'Removed transcodes',
    )
    if (ok) setRemoveTranscodesDialogOpen(false)
  }

  const handleRemoveCrop = async () => {
    const ok = await runBulkAction('/api/admin/files/bulk-remove-crop', { video_ids: [...selected] }, 'Removed crop')
    if (ok) setRemoveCropDialogOpen(false)
  }

  const handleSetUploader = async () => {
    const ok = await runBulkAction(
      '/api/admin/files/bulk-set-uploader',
      { video_ids: [...selected], username: uploaderChoice },
      uploaderChoice ? `Attributed to ${uploaderChoice}` : 'Uploader cleared',
    )
    if (ok) setUploaderDialogOpen(false)
  }

  const handleSetPrivacy = async (isPrivate) => {
    await runBulkAction(
      '/api/admin/files/bulk-set-privacy',
      { video_ids: [...selected], private: isPrivate },
      isPrivate ? 'Set to private' : 'Set to public',
    )
  }

  const handleBulkSetPassword = async () => {
    const ok = await runBulkAction(
      '/api/admin/files/bulk-set-password',
      { video_ids: [...selected], password: bulkPasswordInput.trim() },
      'Password set',
    )
    if (ok) {
      setSetPasswordDialogOpen(false)
      setBulkPasswordInput('')
    }
  }

  const handleBulkRemovePassword = async () => {
    const ok = await runBulkAction(
      '/api/admin/files/bulk-remove-password',
      { video_ids: [...selected] },
      'Password removed',
    )
    if (ok) setRemovePasswordDialogOpen(false)
  }

  const handleCreateFolder = async () => {
    const name = newFolderName.trim()
    if (!name) return
    setActionLoading(true)
    try {
      await Api().post('/api/admin/folders/create', { name })
      setAlert({ open: true, message: `Folder "${name}" created`, type: 'success' })
      setNewFolderName('')
      setCreateFolderDialogOpen(false)
      await fetchFiles()
    } catch (err) {
      setAlert({ open: true, message: err.response?.data || 'Failed to create folder', type: 'error' })
    } finally {
      setActionLoading(false)
    }
  }

  const handleBulkRename = async () => {
    const renames = selectedFiles.map((f) => {
      const currentTitle = f.title || f.filename || ''
      const newTitle = applyRenameOperation(
        currentTitle,
        renameOp.value,
        renameFind,
        renameReplace,
        renamePrefix,
        renameSuffix,
      )
      return { video_id: f.video_id, title: newTitle }
    })
    const ok = await runBulkAction('/api/admin/files/bulk-rename', { renames }, 'Renamed files')
    if (ok) setRenameDialogOpen(false)
  }

  const handleCheckOrphans = async () => {
    setOrphanLoading(true)
    try {
      const { data } = await Api().get('/api/admin/files/orphaned-derived')
      const found = data.orphans || []
      if (found.length === 0) {
        setAlert({ open: true, message: 'No orphaned derived folders found', type: 'info' })
      } else {
        setOrphans(found)
        setOrphanDialogOpen(true)
      }
    } catch (err) {
      setAlert({ open: true, message: err.response?.data || 'Failed to check orphans', type: 'error' })
    } finally {
      setOrphanLoading(false)
    }
  }

  const handleCleanupOrphans = async () => {
    setOrphanLoading(true)
    try {
      const { data } = await Api().post('/api/admin/files/cleanup-orphaned-derived')
      const deletedCount = (data.deleted || []).length
      const errorCount = (data.errors || []).length
      if (errorCount > 0) {
        setAlert({
          open: true,
          message: `Cleaned ${deletedCount} orphan${deletedCount !== 1 ? 's' : ''}, ${errorCount} error${errorCount !== 1 ? 's' : ''}`,
          type: 'warning',
        })
      } else {
        setAlert({
          open: true,
          message: `Cleaned up ${deletedCount} orphaned derived folder${deletedCount !== 1 ? 's' : ''}`,
          type: 'success',
        })
      }
      setOrphanDialogOpen(false)
      await fetchFiles()
    } catch (err) {
      setAlert({ open: true, message: err.response?.data || 'Cleanup failed', type: 'error' })
    } finally {
      setOrphanLoading(false)
    }
  }

  const toggleColumnVisibility = (colLabel) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev)
      next.has(colLabel) ? next.delete(colLabel) : next.add(colLabel)
      return next
    })
  }

  if (loading && files.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
        <CircularProgress size={36} />
      </Box>
    )
  }

  // Base columns: checkbox + name + size + visible data columns
  // checkbox(1) + name(1) + size(1) + total_size(1) + duration(1) + resolution(1) + transcodes(1) + cropped(1) + privacy(1) + date(1) = 10
  // minus hidden columns
  const visibleDataCols = [
    'Duration',
    'Resolution',
    'Transcodes',
    'Cropped',
    'Privacy',
    'Password',
    'Date',
    'Total Size',
  ].filter((c) => !hiddenColumns.has(c))
  const COL_SPAN = 4 + visibleDataCols.length // checkbox + privacy spacer + name + size + visible toggleable cols

  const renamePreviewFiles = selectedFiles.slice(0, 3)

  const orphanTotalSize = orphans.reduce((sum, o) => sum + (o.size || 0), 0)

  const renameOpOptions = [
    { value: 'find_replace', label: 'Find & Replace' },
    { value: 'strip_prefix', label: 'Strip Prefix' },
    { value: 'strip_suffix', label: 'Strip Suffix' },
    { value: 'smart_clean', label: 'Smart Clean' },
  ]

  return (
    <Box>
      {/* ── Selected actions row (only when items are selected) ── */}
      {selectedCount > 0 && (
        <Box
          sx={{
            mb: 1,
            px: 2,
            py: 1.25,
            borderRadius: '8px',
            bgcolor: '#1A3A5C',
            border: '1px solid #3399FF33',
          }}
        >
          {!onlyEmptyFoldersSelected && (
            <Typography variant="body2" sx={{ color: '#FFFFFFCC', whiteSpace: 'nowrap', mb: isMobile ? 1 : 0 }}>
              {selectedCount} selected
            </Typography>
          )}

          {isMobile ? (
            /* Mobile: icon-only buttons in a compact wrap row */
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              <Tooltip title="Move to folder">
                <span>
                  <IconButton
                    size="small"
                    disabled={onlyEmptyFoldersSelected}
                    onClick={() => {
                      setMoveTargetFolder(null)
                      setMoveModalOpen(true)
                    }}
                    sx={{
                      border: '1px solid #3399FF44',
                      borderRadius: 1,
                      color: '#7FBFFF',
                      '&:hover': { bgcolor: '#3399FF12' },
                    }}
                  >
                    <DriveFileMoveIcon sx={{ fontSize: 20 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Set uploader">
                <span>
                  <IconButton
                    size="small"
                    disabled={onlyEmptyFoldersSelected}
                    onClick={() => {
                      setUploaderChoice(null)
                      setUploaderDialogOpen(true)
                    }}
                    sx={{
                      border: '1px solid #3399FF44',
                      borderRadius: 1,
                      color: '#7FBFFF',
                      '&:hover': { bgcolor: '#3399FF12' },
                    }}
                  >
                    <PersonIcon sx={{ fontSize: 20 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Rename">
                <span>
                  <IconButton
                    size="small"
                    disabled={onlyEmptyFoldersSelected}
                    onClick={() => {
                      setRenameOp({ value: 'find_replace', label: 'Find & Replace' })
                      setRenameFind(
                        selectedFiles.length === 1 ? selectedFiles[0].title || selectedFiles[0].filename || '' : '',
                      )
                      setRenameReplace('')
                      setRenamePrefix('')
                      setRenameSuffix('')
                      setRenameDialogOpen(true)
                    }}
                    sx={{
                      border: '1px solid #3399FF44',
                      borderRadius: 1,
                      color: '#7FBFFF',
                      '&:hover': { bgcolor: '#3399FF12' },
                    }}
                  >
                    <DriveFileRenameOutlineIcon sx={{ fontSize: 20 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Set password">
                <span>
                  <IconButton
                    size="small"
                    onClick={() => setSetPasswordDialogOpen(true)}
                    disabled={onlyEmptyFoldersSelected || actionLoading}
                    sx={{
                      border: '1px solid #3399FF44',
                      borderRadius: 1,
                      color: '#7FBFFF',
                      '&:hover': { bgcolor: '#3399FF12' },
                    }}
                  >
                    <LockIcon sx={{ fontSize: 20 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Remove password">
                <span>
                  <IconButton
                    size="small"
                    onClick={() => setRemovePasswordDialogOpen(true)}
                    disabled={onlyEmptyFoldersSelected || actionLoading}
                    sx={{
                      border: '1px solid #3399FF44',
                      borderRadius: 1,
                      color: '#7FBFFF',
                      '&:hover': { bgcolor: '#3399FF12' },
                    }}
                  >
                    <LockOpenIcon sx={{ fontSize: 20 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Remove transcodes">
                <span>
                  <IconButton
                    size="small"
                    disabled={onlyEmptyFoldersSelected}
                    onClick={() => setRemoveTranscodesDialogOpen(true)}
                    sx={{
                      border: '1px solid #FF990044',
                      borderRadius: 1,
                      color: '#FFBB66',
                      '&:hover': { bgcolor: '#FF990012' },
                    }}
                  >
                    <VideoSettingsIcon sx={{ fontSize: 20 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Remove crop">
                <span>
                  <IconButton
                    size="small"
                    disabled={onlyEmptyFoldersSelected}
                    onClick={() => setRemoveCropDialogOpen(true)}
                    sx={{
                      border: '1px solid #FF990044',
                      borderRadius: 1,
                      color: '#FFBB66',
                      '&:hover': { bgcolor: '#FF990012' },
                    }}
                  >
                    <ContentCutIcon sx={{ fontSize: 20 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Set public">
                <span>
                  <IconButton
                    size="small"
                    onClick={() => handleSetPrivacy(false)}
                    disabled={onlyEmptyFoldersSelected || actionLoading}
                    sx={{
                      border: '1px solid #1DB95444',
                      borderRadius: 1,
                      color: '#1DB954',
                      '&:hover': { bgcolor: '#1DB95412' },
                    }}
                  >
                    <LockOpenIcon sx={{ fontSize: 20 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Set private">
                <span>
                  <IconButton
                    size="small"
                    onClick={() => handleSetPrivacy(true)}
                    disabled={onlyEmptyFoldersSelected || actionLoading}
                    sx={{
                      border: '1px solid #FFFFFF33',
                      borderRadius: 1,
                      color: '#FFFFFFCC',
                      '&:hover': { bgcolor: '#FFFFFF0D' },
                    }}
                  >
                    <LockIcon sx={{ fontSize: 20 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Delete selected">
                <IconButton
                  size="small"
                  onClick={() => setDeleteDialogOpen(true)}
                  sx={{
                    border: '1px solid #f4433644',
                    borderRadius: 1,
                    color: '#f44336',
                    '&:hover': { bgcolor: '#f4433612' },
                  }}
                >
                  <DeleteIcon sx={{ fontSize: 20 }} />
                </IconButton>
              </Tooltip>
            </Box>
          ) : (
            /* Desktop: labelled buttons with dividers */
            <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', mt: 0.5 }}>
              {/* Group 1: Organize */}
              <Box sx={{ display: 'flex', gap: '12px' }}>
                <Tooltip title="Move selected to another folder">
                  <span>
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={onlyEmptyFoldersSelected}
                      startIcon={<DriveFileMoveIcon />}
                      onClick={() => {
                        setMoveTargetFolder(null)
                        setMoveModalOpen(true)
                      }}
                      sx={{
                        textTransform: 'none',
                        borderColor: '#3399FF44',
                        color: '#7FBFFF',
                        '&:hover': { borderColor: '#3399FF99', bgcolor: '#3399FF12' },
                      }}
                    >
                      Move
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip title="Attribute selected files to a user">
                  <span>
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={onlyEmptyFoldersSelected}
                      startIcon={<PersonIcon />}
                      onClick={() => {
                        setUploaderChoice(null)
                        setUploaderDialogOpen(true)
                      }}
                      sx={{
                        textTransform: 'none',
                        borderColor: '#3399FF44',
                        color: '#7FBFFF',
                        '&:hover': { borderColor: '#3399FF99', bgcolor: '#3399FF12' },
                      }}
                    >
                      Uploader
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip title="Rename selected files">
                  <span>
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={onlyEmptyFoldersSelected}
                      startIcon={<DriveFileRenameOutlineIcon />}
                      onClick={() => {
                        setRenameOp({ value: 'find_replace', label: 'Find & Replace' })
                        setRenameFind(
                          selectedFiles.length === 1 ? selectedFiles[0].title || selectedFiles[0].filename || '' : '',
                        )
                        setRenameReplace('')
                        setRenamePrefix('')
                        setRenameSuffix('')
                        setRenameDialogOpen(true)
                      }}
                      sx={{
                        textTransform: 'none',
                        borderColor: '#3399FF44',
                        color: '#7FBFFF',
                        '&:hover': { borderColor: '#3399FF99', bgcolor: '#3399FF12' },
                      }}
                    >
                      Rename
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip title="Set password on selected files">
                  <span>
                    <IconButton
                      size="small"
                      onClick={() => setSetPasswordDialogOpen(true)}
                      disabled={onlyEmptyFoldersSelected || actionLoading}
                      sx={{
                        border: '1px solid #3399FF44',
                        borderRadius: 1,
                        color: '#7FBFFF',
                        '&:hover': { bgcolor: '#3399FF12' },
                      }}
                    >
                      <LockIcon sx={{ fontSize: 20 }} />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title="Remove password from selected files">
                  <span>
                    <IconButton
                      size="small"
                      onClick={() => setRemovePasswordDialogOpen(true)}
                      disabled={onlyEmptyFoldersSelected || actionLoading}
                      sx={{
                        border: '1px solid #3399FF44',
                        borderRadius: 1,
                        color: '#7FBFFF',
                        '&:hover': { bgcolor: '#3399FF12' },
                      }}
                    >
                      <LockOpenIcon sx={{ fontSize: 20 }} />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>

              <Box sx={{ width: '1px', height: '24px', bgcolor: '#FFFFFF22', flexShrink: 0 }} />

              {/* Group 2: Cleanup */}
              <Box sx={{ display: 'flex', gap: '12px' }}>
                <Tooltip title="Remove transcoded versions (480p / 720p / 1080p)">
                  <span>
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={onlyEmptyFoldersSelected}
                      startIcon={<VideoSettingsIcon />}
                      onClick={() => setRemoveTranscodesDialogOpen(true)}
                      sx={{
                        textTransform: 'none',
                        borderColor: '#FF990044',
                        color: '#FFBB66',
                        '&:hover': { borderColor: '#FF990099', bgcolor: '#FF990012' },
                      }}
                    >
                      Remove Transcodes
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip title="Remove crop settings from selected files">
                  <span>
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={onlyEmptyFoldersSelected}
                      startIcon={<ContentCutIcon />}
                      onClick={() => setRemoveCropDialogOpen(true)}
                      sx={{
                        textTransform: 'none',
                        borderColor: '#FF990044',
                        color: '#FFBB66',
                        '&:hover': { borderColor: '#FF990099', bgcolor: '#FF990012' },
                      }}
                    >
                      Remove Crop
                    </Button>
                  </span>
                </Tooltip>
              </Box>

              <Box sx={{ width: '1px', height: '24px', bgcolor: '#FFFFFF22', flexShrink: 0 }} />

              {/* Group 3: Privacy */}
              <Box sx={{ display: 'flex', gap: '12px' }}>
                <Tooltip title="Make selected files public">
                  <span>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<LockOpenIcon />}
                      onClick={() => handleSetPrivacy(false)}
                      disabled={onlyEmptyFoldersSelected || actionLoading}
                      sx={{
                        textTransform: 'none',
                        borderColor: '#1DB95444',
                        color: '#1DB954',
                        '&:hover': { borderColor: '#1DB954', bgcolor: '#1DB95412' },
                      }}
                    >
                      Set Public
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip title="Make selected files private">
                  <span>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<LockIcon />}
                      onClick={() => handleSetPrivacy(true)}
                      disabled={onlyEmptyFoldersSelected || actionLoading}
                      sx={{
                        textTransform: 'none',
                        borderColor: '#FFFFFF33',
                        color: '#FFFFFFCC',
                        '&:hover': { borderColor: '#FFFFFF66', bgcolor: '#FFFFFF0D' },
                      }}
                    >
                      Set Private
                    </Button>
                  </span>
                </Tooltip>
              </Box>

              <Box sx={{ width: '1px', height: '24px', bgcolor: '#FFFFFF22', flexShrink: 0 }} />

              {/* Group 4: Destructive */}
              <Tooltip title="Delete selected files">
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<DeleteIcon />}
                  onClick={() => setDeleteDialogOpen(true)}
                  sx={{
                    textTransform: 'none',
                    borderColor: '#f4433644',
                    color: '#f44336',
                    '&:hover': { borderColor: '#f44336', bgcolor: '#f4433612' },
                  }}
                >
                  Delete
                </Button>
              </Tooltip>
            </Box>
          )}
        </Box>
      )}

      {/* ── Search / folder filter / game filter / utility buttons ── */}
      {isMobile ? (
        <Box sx={{ mb: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
          {/* Row 1: search full width */}
          <TextField
            size="small"
            placeholder="Search by name, title or uploader…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            fullWidth
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ color: '#FFFFFF55', fontSize: 18 }} />
                </InputAdornment>
              ),
            }}
            sx={{ ...inputSx, '& .MuiInputBase-input::placeholder': { color: '#FFFFFF55' } }}
          />
          {/* Row 2: filters */}
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Select
                options={[
                  { value: '__all__', label: 'All Folders' },
                  ...folders.sort((a, b) => a.localeCompare(b)).map((f) => ({ value: f, label: f })),
                ]}
                value={
                  folderFilter === '__all__'
                    ? { value: '__all__', label: 'All Folders' }
                    : { value: folderFilter, label: folderFilter }
                }
                onChange={(opt) => setFolderFilter(opt.value)}
                styles={selectFolderTheme}
                isSearchable={false}
                components={{ SingleValue: MarqueeSingleValue, Option: MarqueeOption }}
              />
            </Box>
            {uniqueGames.length > 0 && (
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Select
                  options={[
                    { value: '__all__', label: 'All Games' },
                    ...uniqueGames.map((g) => ({ value: g, label: g })),
                  ]}
                  value={
                    gameFilter === '__all__'
                      ? { value: '__all__', label: 'All Games' }
                      : { value: gameFilter, label: gameFilter }
                  }
                  onChange={(opt) => setGameFilter(opt.value)}
                  styles={selectFolderTheme}
                  isSearchable={false}
                />
              </Box>
            )}
            {uniqueUploaders.length > 0 && (
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Select
                  options={uploaderFilterOptions}
                  value={uploaderFilterValue}
                  onChange={(opt) => setUploaderFilter(opt.value)}
                  styles={selectFolderTheme}
                  isSearchable={false}
                  components={{ SingleValue: MarqueeSingleValue, Option: MarqueeOption }}
                />
              </Box>
            )}
          </Box>
          {unattributedChip && <Box sx={{ display: 'flex' }}>{unattributedChip}</Box>}
          {/* Row 3: utility buttons */}
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', maxWidth: '100%' }}>
            <Tooltip title="Create a new empty folder in /videos">
              <OutlinedIconButton
                icon={<CreateNewFolderIcon sx={{ fontSize: 18 }} />}
                onClick={() => {
                  setNewFolderName('')
                  setCreateFolderDialogOpen(true)
                }}
              >
                Create Folder
              </OutlinedIconButton>
            </Tooltip>
            <Tooltip title="Toggle column visibility">
              <IconButton
                onClick={(e) => setColVisAnchor(e.currentTarget)}
                sx={{
                  border: '1px solid #FFFFFF33',
                  borderRadius: 1,
                  color: '#FFFFFFCC',
                  '&:hover': { borderColor: '#FFFFFF66', bgcolor: '#FFFFFF0D' },
                }}
              >
                <TuneIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Clean up orphaned derived folders">
              <IconButton
                onClick={handleCheckOrphans}
                disabled={orphanLoading}
                sx={{
                  border: '1px solid #FFFFFF33',
                  borderRadius: 1,
                  color: '#FFFFFFCC',
                  '&:hover': { borderColor: '#FFFFFF66', bgcolor: '#FFFFFF0D' },
                }}
              >
                {orphanLoading ? (
                  <CircularProgress size={20} color="inherit" />
                ) : (
                  <DeleteSweepIcon sx={{ fontSize: 20 }} />
                )}
              </IconButton>
            </Tooltip>
            <Tooltip title="Refresh file list">
              <IconButton
                onClick={fetchFiles}
                disabled={loading}
                sx={{
                  border: '1px solid #FFFFFF33',
                  borderRadius: 1,
                  color: '#FFFFFFCC',
                  '&:hover': { borderColor: '#FFFFFF66', bgcolor: '#FFFFFF0D' },
                }}
              >
                <RefreshIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      ) : (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5, flexWrap: 'wrap', gap: 1 }}>
          <TextField
            size="small"
            placeholder="Search by name, title or uploader…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ color: '#FFFFFF55', fontSize: 18 }} />
                </InputAdornment>
              ),
            }}
            sx={{
              ...inputSx,
              flex: 1,
              minWidth: 140,
              height: 38,
              '& .MuiInputBase-input::placeholder': { color: '#FFFFFF55' },
            }}
          />

          <Box sx={{ minWidth: 160 }}>
            <Select
              options={[
                { value: '__all__', label: 'All Folders' },
                ...folders.sort((a, b) => a.localeCompare(b)).map((f) => ({ value: f, label: f })),
              ]}
              value={
                folderFilter === '__all__'
                  ? { value: '__all__', label: 'All Folders' }
                  : { value: folderFilter, label: folderFilter }
              }
              onChange={(opt) => setFolderFilter(opt.value)}
              styles={selectFolderTheme}
              isSearchable={false}
              components={{ SingleValue: MarqueeSingleValue, Option: MarqueeOption }}
            />
          </Box>

          {uniqueGames.length > 0 && (
            <Box sx={{ minWidth: 160 }}>
              <Select
                options={[
                  { value: '__all__', label: 'All Games' },
                  ...uniqueGames.map((g) => ({ value: g, label: g })),
                ]}
                value={
                  gameFilter === '__all__'
                    ? { value: '__all__', label: 'All Games' }
                    : { value: gameFilter, label: gameFilter }
                }
                onChange={(opt) => setGameFilter(opt.value)}
                styles={selectFolderTheme}
                isSearchable={false}
              />
            </Box>
          )}

          {uniqueUploaders.length > 0 && (
            <Box sx={{ minWidth: 175 }}>
              <Select
                options={uploaderFilterOptions}
                value={uploaderFilterValue}
                onChange={(opt) => setUploaderFilter(opt.value)}
                styles={selectFolderTheme}
                isSearchable={false}
                components={{ SingleValue: MarqueeSingleValue, Option: MarqueeOption }}
              />
            </Box>
          )}

          {unattributedChip}

          <Tooltip title="Create a new empty folder in /videos">
            <OutlinedIconButton
              icon={<CreateNewFolderIcon sx={{ fontSize: 18 }} />}
              onClick={() => {
                setNewFolderName('')
                setCreateFolderDialogOpen(true)
              }}
            >
              Create Folder
            </OutlinedIconButton>
          </Tooltip>

          <Tooltip title="Toggle column visibility">
            <IconButton
              onClick={(e) => setColVisAnchor(e.currentTarget)}
              sx={{
                border: '1px solid #FFFFFF33',
                borderRadius: 1,
                color: '#FFFFFFCC',
                '&:hover': { borderColor: '#FFFFFF66', bgcolor: '#FFFFFF0D' },
              }}
            >
              <TuneIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </Tooltip>

          <Tooltip title="Clean up orphaned derived folders">
            <IconButton
              onClick={handleCheckOrphans}
              disabled={orphanLoading}
              sx={{
                border: '1px solid #FFFFFF33',
                borderRadius: 1,
                color: '#FFFFFFCC',
                '&:hover': { borderColor: '#FFFFFF66', bgcolor: '#FFFFFF0D' },
              }}
            >
              {orphanLoading ? (
                <CircularProgress size={20} color="inherit" />
              ) : (
                <DeleteSweepIcon sx={{ fontSize: 20 }} />
              )}
            </IconButton>
          </Tooltip>

          <Tooltip title="Refresh file list">
            <IconButton
              onClick={fetchFiles}
              disabled={loading}
              sx={{
                border: '1px solid #FFFFFF33',
                borderRadius: 1,
                color: '#FFFFFFCC',
                '&:hover': { borderColor: '#FFFFFF66', bgcolor: '#FFFFFF0D' },
              }}
            >
              <RefreshIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </Tooltip>
        </Stack>
      )}

      {/* ── Column visibility popover ── */}
      <Popover
        open={Boolean(colVisAnchor)}
        anchorEl={colVisAnchor}
        onClose={() => setColVisAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { bgcolor: '#0e233a', border: '1px solid #FFFFFF18', p: 1.5, minWidth: 180 } } }}
      >
        <Typography
          sx={{
            fontSize: 11,
            fontWeight: 700,
            color: '#FFFFFF66',
            mb: 1,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          Columns
        </Typography>
        {TOGGLEABLE_COLUMNS.map((col) => (
          <Box
            key={col}
            sx={{ display: 'flex', alignItems: 'center', cursor: 'pointer', py: 0.25 }}
            onClick={() => toggleColumnVisibility(col)}
          >
            <Checkbox
              size="small"
              checked={!hiddenColumns.has(col)}
              sx={{ color: '#FFFFFF44', '&.Mui-checked': { color: '#3399FF' }, p: 0.5 }}
            />
            <Typography sx={{ fontSize: 13, color: '#FFFFFFCC', ml: 0.5 }}>{col}</Typography>
          </Box>
        ))}
      </Popover>

      {/* ── File table ── */}
      <TableContainer
        sx={{
          borderRadius: '8px',
          border: '1px solid #FFFFFF14',
          bgcolor: '#FFFFFF05',
          maxHeight: isMobile ? 'calc(100vh - 340px)' : 'calc(100vh - 280px)',
          overflow: 'auto',
        }}
      >
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox" sx={{ ...headCellSx, width: 40 }}>
                <Checkbox
                  size="small"
                  indeterminate={someFilteredSelected}
                  checked={allFilteredSelected}
                  onChange={toggleSelectAll}
                  sx={{ color: '#FFFFFF44', '&.Mui-checked, &.MuiCheckbox-indeterminate': { color: '#3399FF' } }}
                />
              </TableCell>
              <TableCell padding="checkbox" sx={{ ...headCellSx, width: 32 }} />
              {[
                {
                  col: 'name',
                  label: 'Name',
                  sx: { maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                },
                { col: 'size', label: 'Size', sx: { width: 110, minWidth: 110, whiteSpace: 'nowrap' } },
                !hiddenColumns.has('Total Size') && {
                  col: 'total_size',
                  label: 'Total Size',
                  sx: { width: 110, minWidth: 110, whiteSpace: 'nowrap' },
                },
                !hiddenColumns.has('Duration') && {
                  col: 'duration',
                  label: 'Duration',
                  sx: { width: 85, whiteSpace: 'nowrap' },
                },
                !hiddenColumns.has('Resolution') && {
                  col: null,
                  label: 'Resolution',
                  sx: { width: 80, whiteSpace: 'nowrap' },
                },
                !hiddenColumns.has('Transcodes') && {
                  col: null,
                  label: 'Transcodes',
                  sx: { width: 155, minWidth: 155, whiteSpace: 'nowrap' },
                },
                !hiddenColumns.has('Cropped') && {
                  col: null,
                  label: 'Cropped',
                  sx: { width: 80, whiteSpace: 'nowrap' },
                },
                !hiddenColumns.has('Privacy') && {
                  col: null,
                  label: 'Privacy',
                  sx: { width: 75, whiteSpace: 'nowrap' },
                },
                !hiddenColumns.has('Password') && {
                  col: null,
                  label: 'Password',
                  sx: { width: 75, whiteSpace: 'nowrap' },
                },
                !hiddenColumns.has('Uploader') && {
                  col: 'uploader',
                  label: 'Uploader',
                  sx: { width: 170, minWidth: 170, whiteSpace: 'nowrap' },
                },
                !hiddenColumns.has('Date') && {
                  col: 'date',
                  label: 'Date',
                  sx: { width: 110, minWidth: 110, whiteSpace: 'nowrap' },
                },
              ]
                .filter(Boolean)
                .map(({ col, label, sx }) => (
                  <TableCell
                    key={label}
                    onClick={col ? () => handleSort(col) : undefined}
                    sx={{
                      ...headCellSx,
                      ...sx,
                      ...(col && {
                        cursor: 'pointer',
                        userSelect: 'none',
                        '&:hover': { color: '#FFFFFFCC', bgcolor: '#FFFFFF10' },
                      }),
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      {label}
                      {col && (
                        <Box
                          component="span"
                          sx={{
                            fontSize: 12,
                            lineHeight: 1,
                            opacity: sortColumn === col ? 1 : 0.25,
                            color: sortColumn === col ? '#3399FF' : 'inherit',
                          }}
                        >
                          {sortColumn === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                        </Box>
                      )}
                    </Box>
                  </TableCell>
                ))}
            </TableRow>
          </TableHead>

          <TableBody>
            {groupedFiles.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COL_SPAN} sx={{ ...bodyCellSx, textAlign: 'center', py: 4, color: '#FFFFFF55' }}>
                  No files found
                </TableCell>
              </TableRow>
            ) : (
              groupedFiles.map(([folder, groupItems]) => {
                const isCollapsed = collapsedFolders.has(folder)
                const folderFileIds = groupItems.map((f) => f.video_id)
                const allFolderSelected = folderFileIds.length > 0 && folderFileIds.every((id) => selected.has(id))
                const someFolderSelected = folderFileIds.some((id) => selected.has(id)) && !allFolderSelected
                const folderTotalSize = groupItems.reduce((sum, f) => sum + (f.size || 0), 0)
                const toggleFolderSelect = () => {
                  setSelected((prev) => {
                    const next = new Set(prev)
                    if (allFolderSelected) {
                      folderFileIds.forEach((id) => next.delete(id))
                    } else {
                      folderFileIds.forEach((id) => next.add(id))
                    }
                    return next
                  })
                }
                return (
                  <React.Fragment key={folder || '__root__'}>
                    {/* Folder header row */}
                    <TableRow
                      sx={{ ...folderRowSx, cursor: 'pointer' }}
                      onClick={() => {
                        if (folderFileIds.length > 0) toggleFolderCollapse(folder)
                        else if (folder) toggleSelectFolder(folder)
                      }}
                    >
                      <TableCell
                        padding="checkbox"
                        sx={{ borderBottom: '1px solid #FFFFFF14', bgcolor: 'transparent' }}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (folderFileIds.length > 0) toggleFolderSelect()
                          else if (folder) toggleSelectFolder(folder)
                        }}
                      >
                        <Checkbox
                          size="small"
                          checked={folderFileIds.length === 0 ? selectedFolders.has(folder) : allFolderSelected}
                          indeterminate={folderFileIds.length > 0 && someFolderSelected}
                          disabled={folderFileIds.length === 0 && isProtectedFolder(folder)}
                          sx={{
                            color: '#FFFFFF44',
                            '&.Mui-checked, &.MuiCheckbox-indeterminate': { color: '#3399FF' },
                          }}
                        />
                      </TableCell>
                      <TableCell
                        padding="checkbox"
                        sx={{
                          py: 0.75,
                          borderBottom: '1px solid #FFFFFF14',
                          bgcolor: 'transparent',
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {folder && groupItems.length > 0 && (
                          <Box sx={{ display: 'flex', alignItems: 'center' }}>
                            <FolderPrivacyToggle path={folder} mediaType="video" setAlert={setAlert} />
                            <FolderLinkActions path={folder} mediaType="video" setAlert={setAlert} />
                          </Box>
                        )}
                      </TableCell>
                      <TableCell
                        colSpan={COL_SPAN - 2}
                        sx={{
                          py: 0.75,
                          borderBottom: '1px solid #FFFFFF14',
                          bgcolor: 'transparent',
                        }}
                      >
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          {folderFileIds.length > 0 ? (
                            <Box sx={{ display: 'flex', alignItems: 'center', width: 16 }}>
                              {isCollapsed ? (
                                <KeyboardArrowRightIcon sx={{ fontSize: 16, color: '#FFFFFF44' }} />
                              ) : (
                                <KeyboardArrowDownIcon sx={{ fontSize: 16, color: '#FFFFFF44' }} />
                              )}
                            </Box>
                          ) : (
                            <Box sx={{ width: 16 }} />
                          )}
                          <FolderIcon sx={{ fontSize: 14, color: '#FFFFFF55' }} />
                          <Typography
                            sx={{ fontSize: 12, fontWeight: 700, color: '#FFFFFFAA', letterSpacing: '0.04em' }}
                          >
                            {folder || '(root)'}
                            {isProtectedFolder(folder) && folderFileIds.length === 0 && (
                              <LockIcon
                                sx={{ fontSize: 12, color: '#FFAA33', ml: 0.5 }}
                                title="This folder cannot be deleted"
                              />
                            )}
                          </Typography>
                          {groupItems.length > 0 && (
                            <Typography sx={{ fontSize: 11, fontWeight: 400, color: '#FFFFFF44', ml: 0.5 }}>
                              {formatSize(folderTotalSize)} · {groupItems.length} file
                              {groupItems.length !== 1 ? 's' : ''}
                            </Typography>
                          )}
                        </Box>
                      </TableCell>
                    </TableRow>

                    {/* File rows */}
                    {!isCollapsed &&
                      groupItems.map((file) => (
                        <VideoFileRow
                          key={file.video_id}
                          file={file}
                          isSelected={selected.has(file.video_id)}
                          onToggle={toggleSelect}
                          hiddenColumns={hiddenColumns}
                        />
                      ))}
                  </React.Fragment>
                )
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* ── Move modal ── */}
      <Modal open={moveModalOpen} onClose={() => !actionLoading && setMoveModalOpen(false)}>
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 420,
            p: 4,
            ...dialogPaperSx,
          }}
        >
          <Typography variant="h6" sx={{ fontWeight: 800, color: 'white', mb: 2.5 }}>
            Move {selectedCount} file{selectedCount !== 1 ? 's' : ''}...
          </Typography>

          {uniqueCurrentFolders.size === 1 && (
            <Box sx={{ mb: 2 }}>
              <Typography sx={labelSx}>Current location</Typography>
              <Box sx={{ ...rowBoxSx, fontSize: 14, fontFamily: 'Inter, sans-serif', color: '#FFFFFFCC' }}>
                {`/videos/${[...uniqueCurrentFolders][0]}/`}
              </Box>
            </Box>
          )}

          <Box sx={{ mb: 3.5 }}>
            <Typography sx={labelSx}>Move to folder</Typography>
            <Select
              options={moveFolderOptions}
              value={moveTargetFolder}
              onChange={setMoveTargetFolder}
              placeholder="Select a folder…"
              styles={selectFolderTheme}
              isDisabled={actionLoading}
              noOptionsMessage={() => 'No other folders available'}
            />
          </Box>

          <Stack direction="row" spacing={1.5}>
            <Button
              fullWidth
              variant="outlined"
              onClick={() => setMoveModalOpen(false)}
              disabled={actionLoading}
              sx={{
                color: 'white',
                borderColor: '#FFFFFF44',
                '&:hover': { borderColor: 'white', bgcolor: '#FFFFFF12' },
              }}
            >
              Cancel
            </Button>
            <Button
              fullWidth
              variant="contained"
              startIcon={actionLoading ? <CircularProgress size={14} color="inherit" /> : <FolderIcon />}
              onClick={handleMove}
              disabled={actionLoading || !moveTargetFolder}
              sx={{
                bgcolor: '#3399FF',
                '&:hover': { bgcolor: '#1976D2' },
                '&.Mui-disabled': { bgcolor: '#3399FF44', color: '#FFFFFF44' },
              }}
            >
              {actionLoading ? 'Moving…' : 'Move'}
            </Button>
          </Stack>
        </Box>
      </Modal>

      {/* ── Delete dialog ── */}
      <Dialog
        open={deleteDialogOpen}
        onClose={() => !actionLoading && setDeleteDialogOpen(false)}
        slotProps={{ paper: { sx: { ...dialogPaperSx, minWidth: 380 } } }}
      >
        <DialogTitle sx={dialogTitleSx}>
          Delete{' '}
          {[
            selected.size > 0 && `${selected.size} file${selected.size !== 1 ? 's' : ''}`,
            selectedFolders.size > 0 && `${selectedFolders.size} folder${selectedFolders.size !== 1 ? 's' : ''}`,
          ]
            .filter(Boolean)
            .join(' and ')}
          ?
        </DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ color: '#FFFFFFAA' }}>
            {selected.size > 0 &&
              `This will permanently delete ${selected.size} file${selected.size !== 1 ? 's' : ''} and all related data. `}
            {selectedFolders.size > 0 &&
              `This will permanently delete ${selectedFolders.size} empty folder${selectedFolders.size !== 1 ? 's' : ''}. `}
            This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
          <Button
            onClick={() => setDeleteDialogOpen(false)}
            disabled={actionLoading}
            sx={{ color: '#FFFFFF88', textTransform: 'none' }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleDelete}
            disabled={actionLoading}
            startIcon={actionLoading ? <CircularProgress size={14} color="inherit" /> : <DeleteIcon />}
            sx={{ textTransform: 'none' }}
          >
            {actionLoading ? 'Deleting…' : `Delete ${selectedCount} item${selectedCount !== 1 ? 's' : ''}`}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── Remove Transcodes dialog ── */}
      <Dialog
        open={removeTranscodesDialogOpen}
        onClose={() => !actionLoading && setRemoveTranscodesDialogOpen(false)}
        slotProps={{ paper: { sx: { ...dialogPaperSx, minWidth: 380 } } }}
      >
        <DialogTitle sx={dialogTitleSx}>Remove Transcodes?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ color: '#FFFFFFAA' }}>
            This will delete the 480p, 720p, and 1080p transcoded files for {selectedCount} selected file
            {selectedCount !== 1 ? 's' : ''}.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
          <Button
            onClick={() => setRemoveTranscodesDialogOpen(false)}
            disabled={actionLoading}
            sx={{ color: '#FFFFFF88', textTransform: 'none' }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleRemoveTranscodes}
            disabled={actionLoading}
            startIcon={actionLoading ? <CircularProgress size={14} color="inherit" /> : <VideoSettingsIcon />}
            sx={{ textTransform: 'none' }}
          >
            {actionLoading ? 'Removing…' : 'Remove Transcodes'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── Remove Crop dialog ── */}
      <Dialog
        open={removeCropDialogOpen}
        onClose={() => !actionLoading && setRemoveCropDialogOpen(false)}
        slotProps={{ paper: { sx: { ...dialogPaperSx, minWidth: 380 } } }}
      >
        <DialogTitle sx={dialogTitleSx}>Remove Crop?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ color: '#FFFFFFAA' }}>
            This will clear the crop settings and remove associated transcoded files for {selectedCount} selected file
            {selectedCount !== 1 ? 's' : ''}. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
          <Button
            onClick={() => setRemoveCropDialogOpen(false)}
            disabled={actionLoading}
            sx={{ color: '#FFFFFF88', textTransform: 'none' }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleRemoveCrop}
            disabled={actionLoading}
            startIcon={actionLoading ? <CircularProgress size={14} color="inherit" /> : <ContentCutIcon />}
            sx={{ textTransform: 'none' }}
          >
            {actionLoading ? 'Removing…' : 'Remove Crop'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── Create Folder dialog ── */}
      <Dialog
        open={createFolderDialogOpen}
        onClose={() => !actionLoading && setCreateFolderDialogOpen(false)}
        slotProps={{ paper: { sx: { ...dialogPaperSx, minWidth: 360 } } }}
      >
        <DialogTitle sx={dialogTitleSx}>Create New Folder</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ color: '#FFFFFFAA', mb: 2 }}>
            Enter a name for the new folder. It will be created in the root of your videos directory.
          </DialogContentText>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Folder Name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newFolderName.trim() && !actionLoading) handleCreateFolder()
            }}
            InputLabelProps={{ sx: { color: '#FFFFFF66' } }}
            sx={inputSx}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
          <Button
            onClick={() => setCreateFolderDialogOpen(false)}
            disabled={actionLoading}
            sx={{ color: '#FFFFFF88', textTransform: 'none' }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleCreateFolder}
            disabled={actionLoading || !newFolderName.trim()}
            startIcon={actionLoading ? <CircularProgress size={14} color="inherit" /> : <CreateNewFolderIcon />}
            sx={{ textTransform: 'none', '&.Mui-disabled': { bgcolor: 'rgba(255,255,255,0.12)', color: '#FFFFFF44' } }}
          >
            {actionLoading ? 'Creating…' : 'Create Folder'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── Bulk Rename dialog ── */}
      <Dialog
        open={renameDialogOpen}
        onClose={() => !actionLoading && setRenameDialogOpen(false)}
        slotProps={{ paper: { sx: { ...dialogPaperSx, width: 440, minWidth: 440, minHeight: 420 } } }}
      >
        <DialogTitle sx={dialogTitleSx}>
          Rename {selectedCount} file{selectedCount !== 1 ? 's' : ''}
        </DialogTitle>
        <DialogContent>
          <Box sx={{ mb: 2 }}>
            <Typography sx={{ ...labelSx, mb: 1 }}>Operation</Typography>
            <Select
              options={renameOpOptions}
              value={renameOp}
              onChange={setRenameOp}
              styles={selectFolderTheme}
              isSearchable={false}
              isDisabled={actionLoading}
            />
          </Box>

          {renameOp.value === 'find_replace' && (
            <Stack spacing={1.5} sx={{ mb: 2 }}>
              <TextField
                size="small"
                label="Find"
                value={renameFind}
                onChange={(e) => setRenameFind(e.target.value)}
                disabled={actionLoading}
                InputLabelProps={{ sx: { color: '#FFFFFF66' } }}
                sx={inputSx}
              />
              <TextField
                size="small"
                label="Replace with"
                value={renameReplace}
                onChange={(e) => setRenameReplace(e.target.value)}
                disabled={actionLoading}
                InputLabelProps={{ sx: { color: '#FFFFFF66' } }}
                sx={inputSx}
              />
            </Stack>
          )}

          {renameOp.value === 'strip_prefix' && (
            <Box sx={{ mb: 2 }}>
              <TextField
                fullWidth
                size="small"
                label="Prefix to strip"
                value={renamePrefix}
                onChange={(e) => setRenamePrefix(e.target.value)}
                disabled={actionLoading}
                InputLabelProps={{ sx: { color: '#FFFFFF66' } }}
                sx={inputSx}
              />
            </Box>
          )}

          {renameOp.value === 'strip_suffix' && (
            <Box sx={{ mb: 2 }}>
              <TextField
                fullWidth
                size="small"
                label="Suffix to strip"
                value={renameSuffix}
                onChange={(e) => setRenameSuffix(e.target.value)}
                disabled={actionLoading}
                InputLabelProps={{ sx: { color: '#FFFFFF66' } }}
                sx={inputSx}
              />
            </Box>
          )}

          {renameOp.value === 'smart_clean' && (
            <Box sx={{ mb: 2, bgcolor: '#FFFFFF06', borderRadius: '6px', p: 1.5, border: '1px solid #FFFFFF12' }}>
              <Typography sx={{ fontSize: 12, color: '#FFFFFF88', lineHeight: 1.6 }}>
                Removes non-alphanumeric characters, strips standalone leading/trailing numbers, and capitalizes the
                first letter of each word.
              </Typography>
            </Box>
          )}

          {renamePreviewFiles.length > 0 && (
            <Box sx={{ bgcolor: '#FFFFFF06', borderRadius: '6px', p: 1.5, border: '1px solid #FFFFFF12' }}>
              <Typography
                sx={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#FFFFFF55',
                  mb: 1,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Preview
              </Typography>
              {renamePreviewFiles.map((f) => {
                const before = f.title || f.filename || ''
                const after = applyRenameOperation(
                  before,
                  renameOp.value,
                  renameFind,
                  renameReplace,
                  renamePrefix,
                  renameSuffix,
                )
                return (
                  <Box key={f.video_id} sx={{ mb: 0.75 }}>
                    <Typography
                      sx={{
                        fontSize: 11,
                        color: '#FFFFFF55',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {before}
                    </Typography>
                    <Typography
                      sx={{
                        fontSize: 11,
                        color: '#3399FF',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      → {after || '(empty)'}
                    </Typography>
                  </Box>
                )
              })}
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
          <Button
            onClick={() => setRenameDialogOpen(false)}
            disabled={actionLoading}
            sx={{ color: '#FFFFFF88', textTransform: 'none' }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleBulkRename}
            disabled={
              actionLoading ||
              selectedFiles.some(
                (f) =>
                  !applyRenameOperation(
                    f.title || f.filename || '',
                    renameOp.value,
                    renameFind,
                    renameReplace,
                    renamePrefix,
                    renameSuffix,
                  ).trim(),
              )
            }
            startIcon={actionLoading ? <CircularProgress size={14} color="inherit" /> : <DriveFileRenameOutlineIcon />}
            sx={{ textTransform: 'none' }}
          >
            {actionLoading ? 'Applying…' : 'Apply'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── Set Uploader modal ── */}
      <Dialog
        open={uploaderDialogOpen}
        onClose={() => !actionLoading && setUploaderDialogOpen(false)}
        fullWidth
        maxWidth="xs"
        PaperProps={{ sx: dialogPaperSx }}
      >
        <DialogTitle sx={dialogTitleSx}>Set uploader</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ color: '#FFFFFFAA', fontSize: 13.5, mb: 2 }}>
            Attribute {selected.size} selected item{selected.size === 1 ? '' : 's'} to an account.
            This is how library content indexed from disk gets an owner, so it appears on their
            profile and comes under their edit and delete permissions.
          </DialogContentText>
          <UploaderPicker value={uploaderChoice} onChange={setUploaderChoice} disabled={actionLoading} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
          <Button onClick={() => setUploaderDialogOpen(false)} disabled={actionLoading} sx={{ color: '#B2BAC2' }}>
            Cancel
          </Button>
          <Button onClick={handleSetUploader} variant="contained" disabled={actionLoading}>
            {actionLoading ? 'Applying...' : 'Apply'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── Set Password modal ── */}
      <Modal
        open={setPasswordDialogOpen}
        onClose={() => !actionLoading && (setSetPasswordDialogOpen(false), setBulkPasswordInput(''))}
      >
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 500,
            maxWidth: 'calc(100vw - 32px)',
            maxHeight: 'calc(100svh - 32px)',
            overflowY: 'auto',
            p: 4,
            ...dialogPaperSx,
          }}
        >
          <Typography variant="h6" sx={{ fontWeight: 800, color: 'white', mb: 3 }}>
            Set Password
          </Typography>

          <Stack spacing={2.5}>
            <Box>
              <Typography sx={{ fontSize: 13, color: '#FFFFFFAA', mb: 2 }}>
                Set a password on {selected.size} selected file{selected.size !== 1 ? 's' : ''}. Users will need to
                enter this password to view the video{selected.size !== 1 ? 's' : ''}.
              </Typography>
            </Box>

            <Box>
              <Typography sx={labelSx}>Password</Typography>
              <TextField
                autoFocus
                value={bulkPasswordInput}
                onChange={(e) => setBulkPasswordInput(e.target.value)}
                onKeyDown={(e) =>
                  e.key === 'Enter' && bulkPasswordInput.trim() && !actionLoading && handleBulkSetPassword()
                }
                placeholder="Set a password..."
                size="small"
                fullWidth
                sx={inputSx}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end" sx={{ gap: 0.25 }}>
                      {bulkPasswordInput ? (
                        <IconButton
                          size="small"
                          onClick={() => {
                            navigator.clipboard.writeText(bulkPasswordInput)
                            setAlert({ open: true, type: 'info', message: 'Copied to clipboard.' })
                          }}
                          sx={{ color: '#FFFFFF66', '&:hover': { color: '#90CAF9' }, p: 0.5 }}
                        >
                          <ContentCopyIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                      ) : (
                        <IconButton
                          size="small"
                          onClick={() => {
                            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
                            const arr = crypto.getRandomValues(new Uint8Array(12))
                            setBulkPasswordInput(Array.from(arr, (b) => chars[b % chars.length]).join(''))
                          }}
                          sx={{ color: '#FFFFFF66', '&:hover': { color: '#90CAF9' }, p: 0.5 }}
                        >
                          <RefreshIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                      )}
                    </InputAdornment>
                  ),
                }}
              />
            </Box>
          </Stack>

          <Stack direction="row" spacing={1.5} sx={{ mt: 4 }}>
            <Button
              fullWidth
              variant="outlined"
              onClick={() => {
                setSetPasswordDialogOpen(false)
                setBulkPasswordInput('')
              }}
              disabled={actionLoading}
              sx={{ color: 'white', borderColor: 'white', '&:hover': { borderColor: 'white', bgcolor: '#FFFFFF12' } }}
            >
              Cancel
            </Button>
            <Button
              fullWidth
              variant="contained"
              onClick={handleBulkSetPassword}
              disabled={actionLoading || !bulkPasswordInput.trim()}
              sx={{
                bgcolor: '#3399FF',
                '&:hover': { bgcolor: '#1976D2' },
                '&.Mui-disabled': { bgcolor: '#3399FF44', color: '#FFFFFF44' },
              }}
            >
              {actionLoading ? 'Setting…' : 'Set Password'}
            </Button>
          </Stack>
        </Box>
      </Modal>

      {/* ── Remove Password dialog ── */}
      <Dialog
        open={removePasswordDialogOpen}
        onClose={() => !actionLoading && setRemovePasswordDialogOpen(false)}
        slotProps={{ paper: { sx: { ...dialogPaperSx, minWidth: 380 } } }}
      >
        <DialogTitle sx={dialogTitleSx}>Remove Password?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ color: '#FFFFFFAA' }}>
            This will remove the password from {selected.size} selected file{selected.size !== 1 ? 's' : ''}. Anyone
            with the link will be able to view the video{selected.size !== 1 ? 's' : ''} without a password.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
          <Button
            onClick={() => setRemovePasswordDialogOpen(false)}
            disabled={actionLoading}
            sx={{ color: '#FFFFFF88', textTransform: 'none' }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleBulkRemovePassword}
            disabled={actionLoading}
            startIcon={actionLoading ? <CircularProgress size={14} color="inherit" /> : <LockOpenIcon />}
            sx={{ textTransform: 'none' }}
          >
            {actionLoading ? 'Removing…' : 'Remove Password'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── Orphan cleanup confirmation dialog ── */}
      <Dialog
        open={orphanDialogOpen}
        onClose={() => !orphanLoading && setOrphanDialogOpen(false)}
        slotProps={{ paper: { sx: { ...dialogPaperSx, minWidth: 380 } } }}
      >
        <DialogTitle sx={dialogTitleSx}>Clean Up Orphaned Derived Folders?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ color: '#FFFFFFAA' }}>
            Found {orphans.length} orphaned derived folder{orphans.length !== 1 ? 's' : ''} totalling{' '}
            {formatSize(orphanTotalSize)}. These folders have no matching video in the database and can be safely
            deleted.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
          <Button
            onClick={() => setOrphanDialogOpen(false)}
            disabled={orphanLoading}
            sx={{ color: '#FFFFFF88', textTransform: 'none' }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleCleanupOrphans}
            disabled={orphanLoading}
            startIcon={orphanLoading ? <CircularProgress size={14} color="inherit" /> : <DeleteSweepIcon />}
            sx={{ textTransform: 'none' }}
          >
            {orphanLoading ? 'Cleaning…' : `Delete ${orphans.length} folder${orphans.length !== 1 ? 's' : ''}`}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
