import { parentPort, workerData } from 'worker_threads'
import { createHash } from 'crypto'
import { WcdbCore } from './services/wcdbCore'

const core = new WcdbCore()

const quoteSqlIdentifier = (value: string): string => `"${String(value || '').replace(/"/g, '""')}"`
const escapeSqlString = (value: string): string => String(value || '').replace(/'/g, "''")

const countSessionsByTableScan = async (
    sessionIds: string[]
): Promise<{ success: boolean; counts?: Record<string, number>; error?: string }> => {
    const normalizedIds = Array.from(new Set(
        (sessionIds || []).map(id => String(id || '').trim()).filter(Boolean)
    ))
    const counts = Object.fromEntries(normalizedIds.map(id => [id, 0])) as Record<string, number>
    if (normalizedIds.length === 0) return { success: true, counts }

    const fullHashLookup = new Map<string, string>()
    const shortHashLookup = new Map<string, string | null>()
    for (const sessionId of normalizedIds) {
        const hash = createHash('md5').update(sessionId).digest('hex').toLowerCase()
        fullHashLookup.set(hash, sessionId)
        const shortHash = hash.slice(0, 16)
        const existing = shortHashLookup.get(shortHash)
        shortHashLookup.set(shortHash, existing === undefined || existing === sessionId ? sessionId : null)
    }

    const matchSessionId = (tableName: string): string | null => {
        const normalized = String(tableName || '').trim().toLowerCase()
        if (!normalized.startsWith('msg_')) return null
        const suffix = normalized.slice(4)
        const full = fullHashLookup.get(suffix)
        if (full) return full
        const short = shortHashLookup.get(suffix.slice(0, 16))
        return typeof short === 'string' ? short : null
    }

    let dbResult = await core.listMessageDbs()
    if (dbResult.success && Array.isArray(dbResult.data) && dbResult.data.length === 0) {
        for (const sessionId of normalizedIds.slice(0, 48)) {
            const probe = await core.getMessages(sessionId, 1, 0)
            if (probe.success && Array.isArray(probe.messages) && probe.messages.length > 0) break
        }
        dbResult = await core.listMessageDbs()
    }
    if (!dbResult.success || !Array.isArray(dbResult.data)) {
        return { success: false, error: dbResult.error || '获取消息数据库列表失败' }
    }

    let listedDatabaseCount = 0
    let failedDatabaseCount = 0
    let matchedTableCount = 0
    let successfulQueryCount = 0
    let failedQueryCount = 0
    let lastError = ''
    for (const dbPathValue of dbResult.data) {
        const dbPath = String(dbPathValue || '').trim()
        if (!dbPath) continue
        const tablesResult = await core.listTables('message', dbPath)
        if (!tablesResult.success || !Array.isArray(tablesResult.tables)) {
            lastError = tablesResult.error || lastError
            failedDatabaseCount += 1
            continue
        }
        listedDatabaseCount += 1

        const matchedTables = tablesResult.tables
            .map(tableName => ({ tableName: String(tableName || '').trim(), sessionId: matchSessionId(tableName) }))
            .filter((item): item is { tableName: string; sessionId: string } => Boolean(item.tableName && item.sessionId))
        matchedTableCount += matchedTables.length

        // Keep each compound query comfortably below SQLite's compound-select
        // limit while counting every matched Msg table in one pass per chunk.
        const queryChunkSize = 80
        for (let offset = 0; offset < matchedTables.length; offset += queryChunkSize) {
            const chunk = matchedTables.slice(offset, offset + queryChunkSize)
            const sql = chunk.map(({ tableName }) => (
                `SELECT '${escapeSqlString(tableName)}' AS table_name, COUNT(*) AS cnt FROM ${quoteSqlIdentifier(tableName)}`
            )).join(' UNION ALL ')
            const queryResult = await core.execQuery('message', dbPath, sql)
            if (!queryResult.success || !Array.isArray(queryResult.rows)) {
                lastError = queryResult.error || lastError
                failedQueryCount += 1
                continue
            }
            successfulQueryCount += 1
            for (const row of queryResult.rows as Record<string, unknown>[]) {
                const sessionId = matchSessionId(String(row.table_name || ''))
                if (!sessionId) continue
                const rawCount = Number(row.cnt || 0)
                if (Number.isFinite(rawCount) && rawCount > 0) {
                    counts[sessionId] += Math.floor(rawCount)
                }
            }
        }
    }

    if (dbResult.data.length > 0 && listedDatabaseCount === 0) {
        return { success: false, error: lastError || '无法读取消息表列表' }
    }
    if (failedDatabaseCount > 0 || failedQueryCount > 0 || (matchedTableCount > 0 && successfulQueryCount === 0)) {
        return { success: false, error: lastError || '消息表统计不完整，请重试' }
    }
    return { success: true, counts }
}

// The native layer populates its message database registry lazily. Keep the
// refresh and the dependent operation in the same queued job so no contact,
// media, or second open request can run between them.
const MESSAGE_DB_DEPENDENT_REQUESTS = new Set([
    'getMessages',
    'getNewMessages',
    'getMessageCount',
    'getMessageByServerId',
    'getMessageCounts',
    'getSessionMessageCounts',
    'getSessionMessageTypeStats',
    'getSessionMessageTypeStatsBatch',
    'getSessionMessageDateCounts',
    'getSessionMessageDateCountsBatch',
    'getMessagesByType',
    'getMediaStream',
    'getMessageTables',
    'getMessageTableStats',
    'getMessageDates',
    'getAggregateStats',
    'getAvailableYears',
    'getAnnualReportStats',
    'getAnnualReportExtras',
    'getDualReportStats',
    'getGroupStats',
    'getMyFootprintStats',
    'openMessageCursor',
    'getMessageById',
    'searchMessages',
    'getVoiceData',
    'getVoiceDataBatch',
    'checkMessageAntiRevokeTriggers',
    'installMessageAntiRevokeTriggers',
    'uninstallMessageAntiRevokeTriggers',
    'updateMessage',
    'deleteMessage'
])

if (parentPort) {
    // Every request shares one native account handle. Some core operations yield
    // to the event loop while opening or paging, so independent message handlers
    // can otherwise overlap and reset the handle during lazy database indexing.
    // Keep native work ordered inside this dedicated worker.
    let requestQueue: Promise<void> = Promise.resolve()
    let messageDbIndexReady = false
    let activeAccountKey = ''

    const refreshMessageDbIndex = async (): Promise<boolean> => {
        if (!core.isConnected()) {
            messageDbIndexReady = false
            return false
        }
        const index = await core.listMessageDbs()
        messageDbIndexReady = Boolean(index.success && Array.isArray(index.data) && index.data.length > 0)
        return messageDbIndexReady
    }

    const warmSessionHashLookup = async (sessionIds: string[]): Promise<boolean> => {
        const candidates = Array.from(new Set(
            (sessionIds || []).map(id => String(id || '').trim()).filter(Boolean)
        )).slice(0, 48)
        for (const sessionId of candidates) {
            const probe = await core.getMessages(sessionId, 1, 0)
            if (probe.success && Array.isArray(probe.messages) && probe.messages.length > 0) {
                return true
            }
        }
        return false
    }

    const handleMessage = async (msg: any): Promise<void> => {
        const { id, type, payload } = msg

        try {
            // listMessageDbs performs a native discovery scan. Doing it before
            // every statistics query made page navigation progressively slower
            // and defeated the caches above this layer. The registry belongs to
            // the current account handle, so one successful discovery is enough
            // until that handle is replaced.
            if (MESSAGE_DB_DEPENDENT_REQUESTS.has(type) && core.isConnected() && !messageDbIndexReady) {
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    if (await refreshMessageDbIndex()) break
                    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150))
                }
            }

            let result: any

            switch (type) {
                case 'setPaths':
                    core.setPaths(payload.resourcesPath, payload.userDataPath)
                    messageDbIndexReady = false
                    result = { success: true }
                    break
                case 'setLogEnabled':
                    core.setLogEnabled(payload.enabled)
                    result = { success: true }
                    break
                case 'setMonitor':
                    {
                    const monitorOk = core.setMonitor((type, json) => {
                        parentPort!.postMessage({
                            id: -1,
                            type: 'monitor',
                            payload: { type, json }
                        })
                    })
                    result = { success: monitorOk }
                    break
                    }
                case 'testConnection':
                    messageDbIndexReady = false
                    result = await core.testConnection(payload.accountDir, payload.hexKey)
                    break
                case 'open':
                    {
                    const nextAccountKey = `${String(payload.accountDir || '')}\u0000${String(payload.hexKey || '')}`
                    if (nextAccountKey !== activeAccountKey) {
                        messageDbIndexReady = false
                    }
                    result = await core.open(payload.accountDir, payload.hexKey)
                    activeAccountKey = result === true ? nextAccountKey : ''
                    if (result !== true) messageDbIndexReady = false
                    break
                    }
                case 'getLastInitError':
                    result = core.getLastInitError()
                    break
                case 'close':
                    core.close()
                    messageDbIndexReady = false
                    activeAccountKey = ''
                    result = { success: true }
                    break
                case 'isConnected':
                    result = core.isConnected()
                    break
                case 'getSessions':
                    result = await core.getSessions()
                    break
                case 'markAllSessionsRead':
                    result = await core.markAllSessionsRead()
                    break
                case 'getMessages':
                    result = await core.getMessages(payload.sessionId, payload.limit, payload.offset)
                    break
                case 'getNewMessages':
                    result = await core.getNewMessages(payload.sessionId, payload.minTime, payload.limit)
                    break
                case 'getMessageCount':
                    result = await core.getMessageCount(payload.sessionId)
                    break
                case 'getMessageByServerId':
                    result = await core.getMessageByServerId(payload.sessionId, payload.svrid)
                    break
                case 'getMessageCounts':
                    result = await core.getMessageCounts(payload.sessionIds)
                    break
                case 'getSessionMessageCounts':
                    {
                    const sessionIds = Array.from(new Set(
                        (payload.sessionIds || []).map((id: unknown) => String(id || '').trim()).filter(Boolean)
                    )) as string[]
                    // The native aggregate APIs can return a structurally valid
                    // all-zero map on a cold connection. Count the concrete Msg
                    // tables instead; this is deterministic and also works for
                    // sessions spread across more than one message database.
                    result = await countSessionsByTableScan(sessionIds)
                    break
                    }
                case 'getSessionMessageTypeStats':
                    result = await core.getSessionMessageTypeStats(payload.sessionId, payload.beginTimestamp, payload.endTimestamp)
                    break
                case 'getSessionMessageTypeStatsBatch':
                    await warmSessionHashLookup(payload.sessionIds || [])
                    result = await core.getSessionMessageTypeStatsBatch(payload.sessionIds, payload.options)
                    break
                case 'getSessionMessageDateCounts':
                    result = await core.getSessionMessageDateCounts(payload.sessionId)
                    break
                case 'getSessionMessageDateCountsBatch':
                    result = await core.getSessionMessageDateCountsBatch(payload.sessionIds)
                    break
                case 'getMessagesByType':
                    result = await core.getMessagesByType(payload.sessionId, payload.localType, payload.ascending, payload.limit, payload.offset)
                    break
                case 'getMediaStream':
                    result = await core.getMediaStream(payload.options)
                    break
                case 'getDisplayNames':
                    result = await core.getDisplayNames(payload.usernames)
                    break
                case 'getAvatarUrls':
                    result = await core.getAvatarUrls(payload.usernames)
                    break
                case 'getGroupMemberCount':
                    result = await core.getGroupMemberCount(payload.chatroomId)
                    break
                case 'getGroupMemberCounts':
                    result = await core.getGroupMemberCounts(payload.chatroomIds)
                    break
                case 'getGroupMembers':
                    result = await core.getGroupMembers(payload.chatroomId)
                    break
                case 'getGroupNicknames':
                    result = await core.getGroupNicknames(payload.chatroomId)
                    break
                case 'getMessageTables':
                    result = await core.getMessageTables(payload.sessionId)
                    break
                case 'getMessageTableStats':
                    result = await core.getMessageTableStats(payload.sessionId)
                    break
                case 'getMessageDates':
                    result = await core.getMessageDates(payload.sessionId)
                    break
                case 'getMessageMeta':
                    result = await core.getMessageMeta(payload.dbPath, payload.tableName, payload.limit, payload.offset)
                    break
                case 'getMessageTableColumns':
                    result = await core.getMessageTableColumns(payload.dbPath, payload.tableName)
                    break
                case 'listTables':
                    result = await core.listTables(payload.kind, payload.dbPath)
                    break
                case 'getTableSchema':
                    result = await core.getTableSchema(payload.kind, payload.dbPath, payload.tableName)
                    break
                case 'exportTableSnapshot':
                    result = await core.exportTableSnapshot(payload.kind, payload.dbPath, payload.tableName, payload.outputPath)
                    break
                case 'importTableSnapshot':
                    result = await core.importTableSnapshot(payload.kind, payload.dbPath, payload.tableName, payload.inputPath)
                    break
                case 'importTableSnapshotWithSchema':
                    result = await core.importTableSnapshotWithSchema(payload.kind, payload.dbPath, payload.tableName, payload.inputPath, payload.createTableSql)
                    break
                case 'getMessageTableTimeRange':
                    result = await core.getMessageTableTimeRange(payload.dbPath, payload.tableName)
                    break
                case 'getContact':
                    result = await core.getContact(payload.username)
                    break
                case 'getContactStatus':
                    result = await core.getContactStatus(payload.usernames)
                    break
                case 'getContactTypeCounts':
                    result = await core.getContactTypeCounts()
                    break
                case 'getContactsCompact':
                    result = await core.getContactsCompact(payload.usernames)
                    break
                case 'getContactAliasMap':
                    result = await core.getContactAliasMap(payload.usernames)
                    break
                case 'getContactFriendFlags':
                    result = await core.getContactFriendFlags(payload.usernames)
                    break
                case 'getChatRoomExtBuffer':
                    result = await core.getChatRoomExtBuffer(payload.chatroomId)
                    break
                case 'getAggregateStats':
                    result = await core.getAggregateStats(payload.sessionIds, payload.beginTimestamp, payload.endTimestamp)
                    break
                case 'getAvailableYears':
                    result = await core.getAvailableYears(payload.sessionIds)
                    break
                case 'getAnnualReportStats':
                    result = await core.getAnnualReportStats(payload.sessionIds, payload.beginTimestamp, payload.endTimestamp)
                    break
                case 'getAnnualReportExtras':
                    result = await core.getAnnualReportExtras(payload.sessionIds, payload.beginTimestamp, payload.endTimestamp, payload.peakDayBegin, payload.peakDayEnd)
                    break
                case 'getDualReportStats':
                    result = await core.getDualReportStats(payload.sessionId, payload.beginTimestamp, payload.endTimestamp)
                    break
                case 'getGroupStats':
                    result = await core.getGroupStats(payload.chatroomId, payload.beginTimestamp, payload.endTimestamp)
                    break
                case 'getMyFootprintStats':
                    result = await core.getMyFootprintStats(payload.options || {})
                    break
                case 'openMessageCursor':
                    result = await core.openMessageCursor(payload.sessionId, payload.batchSize, payload.ascending, payload.beginTimestamp, payload.endTimestamp)
                    break
                case 'fetchMessageBatch':
                    result = await core.fetchMessageBatch(payload.cursor)
                    break
                case 'closeMessageCursor':
                    result = await core.closeMessageCursor(payload.cursor)
                    break
                case 'execQuery':
                    result = await core.execQuery(payload.kind, payload.path, payload.sql, payload.params)
                    break
                case 'getEmoticonCdnUrl':
                    result = await core.getEmoticonCdnUrl(payload.dbPath, payload.md5)
                    break
                case 'getEmoticonCaption':
                    result = await core.getEmoticonCaption(payload.dbPath, payload.md5)
                    break
                case 'getEmoticonCaptionStrict':
                    result = await core.getEmoticonCaptionStrict(payload.md5)
                    break
                case 'listMessageDbs':
                    result = await core.listMessageDbs()
                    messageDbIndexReady = Boolean(result.success && Array.isArray(result.data) && result.data.length > 0)
                    break
                case 'listMediaDbs':
                    result = await core.listMediaDbs()
                    break
                case 'getMessageById':
                    result = await core.getMessageById(payload.sessionId, payload.localId)
                    break
                case 'searchMessages':
                    result = await core.searchMessages(payload.keyword, payload.sessionId, payload.limit, payload.offset, payload.beginTimestamp, payload.endTimestamp)
                    break
                case 'getVoiceData':
                    result = await core.getVoiceData(payload.sessionId, payload.createTime, payload.candidates, payload.localId, payload.svrId)
                    if (!result.success) {
                        console.error('[wcdbWorker] getVoiceData failed:', result.error)
                    }
                    break
                case 'getVoiceDataBatch':
                    result = await core.getVoiceDataBatch(payload.requests)
                    break
                case 'getMediaSchemaSummary':
                    result = await core.getMediaSchemaSummary(payload.dbPath)
                    break
                case 'getHeadImageBuffers':
                    result = await core.getHeadImageBuffers(payload.usernames)
                    break
                case 'resolveImageHardlink':
                    result = await core.resolveImageHardlink(payload.md5, payload.accountDir)
                    break
                case 'resolveImageHardlinkBatch':
                    result = await core.resolveImageHardlinkBatch(payload.requests)
                    break
                case 'resolveVideoHardlinkMd5':
                    result = await core.resolveVideoHardlinkMd5(payload.md5, payload.dbPath)
                    break
                case 'resolveVideoHardlinkMd5Batch':
                    result = await core.resolveVideoHardlinkMd5Batch(payload.requests)
                    break
                case 'getSnsTimeline':
                    result = await core.getSnsTimeline(payload.limit, payload.offset, payload.usernames, payload.keyword, payload.startTime, payload.endTime)
                    break
                case 'getSnsAnnualStats':
                    result = await core.getSnsAnnualStats(payload.beginTimestamp, payload.endTimestamp)
                    break
                case 'getSnsUsernames':
                    result = await core.getSnsUsernames()
                    break
                case 'getSnsExportStats':
                    result = await core.getSnsExportStats(payload.myWxid)
                    break
                case 'checkMessageAntiRevokeTriggers':
                    result = await core.checkMessageAntiRevokeTriggers(payload.sessionIds)
                    break
                case 'installMessageAntiRevokeTriggers':
                    result = await core.installMessageAntiRevokeTriggers(payload.sessionIds)
                    break
                case 'uninstallMessageAntiRevokeTriggers':
                    result = await core.uninstallMessageAntiRevokeTriggers(payload.sessionIds)
                    break
                case 'installSnsBlockDeleteTrigger':
                    result = await core.installSnsBlockDeleteTrigger()
                    break
                case 'uninstallSnsBlockDeleteTrigger':
                    result = await core.uninstallSnsBlockDeleteTrigger()
                    break
                case 'checkSnsBlockDeleteTrigger':
                    result = await core.checkSnsBlockDeleteTrigger()
                    break
                case 'deleteSnsPost':
                    result = await core.deleteSnsPost(payload.postId)
                    break
                case 'getLogs':
                    result = await core.getLogs()
                    break
                case 'verifyUser':
                    result = await core.verifyUser(payload.message, payload.hwnd)
                    break
                case 'updateMessage':
                    result = await core.updateMessage(payload.sessionId, payload.localId, payload.createTime, payload.newContent)
                    break
                case 'deleteMessage':
                    result = await core.deleteMessage(payload.sessionId, payload.localId, payload.createTime, payload.dbPathHint)
                    break
                case 'cloudInit':
                    result = await core.cloudInit(payload.intervalSeconds)
                    break
                case 'cloudReport':
                    result = await core.cloudReport(payload.statsJson)
                    break
                case 'cloudStop':
                    result = core.cloudStop()
                    break
                default:
                    result = { success: false, error: `Unknown method: ${type}` }
            }

            if (
                MESSAGE_DB_DEPENDENT_REQUESTS.has(type) &&
                result?.success === false &&
                /(?:status\s*)?-3\b|消息数据库(?:未找到|为空)/i.test(String(result?.error || ''))
            ) {
                messageDbIndexReady = false
            }

            parentPort!.postMessage({ id, result })
        } catch (e) {
            parentPort!.postMessage({ id, error: String(e) })
        }
    }

    parentPort.on('message', (msg) => {
        requestQueue = requestQueue
            .then(() => handleMessage(msg))
            .catch((error) => {
                const id = Number(msg?.id || 0)
                parentPort!.postMessage({ id, error: String(error) })
            })
    })
}
