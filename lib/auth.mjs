// lib/auth.mjs — 登录态三级备略。
//   ① 已存凭证（auth.json 里的 token，或 Playwright persistent profile 里的 localStorage）
//   ② 纯 Node 直读系统浏览器 profile 的 LevelDB（不需要浏览器、不需要 Playwright）
//   ③ Playwright 拉起系统浏览器（msedge / chrome，不下载 Chromium）弹窗登录一次
// 顺序：① 命中就不碰浏览器；② 失败或没登录过才升级到 ③。

import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AUTH_PATH, HOME_DIR } from './state.mjs'

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/
export const DEEPSEEK_URL = 'https://chat.deepseek.com/'

async function exists(path) {
  try { await access(path, constants.F_OK); return true } catch { return false }
}

/** 从 Playwright storageState 形状的对象里挖 token。 */
export function tokenFromStorageState(state) {
  if (!state) return ''
  if (typeof state.token === 'string' && state.token) return state.token
  for (const origin of state.origins || []) {
    for (const item of origin.localStorage || []) {
      if (item && item.name === 'userToken' && item.value) {
        try {
          const parsed = JSON.parse(item.value)
          if (parsed && typeof parsed.value === 'string') return parsed.value
        } catch {
          const match = String(item.value).match(JWT)
          if (match) return match[0]
        }
      }
    }
  }
  return ''
}

export async function readAuthFile(path = AUTH_PATH) {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function writeAuthFile(payload, path = AUTH_PATH) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8')
}

/** 浏览器目录名的启发式清单：覆盖 Chrome/Edge/Chromium 与常见国产 Chromium 内核浏览器。 */
const BROWSER_DIR_HINT = /(chrome|chromium|edge|brave|vivaldi|opera|yandex|360|qq|tencent|sogou|quark|uc|liebao|2345|maxthon|browser)/i
/** 厂商目录（Windows 上浏览器普遍是 <厂商>/<产品>/User Data 两层）。 */
const VENDOR_DIR_HINT = /(google|microsoft|tencent|360|sogou|quark|uc|liebao|2345|maxthon|mozilla|brave|vivaldi|opera|yandex|alibaba)/i

/** 各平台上可能藏浏览器用户数据的基目录。 */
async function browserBases() {
  const home = homedir()
  const bases = []
  const os = platform()
  if (os === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const roaming = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    bases.push(local, roaming)
  } else if (os === 'darwin') {
    bases.push(join(home, 'Library', 'Application Support'))
  } else {
    bases.push(join(home, '.config'))
    // WSL：把 Windows 侧用户目录也加进来（浏览器多半跑在 Windows 上）
    let users = []
    try { users = await readdir('/mnt/c/Users', { withFileTypes: true }) } catch { users = [] }
    for (const user of users) {
      // 9p/网络盘上 dirent 类型可能不可靠，这里只按名字过滤
      if (['All Users', 'Default', 'Default User', 'Public', 'desktop.ini'].includes(user.name)) continue
      bases.push(join('/mnt/c/Users', user.name, 'AppData', 'Local'))
      bases.push(join('/mnt/c/Users', user.name, 'AppData', 'Roaming'))
    }
  }
  return bases
}

/**
 * 自动发现浏览器用户数据根（不写死厂商路径）。
 * 规则：在某基目录下找名字像浏览器的子目录，再看它自己或它的 User Data 子目录里有没有
 * `Local Storage/leveldb`。这样 Chrome、Edge、360、QQ、搜狗、夸克……都能被认出来。
 */
export async function browserRoots() {
  const roots = []
  const seen = new Set()
  const push = (name, root) => {
    if (seen.has(root)) return
    seen.add(root)
    roots.push({ name, root })
  }
  for (const base of await browserBases()) {
    let entries = []
    try { entries = await readdir(base, { withFileTypes: true }) } catch { continue }
    const probe = async (name, dir) => {
      // 根目录本身是 profile（含 Local Storage/leveldb），或者根目录下还有 Default / Profile N
      for (const candidate of [join(dir, 'User Data'), dir]) {
        if (await exists(join(candidate, 'Local Storage', 'leveldb'))) { push(name, candidate); return true }
        if (await exists(join(candidate, 'Default', 'Local Storage', 'leveldb'))) { push(name, candidate); return true }
      }
      return false
    }
    for (const entry of entries) {
      // 第一层可能是产品名（Chrome）也可能是厂商名（Google / Tencent / 360）
      if (!BROWSER_DIR_HINT.test(entry.name) && !VENDOR_DIR_HINT.test(entry.name)) continue
      const dir = join(base, entry.name)
      if (await probe(entry.name, dir)) continue
      // 再看一层：<厂商>/<产品>/User Data（Chrome、Edge、QQ浏览器等都是这个形状）
      if (!VENDOR_DIR_HINT.test(entry.name)) continue
      let children = []
      try { children = await readdir(dir, { withFileTypes: true }) } catch { continue }
      for (const child of children) {
        if (!BROWSER_DIR_HINT.test(child.name)) continue
        await probe(child.name, join(dir, child.name))
      }
    }
  }
  return roots
}

/** 列出所有 profile 的 localStorage LevelDB 目录（Default / Profile N / 根目录自身）。 */
export async function findLevelDbDirs() {
  const found = []
  for (const { name, root } of await browserRoots()) {
    const direct = join(root, 'Local Storage', 'leveldb')
    if (await exists(direct)) found.push({ browser: name, profile: '(root)', dir: direct })
    let entries = []
    try { entries = await readdir(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name !== 'Default' && !/^Profile \d+$/.test(entry.name)) continue
      const leveldb = join(root, entry.name, 'Local Storage', 'leveldb')
      if (await exists(leveldb)) found.push({ browser: name, profile: entry.name, dir: leveldb })
    }
  }
  return found
}

/** 在 LevelDB 文件里找离 userToken 最近的 JWT。纯 Node，不依赖任何库。 */
export async function readTokenFromLevelDb(dir) {
  let files = []
  try { files = await readdir(dir) } catch { return '' }
  const candidates = files.filter((f) => /\.(ldb|log)$/i.test(f))
  // .log 是最近的写入，先扫它
  candidates.sort((a, b) => (a.endsWith('.log') ? -1 : 1) - (b.endsWith('.log') ? -1 : 1))
  for (const file of candidates) {
    const full = join(dir, file)
    let buffer
    try {
      const info = await stat(full)
      if (info.size > 64 * 1024 * 1024) continue
      buffer = await readFile(full)
    } catch { continue }
    const token = scanBuffer(buffer)
    if (token) return token
  }
  return ''
}

function scanBuffer(buffer) {
  for (const encoding of ['latin1', 'utf16le']) {
    const text = buffer.toString(encoding)
    let from = 0
    while (true) {
      const at = text.indexOf('userToken', from)
      if (at < 0) break
      from = at + 1
      const window = text.slice(Math.max(0, at - 512), Math.min(text.length, at + 4096))
      const match = window.match(JWT)
      if (match) return match[0]
    }
  }
  return ''
}

/** ① 本地凭证：auth.json → 各浏览器 profile。 */
export async function resolveStoredToken({ log = () => {} } = {}) {
  const auth = await readAuthFile()
  const token = tokenFromStorageState(auth)
  if (token) return { token, source: 'auth.json' }
  const dirs = await findLevelDbDirs()
  for (const entry of dirs) {
    const found = await readTokenFromLevelDb(entry.dir)
    if (found) {
      log(`从 ${entry.browser}（${entry.profile}）读取到登录态`)
      return { token: found, source: `${entry.browser}/${entry.profile}` }
    }
  }
  return null
}

async function pickChannel(chromium) {
  for (const channel of ['msedge', 'chrome']) {
    try {
      const browser = await chromium.launch({ channel, headless: true, args: ['--no-sandbox'] })
      await browser.close()
      return channel
    } catch { /* 换下一个 */ }
  }
  return undefined
}

/** 找一份可用的 playwright：本地依赖 → npx 缓存里版本最高的那份。 */
export async function resolvePlaywright() {
  for (const spec of ['playwright', 'playwright-core']) {
    try { return await import(spec) } catch { /* 继续找 */ }
  }
  const cache = join(homedir(), '.npm', '_npx')
  let dirs = []
  try { dirs = await readdir(cache, { withFileTypes: true }) } catch { dirs = [] }
  const candidates = []
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue
    const dir = join(cache, entry.name, 'node_modules', 'playwright')
    const pkg = join(dir, 'package.json')
    if (!(await exists(pkg))) continue
    try {
      const version = JSON.parse(await readFile(pkg, 'utf8')).version
      candidates.push({ dir, version })
    } catch { /* 跳过坏包 */ }
  }
  candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
  for (const candidate of candidates) {
    for (const entry of ['index.mjs', 'index.js']) {
      const file = join(candidate.dir, entry)
      if (await exists(file)) {
        try { return await import(pathToFileURL(file).href) } catch { /* 换下一个 */ }
      }
    }
  }
  const error = new Error(
    '没有可用的 playwright。任选其一：npm i -g playwright；或在浏览器里登录 DeepSeek 后让我直接读浏览器存储。',
  )
  error.code = 'NO_PLAYWRIGHT'
  throw error
}

/** 复用 ~/.cache/ms-playwright 里已有的 chromium，避免下载与版本不匹配。 */
export async function resolveChromiumExecutable() {
  const base = join(homedir(), '.cache', 'ms-playwright')
  let dirs = []
  try { dirs = await readdir(base) } catch { return undefined }
  const chromiumDirs = dirs
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  for (const name of chromiumDirs) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = join(base, name, rel)
      if (await exists(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * ③ 弹窗登录：优先复用系统浏览器，其次 ~/.cache/ms-playwright 里的 chromium。
 * 成功后把 token 与 storageState 一起落盘，下次零交互。
 */
export async function loginInteractively({ log = () => {}, timeoutMs = 5 * 60 * 1000, pollMs = 1500 } = {}) {
  const playwright = await resolvePlaywright()
  const { chromium } = playwright
  const channel = await pickChannel(chromium)
  const executablePath = channel ? undefined : await resolveChromiumExecutable()
  if (channel) log(`使用系统浏览器：${channel}`)
  else if (executablePath) log(`使用已缓存的 Chromium：${executablePath}`)
  else log('没有系统浏览器也没有缓存 Chromium，将尝试让 playwright 自行解析')
  const userDataDir = join(HOME_DIR, 'browser-profile')
  await mkdir(userDataDir, { recursive: true })
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel,
    executablePath,
    headless: false,
    args: ['--no-sandbox'],
    viewport: { width: 1280, height: 800 },
  })
  try {
    const page = context.pages()[0] || (await context.newPage())
    await page.goto(DEEPSEEK_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
    log('请在弹出的窗口里登录 DeepSeek（手机号 / 微信扫码均可），登录完成后自动继续…')
    const deadline = Date.now() + timeoutMs
    let lastAnnounce = 0
    while (Date.now() < deadline) {
      const token = await page
        .evaluate(() => {
          try {
            const raw = window.localStorage.getItem('userToken')
            if (!raw) return ''
            try { return JSON.parse(raw).value || '' } catch { return raw }
          } catch { return '' }
        })
        .catch(() => '')
      if (token) {
        const state = await context.storageState().catch(() => null)
        await writeAuthFile({ token, savedAt: Date.now(), storageState: state, source: 'playwright' })
        log('登录成功，凭证已保存')
        return { token, source: 'playwright' }
      }
      if (Date.now() - lastAnnounce > 20000) {
        lastAnnounce = Date.now()
        log(`等待登录中…（剩 ${Math.round((deadline - Date.now()) / 1000)}s）`)
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    throw new Error('登录超时：5 分钟内没有检测到登录完成')
  } finally {
    await context.close().catch(() => {})
  }
}

/** 把全部备略串起来：凭证文件 → 浏览器存储 → CDP 调试端口 → token 文件 → 弹窗登录。 */
export async function resolveToken({ log = () => {}, interactive = true, cdpPort, tokenFile } = {}) {
  const stored = await resolveStoredToken({ log })
  if (stored) return stored

  // 浏览器已经用 --remote-debugging-port 起着的场景（含国产 Chromium 内核浏览器）
  const { readTokenViaCdp, readTokenFromFile } = await import('./cdp.mjs')
  const viaCdp = await readTokenViaCdp({ port: cdpPort || 9222 })
  if (viaCdp) {
    await writeAuthFile({ token: viaCdp.token, savedAt: Date.now(), source: viaCdp.source })
    log(`从 CDP 调试端口读到登录态（${viaCdp.source}）`)
    return viaCdp
  }

  if (tokenFile) {
    const manual = await readTokenFromFile(tokenFile)
    if (manual) {
      await writeAuthFile({ token: manual, savedAt: Date.now(), source: 'token-file' })
      return { token: manual, source: 'token-file' }
    }
    log(`指定的 token 文件读不出内容：${tokenFile}`)
  }

  if (!interactive) throw new Error('没有本地凭证，且禁用了交互式登录')

  // 自动拉起一个带调试端口的 Chromium 内核浏览器（Chrome/Edge/360/QQ…），用户只需登录一次。
  try {
    const { loginViaLaunchedBrowser } = await import('./launch.mjs')
    const port = Number(cdpPort) || 9222
    const launched = await loginViaLaunchedBrowser({ port, log })
    if (launched) {
      await writeAuthFile({ token: launched.token, savedAt: Date.now(), source: launched.source })
      return launched
    }
  } catch (error) {
    log('自动拉起浏览器失败：' + String((error && error.message) || error))
  }

  log('退回 Playwright 弹窗登录…')
  return loginInteractively({ log })
}
