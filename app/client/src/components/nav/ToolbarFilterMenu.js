import * as React from 'react'

import Box from '@mui/material/Box'
import Popover from '@mui/material/Popover'
import Typography from '@mui/material/Typography'
import IconButton from '@mui/material/IconButton'
import TuneIcon from '@mui/icons-material/Tune'
import Select from 'react-select'

import { folderSelectTheme } from '../../common/reactSelectThemes'

// The app bar on a phone has to fit the drawer toggle, the page's filter
// selects and the edit/search buttons in ~400px. Three selects alone overflow
// that, so on xs the filters collapse behind this single button and open in a
// popover where each one gets a full-width row and a label.
const MENU_WIDTH = 260

// A multi-select (the tag filter) is active when anything is picked.
const isFilterActive = (filter) =>
  Array.isArray(filter.value)
    ? filter.value.length > 0
    : filter.defaultValue !== undefined && filter.value?.value !== undefined && filter.value.value !== filter.defaultValue

export default function ToolbarFilterMenu({ filters }) {
  const [anchorEl, setAnchorEl] = React.useState(null)

  const visible = filters.filter(Boolean)
  if (visible.length === 0) return null

  const activeCount = visible.filter(isFilterActive).length

  return (
    <>
      <IconButton
        onClick={(e) => setAnchorEl(e.currentTarget)}
        aria-label="filters"
        sx={{
          position: 'relative',
          border: '1px solid',
          borderColor: anchorEl ? '#FFFFFF55' : '#FFFFFF33',
          borderRadius: '8px',
          height: '38px',
          width: '38px',
          flexShrink: 0,
          bgcolor: anchorEl ? '#FFFFFF18' : 'transparent',
          color: '#FFFFFFCC',
          '&:hover': { borderColor: '#FFFFFF66', bgcolor: '#FFFFFF0D' },
        }}
      >
        <TuneIcon fontSize="small" />
        {activeCount > 0 && (
          <Box
            sx={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 7,
              height: 7,
              borderRadius: '50%',
              bgcolor: '#3399FF',
            }}
          />
        )}
      </IconButton>
      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: {
              mt: 1,
              width: MENU_WIDTH,
              maxWidth: 'calc(100vw - 24px)',
              p: 1.5,
              borderRadius: '8px',
              backgroundColor: '#0b132b',
              border: '1px solid #FFFFFF1A',
              boxShadow: '0 8px 24px #00000066',
              backgroundImage: 'none',
            },
          },
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {visible.map((filter) => (
            <Box key={filter.key}>
              <Typography
                sx={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: '#FFFFFF66',
                  mb: 0.5,
                }}
              >
                {filter.label}
              </Typography>
              {/* A filter can bring its own control, as the tag filter does. */}
              {filter.render || (
                <Select
                  value={filter.value}
                  options={filter.options}
                  onChange={filter.onChange}
                  styles={folderSelectTheme}
                  menuPortalTarget={document.body}
                  menuPosition="fixed"
                  blurInputOnSelect
                  isSearchable={false}
                  {...filter.selectProps}
                />
              )}
            </Box>
          ))}
        </Box>
      </Popover>
    </>
  )
}
