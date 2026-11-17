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
import { buildRunArgs, readRunStatus, renderRunStatus, startBackgroundRun, summarizeRunStatus } from '../lib/background.mjs'
import { renderError } from '../lib/errors.mjs'
import { undoImported } from '../lib/undo.mjs'
import { notify } from '../lib/notify.mjs'
import { readTokenFromFile, readTokenViaCdp } from '../lib/cdp.mjs'
import { filterSessions, migrateAccount, resolveSince } from '../lib/migrate.mjs'
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

/** 收集所有同名 flag 的值（--only 可以重复）。 */
function flagAll(name) {
  const out = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== `--${name}`) continue
    const value = argv[i + 1]
    if (value && !value.startsWith('--')) out.push(value)
  }
  return out
}

const onlyIds = flagAll('only')
const maxMb = Number(flag('max-mb', 0)) || 0

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

const HEAP_MB = 6144

/** 大会话解析需要更大堆；用子进程自举一次，避免默认堆上限直接 OOM。 */
async function ensureHeap() {
  if (process.env.DSH_HEAP_BUMPED === '1') return
  if (process.execArgv.some((arg) => arg.startsWith('--max-old-space-size'))) return
  const { spawnSync } = await import('node:child_process')
  const args = [`--max-old-space-size=${HEAP_MB}`, ...process.execArgv, ...process.argv.slice(1)]
  const isElectron = Boolean(process.versions && process.versions.electron)
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    // Electron 下必须声明「当 Node 跑」，否则会再弹一个 Electron 实例
    env: { ...process.env, DSH_HEAP_BUMPED: '1', ...(isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
  })
  process.exit(result.status === null ? 1 : result.status)
}

async function main() {
  await ensureHeap()
  if (command === 'help' || command === '--help') {
    log(`用法：
  ds-migrate login                         弹窗登录 DeepSeek 并保存凭证
  ds-migrate whoami                        查看登录态来源
  ds-migrate list [--json]                 列出会话
  ds-migrate dump <sessionId> [--out f]    保存一条会话的原始 JSON
  ds-migrate run [--dry-run] [--limit N] [--min-turns N] [--since YYYY-MM-DD] [--force] [--no-files] [--out dir]
  ds-migrate run --only <id> [--max-mb N]  单独导入指定会话（可放宽体积上限）
  ds-migrate list-skipped                  列出被体积保护跳过的会话
  ds-migrate undo [--dry-run] [--yes]      撤销：删掉本工具导入的会话副本
  ds-migrate progress                      查看后台迁移进度
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

  if (command === 'undo') {
    const preview = await undoImported({ dryRun: true })
    if (!preview.entries) {
      log('没有找到本工具的导入登记（可能还没导入过）。')
      return 0
    }
    log(`本工具导入的会话：${preview.entries} 条登记，可删除 ${preview.removedSessions} 个，缺失 ${preview.missingSessions} 个`)
    if (flag('dry-run', false)) {
      log('（dry-run：没有删除任何东西）')
      return 0
    }
    if (!argv.includes('--yes')) {
      log('确认后会从 DSH 的会话库里删掉这些副本（DeepSeek 上的原始对话不受影响）。')
      log('确认请重跑：ds-migrate undo --yes')
      return 1
    }
    const done = await undoImported({})
    log(`已删除 ${done.removedSessions} 个会话，已清理 ${done.entries} 条导入登记。`)
    log('DeepSeek 上的原始对话没有任何改动。')
    return 0
  }

  if (command === 'list-skipped') {
    const state = await loadState()
    const skipped = Object.entries(state.sessions)
      .filter(([, info]) => info && info.skipped === 'too-large')
      .map(([id, info]) => ({ id, title: info.title || '', bytes: Number(info.bytes) || 0 }))
    if (!skipped.length) {
      log('没有被跳过的超大会话。')
      return 0
    }
    log(`有 ${skipped.length} 条会话因体积过大被跳过：`)
    for (const item of skipped) {
      log(`  ${item.id}  ${(item.bytes / 1048576).toFixed(1)}MB  ${item.title.slice(0, 30)}`)
    }
    log('')
    log('单独导入其中一条（会重新拉取，可放宽上限）：')
    log(`  ds-migrate run --only ${skipped[0].id} --max-mb 600 --force --no-files`)
    log('--no-files 只迁文本（大图片往往是体积主因）；确认没问题再去掉它重跑。')
    return 0
  }

  if (command === 'progress') {
    const status = await readRunStatus()
    if (flag('json', false)) {
      log(JSON.stringify(summarizeRunStatus(status), null, 2))
      return 0
    }
    log(renderRunStatus(status))
    if (!status.info) log('（用 ds-migrate run 或在 dsh 里调用 deepseek_migrate 启动一次迁移）')
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

    if (Boolean(flag('background', false)) || argv.includes('--bg')) {
      const info = await startBackgroundRun({
        since: flag('since', undefined),
        limit: Number(flag('limit', 0)) || 0,
        minTurns: Number(flag('min-turns', 0)) || 0,
        force: Boolean(flag('force', false)),
        downloadFiles: !flag('no-files', false),
        outDir,
        sessionIds: onlyIds,
        maxSessionBytes: maxMb ? maxMb * 1024 * 1024 : undefined,
      }, { log })
      if (!info) return 1
      log(`已启动后台迁移（pid ${info.pid}），日志：${info.journal}`)
      log('查看进度：ds-migrate progress')
      return 0
    }

    const force = Boolean(flag('force', false))
    const explicitLimit = Number(flag('limit', 0)) || 0
    const firstRun = !argv.includes('--all') && !force && explicitLimit === 0 && Object.keys(state.sessions).length === 0
    if (firstRun && !dryRun && !(Boolean(flag('background', false)) || argv.includes('--bg'))) {
      log('这是第一次迁移，先试迁 1 条：')
      log('  1) 只读你自己的账号，不修改 DeepSeek 上的任何数据')
      log('  2) 数据只在本机处理，不经过任何服务器')
      log('  3) 导入后随时可以 ds-migrate undo 全部撤销')
      log('')
    }

    if (dryRun) {
      const sessions = await api.listSessions({ onPage: ({ total }) => log(`  已取 ${total} 条…`) })
      if (onlyIds.length) {
        const picked = sessions.filter((item) => onlyIds.includes(String(item.id)))
        log(`dry-run：按 id 指定 ${onlyIds.length} 条，命中 ${picked.length} 条`)
        for (const item of picked) log(`  · ${String(item.title || '(无标题)').slice(0, 40)}  ${item.id}`)
        return 0
      }
      const selected = filterSessions(sessions, {
        since: flag('since', undefined) === 'last'
          ? new Date(resolveSince('last', state))
          : flag('since', undefined),
        limit: firstRun ? 1 : explicitLimit,
      })
      log(`dry-run：账号共 ${sessions.length} 条，本次会处理 ${selected.length} 条（不含拉取，不会写任何文件）`)
      for (const item of selected.slice(0, 10)) log(`  · ${String(item.title || '(无标题)').slice(0, 40)}`)
      if (selected.length > 10) log(`  …另有 ${selected.length - 10} 条`)
      return 0
    }

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
        limit: firstRun ? 1 : explicitLimit,
        sessionIds: onlyIds,
        maxSessionBytes: maxMb ? maxMb * 1024 * 1024 : undefined,
      },
      onProgress: ({ message }) => log(message),
    })
    await saveState(state)
    log('')
    log(`产物：${manifest.items.length} 个 interchange 文件，${manifest.stats.turns} 轮，${manifest.stats.steps} 步，图片 ${manifest.stats.images}（降级 ${manifest.stats.imagesDegraded}）`)
    log(`跳过 ${manifest.skipped}，失败 ${manifest.failed}`)
    for (const item of (manifest.tooLarge || []).slice(0, 5)) log(`  超大跳过：${item.title || item.id}（${item.error}）`)
    if (manifest.items.length) log(`下一步导入：/import auto "${outDir}"`)
    if (firstRun && manifest.items.length) {
      log('')
      log('试迁成功 ✓ 确认这些会话在 dsh 侧栏里看起来正常后，跑这条把剩下的全迁：')
      log('  ds-migrate run --all --background')
      log('（--background 会放到独立进程，关掉页面也继续）')
    }
    if (process.env.DSH_RUN_NOTIFY === '1') {
      await notify({ title: 'DSH 迁移完成', message: `${manifest.items.length} 条会话 / ${manifest.stats.turns} 轮` })
    }
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
    process.stderr.write(renderError(error) + '\n')
    process.exit(1)
  })
