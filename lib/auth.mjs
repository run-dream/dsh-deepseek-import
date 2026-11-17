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

/** 已知浏览器的用户数据根目录（每个元素是一个 “User Data” 根）。 */
function linuxBrowserRoots() {
  const home = homedir()
  return [
    { name: 'Chrome', root: join(home, '.config', 'google-chrome') },
    { name: 'Chromium', root: join(home, '.config', 'chromium') },
    { name: 'Edge', root: join(home, '.config', 'microsoft-edge') },
  ]
}

export async function browserRoots() {
  const home = homedir()
  const os = platform()
  if (os === 'linux') return [...(await linuxBrowserRoots()), ...(await windowsBrowserRoots())]
  if (os === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    return [
      { name: 'Edge', root: join(local, 'Microsoft', 'Edge', 'User Data') },
      { name: 'Chrome', root: join(local, 'Google', 'Chrome', 'User Data') },
    ]
  }
  if (os === 'darwin') {
    return [
      { name: 'Chrome', root: join(home, 'Library', 'Application Support', 'Google', 'Chrome') },
      { name: 'Edge', root: join(home, 'Library', 'Application Support', 'Microsoft Edge') },
    ]
  }
  return [
    { name: 'Chrome', root: join(home, '.config', 'google-chrome') },
    { name: 'Chromium', root: join(home, '.config', 'chromium') },
    { name: 'Edge', root: join(home, '.config', 'microsoft-edge') },
  ]
}

/** WSL：Windows 侧浏览器的 User Data 根（/mnt/c/Users/<user>/AppData/Local/...）。 */
async function windowsBrowserRoots() {
  const found = []
  let users = []
  try { users = await readdir('/mnt/c/Users', { withFileTypes: true }) } catch { return found }
  for (const user of users) {
    if (!user.isDirectory()) continue
    if (['All Users', 'Default', 'Default User', 'Public'].includes(user.name)) continue
    const base = join('/mnt/c/Users', user.name, 'AppData', 'Local')
    for (const [name, rel] of [
      ['Chrome (Windows)', join('Google', 'Chrome', 'User Data')],
      ['Edge (Windows)', join('Microsoft', 'Edge', 'User Data')],
      ['Chromium (Windows)', join('Chromium', 'User Data')],
    ]) {
      const root = join(base, rel)
      if (await exists(root)) found.push({ name, root })
    }
  }
  return found
}

/** 列出所有 profile 的 localStorage LevelDB 目录（Default / Profile N）。 */
export async function findLevelDbDirs() {
  const found = []
  for (const { name, root } of await browserRoots()) {
    if (!(await exists(root))) continue
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

/** 把三级备略串起来。 */
export async function resolveToken({ log = () => {}, interactive = true } = {}) {
  const stored = await resolveStoredToken({ log })
  if (stored) return stored
  if (!interactive) throw new Error('没有本地凭证，且禁用了交互式登录')
  return loginInteractively({ log })
}
