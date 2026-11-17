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
import { loginInteractively, resolveStoredToken, resolveToken } from '../lib/auth.mjs'
import { migrateAccount } from '../lib/migrate.mjs'
import { OUT_DIR, STATE_PATH, loadState, saveState } from '../lib/state.mjs'

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

async function buildApi() {
  const resolved = await resolveToken({ log })
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
    await loginInteractively({ log })
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
    const stored = await resolveStoredToken({ log: () => {} })
    log(`登录态：${stored ? stored.source : '无（需要 login）'}`)
    log(`状态文件：${STATE_PATH}（已记录 ${Object.keys(state.sessions).length} 条会话）`)
    log(`产物目录：${dir}（${files.length} 个 interchange 文件）`)
    if (files.length) {
      const info = await stat(join(dir, files[0]))
      log(`首个产物：${files[0]}（${Math.round(info.size / 1024)}KB）`)
      log(`下一步：/import auto "${dir}"`)
    }
    return 0
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
