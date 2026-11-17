// lib/migrate.mjs — 编排：拉列表 → 拉消息 → 下载附件 → 转 interchange → 落盘（可断点）。
// 导入不在这里做：落盘后由宿主（插件用 chatImport 服务 / 用户跑 /import auto）接手。

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { collectMessageFiles, deepseekToInterchange } from './convert.mjs'
import { OUT_DIR, isFetched, markFetched } from './state.mjs'

const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_ASSET_BYTES = 200 * 1024 * 1024

const toMs = (seconds) => (Number(seconds) > 1e12 ? Number(seconds) : Number(seconds) * 1000)

/** 按 --since / --min-turns 过滤（min-turns 要拉到消息才知道，因此是后置过滤）。 */
export function filterSessions(sessions, { since, limit } = {}) {
  let list = sessions.slice()
  if (since) {
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
export async function migrateAccount({ api, state, options = {}, onProgress = () => {} }) {
  const {
    outDir = OUT_DIR,
    force = false,
    downloadFiles = true,
    minTurns = 0,
    log = () => {},
  } = options
  await mkdir(outDir, { recursive: true })
  const budget = { used: 0 }

  onProgress({ phase: 'list', done: 0, total: 0, message: '正在拉取会话列表…' })
  const all = options.sessions && options.sessions.length
    ? options.sessions
    : await api.listSessions({
        onPage: ({ page, total }) => onProgress({ phase: 'list', done: total, total, message: `会话列表 ${total} 条（第 ${page} 页）` }),
      })
  const selected = filterSessions(all, options)
  onProgress({ phase: 'list', done: selected.length, total: selected.length, message: `待处理 ${selected.length} 条` })

  const manifest = { outDir, items: [], skipped: 0, failed: 0, stats: { turns: 0, steps: 0, images: 0, imagesDegraded: 0 }, bytes: 0 }
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
    try {
      const data = await api.fetchSession(id)
      const messages = (data && data.chat_messages) || []
      const branch = messages.slice()
      const { assets, downloaded, failed, skipped } = downloadFiles
        ? await downloadAssets(api, branch, { log, budget })
        : { assets: {}, downloaded: 0, failed: 0, skipped: 0 }
      const { document, stats } = deepseekToInterchange({
        session: (data && data.chat_session) || session,
        messages,
        assets,
      })
      if (minTurns > 0 && document.turns.length < minTurns) {
        manifest.skipped += 1
        markFetched(state, session, { turns: document.turns.length, skipped: 'min-turns' })
        onProgress({ phase: 'skip', done: index, total: selected.length, message: `${label} 只有 ${document.turns.length} 轮，跳过` })
        continue
      }
      const file = join(outDir, `${sanitize(id)}.interchange.json`)
      const text = JSON.stringify(document, null, 2)
      await writeFile(file, text, 'utf8')
      markFetched(state, session, {
        turns: document.turns.length,
        steps: stats.steps,
        file,
        assets: downloaded,
        assetsFailed: failed,
        assetsSkipped: skipped,
      })
      manifest.items.push({ id, title: document.title, turns: document.turns.length, steps: stats.steps, file })
      manifest.stats.turns += document.turns.length
      manifest.stats.steps += stats.steps
      manifest.stats.images += downloaded
      manifest.stats.imagesDegraded += stats.imagesDegraded
      manifest.bytes += Buffer.byteLength(text)
      onProgress({ phase: 'convert', done: index, total: selected.length, message: `${label} → ${document.turns.length} 轮` })
    } catch (error) {
      manifest.failed += 1
      onProgress({ phase: 'error', done: index, total: selected.length, message: `${label} 失败：${error.message}` })
    }
  }
  onProgress({
    phase: 'done',
    done: selected.length,
    total: selected.length,
    message: `完成：${manifest.items.length} 条会话 / ${manifest.stats.turns} 轮 / 跳过 ${manifest.skipped} / 失败 ${manifest.failed}`,
  })
  return manifest
}

function sanitize(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96)
}
