// lib/cdp.mjs — 通过 Chrome DevTools Protocol 读 localStorage.userToken。
//
// 不依赖 Playwright：Node 22 自带 fetch 与 WebSocket。只要目标浏览器用
// --remote-debugging-port 启动（Chrome / Edge / Chromium，以及 360、QQ、
// 搜狗等 Chromium 内核的国产浏览器在「极速模式」下的调试端口），就能连上。
// 这比读 LevelDB 可靠：不受 Snappy 压缩影响，也不关心 profile 存在哪。

const DEFAULT_PORT = 9222

/** 从 /json 列表里挑出 chat.deepseek.com 的页面目标（纯函数，便于测试）。 */
export function pickDeepseekTarget(targets) {
  if (!Array.isArray(targets)) return null
  return (
    targets.find((t) => t && t.type === 'page' && /chat\.deepseek\.com/i.test(String(t.url || ''))) ||
    targets.find((t) => t && t.type === 'page' && /deepseek\.com/i.test(String(t.url || ''))) ||
    null
  )
}

/** 从 Runtime.evaluate 的响应文本里挖 token（纯函数，便于测试）。 */
export function extractTokenFromCdpResponse(text) {
  let message
  try {
    message = JSON.parse(String(text))
  } catch {
    return ''
  }
  const value = message && message.result && message.result.result && message.result.result.value
  if (typeof value !== 'string' || !value) return ''
  // 页面返回的可能是 localStorage 的原始 JSON：{"value":"<token>"}
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed.value === 'string' && parsed.value) return parsed.value
  } catch { /* 不是 JSON，按裸 token 处理 */ }
  return value.trim()
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 连上调试端口，读 chat.deepseek.com 页面的 userToken。
 * 返回 { token, source } 或 ''。
 */
export async function readTokenViaCdp({ port = DEFAULT_PORT, host = '127.0.0.1', timeoutMs = 5000 } = {}) {
  const base = `http://${host}:${port}`
  const version = await fetchJson(`${base}/json/version`, timeoutMs)
  if (!version) return ''
  const targets = await fetchJson(`${base}/json`, timeoutMs)
  const target = pickDeepseekTarget(targets)
  if (!target || !target.webSocketDebuggerUrl) return ''
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
    })
    const payload = JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: "localStorage.getItem('userToken')", returnByValue: true },
    })
    socket.send(payload)
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 响应超时')), timeoutMs)
      socket.addEventListener('message', (event) => {
        clearTimeout(timer)
        resolve(typeof event.data === 'string' ? event.data : String(event.data))
      }, { once: true })
    })
    const token = extractTokenFromCdpResponse(reply)
    return token ? { token, source: `cdp:${version.Browser || 'chromium'}` } : ''
  } catch {
    return ''
  } finally {
    try { socket.close() } catch { /* 忽略 */ }
  }
}

/** 探测某个调试端口：返回浏览器标识、页面目标、以及是否已打开 DeepSeek。 */
export async function probeCdp({ port = 9222, host = '127.0.0.1', timeoutMs = 800 } = {}) {
  const base = `http://${host}:${port}`
  const version = await fetchJson(`${base}/json/version`, timeoutMs)
  if (!version) return null
  const targets = (await fetchJson(`${base}/json`, timeoutMs)) || []
  return {
    port,
    browser: String(version.Browser || 'chromium'),
    targets: targets.length,
    hasDeepseek: Boolean(pickDeepseekTarget(targets)),
  }
}

/** 写一份可直接被脚本读走的凭证（用户自己把 token 存文件时用）。 */
export async function readTokenFromFile(path) {
  const { readFile } = await import('node:fs/promises')
  try {
    const raw = (await readFile(path, 'utf8')).trim()
    if (!raw) return ''
    // 支持三种：裸 token、{"token":"..."}、{"value":"..."}
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.token === 'string') return parsed.token
      if (parsed && typeof parsed.value === 'string') return parsed.value
    } catch { /* 裸 token */ }
    return raw
  } catch {
    return ''
  }
}
