// lib/migrate.mjs — 编排：拉列表 → 拉消息 → 下载附件 → 转 interchange → 落盘（可断点）。
// 导入不在这里做：落盘后由宿主（插件用 chatImport 服务 / 用户跑 /import auto）接手。

import { mkdir, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { collectMessageFiles, deepseekToInterchange } from './convert.mjs'
import { OUT_DIR, isFetched, markFetched } from './state.mjs'

const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_ASSET_BYTES = 200 * 1024 * 1024

const toMs = (seconds) => (Number(seconds) > 1e12 ? Number(seconds) : Number(seconds) * 1000)

/** 按 --since / --min-turns 过滤（min-turns 要拉到消息才知道，因此是后置过滤）。 */
export const INCREMENTAL_OVERLAP_MS = 5 * 60 * 1000

/** 把 since 解析成毫秒时间戳：支持 Date / 字符串 / 'last' | 'last-run'（用上次记录的游标）。 */
export function resolveSince(since, state) {
  if (since === undefined || since === null || since === '') return null
  if (since === 'last' || since === 'last-run') {
    // 优先用显式游标；没有就退回到「已有会话记录里的最大 updatedAt」——
    // 这样功能上线前已经跑过全量的用户，第一次 since:last 也不会变成全量重跑。
    const explicit = state && state.lastRun && Number(state.lastRun.maxUpdatedAt)
    const derived = state && state.sessions
      ? Object.values(state.sessions).reduce((max, item) => {
          const value = Number(item && item.updatedAt)
          return Number.isFinite(value) && value > max ? value : max
        }, 0)
      : 0
    const last = explicit || derived
    if (!last) return null
    return last * 1000 - INCREMENTAL_OVERLAP_MS
  }
  if (since instanceof Date) return since.getTime()
  const parsed = Date.parse(String(since))
  return Number.isFinite(parsed) ? parsed : null
}

/** 只保留指定 id（用户点名导入某几条时用，优先级高于 since/limit）。 */
export function filterByIds(sessions, ids) {
  if (!Array.isArray(ids) || !ids.length) return null
  const wanted = new Set(ids.map((id) => String(id)))
  return sessions.filter((item) => wanted.has(String(item.id)))
}

export function filterSessions(sessions, { since, limit } = {}) {
  let list = sessions.slice()
  if (since !== undefined && since !== null && since !== '') {
    const cutoff = since instanceof Date ? since.getTime() : Date.parse(String(since))
    if (Number.isFinite(cutoff)) {
      list = list.filter((s) => {
        const updated = toMs(s.updated_at || s.inserted_at)
        return !Number.isFinite(updated) || updated >= cutoff
      })
    }
  }
  if (Number.isFinite(limit) && limit > 0) list = list.slice(0, limit)
  return list
}

function collectFileRefs(branch) {
  const refs = new Map()
  for (const message of branch) {
    for (const file of collectMessageFiles(message)) {
      const id = String(file.id || file.file_id || file.fileId || '')
      if (!id) continue
      const name = String(file.file_name || file.name || '')
      const mime = String(file.content_type || file.mime_type || '')
      const kind = String(file.model_kind || '').toUpperCase()
      const isImage = /^image\//i.test(mime) || kind === 'VISION' || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)
      refs.set(id, {
        id,
        name,
        mime,
        isImage,
        size: Number(file.file_size || file.size) || 0,
        signedPath: String(file.signed_path || ''),
      })
    }
  }
  return [...refs.values()]
}

async function downloadAssets(api, branch, { log, budget }) {
  const assets = {}
  const refs = collectFileRefs(branch)
  if (!refs.length) return { assets, downloaded: 0, failed: 0, skipped: 0 }
  let downloaded = 0
  let failed = 0
  let skipped = 0
  for (const ref of refs) {
    if (budget.used > MAX_ASSET_BYTES) { skipped += 1; continue }
    const file = await api.fetchFile(ref)
    if (!file || !file.buffer || !file.buffer.length) { failed += 1; continue }
    if (file.buffer.length > MAX_FILE_BYTES) { skipped += 1; continue }
    budget.used += file.buffer.length
    const mediaType = ref.mime || file.contentType || 'application/octet-stream'
    assets[ref.id] = {
      data: file.buffer.toString('base64'),
      mediaType,
      name: ref.name,
      bytes: file.buffer.length,
    }
    downloaded += 1
    log(`  附件 ${ref.name || ref.id} (${Math.round(file.buffer.length / 1024)}KB)`)
  }
  return { assets, downloaded, failed, skipped }
}

/**
 * 主流程。回调 onProgress({ phase, done, total, message })。
 * options: { sessions? , since, limit, minTurns, outDir, force, downloadFiles, log }
 */
export async function migrateAccount({ api, state, options = {}, onProgress = () => {}, onCheckpoint, onBatch } = {}) {
  const {
    outDir = OUT_DIR,
    force = false,
    downloadFiles = true,
    minTurns = 0,
    batchSize = 0,
    dryRun = false,
    maxSessionBytes = 1024 * 1024 * 1024,
    log = () => {},
  } = options
  if (!dryRun) await mkdir(outDir, { recursive: true })
  const budget = { used: 0 }

  onProgress({ phase: 'list', done: 0, total: 0, message: '正在拉取会话列表…' })
  const all = options.sessions && options.sessions.length
    ? options.sessions
    : await api.listSessions({
        onPage: ({ page, total }) => onProgress({ phase: 'list', done: total, total, message: `会话列表 ${total} 条（第 ${page} 页）` }),
      })
  const sinceMs = resolveSince(options.since, state)
  const incremental = sinceMs !== null
  const byIds = filterByIds(all, options.sessionIds)
  if (byIds && !byIds.length) {
    onProgress({ phase: 'list', done: 0, total: 0, message: '指定的会话 id 在账号里没找到' })
  }
  const selected = byIds || filterSessions(all, { ...options, since: incremental ? new Date(sinceMs) : undefined })
  if (byIds) onProgress({ phase: 'list', done: selected.length, total: selected.length, message: `按 id 导入 ${selected.length} 条` })
  if (incremental) {
    onProgress({
      phase: 'list', done: selected.length, total: selected.length,
      message: `增量模式：自 ${new Date(sinceMs).toLocaleString()} 起，命中 ${selected.length} / ${all.length} 条`,
    })
  } else {
    onProgress({ phase: 'list', done: selected.length, total: selected.length, message: `待处理 ${selected.length} 条` })
  }

  const manifest = {
    outDir, items: [], skipped: 0, failed: 0, failures: [], tooLarge: [], authExpired: false,
    stats: { turns: 0, steps: 0, images: 0, imagesDegraded: 0, skippedBlocks: 0, unknownFragmentTypes: [] },
    bytes: 0,
  }
  const attempts = Math.max(1, Number(options.retries) || 2)

  const processOne = async (session) => {
    // 兼容只实现 fetchSession 的调用方（含测试替身）
    const meta = typeof api.fetchSessionMeta === 'function'
      ? await api.fetchSessionMeta(String(session.id))
      : { data: await api.fetchSession(String(session.id)), bytes: 0 }
    const { data, bytes: rawBytes } = meta
    // 单条会话过大（几百轮、巨量附件）时跳过而不是把进程拖崩
    if (rawBytes > maxSessionBytes) {
      const tooLarge = new Error(`单条会话 ${(rawBytes / 1048576).toFixed(1)}MB，超过上限 ${(maxSessionBytes / 1048576).toFixed(0)}MB`)
      tooLarge.name = 'SessionTooLarge'
      tooLarge.bytes = rawBytes
      throw tooLarge
    }
    const messages = (data && data.chat_messages) || []
    const { assets, downloaded, failed, skipped } = downloadFiles
      ? await downloadAssets(api, messages.slice(), { log, budget })
      : { assets: {}, downloaded: 0, failed: 0, skipped: 0 }
    const { document, stats } = deepseekToInterchange({
      session: (data && data.chat_session) || session,
      messages,
      assets,
    })
    return { document, stats, downloaded, failed, skipped }
  }

  let index = 0
  for (const session of selected) {
    index += 1
    const id = String(session.id)
    const label = `${index}/${selected.length} ${session.title || id}`
    if (!force && isFetched(state, id)) {
      manifest.skipped += 1
      onProgress({ phase: 'skip', done: index, total: selected.length, message: `${label} 已迁移过，跳过` })
      continue
    }
    onProgress({ phase: 'fetch', done: index, total: selected.length, message: `拉取 ${label}` })

    let result = null
    let lastError = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        result = await processOne(session)
        break
      } catch (error) {
        lastError = error
        // 登录态失效重试没有意义，直接中止整轮，别把 400 条都记成失败
        if (error && error.name === 'SessionTooLarge') break
        if (error && error.name === 'AuthError') {
          manifest.authExpired = true
          onProgress({ phase: 'auth', done: index, total: selected.length, message: `登录态失效：${error.message}（已中止，重新 login 后重跑会从断点继续）` })
          break
        }
        if (attempt < attempts) {
          onProgress({ phase: 'retry', done: index, total: selected.length, message: `${label} 第 ${attempt} 次失败（${error.message}），重试…` })
          await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
        }
      }
    }
    if (manifest.authExpired) break
    if (!result && lastError && lastError.name === 'SessionTooLarge') {
      manifest.skipped += 1
      manifest.tooLarge.push({ id, title: session.title || '', bytes: lastError.bytes, error: lastError.message })
      markFetched(state, session, { skipped: 'too-large', bytes: lastError.bytes })
      onProgress({ phase: 'skip', done: index, total: selected.length, message: `${label} 跳过：${lastError.message}` })
      continue
    }
    if (!result) {
      manifest.failed += 1
      if (manifest.failures.length < 50) manifest.failures.push({ id, title: session.title || '', error: lastError && lastError.message })
      onProgress({ phase: 'error', done: index, total: selected.length, message: `${label} 失败：${lastError && lastError.message}` })
      continue
    }

    const { document, stats, downloaded, failed, skipped } = result
    if (minTurns > 0 && document.turns.length < minTurns) {
      manifest.skipped += 1
      markFetched(state, session, { turns: document.turns.length, skipped: 'min-turns' })
      onProgress({ phase: 'skip', done: index, total: selected.length, message: `${label} 只有 ${document.turns.length} 轮，跳过` })
      continue
    }
    if (dryRun) {
      // 只验证转换，不落盘、不写状态
      manifest.items.push({ id, title: document.title, turns: document.turns.length, steps: stats.steps, dryRun: true })
      manifest.stats.turns += document.turns.length
      manifest.stats.steps += stats.steps
      manifest.stats.images += downloaded
      manifest.stats.imagesDegraded += stats.imagesDegraded
      onProgress({ phase: 'convert', done: index, total: selected.length, message: `${label} → ${document.turns.length} 轮（dry-run，未写入）` })
      continue
    }
    try {
      const file = join(outDir, `${sanitize(id)}.interchange.json`)
      const written = await writeInterchange(file, document, { pretty: true })
      markFetched(state, session, {
        turns: document.turns.length,
        steps: stats.steps,
        file,
        assets: downloaded,
        assetsFailed: failed,
        assetsSkipped: skipped,
        unknownFragmentTypes: stats.unknownFragmentTypes,
      })
      manifest.items.push({ id, title: document.title, turns: document.turns.length, steps: stats.steps, file })
      manifest.stats.turns += document.turns.length
      manifest.stats.steps += stats.steps
      manifest.stats.images += downloaded
      manifest.stats.imagesDegraded += stats.imagesDegraded
      manifest.stats.skippedBlocks += stats.skippedBlocks || 0
      for (const type of stats.unknownFragmentTypes || []) {
        if (!manifest.stats.unknownFragmentTypes.includes(type)) manifest.stats.unknownFragmentTypes.push(type)
      }
      manifest.bytes += written
      onProgress({ phase: 'convert', done: index, total: selected.length, message: `${label} → ${document.turns.length} 轮` })
      // 边转边导：攒够一批就交给调用方立即导入，用户不必等全部转完
      if (batchSize > 0 && typeof onBatch === 'function' && manifest.items.length % batchSize === 0) {
        await onBatch(manifest.items.slice(-batchSize), manifest)
      }
      // 每 N 条落一次盘：中断也不会丢掉已完成的进度
      if (typeof onCheckpoint === 'function' && index % (Number(options.checkpointEvery) || 10) === 0) {
        await onCheckpoint(state, manifest)
      }
    } catch (error) {
      manifest.failed += 1
      onProgress({ phase: 'error', done: index, total: selected.length, message: `${label} 写文件失败：${error.message}` })
    }
  }

  // 记录游标：下次 since:'last' 从这里继续（含 5 分钟重叠，边界会话不会漏）
  const cursor = selected.reduce((max, item) => {
    const updated = Number(item.updated_at || item.inserted_at || 0)
    return Number.isFinite(updated) && updated > max ? updated : max
  }, 0)
  if (cursor > 0) {
    state.lastRun = { at: Date.now(), maxUpdatedAt: cursor, sessions: selected.length, incremental }
  }

  onProgress({
    phase: manifest.authExpired ? 'aborted' : 'done',
    done: selected.length,
    total: selected.length,
    message: manifest.authExpired
      ? `已中止（登录态失效）：本次完成 ${manifest.items.length} 条，重新 login 后重跑会从断点继续`
      : `完成：${manifest.items.length} 条会话 / ${manifest.stats.turns} 轮 / 跳过 ${manifest.skipped} / 失败 ${manifest.failed}`,
  })
  return manifest
}

/**
 * 写 interchange 文件。小文档一次性写；大文档逐轮流式写，
 * 避免「整个文档 + 整份 JSON 字符串」同时在内存里（那是 OOM 的主因）。
 */
export async function writeInterchange(file, document, { pretty = true, threshold = 16 * 1024 * 1024 } = {}) {
  const turns = Array.isArray(document.turns) ? document.turns : []
  const roughBytes = turns.reduce((sum, turn) => sum + (turn.prompt ? turn.prompt.length : 0), 0)
  if (pretty && roughBytes < threshold) {
    const text = JSON.stringify(document, null, 2)
    await writeFile(file, text, 'utf8')
    return Buffer.byteLength(text)
  }
  const { turns: _omit, ...head } = document
  const stream = createWriteStream(file, { encoding: 'utf8' })
  const write = (chunk) => new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()))
  })
  try {
    await write(JSON.stringify(head).replace(/}$/, ',"turns":['))
    for (let i = 0; i < turns.length; i += 1) {
      await write((i === 0 ? '' : ',') + JSON.stringify(turns[i]))
    }
    await write(']}')
  } finally {
    await new Promise((resolve) => stream.end(resolve))
  }
  const { stat } = await import('node:fs/promises')
  return (await stat(file)).size
}

function sanitize(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96)
}
