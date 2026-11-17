// lib/launch.mjs — 自动拉起一个带调试端口的 Chromium 内核浏览器，让用户登录一次。
// 这是「一句话迁移」里唯一必须由人参与的环节：扫码 / 输手机号。其余全自动。

import { spawn } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { readTokenViaCdp } from './cdp.mjs'
import { HOME_DIR } from './state.mjs'

const DEEPSEEK_URL = 'https://chat.deepseek.com/'

async function exists(path) {
  try { await access(path, constants.F_OK); return true } catch { return false }
}

const isWsl = async () => platform() === 'linux' && (await exists('/mnt/c/Windows'))

/** 候选浏览器可执行文件（先环境变量，再各平台常见位置，最后 WSL 下的 Windows 浏览器）。 */
export async function candidateBrowsers() {
  const list = []
  const push = (name, command) => { if (command && !list.some((x) => x.command === command)) list.push({ name, command }) }
  if (process.env.DSH_BROWSER_PATH) push('$DSH_BROWSER_PATH', process.env.DSH_BROWSER_PATH)
  if (process.env.CHROME_PATH) push('$CHROME_PATH', process.env.CHROME_PATH)

  const os = platform()
  if (os === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)
    for (const root of roots) {
      push('Chrome', join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      push('Edge', join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
      push('360 极速', join(root, '360', '360Chrome', 'Chrome', 'Application', '360chrome.exe'))
      push('QQ 浏览器', join(root, 'Tencent', 'QQBrowser', 'QQBrowser.exe'))
    }
  } else if (os === 'darwin') {
    push('Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    push('Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    push('Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium')
  } else {
    for (const command of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      push(command, command)
    }
    if (await isWsl()) {
      const users = ['/mnt/c/Program Files', '/mnt/c/Program Files (x86)']
      for (const root of users) {
        push('Chrome (Windows)', `${root}/Google/Chrome/Application/chrome.exe`)
        push('Edge (Windows)', `${root}/Microsoft/Edge/Application/msedge.exe`)
      }
    }
  }
  return list
}

/** 构造启动参数（纯函数，便于测试）。 */
export function buildLaunchArgs({ port, profileDir, url = DEEPSEEK_URL } = {}) {
  return [
    `--remote-debugging-port=${Number(port) || 9222}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    url,
  ]
}

/** WSL 下把 Linux 路径换成 Windows 路径（浏览器的 --user-data-dir 只认 Windows 路径）。 */
export async function toLaunchProfileDir(profileDir, { windowsTarget }) {
  if (!windowsTarget) return profileDir
  const { execFile } = await import('node:child_process')
  return await new Promise((resolve) => {
    execFile('wslpath', ['-w', profileDir], (error, stdout) => {
      resolve(error ? profileDir : String(stdout).trim())
    })
  })
}

/** 拉起浏览器（不等待登录）。返回 { name, command, child }。 */
export async function launchBrowser({ port = 9222, log = () => {} } = {}) {
  const candidates = await candidateBrowsers()
  const profileDir = join(HOME_DIR, 'cdp-profile')
  await mkdir(profileDir, { recursive: true })
  for (const candidate of candidates) {
    const windowsTarget = /^\/mnt\/c\//.test(candidate.command) || /\.exe$/i.test(candidate.command)
    const launchProfile = await toLaunchProfileDir(profileDir, { windowsTarget })
    const args = buildLaunchArgs({ port, profileDir: launchProfile })
    try {
      const child = spawn(candidate.command, args, { detached: true, stdio: 'ignore' })
      child.unref()
      // 给进程一点启动时间，再确认调试端口是否真的起来了
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const probe = await readTokenViaCdp({ port, timeoutMs: 2500 })
      if (probe) return { ...candidate, child, alreadyLoggedIn: true }
      const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      if (version) {
        log(`已启动 ${candidate.name}，请在弹出的窗口里登录 DeepSeek`)
        return { ...candidate, child, version }
      }
    } catch { /* 换下一个候选 */ }
    log(`未能启动 ${candidate.name}，尝试下一个…`)
  }
  return null
}

/**
 * 拉起浏览器并等待用户登录，最多 timeoutMs。
 * 返回 { token, source } 或 null。
 */
export async function loginViaLaunchedBrowser({ port = 9222, timeoutMs = 5 * 60 * 1000, log = () => {} } = {}) {
  const launched = await launchBrowser({ port, log })
  if (!launched) {
    log('没有可用的 Chromium 内核浏览器，无法自动拉起。请手动启动浏览器并带上 --remote-debugging-port=' + port)
    return null
  }
  if (launched.alreadyLoggedIn) {
    const hit = await readTokenViaCdp({ port })
    return hit || null
  }
  const deadline = Date.now() + timeoutMs
  let lastNotice = 0
  while (Date.now() < deadline) {
    const hit = await readTokenViaCdp({ port })
    if (hit) {
      log('检测到登录完成')
      return hit
    }
    if (Date.now() - lastNotice > 20000) {
      lastNotice = Date.now()
      log(`等待登录中…（剩 ${Math.round((deadline - Date.now()) / 1000)}s）`)
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  log('等待登录超时')
  return null
}
