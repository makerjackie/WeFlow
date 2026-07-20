/**
 * ExportV2 — Session utility functions
 * Pure functions for session classification, sorting, and merging.
 */

import type { ChatSession as AppChatSession, ContactInfo } from '../../../types/models'
import type { ConversationTab, DisplayNamePreference, SessionRow } from '../types'
import { displayNameOrFallback, pickDisplayName } from '../../../utils/displayName'

// ─── Session type classification ─────────────────────────────

export const toKindByContactType = (session: AppChatSession, contact?: ContactInfo): ConversationTab => {
  if (session.username.endsWith('@chatroom')) return 'group'
  if (session.username.startsWith('gh_')) return 'official'
  if (contact?.type === 'official') return 'official'
  if (contact?.type === 'former_friend') return 'former_friend'
  return 'private'
}

export const toKindByContact = (contact: ContactInfo): ConversationTab => {
  if (contact.type === 'group') return 'group'
  if (contact.type === 'official') return 'official'
  if (contact.type === 'former_friend') return 'former_friend'
  return 'private'
}

// ─── Session filtering predicates ────────────────────────────

export const isContentScopeSession = (session: SessionRow): boolean =>
  session.kind === 'private' || session.kind === 'group' || session.kind === 'former_friend'

export const isExportConversationSession = (session: SessionRow): boolean =>
  session.kind === 'private' || session.kind === 'group' || session.kind === 'former_friend'

export const isSingleContactSession = (sessionId: string): boolean => {
  const normalized = String(sessionId || '').trim()
  if (!normalized) return false
  if (normalized.includes('@chatroom')) return false
  if (normalized.startsWith('gh_')) return false
  return true
}

export const matchesContactTab = (contact: ContactInfo, tab: ConversationTab): boolean => {
  if (tab === 'private') return contact.type === 'friend'
  if (tab === 'group') return contact.type === 'group'
  if (tab === 'official') return contact.type === 'official'
  return contact.type === 'former_friend'
}

// ─── Build session rows from sessions + contacts ─────────────

export const toSessionRowsWithContacts = (
  sessions: AppChatSession[],
  contactMap: Record<string, ContactInfo>
): SessionRow[] => {
  // Export is a chat-history operation, so the session database is the source
  // of truth. Contacts only enrich rows with names and avatars. Building this
  // list from the full address book included contacts with no message table,
  // which made them selectable even though every export engine had to fail.
  return (sessions || [])
    .map((session) => {
      const contact = contactMap[session.username]
      return {
        ...session,
        kind: toKindByContactType(session, contact),
        wechatId: contact?.username || session.username,
        displayName: displayNameOrFallback(session.username, contact?.displayName, session.displayName),
        avatarUrl: session.avatarUrl || contact?.avatarUrl,
        remark: contact?.remark,
        nickname: contact?.nickname,
        hasSession: true
      } as SessionRow
    })
    .sort((a, b) => (b.sortTimestamp || b.lastTimestamp || 0) - (a.sortTimestamp || a.lastTimestamp || 0))
}

// ─── Array equality check ────────────────────────────────────

export const areStringArraysEqual = (left: string[], right: string[]): boolean => {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export const getSelectionScopeFromRows = (rows: SessionRow[]): import('../types').TaskScope => {
  if (rows.length === 0) return 'single'
  if (rows.length === 1) return 'single'
  return 'multi'
}

export const resolveScopeDisplayNames = (
  rows: SessionRow[], 
  pref: DisplayNamePreference
): string[] => {
  return rows.map(r => {
    if (pref === 'nickname') return displayNameOrFallback(r.username, r.nickname, r.remark, r.displayName)
    return displayNameOrFallback(r.username, r.remark, r.nickname, r.displayName)
  })
}

// ─── Name comparison helper ──────────────────────────────────

export const toComparableNameSet = (values: Array<string | undefined | null>): Set<string> => {
  const set = new Set<string>()
  for (const value of values) {
    const normalized = pickDisplayName(value)?.trim() || ''
    if (!normalized) continue
    set.add(normalized)
  }
  return set
}
