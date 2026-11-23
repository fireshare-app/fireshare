import { ConfigService } from '../services'
import { setSetting } from './utils'

let pending = null

/**
 * The public config (/api/config), fetched once per page load and shared by everything
 * that needs it, then cached in settings for the code that reads it synchronously.
 *
 * The player waits on this rather than reading the cache: on a browser's first visit
 * the cache is empty until this request returns, and the starting quality is decided
 * once, when the player mounts. Pass `refresh` after the config has changed.
 */
export const loadUiConfig = ({ refresh = false } = {}) => {
  if (pending && !refresh) return pending
  const request = ConfigService.getConfig().then((res) => {
    const config = res.data
    setSetting('ui_config', config)
    setSetting('demo_mode', config.demo_mode || false)
    setSetting('is_demo_user', config.is_demo_user || false)
    setSetting('upload_limit_mb', config.upload_limit_mb || 0)
    return config
  })
  // A failed request is not kept, so the next caller asks again.
  request.catch(() => {
    if (pending === request) pending = null
  })
  pending = request
  return request
}
