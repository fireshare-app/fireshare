import React from 'react'
import { ListItemIcon, Menu, MenuItem } from '@mui/material'

// The ⋮ menu on video and image cards. Each card builds its own list of items;
// hidden items and items that need a signed-in user are dropped here.
const CardMenu = ({ anchorEl, onClose, items, authenticated }) => (
  <Menu
    anchorEl={anchorEl}
    open={Boolean(anchorEl)}
    onClose={onClose}
    onClick={(e) => e.stopPropagation()}
    transformOrigin={{ horizontal: 'right', vertical: 'top' }}
    anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
    slotProps={{
      paper: {
        sx: {
          bgcolor: '#0b132b',
          border: '1px solid #FFFFFF14',
          borderRadius: '10px',
          minWidth: 160,
          boxShadow: '0 8px 32px #00000099',
          mt: 0.5,
        },
      },
    }}
  >
    {items
      .filter((item) => !item.hidden)
      .filter((item) => !item.requiresAuth || authenticated)
      .map(({ label, Icon, iconColor, danger, onClick }) => (
        <MenuItem
          key={label}
          onClick={() => {
            onClick?.()
            onClose()
          }}
          sx={{
            gap: 1.5,
            py: 1.25,
            fontSize: 14,
            color: danger ? '#EF5350' : '#FFFFFFE6',
            bgcolor: danger ? '#EF535012' : 'transparent',
            '&:hover': { bgcolor: danger ? '#EF535028' : '#FFFFFF12' },
          }}
        >
          <ListItemIcon sx={{ minWidth: 0, color: danger ? '#EF5350' : iconColor || 'white' }}>
            <Icon fontSize="small" />
          </ListItemIcon>
          {label}
        </MenuItem>
      ))}
  </Menu>
)

export default CardMenu
