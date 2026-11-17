#!/usr/bin/env node
// bin/cli.mjs — 独立 CLI，用来先跑通链路（不依赖 DSH 插件装配）。
//   ds-migrate login            弹窗登录一次并保存凭证
//   ds-migrate whoami           显示登录态来源（不打印 token）
//   ds-migrate list [--json]    列出账号里的会话
//   ds-migrate dump <id>        把一条会话的原始响应存下来（用于核对字段）
//   ds-migrate run [flags]      全量迁移：拉 → 转 → 落盘
//   ds-migrate doctor           打印状态/产物/待办提示

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DeepSeekApi } from '../lib/api.mjs'
import { loginInteractively, resolveStoredToken, resolveToken, writeAuthFile } from '../lib/auth.mjs'
import { renderScan, scanBrowsers } from '../lib/browsers.mjs'
import { readTokenFromFile, readTokenViaCdp } from '../lib/cdp.mjs'
import { migrateAccount } from '../lib/migrate.mjs'
import { OUT_DIR, STATE_PATH, acquireRunLock, loadState, releaseRunLock, saveState } from '../lib/state.mjs'

const argv = process.argv.slice(2)
const command = argv[0] || 'help'

function flag(name, fallback) {
  const at = argv.indexOf(`--${name}`)
  if (at < 0) return fallback
  const value = argv[at + 1]
  if (!value || value.startsWith('--')) return true
  return value
}

const log = (message) => process.stdout.write(`${message}\n`)

const cdpPort = flag('cdp', undefined)
const tokenFile = flag('token-file', undefined)

async function buildApi() {
  const resolved = await resolveToken({
    log,
    cdpPort: Number(cdpPort) || undefined,
    tokenFile: typeof tokenFile === 'string' ? tokenFile : undefined,
  })
  return { api: new DeepSeekApi({ token: resolved.token, log }), resolved }
}

async function main() {
  if (command === 'help' || command === '--help') {
    log(`用法：
  ds-migrate login                         弹窗登录 DeepSeek 并保存凭证
  ds-migrate whoami                        查看登录态来源
  ds-migrate list [--json]                 列出会话
  ds-migrate dump <sessionId> [--out f]    保存一条会话的原始 JSON
  ds-migrate run [--dry-run] [--limit N] [--min-turns N] [--since YYYY-MM-DD] [--force] [--no-files] [--out dir]
  ds-migrate doctor                        体检

产出的 interchange v1 文件默认写到：${OUT_DIR}
之后交给 dsh：/import auto <目录>（或在 web 会话里说“把 out 里的对话导进来”）
`)
    return 0
  }

  if (command === 'login') {
    // 第一步永远是检测：已经登录过就别再弹窗
    const scan = await scanBrowsers({ checkTokens: true })
    if (argv.includes('--verbose')) log(renderScan(scan))
    if (scan.recommendation === 'use-profile' || scan.recommendation === 'attach-cdp') {
      const resolved = await resolveToken({ log })
      log(`已有可用登录态（来源：${resolved.source}），无需重新登录`)
      return 0
    }
    // 默认走「自动拉起浏览器 + CDP」，失败再退回 Playwright
    if (cdpPort !== undefined || argv.includes('--cdp')) {
      const { loginViaLaunchedBrowser } = await import('../lib/launch.mjs')
      const port = Number(cdpPort) || 9222
      const hit = await loginViaLaunchedBrowser({ port, log })
      if (!hit) return 1
      await writeAuthFile({ token: hit.token, savedAt: Date.now(), source: hit.source })
      log(`登录成功（${hit.source}）`)
      return 0
    }
    const resolved = await resolveToken({ log, cdpPort: Number(cdpPort) || undefined, tokenFile: typeof tokenFile === 'string' ? tokenFile : undefined })
    log(`登录态已就绪（来源：${resolved.source}）`)
    return 0
  }

  if (command === 'whoami') {
    const stored = await resolveStoredToken({ log: () => {} })
    if (!stored) {
      log('没有找到 DeepSeek 登录态。运行：ds-migrate login')
      return 1
    }
    log(`登录态来源：${stored.source}（token 长度 ${stored.token.length}，不打印内容）`)
    return 0
  }

  if (command === 'doctor') {
    const state = await loadState()
    const dir = resolve(String(flag('out', OUT_DIR)))
    let files = []
    try { files = (await readdir(dir)).filter((f) => f.endsWith('.interchange.json')) } catch { /* 无产物 */ }

    log(`Node：${process.version}（要求 >=20）${Number(process.versions.node.split('.')[0]) >= 20 ? ' ✔' : ' ✘'}`)

    // 网络：只探测两个真正会用到的域名
    const probe = async (url) => {
      const started = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 6000)
      try {
        const res = await fetch(url, { method: 'GET', signal: controller.signal, headers: { 'User-Agent': 'dsh-doctor' } })
        return { ok: true, status: res.status, ms: Date.now() - started }
      } catch (error) {
        return { ok: false, error: error.name === 'AbortError' ? '超时 6s' : error.message, ms: Date.now() - started }
      } finally { clearTimeout(timer) }
    }
    const chat = await probe('https://chat.deepseek.com/')
    const files_svc = await probe('https://files.deepseeksvc.com/')
    log(`chat.deepseek.com：${chat.ok ? `✔ ${chat.status} (${chat.ms}ms)` : `✘ ${chat.error}`}`)
    log(`files.deepseeksvc.com：${files_svc.ok ? `✔ ${files_svc.status} (${files_svc.ms}ms)` : `✘ ${files_svc.error}`}`)

    const stored = await resolveStoredToken({ log: () => {} })
    log(`登录态：${stored ? `✔ ${stored.source}` : '✘ 无（运行 ds-migrate login）'}`)

    const scan = await scanBrowsers({ checkTokens: false })
    log(`浏览器：${scan.installed.length ? scan.installed.map((b) => b.name).join('、') : '未检测到'}`)
    log(`调试端口：${scan.cdp.length ? scan.cdp.map((c) => `:${c.port} ${c.browser}`).join('、') : '无'}`)

    log(`状态文件：${STATE_PATH}（已记录 ${Object.keys(state.sessions).length} 条会话）`)
    log(`产物目录：${dir}（${files.length} 个 interchange 文件）`)

    try {
      const { statfs } = await import('node:fs/promises')
      const fsInfo = await statfs(dir)
      const freeGb = (fsInfo.bavail * fsInfo.bsize) / 1024 / 1024 / 1024
      log(`磁盘剩余：${freeGb.toFixed(1)} GB ${freeGb > 2 ? '✔' : '⚠ 空间偏小'}`)
    } catch { /* 部分平台不支持 statfs */ }

    if (files.length) log(`下一步：/import auto "${dir}"`)
    return 0
  }

  if (command === 'browsers') {
    const scan = await scanBrowsers()
    log(renderScan(scan))
    log('')
    log('如果上面没有你的浏览器（例如装在非常规位置），可以：')
    log('  1) 用 --remote-debugging-port=9222 启动它，再跑 ds-migrate token --cdp 9222')
    log('  2) 或控制台复制 token（JSON.parse(localStorage.userToken).value）存文件，跑 ds-migrate token --file <路径>')
    return scan.recommendation === 'none' ? 1 : 0
  }

  if (command === 'token') {
    const manual = typeof tokenFile === 'string' ? await readTokenFromFile(tokenFile) : ''
    if (manual) {
      await writeAuthFile({ token: manual, savedAt: Date.now(), source: 'token-file' })
      log('已从文件导入 token')
      return 0
    }
    const port = Number(cdpPort) || 9222
    const viaCdp = await readTokenViaCdp({ port })
    if (viaCdp) {
      await writeAuthFile({ token: viaCdp.token, savedAt: Date.now(), source: viaCdp.source })
      log(`已从 CDP 端口 ${port} 读取并保存登录态（${viaCdp.source}）`)
      return 0
    }
    log(`两种方式都没拿到 token。用法：
  ds-migrate token --file /path/to/token.txt      从文件读（裸 token 或 {"token":"..."}）
  ds-migrate token --cdp 9222                     从浏览器调试端口读
先用 --remote-debugging-port=9222 启动浏览器，并在里面登录 chat.deepseek.com。`)
    return 1
  }

  if (command === 'list') {
    const { api } = await buildApi()
    const sessions = await api.listSessions({ onPage: ({ total }) => log(`  已取 ${total} 条…`) })
    if (flag('json', false)) {
      log(JSON.stringify(sessions, null, 2))
      return 0
    }
    log(`共 ${sessions.length} 条会话：`)
    for (const session of sessions.slice(0, 50)) {
      log(`  ${session.id}  ${String(session.title || '(无标题)').slice(0, 40)}  updated=${session.updated_at}`)
    }
    if (sessions.length > 50) log(`  …另有 ${sessions.length - 50} 条`)
    return 0
  }

  if (command === 'dump') {
    const id = argv[1]
    if (!id) { log('用法：ds-migrate dump <sessionId>'); return 1 }
    const { api } = await buildApi()
    const data = await api.fetchSession(id)
    const out = String(flag('out', join(OUT_DIR, `${id}.raw.json`)))
    await mkdir(join(out, '..'), { recursive: true })
    await writeFile(out, JSON.stringify(data, null, 2), 'utf8')
    const shape = {
      sessionKeys: Object.keys((data && data.chat_session) || {}),
      messageCount: ((data && data.chat_messages) || []).length,
      firstMessageKeys: Object.keys(((data && data.chat_messages) || [])[0] || {}),
      fragmentTypes: [...new Set(((data && data.chat_messages) || []).flatMap((m) => (m.fragments || []).map((f) => f.type)))],
    }
    log(`已写入 ${out}`)
    log(JSON.stringify(shape, null, 2))
    return 0
  }

  if (command === 'run') {
    const lock = await acquireRunLock()
    if (!lock.ok) {
      log(`已有迁移在进行（pid ${lock.holder.pid}，开始于 ${new Date(lock.holder.startedAt).toLocaleString()}）。`)
      log('如果确认那个进程已经不在了，删掉 ~/.dsh/dsh-deepseek-import/run.lock 再试。')
      return 1
    }
    process.on('exit', () => { releaseRunLock().catch(() => {}) })
    const dryRun = Boolean(flag('dry-run', false))
    const outDir = resolve(String(flag('out', OUT_DIR)))
    const { api } = await buildApi()
    const state = await loadState()
    const manifest = await migrateAccount({
      api,
      state,
      options: {
        outDir,
        dryRun,
        force: Boolean(flag('force', false)),
        downloadFiles: !flag('no-files', false),
        minTurns: Number(flag('min-turns', 0)) || 0,
        since: flag('since', undefined),
        limit: Number(flag('limit', 0)) || 0,
      },
      onProgress: ({ message }) => log(message),
    })
    await saveState(state)
    log('')
    log(`产物：${manifest.items.length} 个 interchange 文件，${manifest.stats.turns} 轮，${manifest.stats.steps} 步，图片 ${manifest.stats.images}（降级 ${manifest.stats.imagesDegraded}）`)
    log(`跳过 ${manifest.skipped}，失败 ${manifest.failed}`)
    if (manifest.items.length) log(`下一步导入：/import auto "${outDir}"`)
    return 0
  }

  log(`未知命令：${command}（试 ds-migrate help）`)
  return 1
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    if (error && error.code === 'NO_PLAYWRIGHT') {
      process.stderr.write(`${error.message}\n`)
      process.exit(2)
    }
    process.stderr.write(`失败：${error && error.message ? error.message : error}\n`)
    process.exit(1)
  })
