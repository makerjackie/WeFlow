/**
 * ExportV2 — progressive session metrics
 *
 * Message totals are loaded for the whole session list in one lightweight
 * table scan. Rich media metrics are loaded lazily for the currently visible
 * rows, so opening Export no longer launches thousands of expensive scans.
 */

import { create } from 'zustand'

export interface SessionContentMetric {
  totalMessages?: number
  voiceMessages?: number
  imageMessages?: number
  videoMessages?: number
  emojiMessages?: number
  fileMessages?: number
  systemMessages?: number
  appMessages?: number
}

export interface SessionMetricsProgress {
  active: boolean
  completed: number
  total: number
}

const DETAIL_CHUNK_SIZE = 24
const backgroundRefreshingIds = new Set<string>()

function normalizeIds(sessionIds: string[]): string[] {
  return Array.from(new Set(sessionIds.map(id => String(id || '').trim()).filter(Boolean)))
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
  return chunks
}

function toMetric(sessionStat: Record<string, any>, previous?: SessionContentMetric): SessionContentMetric {
  return {
    ...previous,
    totalMessages: Number.isFinite(sessionStat.totalMessages)
      ? Math.max(0, Math.floor(sessionStat.totalMessages))
      : previous?.totalMessages,
    voiceMessages: Math.max(0, Math.floor(Number(sessionStat.voiceMessages || 0))),
    imageMessages: Math.max(0, Math.floor(Number(sessionStat.imageMessages || 0))),
    videoMessages: Math.max(0, Math.floor(Number(sessionStat.videoMessages || 0))),
    emojiMessages: Math.max(0, Math.floor(Number(sessionStat.emojiMessages || 0))),
    fileMessages: Math.max(0, Math.floor(Number(sessionStat.fileMessages || 0)))
  }
}

interface SessionMetricsState {
  metricsMap: Record<string, SessionContentMetric>
  isLoading: boolean
  error: Error | null
  loadingRefs: Set<string>
  messageCountLoadingRefs: Set<string>
  messageCountProgress: SessionMetricsProgress
  detailProgress: SessionMetricsProgress
  fetchMessageCounts: (sessionIds: string[], options?: { forceRefresh?: boolean }) => Promise<void>
  fetchMetrics: (sessionIds: string[], options?: { forceRefresh?: boolean }) => Promise<void>
}

async function refreshMetricsInBackground(sessionIds: string[]): Promise<void> {
  const targetIds = normalizeIds(sessionIds).filter(id => !backgroundRefreshingIds.has(id))
  if (targetIds.length === 0) return

  targetIds.forEach(id => backgroundRefreshingIds.add(id))
  try {
    for (const chunk of chunkArray(targetIds, DETAIL_CHUNK_SIZE)) {
      const stats = await window.electronAPI.chat.getExportSessionStats(chunk, {
        includeRelations: false,
        forceRefresh: true
      })
      if (!stats.success || !stats.data) continue
      useSessionMetrics.setState(state => {
        const next = { ...state.metricsMap }
        for (const [sessionId, sessionStat] of Object.entries(stats.data || {})) {
          next[sessionId] = toMetric(sessionStat, next[sessionId])
        }
        return { metricsMap: next }
      })
    }
  } catch (error) {
    console.error('Failed to refresh visible session metrics:', error)
  } finally {
    targetIds.forEach(id => backgroundRefreshingIds.delete(id))
  }
}

export const useSessionMetrics = create<SessionMetricsState>((set, get) => ({
  metricsMap: {},
  isLoading: false,
  error: null,
  loadingRefs: new Set(),
  messageCountLoadingRefs: new Set(),
  messageCountProgress: { active: false, completed: 0, total: 0 },
  detailProgress: { active: false, completed: 0, total: 0 },

  fetchMessageCounts: async (sessionIds, options) => {
    const forceRefresh = options?.forceRefresh === true
    const state = get()
    const normalizedIds = normalizeIds(sessionIds)
    const targetIds = normalizedIds.filter(id =>
      !state.messageCountLoadingRefs.has(id) &&
      (forceRefresh || state.metricsMap[id]?.totalMessages === undefined)
    )
    if (targetIds.length === 0) return

    const nextLoadingRefs = new Set(state.messageCountLoadingRefs)
    targetIds.forEach(id => nextLoadingRefs.add(id))
    set({
      isLoading: true,
      error: null,
      messageCountLoadingRefs: nextLoadingRefs,
      messageCountProgress: { active: true, completed: 0, total: targetIds.length }
    })

    try {
      // One request intentionally covers the full list: the backend scans each
      // concrete message DB once and maps the requested session hashes in memory.
      const result = await window.electronAPI.chat.getSessionMessageCounts(targetIds, {
        preferHintCache: false,
        bypassSessionCache: forceRefresh
      })
      if (!result.success || !result.counts) {
        throw new Error(result.error || '读取总消息数失败')
      }
      const countMap = result.counts
      const invalidSessionId = targetIds.find((sessionId) => (
        !Object.prototype.hasOwnProperty.call(countMap, sessionId) ||
        !Number.isFinite(countMap[sessionId])
      ))
      if (invalidSessionId) {
        throw new Error(`总消息数结果不完整，请重试`)
      }

      set(current => {
        const next = { ...current.metricsMap }
        for (const sessionId of targetIds) {
          const rawCount = countMap[sessionId]
          const totalMessages = Math.max(0, Math.floor(Number(rawCount)))
          next[sessionId] = { ...next[sessionId], totalMessages }
        }
        return {
          metricsMap: next,
          messageCountProgress: { active: true, completed: targetIds.length, total: targetIds.length }
        }
      })
    } catch (error) {
      console.error('Failed to fetch session message counts:', error)
      set({ error: error instanceof Error ? error : new Error(String(error)) })
    } finally {
      set(current => {
        const refs = new Set(current.messageCountLoadingRefs)
        targetIds.forEach(id => refs.delete(id))
        return {
          messageCountLoadingRefs: refs,
          messageCountProgress: { active: refs.size > 0, completed: 0, total: refs.size },
          isLoading: refs.size > 0 || current.loadingRefs.size > 0
        }
      })
    }
  },

  fetchMetrics: async (sessionIds, options) => {
    const forceRefresh = options?.forceRefresh === true
    const state = get()
    const targetIds = normalizeIds(sessionIds).filter(id =>
      !state.loadingRefs.has(id) &&
      (forceRefresh || state.metricsMap[id]?.voiceMessages === undefined)
    )
    if (targetIds.length === 0) return

    const nextLoadingRefs = new Set(state.loadingRefs)
    targetIds.forEach(id => nextLoadingRefs.add(id))
    set({
      isLoading: true,
      error: null,
      loadingRefs: nextLoadingRefs,
      detailProgress: { active: true, completed: 0, total: targetIds.length }
    })

    try {
      const staleIds = new Set<string>()
      let completed = 0
      for (const chunk of chunkArray(targetIds, DETAIL_CHUNK_SIZE)) {
        const stats = await window.electronAPI.chat.getExportSessionStats(chunk, {
          includeRelations: false,
          forceRefresh,
          allowStaleCache: !forceRefresh
        })
        if (!stats.success) throw new Error(stats.error || '读取消息类型统计失败')

        completed += chunk.length
        set(current => {
          const next = { ...current.metricsMap }
          for (const [sessionId, sessionStat] of Object.entries(stats.data || {})) {
            next[sessionId] = toMetric(sessionStat, next[sessionId])
          }
          return {
            metricsMap: next,
            detailProgress: { active: true, completed, total: targetIds.length }
          }
        })

        if (!forceRefresh && Array.isArray(stats.needsRefresh)) {
          stats.needsRefresh.forEach(id => staleIds.add(id))
        }
      }

      if (!forceRefresh && staleIds.size > 0) {
        void refreshMetricsInBackground(Array.from(staleIds))
      }
    } catch (error) {
      console.error('Failed to fetch visible session metrics:', error)
      set({ error: error instanceof Error ? error : new Error(String(error)) })
    } finally {
      set(current => {
        const refs = new Set(current.loadingRefs)
        targetIds.forEach(id => refs.delete(id))
        return {
          loadingRefs: refs,
          detailProgress: { active: refs.size > 0, completed: 0, total: refs.size },
          isLoading: refs.size > 0 || current.messageCountLoadingRefs.size > 0
        }
      })
    }
  }
}))
