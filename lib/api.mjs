// lib/api.mjs — chat.deepseek.com 私有接口客户端（列表 / 会话 / 文件），限速与退避写死。
//
// 端点来自社区实现（agoramachina/deepseek-exporter 等）：
//   列表 POST/GET /api/v0/chat_session/fetch_page?lte_cursor.pinned=false[&lte_cursor.updated_at=]
//   消息 GET      /api/v0/chat/history_messages?chat_session_id=<id>&cache_version=0
// 认证是 Bearer token（localStorage.userToken 的 .value），不是 cookie。
// 响应外层 { code, msg, data: { biz_code, biz_msg, biz_data } }。

export const BASE_URL = 'https://chat.deepseek.com'
// 文件服务：前端把 signed_path 拼到 https://<filesBaseDomain>/api 后面，
// 再带 ty=p（图片预览）/ ty=r（原文件）。域名见前端常量 files.deepseeksvc.com。
export const FILE_BASE_URL = 'https://files.deepseeksvc.com/api'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export class AuthError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuthError'
  }
}

export class RateLimitError extends Error {
  constructor(message, retryAfterMs) {
    super(message)
    this.name = 'RateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class DeepSeekApi {
  #lastAt = 0

  constructor(options = {}) {
    const {
      token,
      baseUrl = BASE_URL,
      fetchImpl,
      minIntervalMs = 1000,
      maxRetries = 4,
      log = () => {},
      requestTimeoutMs = 30000,
      fileTimeoutMs = 180000,
    } = options
    if (!token) throw new AuthError('缺少 DeepSeek token')
    this.token = token
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.fetchImpl = fetchImpl || globalThis.fetch
    this.minIntervalMs = Math.max(0, minIntervalMs)
    this.maxRetries = Math.max(1, maxRetries)
    this.log = log
    this.requests = 0
    this.requestTimeoutMs = Math.max(1000, requestTimeoutMs)
    this.fileTimeoutMs = Math.max(5000, fileTimeoutMs)
  }

  /** 带超时的 fetch：卡住的连接不能把整个迁移拖死。 */
  async #fetchTimed(url, { timeoutMs = this.requestTimeoutMs, headers } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await this.fetchImpl(url, { headers: headers || this.headers(), signal: controller.signal })
    } catch (error) {
      if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
        const timeout = new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)
        timeout.name = 'TimeoutError'
        throw timeout
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async #throttle() {
    const wait = this.minIntervalMs - (Date.now() - this.#lastAt)
    if (wait > 0) await sleep(wait)
    this.#lastAt = Date.now()
  }

  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json, text/plain, */*',
      'User-Agent': UA,
      Referer: `${this.baseUrl}/`,
    }
  }

  async #request(url, { retries = this.maxRetries } = {}) {
    let lastError
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      await this.#throttle()
      this.requests += 1
      let response
      try {
        response = await this.#fetchTimed(url)
      } catch (error) {
        lastError = error
        this.log(`网络错误（第 ${attempt}/${retries} 次）：${error.message}`)
        await sleep(1000 * attempt + Math.floor(Math.random() * 400))
        continue
      }
      if (response.status === 401 || response.status === 403) {
        throw new AuthError(`登录态失效（HTTP ${response.status}），请重新登录 DeepSeek`)
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after')) * 1000
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2000 * attempt
        this.log(`被限流（429），等待 ${Math.round(waitMs / 1000)}s 后重试`)
        await sleep(waitMs)
        lastError = new RateLimitError('429 Too Many Requests', waitMs)
        continue
      }
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} ${response.statusText}`)
        this.log(`请求失败（第 ${attempt}/${retries} 次）：${lastError.message}`)
        await sleep(500 * attempt)
        continue
      }
      const declared = Number(response.headers.get('content-length') || 0)
      this.lastDeclaredBytes = declared
      if (declared > 64 * 1024 * 1024) this.log(`提示：响应体 ${Math.round(declared / 1048576)}MB，较大`)
      let text
      try {
        text = await response.text()
      } catch (error) {
        lastError = new Error(`读取响应失败：${error.message}`)
        this.log(`读取响应失败（第 ${attempt}/${retries} 次）：${error.message}`)
        await sleep(500 * attempt)
        continue
      }
      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`响应不是 JSON：${text.slice(0, 200)}`)
      }
      this.lastBytes = text.length
      if (json.code !== 0 || (json.data && json.data.biz_code !== 0)) {
        throw new Error(`接口错误：${json.msg || (json.data && json.data.biz_msg) || '未知错误'}`)
      }
      return json.data ? json.data.biz_data : json
    }
    throw lastError || new Error('请求在重试后仍然失败')
  }

  /** 全量会话列表（自己翻页，去重，最多 500 页）。 */
  async listSessions({ onPage } = {}) {
    const sessions = []
    const seen = new Set()
    let url = `${this.baseUrl}/api/v0/chat_session/fetch_page?lte_cursor.pinned=false`
    for (let page = 0; page < 500; page += 1) {
      const data = await this.#request(url)
      const items = (data && data.chat_sessions) || []
      let fresh = 0
      for (const item of items) {
        const id = String(item.id)
        if (seen.has(id)) continue
        seen.add(id)
        sessions.push(item)
        fresh += 1
      }
      if (onPage) onPage({ page: page + 1, total: sessions.length, fresh })
      if (!data || !data.has_more || items.length === 0 || fresh === 0) break
      const last = items[items.length - 1]
      url = `${this.baseUrl}/api/v0/chat_session/fetch_page?lte_cursor.pinned=false&lte_cursor.updated_at=${encodeURIComponent(last.updated_at)}`
    }
    return sessions
  }

  /** 会话 + 它这次响应的大小（字节）：超大会话要在解析前就判定，避免内存峰值。 */
  async fetchSessionMeta(sessionId) {
    const data = await this.fetchSession(sessionId)
    return { data, bytes: Number(this.lastBytes || 0) }
  }

  /** 单个会话的完整消息树。 */
  async fetchSession(sessionId) {
    const url = `${this.baseUrl}/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}&cache_version=0`
    return this.#request(url)
  }

  /**
   * 文件内容。DeepSeek 的文件端点没有公开文档，这里按已知形态依次尝试；
   * 全部失败返回 null，由调用方降级成文本占位。
   */
  async fetchFile(ref, { retries = 2 } = {}) {
    const isObject = ref && typeof ref === 'object'
    const fileId = typeof ref === 'string' ? ref : (isObject && ref.id) || ''
    const signedPath = isObject ? String(ref.signedPath || '') : ''
    const isImage = Boolean(isObject && ref.isImage)
    const candidates = []
    // 正式路径：files.deepseeksvc.com/api + signed_path + ty=p|r
    if (signedPath && /^\/(?!\/)/.test(signedPath)) {
      const sep = signedPath.includes('?') ? '&' : '?'
      const preferred = isImage ? 'p' : 'r'
      candidates.push(`${FILE_BASE_URL}${signedPath}${sep}ty=${preferred}`)
      candidates.push(`${FILE_BASE_URL}${signedPath}${sep}ty=${preferred === 'p' ? 'r' : 'p'}`)
    } else if (signedPath) {
      candidates.push(/^https?:/i.test(signedPath) ? signedPath : `${this.baseUrl}${signedPath}`)
    }
    if (!signedPath && fileId) {
      candidates.push(
        `${this.baseUrl}/api/v0/file/preview?file_id=${encodeURIComponent(fileId)}`,
        `${this.baseUrl}/api/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`,
      )
    }
    for (const url of candidates) {
      try {
        await this.#throttle()
        this.requests += 1
        const response = await this.#fetchTimed(url, { timeoutMs: this.fileTimeoutMs })
        if (!response.ok) continue
        const type = response.headers.get('content-type') || ''
        if (/json/i.test(type)) {
          const json = await response.json()
          const inner = json && json.data ? json.data.biz_data : json
          const link = inner && (inner.url || inner.download_url || inner.file_url)
          if (link) {
            const binary = await this.#fetchTimed(link, { timeoutMs: this.fileTimeoutMs })
            if (binary.ok) {
              const buffer = Buffer.from(await binary.arrayBuffer())
              return { buffer, contentType: binary.headers.get('content-type') || 'application/octet-stream' }
            }
          }
          continue
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        if (!buffer.length) continue
        if (/^text\/html/i.test(type) || /json/i.test(type)) continue
        return { buffer, contentType: type || 'application/octet-stream' }
      } catch (error) {
        this.log(`文件 ${fileId || '?'} 读取失败：${error.message}`)
      }
    }
    return null
  }
}
