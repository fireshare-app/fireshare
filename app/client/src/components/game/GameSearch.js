import React from 'react'
import { Autocomplete, TextField, InputAdornment, Box, CircularProgress } from '@mui/material'
import { GameService } from '../../services'

/**
 * Reusable game search autocomplete component
 * Searches SteamGridDB, creates game if needed, and calls onGameLinked callback
 */
const GameSearch = ({
  onGameLinked,
  onError,
  onWarning,
  disabled = false,
  placeholder = 'Search for a game...',
  sx = {},
}) => {
  const [selectedGame, setSelectedGame] = React.useState(null)
  const [gameOptions, setGameOptions] = React.useState([])
  const [gameSearchLoading, setGameSearchLoading] = React.useState(false)
  const [gameLinkLoading, setGameLinkLoading] = React.useState(false)

  const searchGames = async (query) => {
    if (!query || query.length < 2) {
      setGameOptions([])
      return
    }
    setGameSearchLoading(true)
    try {
      const results = (await GameService.searchSteamGrid(query)).data || []
      setGameOptions(results)
    } catch (err) {
      setGameOptions([])
    }
    setGameSearchLoading(false)
  }

  const handleGameChange = async (_, newValue) => {
    if (!newValue) {
      setSelectedGame(null)
      return
    }

    setSelectedGame(newValue)
    setGameLinkLoading(true)

    try {
      // Check if game already exists
      const allGames = (await GameService.getGames()).data
      let game = allGames.find((g) => g.steamgriddb_id === newValue.id)
      let pendingWarning = null

      if (!game) {
        // Create the game
        const assets = (await GameService.getGameAssets(newValue.id)).data
        const gameData = {
          steamgriddb_id: newValue.id,
          name: newValue.name,
          release_date: newValue.release_date
            ? new Date(newValue.release_date * 1000).toISOString().split('T')[0]
            : null,
          hero_url: assets.hero_url,
          logo_url: assets.logo_url,
          icon_url: assets.icon_url,
        }
        const created = (await GameService.createGame(gameData)).data
        if (created.missing_assets?.length) {
          const labels = { heroes: 'hero art', logos: 'logo', icons: 'icon' }
          const missing = created.missing_assets.map((k) => labels[k] || k)
          const missingStr =
            missing.length > 1 ? missing.slice(0, -1).join(', ') + ' and ' + missing[missing.length - 1] : missing[0]
          const verb = missing.length > 1 ? 'were' : 'was'
          pendingWarning = `No ${missingStr} ${verb} available on SteamGridDB.`
        }
        game = created
      }

      // Call the callback with the game, passing any warning as a second argument
      // so callers that fire their own success alert can merge the two messages
      if (onGameLinked) {
        onGameLinked(game, pendingWarning)
      }
      if (pendingWarning && onWarning) {
        onWarning(pendingWarning)
      }

      // Reset the autocomplete
      setSelectedGame(null)
      setGameOptions([])
    } catch (err) {
      console.error('Error creating/linking game:', err)
      if (onError) {
        onError(err)
      }
      setSelectedGame(null)
    } finally {
      setGameLinkLoading(false)
    }
  }

  return (
    <Autocomplete
      fullWidth
      value={selectedGame}
      onChange={handleGameChange}
      onInputChange={(_, val) => searchGames(val)}
      options={gameOptions}
      getOptionLabel={(option) => option.name || ''}
      loading={gameSearchLoading}
      disabled={disabled || gameLinkLoading}
      slotProps={{
        paper: {
          sx: {
            bgcolor: '#0b132b',
            border: '1px solid #FFFFFF1A',
            borderRadius: '8px',
            color: 'white',
            boxShadow: '0 8px 32px #00000099',
            '& .MuiAutocomplete-noOptions': { color: '#FFFFFF66' },
            '& .MuiAutocomplete-loading': { color: '#FFFFFF66' },
          },
        },
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          placeholder={placeholder}
          size="small"
          sx={{
            '& .MuiOutlinedInput-notchedOutline': { border: 'none' },
            ...sx,
          }}
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {gameLinkLoading && (
                  <InputAdornment position="end">
                    <CircularProgress size={20} sx={{ mr: 1 }} />
                  </InputAdornment>
                )}
                {params.InputProps.endAdornment}
              </>
            ),
          }}
        />
      )}
      renderOption={(props, option) => (
        <Box component="li" {...props} key={option.id}>
          {option.name}
          {option.release_date && ` (${new Date(option.release_date * 1000).getFullYear()})`}
          {option.custom ? (
            <Box
              component="span"
              sx={{ ml: 1, fontSize: 11, color: '#FFFFFF66', textTransform: 'uppercase', letterSpacing: '0.08em' }}
            >
              Custom
            </Box>
          ) : null}
        </Box>
      )}
    />
  )
}

export default GameSearch
