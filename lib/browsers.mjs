// lib/browsers.mjs — 「先检测，再决策」的浏览器发现层。
//
// 迁移的第一步不该是「有没有 token」，而是「这台机器上有什么浏览器、哪个已经登录过」。
// 本模块只做只读探测，给出建议动作，由调用方决定要不要拉起新窗口。

import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { findLevelDbDirs, readTokenFromLevelDb } from './auth.mjs'
import { probeCdp } from './cdp.mjs'
import { candidateBrowsers } from './launch.mjs'

const CDP_PORTS = [9222, 9223, 9333]

async function exists(path) {
  try { await access(path, constants.F_OK); return true } catch { return false }
}

/** 可执行文件是否真的存在（裸命令名走 PATH 查找）。 */
export async function isInstalled(command) {
  if (!command) return false
  if (command.includes('/') || command.includes('\\')) return exists(command)
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (dir && (await exists(join(dir, command)))) return true
  }
  return false
}

/**
 * 扫描：装了哪些浏览器、哪些 profile 有登录态、哪些调试端口活着。
 * 返回结构稳定，便于 CLI 与工具复用。
 */
export async function scanBrowsers({ ports = CDP_PORTS, checkTokens = true } = {}) {
  const installed = []
  for (const candidate of await candidateBrowsers()) {
    if (await isInstalled(candidate.command)) installed.push(candidate)
  }

  const profiles = []
  for (const entry of await findLevelDbDirs()) {
    let hasToken = false
    if (checkTokens) {
      try { hasToken = Boolean(await readTokenFromLevelDb(entry.dir)) } catch { hasToken = false }
    }
    profiles.push({ browser: entry.browser, profile: entry.profile, dir: entry.dir, hasToken })
  }

  const cdp = []
  for (const port of ports) {
    const info = await probeCdp({ port })
    if (info) cdp.push(info)
  }

  const usableProfile = profiles.find((p) => p.hasToken)
  const usableCdp = cdp.find((c) => c.hasDeepseek) || cdp[0]
  const recommendation = usableProfile ? 'use-profile'
    : usableCdp ? 'attach-cdp'
    : installed.length ? 'launch'
    : 'none'

  return { installed, profiles, cdp, recommendation }
}

/** 渲染成给人看的一段话（CLI / 工具输出共用）。 */
export function renderScan(scan) {
  const lines = []
  lines.push(`浏览器：${scan.installed.length ? scan.installed.map((b) => b.name).join('、') : '未检测到 Chromium 内核浏览器'}`)

  if (scan.profiles.length) {
    lines.push('profile 与登录态：')
    for (const p of scan.profiles) lines.push(`  ${p.hasToken ? '✔ 已登录' : '✘ 无登录态'}  ${p.browser} / ${p.profile}`)
  } else {
    lines.push('profile：没找到任何 localStorage 目录')
  }

  if (scan.cdp.length) {
    lines.push('调试端口：')
    for (const c of scan.cdp) lines.push(`  :${c.port}  ${c.browser}${c.hasDeepseek ? '（已打开 DeepSeek）' : '（未打开 DeepSeek）'}`)
  }

  const verdict = {
    'use-profile': '结论：可以直接用已登录的浏览器，无需任何弹窗',
    'attach-cdp': '结论：可以直接连已有调试端口',
    launch: '结论：需要拉起一个浏览器让用户登录一次',
    none: '结论：没有可用浏览器，只能用 --token-file 手动提供 token',
  }[scan.recommendation]
  lines.push(verdict)
  return lines.join('\n')
}
