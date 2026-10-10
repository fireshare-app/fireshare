import Api from './Api'

const service = {
  getVideos(sort = 'updated_at desc') {
    return Api().get('/api/videos', {
      params: {
        sort,
      },
    })
  },
  getPublicVideos(sort = 'updated_at desc') {
    return Api().get('/api/videos/public', {
      params: {
        sort,
      },
    })
  },
  getDetails(id) {
    return Api().get(`/api/video/details/${id}`)
  },
  getRandomVideo() {
    return Api().get('/api/video/random')
  },
  getRandomPublicVideo() {
    return Api().get('/api/video/public/random')
  },
  getSuggestions(videoId, count = 6) {
    return Api().get('/api/video/suggestions', {
      params: { video_id: videoId, count },
    })
  },
  getViews(id) {
    return Api().get(`/api/video/${id}/views`)
  },
  getUploadFolders() {
    return Api().get('/api/upload-folders')
  },
  getPublicUploadFolders() {
    return Api().get('/api/upload-folders/public')
  },
  updateTitle(id, title) {
    return Api().put(`/api/video/details/${id}`, {
      title,
    })
  },
  updatePrivacy(id, value) {
    return Api().put(`/api/video/details/${id}`, {
      private: value,
    })
  },
  updateDetails(id, details) {
    return Api().put(`/api/video/details/${id}`, {
      ...details,
    })
  },
  addView(id) {
    return Api().post(`/api/video/view`, {
      video_id: id,
    })
  },
  delete(id) {
    return Api().delete(`/api/video/delete/${id}`)
  },
  move(id, folder) {
    return Api().post(`/api/video/move/${id}`, { folder })
  },
  upload(formData, uploadProgress) {
    return Api().post('/api/upload', formData, {
      timeout: 999999999,
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: (progressEvent) => {
        const progress = progressEvent.loaded / progressEvent.total
        uploadProgress(progress, {
          loaded: progressEvent.loaded / Math.pow(10, 6),
          total: progressEvent.total / Math.pow(10, 6),
        })
      },
    })
  },
  publicUpload(formData, uploadProgress) {
    return Api().post('/api/upload/public', formData, {
      timeout: 999999999,
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: (progressEvent) => {
        const progress = progressEvent.loaded / progressEvent.total
        console.log(progressEvent)
        uploadProgress(progress, {
          loaded: progressEvent.loaded / Math.pow(10, 6),
          total: progressEvent.total / Math.pow(10, 6),
        })
      },
    })
  },
  uploadChunked(formData, uploadProgress, totalSize, alreadyUploaded) {
    return Api().post('/api/uploadChunked', formData, {
      timeout: 600000,
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: (progressEvent) => {
        const progressTotal = (progressEvent.loaded + alreadyUploaded) / totalSize
        const progress = progressEvent.loaded / progressEvent.total
        uploadProgress(progress, progressTotal, {
          loaded: (progressEvent.loaded + alreadyUploaded) / Math.pow(10, 6),
          total: totalSize / Math.pow(10, 6),
        })
      },
    })
  },
  publicUploadChunked(formData, uploadProgress, totalSize, alreadyUploaded) {
    return Api().post('/api/uploadChunked/public', formData, {
      timeout: 600000,
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: (progressEvent) => {
        const progressTotal = (progressEvent.loaded + alreadyUploaded) / totalSize
        const progress = progressEvent.loaded / progressEvent.total
        uploadProgress(progress, progressTotal, {
          loaded: (progressEvent.loaded + alreadyUploaded) / Math.pow(10, 6),
          total: totalSize / Math.pow(10, 6),
        })
      },
    })
  },
  scan() {
    return Api().get('/api/manual/scan')
  },
  scanGames() {
    return Api().get('/api/manual/scan-games')
  },
  scanDates() {
    return Api().get('/api/manual/scan-dates')
  },
  rescanDates() {
    return Api().get('/api/manual/rescan-dates')
  },
  scanFolders() {
    return Api().get('/api/manual/scan-folders')
  },
  getGameSuggestion(videoId) {
    return Api().get(`/api/videos/${videoId}/game/suggestion`)
  },
  rejectGameSuggestion(videoId) {
    return Api().delete(`/api/videos/${videoId}/game/suggestion`)
  },
  getTonemapCapabilities() {
    return Api().get('/api/video/tonemap/capabilities')
  },
  getTonemapFrames(id, count = 3) {
    return Api().get(`/api/video/${id}/tonemap/frames`, { params: { count } })
  },
  // Apply an operator, or null to remove the SDR copy. The server rebuilds in the background.
  setTonemap(id, tonemap) {
    return Api().put(`/api/video/details/${id}`, { tonemap })
  },
  uploadCustomPoster(id, formData) {
    return Api().post(`/api/video/${id}/poster/custom`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  deleteCustomPoster(id) {
    return Api().delete(`/api/video/${id}/poster/custom`)
  },
  unlockVideo(videoId, password) {
    return Api().post(`/api/video/${videoId}/unlock`, { password })
  },
  setPassword(videoId, password) {
    return Api().put(`/api/video/details/${videoId}`, { password })
  },
  generatePassword(videoId) {
    return Api().put(`/api/video/details/${videoId}`, { password: '__autogenerate__' })
  },
  removePassword(videoId) {
    return Api().put(`/api/video/details/${videoId}`, { remove_password: true })
  },
}

export default service
