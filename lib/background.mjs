// lib/background.mjs — 把迁移放到独立进程里跑，Web 对话不必等十几分钟。
//
// 设计：插件工具只负责「拉起 + 报告进度」，真正的活由独立的 node 子进程做
// （它自己有运行锁、断点续跑、日志）。这样对话轮次不被占住，关掉页面也不影响。

import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOME_DIR } from './state.mjs'

const CLI_PATH = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))
export const RUN_INFO_PATH = join(HOME_DIR, 'run.json')
export const JOURNAL_PATH = join(HOME_DIR, 'run.log')

/** 生成传给 CLI 的参数（纯函数，便于测试）。 */
export function buildRunArgs(options = {}) {
  const args = ['run']
  if (options.since) args.push('--since', String(options.since))
  if (Number(options.limit) > 0) args.push('--limit', String(Number(options.limit)))
  if (Number(options.minTurns) > 0) args.push('--min-turns', String(Number(options.minTurns)))
  if (options.force) args.push('--force')
  if (options.downloadFiles === false) args.push('--no-files')
  if (options.outDir) args.push('--out', String(options.outDir))
  return args
}

/** 起一个后台迁移进程，立刻返回进程信息。 */
export async function startBackgroundRun(options = {}, { log = () => {}, cliPath = CLI_PATH, command = process.execPath } = {}) {
  await mkdir(HOME_DIR, { recursive: true })
  const args = buildRunArgs(options)
  // 日志按轮次轮转：超过 5MB 就重来，日志无限增长会拖慢读尾部
  try {
    const { stat, truncate } = await import('node:fs/promises')
    const info = await stat(JOURNAL_PATH)
    if (info.size > 5 * 1024 * 1024) await truncate(JOURNAL_PATH, 0)
  } catch { /* 日志还不存在 */ }
  const fd = openSync(JOURNAL_PATH, 'a')
  let child
  try {
    child = spawn(command, [cliPath, ...args], { detached: true, stdio: ['ignore', fd, fd] })
    child.on('error', (error) => log('启动后台迁移失败：' + error.message))
    child.unref()
  } catch (error) {
    log('启动后台迁移失败：' + error.message)
    return null
  }
  const info = { pid: child.pid, startedAt: Date.now(), args, journal: JOURNAL_PATH }
  const { writeFile } = await import('node:fs/promises')
  await writeFile(RUN_INFO_PATH, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 })
  return info
}

function isAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/** 读后台任务状态：是否还活着、日志末尾几行。 */
export async function readRunStatus({ tailLines = 12 } = {}) {
  let info = null
  try {
    info = JSON.parse(await readFile(RUN_INFO_PATH, 'utf8'))
  } catch {
    return { running: false, info: null, lines: [], lastLine: '' }
  }
  const alive = isAlive(Number(info.pid))
  let lines = []
  try {
    const text = await readFile(JOURNAL_PATH, 'utf8')
    lines = text.trimEnd().split('\n').slice(-tailLines)
  } catch { /* 没有日志 */ }
  return { running: alive, info, lines, lastLine: lines[lines.length - 1] || '' }
}

/** 渲染成人看的进度摘要。 */
export function renderRunStatus(status) {
  if (!status.info) return '还没有后台迁移记录。'
  const started = new Date(status.info.startedAt).toLocaleString()
  const head = status.running
    ? `后台迁移进行中（pid ${status.info.pid}，开始于 ${started}）`
    : `后台迁移已结束（pid ${status.info.pid}，开始于 ${started}）`
  return [head, ...status.lines.map((line) => '  ' + line)].join('\n')
}
