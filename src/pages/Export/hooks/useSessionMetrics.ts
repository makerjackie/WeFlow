/**
 * ExportV2 — useSessionMetrics hook
 *
 * Fetches and caches session content metrics (total messages, voice, image, video, etc.)
 * from the backend SQLite database.
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

const METRICS_CHUNK_SIZE = 160

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

interface SessionMetricsState {
  metricsMap: Record<string, SessionContentMetric>
  isLoading: boolean
  error: Error | null
  loadingRefs: Set<string>
  fetchMetrics: (sessionIds: string[], options?: { forceRefresh?: boolean }) => Promise<void>
}

export const useSessionMetrics = create<SessionMetricsState>((set, get) => ({
  metricsMap: {},
  isLoading: false,
  error: null,
  loadingRefs: new Set(),
  fetchMetrics: async (sessionIds: string[], options?: { forceRefresh?: boolean }) => {
    if (sessionIds.length === 0) return

    const forceRefresh = options?.forceRefresh === true
    const { metricsMap, loadingRefs } = get()
    const normalizedIds = Array.from(new Set(sessionIds.map(id => String(id || '').trim()).filter(Boolean)))
    const targetIds = forceRefresh
      ? normalizedIds.filter(id => !loadingRefs.has(id))
      : normalizedIds.filter(id => !metricsMap[id] && !loadingRefs.has(id))
    if (targetIds.length === 0) return

    set({ isLoading: true, error: null })

    const newLoadingRefs = new Set(loadingRefs)
    targetIds.forEach(id => newLoadingRefs.add(id))
    set(state => {
      if (!forceRefresh) {
        return { loadingRefs: newLoadingRefs }
      }

      const nextMetricsMap = { ...state.metricsMap }
      targetIds.forEach(id => {
        delete nextMetricsMap[id]
      })
      return {
        loadingRefs: newLoadingRefs,
        metricsMap: nextMetricsMap
      }
    })

    try {
      // 将会话分批顺序请求，每批返回后立即更新 UI，实现「扫出一个放一个」的渐进式效果。
      const chunks = chunkArray(targetIds, METRICS_CHUNK_SIZE)
      for (const chunk of chunks) {
        const stats = await window.electronAPI.chat.getExportSessionStats(chunk, {
          includeRelations: false,
          forceRefresh
        })

        const newMetrics: Record<string, SessionContentMetric> = {}
        if (stats.success && stats.data) {
          for (const [sessionId, sessionStat] of Object.entries(stats.data)) {
            newMetrics[sessionId] = {
              totalMessages: sessionStat.totalMessages,
              voiceMessages: sessionStat.voiceMessages,
              imageMessages: sessionStat.imageMessages,
              videoMessages: sessionStat.videoMessages,
              emojiMessages: sessionStat.emojiMessages,
              fileMessages: sessionStat.fileMessages ?? 0  // 文件消息数量，由后端 ExportSessionStats 返回
            }
          }
        }

        set(state => ({
          metricsMap: { ...state.metricsMap, ...newMetrics }
        }))
      }
    } catch (err) {
      console.error('Failed to fetch session metrics:', err)
      set({ error: err instanceof Error ? err : new Error(String(err)) })
    } finally {
      set(state => {
        const nextLoadingRefs = new Set(state.loadingRefs)
        targetIds.forEach(id => nextLoadingRefs.delete(id))
        return { loadingRefs: nextLoadingRefs, isLoading: nextLoadingRefs.size > 0 }
      })
    }
  }
}))
