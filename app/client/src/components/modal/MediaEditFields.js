import React from 'react'
import { Autocomplete, Box, IconButton, TextField, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import GameSearch from '../game/GameSearch'
import TagChip from '../ui/TagChip'
import { inputSx, labelSx, rowBoxSx } from './MediaModalShell'

// Edit-mode fields the video and image modals share.

// The linked game with a button to unlink it, or a search to link one.
export const GameField = ({ game, onLinked, onUnlink, onError }) => (
  <Box>
    <Typography sx={labelSx}>Game</Typography>
    {game ? (
      <Box sx={rowBoxSx}>
        {game.icon_url && (
          <img
            src={game.icon_url}
            alt=""
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
            style={{ width: 20, height: 20, objectFit: 'contain', borderRadius: 3, flexShrink: 0 }}
          />
        )}
        <Typography
          sx={{ fontSize: 14, color: 'white', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {game.name}
        </Typography>
        <IconButton
          size="small"
          aria-label="Unlink game"
          onClick={onUnlink}
          sx={{ color: '#FFFFFF66', '&:hover': { color: 'white' }, p: 0.25 }}
        >
          <CloseIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>
    ) : (
      <Box
        sx={{
          ...rowBoxSx,
          py: 0,
          overflow: 'hidden',
          '& .MuiInputBase-root': { color: 'white', px: 0 },
          '& input::placeholder': { color: '#FFFFFF66', opacity: 1 },
          '& .MuiSvgIcon-root': { color: '#FFFFFF66' },
        }}
      >
        <GameSearch onGameLinked={onLinked} onError={onError} placeholder="Search for a game..." />
      </Box>
    )}
  </Box>
)

// Tags as chips with a box to add more. Typing a name that doesn't exist yet
// creates it; a comma adds several at once.
export const TagsField = ({ tags, allTags, onAdd, onRemove }) => {
  const [inputValue, setInputValue] = React.useState('')
  const add = (tag) => {
    setInputValue('')
    onAdd(tag)
  }
  const findTag = (name) => allTags.find((t) => t.name.toLowerCase() === name.toLowerCase())

  return (
    <Box>
      <Typography sx={labelSx}>Tags</Typography>
      <Autocomplete
        multiple
        freeSolo
        componentsProps={{ root: { sx: { '& .MuiAutocomplete-tag': { my: 0.25 } } } }}
        sx={{ '& .MuiOutlinedInput-root': { gap: 0.5 } }}
        options={allTags.filter((t) => !tags.find((existing) => existing.id === t.id))}
        getOptionLabel={(option) => (typeof option === 'string' ? option : option.name)}
        value={tags}
        inputValue={inputValue}
        onInputChange={(_, v) => setInputValue(v)}
        onChange={(_, newValues) => {
          if (newValues.length > tags.length) {
            const added = newValues[newValues.length - 1]
            add(typeof added === 'string' ? { name: added } : added)
          }
        }}
        renderTags={(value) =>
          value.map((tag) => (
            <TagChip key={tag.id} name={tag.name} color={tag.color} size="small" onDelete={() => onRemove(tag.id)} />
          ))
        }
        renderInput={(params) => (
          <TextField
            {...params}
            size="small"
            placeholder={tags.length === 0 ? 'Add a tag...' : ''}
            sx={inputSx}
            inputProps={{ ...params.inputProps, maxLength: 12 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && inputValue.trim()) {
                e.preventDefault()
                add(findTag(inputValue.trim()) || { name: inputValue.trim() })
              }
              if (e.key === ',') {
                e.preventDefault()
                const parts = inputValue
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
                setInputValue('')
                parts.forEach((p) => onAdd(findTag(p) || { name: p }))
              }
            }}
          />
        )}
      />
    </Box>
  )
}
