import Api from './Api'
import { getGameAssetUrl } from '../common/utils'

// Module-level map: steamgriddb_id -> bust timestamp, persists across navigation
const _assetBusts = {}

export const recordAssetBust = (steamgriddbId) => {
  _assetBusts[steamgriddbId] = Date.now()
}

export const applyAssetBusts = (games) => {
  return games.map((g) => {
    const bust = _assetBusts[g.steamgriddb_id]
    if (!bust) return g
    return {
      ...g,
      hero_url: getGameAssetUrl(g.steamgriddb_id, 'hero_1', bust),
      banner_url: getGameAssetUrl(g.steamgriddb_id, 'hero_2', bust),
      logo_url: getGameAssetUrl(g.steamgriddb_id, 'logo_1', bust),
      icon_url: getGameAssetUrl(g.steamgriddb_id, 'icon_1', bust),
    }
  })
}

const service = {
  searchSteamGrid(query) {
    return Api().get('/api/steamgrid/search', {
      params: {
        query,
      },
    })
  },
  getGameAssets(gameId) {
    return Api().get(`/api/steamgrid/game/${gameId}/assets`)
  },
  getGameAssetOptions(gameId) {
    return Api().get(`/api/steamgrid/game/${gameId}/assets/options`)
  },
  updateGameAsset(gameId, assetType, url) {
    return Api().put(`/api/games/${gameId}/assets`, { asset_type: assetType, url })
  },
  // Custom games carry their artwork as multipart uploads. The server crops and
  // re-encodes every image, which can outlast the default timeout on large files.
  createCustomGame(formData) {
    return Api().post('/api/games/custom', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000,
    })
  },
  updateCustomGame(gameId, formData) {
    return Api().put(`/api/games/custom/${gameId}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000,
    })
  },
  getGames() {
    return Api().get('/api/games')
  },
  getGameVideos(gameId) {
    return Api().get(`/api/games/${gameId}/videos`)
  },
  getGameImages(gameId) {
    return Api().get(`/api/games/${gameId}/images`)
  },
  createGame(gameData) {
    return Api().post('/api/games', gameData)
  },
  linkVideoToGame(videoId, gameId) {
    return Api().post(`/api/videos/${videoId}/game`, {
      game_id: gameId,
    })
  },
  getVideoGame(videoId) {
    return Api().get(`/api/videos/${videoId}/game`)
  },
  unlinkVideoFromGame(videoId) {
    return Api().delete(`/api/videos/${videoId}/game`)
  },
  deleteGame(gameId, deleteVideos = false) {
    return Api().delete(`/api/games/${gameId}`, {
      params: {
        delete_videos: deleteVideos,
      },
    })
  },
  getFolderSuggestions() {
    return Api().get('/api/folder-suggestions')
  },
  dismissFolderSuggestion(folderName) {
    return Api().post(`/api/folder-suggestions/${encodeURIComponent(folderName)}/dismiss`)
  },
  getFolderRules() {
    return Api().get('/api/folder-rules')
  },
  createFolderRule(folderPath, gameId) {
    return Api().post('/api/folder-rules', {
      folder_path: folderPath,
      game_id: gameId,
    })
  },
  deleteFolderRule(ruleId, unlinkVideos = false) {
    return Api().delete(`/api/folder-rules/${ruleId}`, {
      params: {
        unlink_videos: unlinkVideos,
      },
    })
  },
  getImageFolderRules() {
    return Api().get('/api/image-folder-rules')
  },
  createImageFolderRule(folderPath, gameId) {
    return Api().post('/api/image-folder-rules', {
      folder_path: folderPath,
      game_id: gameId,
    })
  },
  deleteImageFolderRule(ruleId, unlinkImages = false) {
    return Api().delete(`/api/image-folder-rules/${ruleId}`, {
      params: {
        unlink_images: unlinkImages,
      },
    })
  },
}

export default service
