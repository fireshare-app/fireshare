import { useEffect, useState } from 'react'

// How long to wait for the browser's answer before starting on the source anyway.
// decodingInfo() normally answers in a few milliseconds; the player is held back
// until it does, so a browser that never answers must not leave it blank.
const DECODING_INFO_TIMEOUT_MS = 1500

const decodingInfo = (media) =>
  Promise.race([
    navigator.mediaCapabilities.decodingInfo({ type: 'file', video: media }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('decodingInfo timed out')), DECODING_INFO_TIMEOUT_MS)),
  ])

/**
 * The index of the source to start on: the best quality, no higher than the one
 * already selected, that this device can decode in hardware, else the best of those
 * it can decode smoothly at all, else the one already selected. The selected one is
 * the source unless an admin set a lower default quality, which this never goes
 * above.
 *
 * The source can be something a transcode never is, such as 3440x1440 AV1 at 60 fps.
 * A browser without an AV1 decoder in hardware falls back to software, which cannot
 * keep up: the audio plays on while the picture freezes, then skips ahead out of sync.
 * Nothing buffers, so the stall-based downgrade never sees it.
 *
 * getVideoSources lists the source first and the transcodes from 1080p down, so the
 * first match is the best one. On a device with no hardware decoding at all nothing
 * is power efficient, and the source is kept, exactly as before.
 */
const pickStartingIndex = async (sources) => {
  const selected = Math.max(0, sources.findIndex((s) => s.selected))
  const results = await Promise.allSettled(
    sources.map((s, i) => (i >= selected && s.media ? decodingInfo(s.media) : Promise.reject())),
  )
  const info = results.map((r) => (r.status === 'fulfilled' ? r.value : null))

  const hardware = info.findIndex((r) => r?.supported && r.smooth && r.powerEfficient)
  if (hardware >= 0) return hardware
  const smooth = info.findIndex((r) => r?.supported && r.smooth)
  if (smooth >= 0) return smooth
  return selected
}

/**
 * The player's sources with `selected` moved to the one this device will actually
 * play well, or null while the browser is being asked.
 *
 * Returns the sources unchanged, without waiting, whenever there is nothing to
 * decide: one source, no codec known for the selected one, or no Media
 * Capabilities API (which browsers only expose to secure contexts, so a plain-http
 * instance behaves as it always has).
 */
const usePlayableSources = (sources) => {
  const key = sources?.map((s) => s.src).join('\n') || ''
  const selectedMedia = sources?.find((s) => s.selected)?.media
  const needsCheck = Boolean(sources?.length > 1 && selectedMedia && navigator.mediaCapabilities?.decodingInfo)
  const [decision, setDecision] = useState({ key: null, index: null })

  useEffect(() => {
    if (!needsCheck) return
    let cancelled = false
    pickStartingIndex(sources)
      .catch(() => Math.max(0, sources.findIndex((s) => s.selected)))
      .then((index) => {
        if (!cancelled) setDecision({ key, index })
      })
    return () => {
      cancelled = true
    }
    // `key` stands in for `sources`: the parent builds a new array on every render,
    // and asking again for the same URLs would only repeat the same answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, needsCheck])

  if (!needsCheck) return sources
  if (decision.key !== key) return null
  return sources.map((s, i) => ({ ...s, selected: i === decision.index }))
}

export default usePlayableSources
