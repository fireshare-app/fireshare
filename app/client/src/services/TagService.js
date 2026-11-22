import Api from './Api'

const service = {
  getTags() {
    return Api().get('/api/tags')
  },
  getTagVideos(tagId) {
    return Api().get(`/api/tags/${tagId}/videos`)
  },
  createTag(data) {
    return Api().post('/api/tags', data)
  },
  // The tag by this name, made if there is none yet. The server answers 409 with the
  // existing tag when there is one, including one the client did not know about: made
  // elsewhere since the tags were loaded, or "my tag" when "my_tag" exists.
  findOrCreateTag(name) {
    return Api()
      .post('/api/tags', { name })
      .catch((err) => {
        if (err.response?.status === 409 && err.response.data?.id) return err.response
        throw err
      })
  },
  updateTag(tagId, data) {
    return Api().put(`/api/tags/${tagId}`, data)
  },
  deleteTag(tagId, deleteVideos = false) {
    return Api().delete(`/api/tags/${tagId}`, {
      params: { delete_videos: deleteVideos },
    })
  },
  getVideoTags(videoId) {
    return Api().get(`/api/videos/${videoId}/tags`)
  },
  addTagToVideo(videoId, tagId) {
    return Api().post(`/api/videos/${videoId}/tags`, { tag_id: tagId })
  },
  removeTagFromVideo(videoId, tagId) {
    return Api().delete(`/api/videos/${videoId}/tags/${tagId}`)
  },
  bulkAssign(tagId, videoIds) {
    return Api().post('/api/tags/bulk-assign', { tag_id: tagId, video_ids: videoIds })
  },
  bulkRemove(tagId, videoIds) {
    return Api().post('/api/tags/bulk-remove', { tag_id: tagId, video_ids: videoIds })
  },
}

export default service
