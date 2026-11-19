import Api from './Api'

const service = {
  getImages(sort = 'updated_at desc') {
    return Api().get('/api/images', { params: { sort } })
  },
  getPublicImages(sort = 'updated_at desc') {
    return Api().get('/api/images/public', { params: { sort } })
  },
  scan() {
    return Api().get('/api/manual/scan-images')
  },
  getUploadFolders() {
    return Api().get('/api/upload/image/folders')
  },
  getPublicUploadFolders() {
    return Api().get('/api/upload/image-folders/public')
  },
  getDetails(id) {
    return Api().get(`/api/image/details/${id}`)
  },
  getViews(id) {
    return Api().get(`/api/image/${id}/views`)
  },
  updateDetails(id, details) {
    return Api().put(`/api/image/details/${id}`, { ...details })
  },
  updatePrivacy(id, value) {
    return Api().put(`/api/image/details/${id}`, { private: value })
  },
  addView(id) {
    return Api().post('/api/image/view', { image_id: id })
  },
  delete(id) {
    return Api().delete(`/api/image/delete/${id}`)
  },
  move(id, folder) {
    return Api().post(`/api/image/move/${id}`, { folder })
  },
  getOriginalUrl(id) {
    return `/api/image/original?id=${id}`
  },
  upload(formData, uploadProgress) {
    return Api().post('/api/upload/image', formData, {
      timeout: 999999999,
      headers: { 'Content-Type': 'multipart/form-data' },
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
    return Api().post('/api/upload/image/public', formData, {
      timeout: 999999999,
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (progressEvent) => {
        const progress = progressEvent.loaded / progressEvent.total
        uploadProgress(progress, {
          loaded: progressEvent.loaded / Math.pow(10, 6),
          total: progressEvent.total / Math.pow(10, 6),
        })
      },
    })
  },
  linkGame(imageId, gameId) {
    return Api().post(`/api/images/${imageId}/game`, { game_id: gameId })
  },
  getGame(imageId) {
    return Api().get(`/api/images/${imageId}/game`)
  },
  unlinkGame(imageId) {
    return Api().delete(`/api/images/${imageId}/game`)
  },
  addTag(imageId, tagId) {
    return Api().post(`/api/images/${imageId}/tags`, { tag_id: tagId })
  },
  removeTag(imageId, tagId) {
    return Api().delete(`/api/images/${imageId}/tags/${tagId}`)
  },
  getThumbnailUrl(imageId) {
    return `/api/image/thumbnail?id=${imageId}`
  },
  getImageUrl(imageId) {
    return `/api/image?id=${imageId}`
  },
}

export default service
