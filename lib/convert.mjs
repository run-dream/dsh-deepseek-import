// lib/convert.mjs — DeepSeek web/app 会话 → dsh-chat-import interchange v1（纯函数，零依赖）
//
// 输入是 chat.deepseek.com 的 /api/v0/chat/history_messages 返回的 biz_data：
//   { chat_session: { id, title, inserted_at, updated_at, current_message_id },
//     chat_messages: [ { message_id, parent_id, role: 'USER'|'ASSISTANT',
//                        content, thinking_content, inserted_at,
//                        fragments: [ { type: 'REQUEST'|'SEARCH'|'THINK'|'RESPONSE', content } ],
//                        files?: [ { id|file_id, file_name, file_size, ... } ] } ] }
//
// 旧版是扁平 content/thinking_content，新版把一切都塞进 fragments；两种都认。
// 分支：DeepSeek 保存的是消息树，从 current_message_id 沿 parent_id 回溯才是当前分支。

export const INTERCHANGE_MARK = 'dsh-chat-import'
export const INTERCHANGE_VERSION = 1
export const PROVIDER = 'deepseek-web'

const MAX_TITLE = 80

function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)) }

/** inserted_at 是 Unix 秒（旧数据可能有毫秒），统一成毫秒。 */
export function toMs(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n > 1e12 ? Math.round(n) : Math.round(n * 1000)
}

function pickFragment(message, types) {
  const fragments = message && message.fragments
  if (!Array.isArray(fragments)) return ''
  return fragments
    .filter((f) => f && types.includes(str(f.type).toUpperCase()) && f.content)
    .map((f) => str(f.content))
    .join('\n\n')
}

/** 用户看到的正文：USER 取 REQUEST，ASSISTANT 取 RESPONSE；兼容扁平 content。 */
export function messageText(message) {
  if (!message) return ''
  if (typeof message.content === 'string' && message.content) return message.content
  return message.role === 'USER'
    ? pickFragment(message, ['REQUEST'])
    : pickFragment(message, ['RESPONSE'])
}

/** 思维链：优先 fragments 的 THINK，再退回扁平 thinking_content。 */
export function messageThinking(message) {
  if (!message) return ''
  const fromFragments = pickFragment(message, ['THINK'])
  if (fromFragments) return fromFragments
  return str(message.thinking_content)
}

/** 搜索证据：SEARCH / TOOL_SEARCH / TOOL_OPEN 拼成一段可读文本（保留来源，不丢上下文）。 */
export function messageSearch(message) {
  const fragments = message && message.fragments
  if (!Array.isArray(fragments)) return ''
  const parts = []
  for (const fragment of fragments) {
    const type = str(fragment && fragment.type).toUpperCase()
    if (type === 'SEARCH') {
      if (fragment.content) parts.push(str(fragment.content))
      continue
    }
    if (type === 'TOOL_SEARCH') {
      const queries = Array.isArray(fragment.queries) ? fragment.queries.map((q) => str(q && q.query)).filter(Boolean) : []
      const results = Array.isArray(fragment.results) ? fragment.results.slice(0, 3) : []
      const head = str(fragment.content) || '联网搜索'
      const lines = [`[搜索] ${head}`]
      if (queries.length) lines.push(`查询：${queries.join(' / ')}`)
      for (const result of results) {
        const title = str(result && result.title)
        const url = str(result && result.url)
        const snippet = str(result && result.snippet).slice(0, 160)
        lines.push(`- ${title || url}${snippet ? ` — ${snippet}` : ''}`)
      }
      parts.push(lines.join('\n'))
      continue
    }
    if (type === 'TOOL_OPEN') {
      const content = str(fragment.content)
      if (content) parts.push(`[打开]${content}`.slice(0, 400))
      continue
    }
  }
  return parts.join('\n\n')
}

/** 从 current_message_id 沿 parent_id 回溯，得到当前分支（根 → 叶）。 */
export function currentBranch(session, messages) {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : []
  if (!list.length) return []
  const byId = new Map(list.map((m) => [str(m.message_id), m]))
  const leaf = session && str(session.current_message_id)
  if (!leaf || !byId.has(leaf)) {
    return list.slice().sort((a, b) => (toMs(a.inserted_at) ?? 0) - (toMs(b.inserted_at) ?? 0))
  }
  const chain = []
  const seen = new Set()
  let cursor = leaf
  while (cursor && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor)
    const message = byId.get(cursor)
    chain.unshift(message)
    cursor = str(message.parent_id) || ''
  }
  return chain
}

/** 附件来源：新版在 fragments 里的 FILE 片段，旧版在 message.files；两处合并。 */
export function collectMessageFiles(message) {
  const out = []
  const fragments = message && message.fragments
  if (Array.isArray(fragments)) {
    for (const fragment of fragments) {
      if (!fragment || str(fragment.type).toUpperCase() !== 'FILE') continue
      for (const file of Array.isArray(fragment.files) ? fragment.files : []) {
        if (file) out.push(file)
      }
    }
  }
  const raw = message && (message.files || message.file_list || message.attachments)
  if (Array.isArray(raw)) for (const file of raw) if (file) out.push(file)
  return out
}

/** 附件里挑出图片与其余文件；assets[fileId] 由下载阶段填充。 */
function partitionFiles(message) {
  const list = collectMessageFiles(message)
  const images = []
  const others = []
  for (const file of list) {
    const id = str(file.id || file.file_id || file.fileId)
    const name = str(file.file_name || file.name || file.filename) || id || '未命名文件'
    const mime = str(file.content_type || file.mime_type || file.mimeType)
    const kind = str(file.model_kind).toUpperCase()
    const size = Number(file.file_size || file.size)
    const signedPath = str(file.signed_path)
    content: {
      if (/^image\//i.test(mime) || kind === 'VISION') { images.push({ id, name, mime, size, signedPath }); break content }
      const looksImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)
      ;(looksImage ? images : others).push({ id, name, mime, size, signedPath })
    }
  }
  return { images, others }
}

function buildPromptBlocks(message, assets, stats) {
  const blocks = []
  const text = messageText(message)
  if (text) blocks.push({ type: 'text', text })
  const { images, others } = partitionFiles(message)
  for (const file of others) {
    const size = Number(file.size) > 0 ? ` (${formatSize(Number(file.size))})` : ''
    blocks.push({ type: 'text', text: `[附件] ${file.name}${size}` })
  }
  for (const image of images) {
    const asset = image.id ? assets[image.id] : undefined
    if (asset && asset.data) {
      blocks.push({
        type: 'image',
        data: asset.data,
        mediaType: asset.mediaType || image.mime || 'image/png',
        name: image.name,
      })
    } else {
      stats.imagesDegraded += 1
      blocks.push({ type: 'text', text: `[图片] ${image.name}` })
    }
  }
  return blocks
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)}${units[unit]}`
}

function buildStep(message, assets, stats) {
  const content = []
  const thinking = messageThinking(message)
  if (thinking) content.push({ type: 'reasoning', text: thinking })
  const search = messageSearch(message)
  if (search) content.push({ type: 'text', text: search })
  const answer = messageText(message)
  if (answer) content.push({ type: 'text', text: answer })
  const step = { content }
  const time = toMs(message.inserted_at)
  if (time) step.time = time
  return step
}

function deriveTitle(session, branch) {
  const given = str(session && session.title).trim()
  if (given) return given
  const firstUser = branch.find((m) => m.role === 'USER')
  const text = messageText(firstUser).replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, MAX_TITLE) : 'DeepSeek 会话'
}

/**
 * 主转换。assets: { [fileId]: { data: base64, mediaType } }，缺省时图片降级成文本占位。
 * 返回 { document, stats }，document 可直接 JSON.stringify 写成 interchange v1 文件。
 */
export function deepseekToInterchange({ session, messages, assets = {}, provider = PROVIDER, model } = {}) {
  const stats = { turns: 0, steps: 0, images: 0, imagesDegraded: 0, malformedTurns: 0, skippedBlocks: 0 }
  const branch = currentBranch(session, messages)
  const turns = []
  let pending = null

  const flush = () => {
    if (!pending) return
    const hasContent = pending.prompt || pending.promptBlocks?.length || pending.steps.length || pending.compaction
    if (!hasContent) { stats.malformedTurns += 1 } else { turns.push(pending) }
    pending = null
  }

  for (const message of branch) {
    const role = str(message.role).toUpperCase()
    if (role === 'USER') {
      flush()
      const promptBlocks = buildPromptBlocks(message, assets, stats)
      const prompt = promptBlocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n')
      pending = { prompt, promptBlocks, steps: [], time: toMs(message.inserted_at) }
      stats.turns += 1
      continue
    }
    if (!pending) {
      pending = { prompt: '', promptBlocks: [], steps: [], time: toMs(message.inserted_at) }
      stats.turns += 1
    }
    pending.steps.push(buildStep(message, assets, stats))
    stats.steps += 1
  }
  flush()
  stats.images = branch.reduce((n, m) => n + partitionFiles(m).images.length, 0)
  if (!turns.length) stats.malformedTurns += 1

  const createdAt = toMs(session && (session.inserted_at || session.created_at)) ?? Date.now()
  const document = {
    interchange: INTERCHANGE_MARK,
    version: INTERCHANGE_VERSION,
    meta: {
      id: str(session && session.id) || `deepseek-${createdAt}`,
      sourceId: str(session && session.id) || undefined,
      createdAt,
    },
    title: deriveTitle(session, branch),
    provider,
  }
  if (model) document.model = model
  document.turns = turns.map((turn) => {
    const out = { prompt: turn.prompt }
    if (turn.promptBlocks && turn.promptBlocks.length > 1) out.promptBlocks = turn.promptBlocks
    else if (turn.promptBlocks && turn.promptBlocks.some((b) => b.type === 'image')) out.promptBlocks = turn.promptBlocks
    if (turn.time) out.time = turn.time
    if (turn.steps.length) out.steps = turn.steps
    if (turn.compaction) out.compaction = turn.compaction
    return out
  })
  return { document, stats }
}
