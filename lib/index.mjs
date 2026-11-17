// lib/index.mjs — DSH 插件入口：注册 /ds-migrate 命令与 deepseek_migrate 工具，
// 干活的链路全在 lib/ 里（auth / api / migrate / convert），本文件只做装配。
//
// 导入交给 dsh-chat-import 的 chatImport 服务：产出 interchange v1 目录后
// 直接 importPath({ format: 'local-jsonl', path: outDir })；服务缺席时明确告诉用户
// 手动跑 /import auto <dir>，绝不假装成功。

import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DeepSeekApi } from './api.mjs'
import { loginInteractively, resolveStoredToken, resolveToken } from './auth.mjs'
import { filterSessions, migrateAccount } from './migrate.mjs'
import { OUT_DIR, loadState, saveState } from './state.mjs'
import { registerSkill } from './skill.mjs'
import { renderScan, scanBrowsers } from './browsers.mjs'
import { JOURNAL_PATH, readRunStatus, renderRunStatus, startBackgroundRun, summarizeRunStatus } from './background.mjs'
import { humanize } from './errors.mjs'
import { undoImported } from './undo.mjs'

export const name = 'dsh-deepseek-migrate'
export const inject = ['tools']

const TOOL = 'deepseek_migrate'

function text(value) {
  return { content: [{ type: 'text', text: String(value) }] }
}

export function apply(ctx) {
  const log = (message) => {
    try { ctx.logger ? ctx.logger.info(message) : console.log(message) } catch { console.log(message) }
  }

  async function statusText() {
    const state = await loadState()
    const dir = resolve(OUT_DIR)
    let files = []
    try { files = (await readdir(dir)).filter((f) => f.endsWith('.interchange.json')) } catch { /* 无产物 */ }
    const stored = await resolveStoredToken({ log: () => {} })
    const scan = await scanBrowsers({ checkTokens: false })
    return [
      `登录态：${stored ? stored.source : '无（需要先 login）'}`,
      '数据只在本机处理，不经过任何服务器；导入的会话随时可以用 action:"undo" 撤销。',
      renderScan(scan),
      `已转换会话：${Object.keys(state.sessions).length}`,
      `产物目录：${dir}（${files.length} 个 interchange 文件）`,
    ].join('\n')
  }

  async function doLogin() {
    const result = await loginInteractively({ log })
    return `登录成功（来源 ${result.source}），凭证已保存到 ~/.dsh/dsh-deepseek-import/auth.json`
  }

  async function doPreview(options) {
    const { token } = await resolveToken({ log })
    const api = new DeepSeekApi({ token, log })
    const sessions = await api.listSessions({ onPage: ({ total }) => log(`已取 ${total} 条会话…`) })
    const selected = filterSessions(sessions, options)
    const state = await loadState()
    const done = selected.filter((s) => state.sessions[String(s.id)]).length
    return [
      `账号里共 ${sessions.length} 条会话`,
      `本次将处理 ${selected.length} 条（已迁移过 ${done} 条，force 才会重做）`,
      selected.slice(0, 10).map((s) => `  · ${String(s.title || '(无标题)').slice(0, 40)}`).join('\n'),
      selected.length > 10 ? `  …另有 ${selected.length - 10} 条` : '',
    ].filter(Boolean).join('\n')
  }

  async function doRun(options) {
    const { token } = await resolveToken({ log })
    const api = new DeepSeekApi({ token, log })
    const state = await loadState()
    // 第一次迁移先只跑 1 条：失败成本低，成功后再全量
    const firstRun = !options.all && !options.force && !(Number(options.limit) > 0) && Object.keys(state.sessions).length === 0
    if (firstRun) options = { ...options, limit: 1 }
    const outDir = resolve(options.outDir || OUT_DIR)
    const manifest = await migrateAccount({
      api,
      state,
      options: { ...options, outDir, batchSize: 50 },
      onProgress: ({ message }) => log(message),
      onBatch: async (batch, manifestNow) => {
        try {
          const service = ctx.get('chatImport')
          if (!service) return
          for (const item of batch) {
            await service.importPath({ format: 'local-jsonl', path: item.file })
          }
          await saveState(state)
          log(`已导入本批 ${batch.length} 条（累计 ${manifestNow.items.length}）`)
        } catch (error) {
          log(`本批导入失败（已落盘，可稍后 import）：${error.message}`)
        }
      },
      onCheckpoint: async (stateNow, manifestNow) => {
        await saveState(stateNow)
        try {
          const { appendFile } = await import('node:fs/promises')
          await appendFile(JOURNAL_PATH, `${new Date().toISOString()} 进度 ${manifestNow.items.length} 条已写出\n`)
        } catch { /* 忽略 */ }
      },
    })
    await saveState(state)
    const lines = [
      firstRun && manifest.items.length ? '试迁 1 条完成。确认 dsh 侧栏里那条会话正常后，再调用 run 并传 all:true 迁剩下的。' : '',
      `迁移完成：${manifest.items.length} 条会话 / ${manifest.stats.turns} 轮 / ${manifest.stats.steps} 步`,
      `图片 ${manifest.stats.images}（降级 ${manifest.stats.imagesDegraded}），跳过 ${manifest.skipped}，失败 ${manifest.failed}`,
      `产物目录：${outDir}`,
    ]
    if (!manifest.items.length) return lines.join('\n')

    const service = typeof ctx.get === 'function' ? ctx.get('chatImport') : undefined
    if (!service || typeof service.importPath !== 'function') {
      lines.push('没有找到 chatImport 服务（未安装/未启用 dsh-chat-import）。请手动导入：')
      lines.push(`  /import auto "${outDir}"`)
      return lines.join('\n')
    }
    lines.push('正在用 chatImport 导入…')
    const imported = await service.importPath({ format: 'local-jsonl', path: outDir })
    lines.push(JSON.stringify(imported, null, 2).slice(0, 4000))
    return lines.join('\n')
  }

  async function runAction(args = {}) {
    const action = String(args.action || 'status')
    const options = {
      minTurns: Number(args.minTurns) || 0,
      since: args.since,
      limit: Number(args.limit) || 0,
      force: Boolean(args.force),
      downloadFiles: args.downloadFiles !== false,
      outDir: args.outDir,
      all: Boolean(args.all),
      sessionIds: Array.isArray(args.sessionIds) ? args.sessionIds : undefined,
      maxSessionBytes: Number(args.maxMb) > 0 ? Number(args.maxMb) * 1024 * 1024 : undefined,
    }
    try {
      if (action === 'status') return await statusText()
      if (action === 'login') return await doLogin()
      if (action === 'preview') return await doPreview(options)
      if (action === 'run') {
        // Desktop（Electron）里同步跑大会话会卡住界面，默认转后台
        if (args.background === undefined && process.versions && process.versions.electron) {
          args = { ...args, background: true }
        }
        if (args.background) {
          const info = await startBackgroundRun({ ...options, since: args.since }, { log })
          if (!info) return '启动后台迁移失败，看日志：' + JSON.stringify(info)
          return [
            `已启动后台迁移（pid ${info.pid}）。`,
            `日志：${info.journal}`,
            '',
            '给 agent 的提示：立刻用 dsh-ui 渲染一个 progress 进度条（value=0），',
            '之后每隔 30–60 秒调用 deepseek_migrate({ action: "progress", json: true })，',
            '用返回的 percent/done/total/etaMs 更新同一个进度条，不要连续轮询刷屏。',
            '跑完（finished:true）再报告条数；中途用户问进度就直接查一次。',
          ].join('\n')
        }
        return await doRun(options)
      }
      if (action === 'undo') {
        const preview = await undoImported({ dryRun: true })
        if (!preview.entries) return '没有找到本工具的导入登记。'
        if (!args.confirm) {
          return [
            `本工具导入的会话：${preview.entries} 条登记，可删除 ${preview.removedSessions} 个。`,
            '这是预览，没有删除任何东西。确认请再调用一次并传 confirm:true。',
            'DeepSeek 上的原始对话不受影响。',
          ].join('\n')
        }
        const done = await undoImported({})
        return `已删除 ${done.removedSessions} 个会话副本，清理 ${done.entries} 条登记。DeepSeek 原始数据未改动。`
      }
      if (action === 'skipped') {
        const state = await loadState()
        const list = Object.entries(state.sessions)
          .filter(([, info]) => info && info.skipped === 'too-large')
          .map(([id, info]) => ({ id, title: info.title || '', mb: Math.round(((Number(info.bytes) || 0) / 1048576) * 10) / 10 }))
        if (!list.length) return '没有被体积保护跳过的会话。'
        return [
          `有 ${list.length} 条会话因体积过大被跳过：`,
          ...list.map((item) => `  ${item.id}  ${item.mb}MB  ${item.title.slice(0, 30)}`),
          '',
          '单独导入某一条：deepseek_migrate({ action: "run", sessionIds: ["<id>"], maxMb: 600, force: true, downloadFiles: false })',
        ].join('\n')
      }
      if (action === 'progress') {
        const status = await readRunStatus()
        if (args.json) return JSON.stringify(summarizeRunStatus(status), null, 2)
        return renderRunStatus(status)
      }
      if (action === 'import') {
        const service = typeof ctx.get === 'function' ? ctx.get('chatImport') : undefined
        if (!service || typeof service.importPath !== 'function') {
          return `没有 chatImport 服务。请手动导入：\n  /import auto "${resolve(options.outDir || OUT_DIR)}"`
        }
        const result = await service.importPath({ format: 'local-jsonl', path: resolve(options.outDir || OUT_DIR) })
        return JSON.stringify(result, null, 2).slice(0, 4000)
      }
      return `未知 action：${action}（可用 status / login / preview / run / import）`
    } catch (error) {
      if (error && error.code === 'NO_PLAYWRIGHT') return error.message
      return `失败：${error && error.message ? error.message : String(error)}`
    }
  }

  const definition = buildToolDefinition(runAction)

  if (ctx.tools && typeof ctx.tools.register === 'function') {
    ctx.tools.register(definition)
  }

  // 装上插件即获得 deepseek-to-dsh 技能（自然语言触发，不用手工拷 SKILL.md）
  registerSkill(ctx)

  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.commands.register({
      name: 'ds-migrate',
      description: '把 DeepSeek 账号里的对话整批迁进 DSH（拉取 → 转 interchange v1 → 导入）。用法：/ds-migrate [status|login|preview|run|import] [--limit N] [--min-turns N] [--since YYYY-MM-DD] [--force] [--no-files]',
      input: { hint: '[status|login|preview|run|import] [flags]' },
      async handler(invocation) {
        const raw = String(invocation.rawInput || '').trim()
        const parts = raw.split(/\s+/).filter(Boolean)
        const args = { action: parts[0] && !parts[0].startsWith('--') ? parts[0] : 'status' }
        for (let i = 0; i < parts.length; i += 1) {
          const part = parts[i]
          if (part === '--force') args.force = true
          else if (part === '--background' || part === '--bg') args.background = true
          else if (part === '--no-files') args.downloadFiles = false
          else if (part === '--limit') args.limit = Number(parts[++i])
          else if (part === '--min-turns') args.minTurns = Number(parts[++i])
          else if (part === '--since') args.since = parts[++i]
          else if (part === '--out') args.outDir = parts[++i]
        }
        const result = await runAction(args)
        return { kind: /失败/.test(result) ? 'error' : 'success', text: result }
      },
    })
  })
}

/** 构造 deepseek_migrate 的工具定义（纯函数，便于测试宿主契约）。 */
export function buildToolDefinition(runAction) {
    return {
    name: TOOL,
    description:
      'Migrate a whole DeepSeek web/app account into DSH sessions. Pulls the account session list and message trees ' +
      '(thinking and images included), converts each conversation to dsh-chat-import interchange v1 files, then imports ' +
      'them through the chatImport service. Actions: status (default, read-only), login (open a browser once to store ' +
      'credentials), preview (list how many sessions would be migrated, no writes), run (fetch + convert + import), ' +
      'import (import an existing output directory only).',
    parameters: {
      action: { type: 'string', enum: ['status', 'login', 'preview', 'run', 'progress', 'skipped', 'import', 'undo'], description: 'What to do. Default status. Use run+background for long migrations.' },
      background: { type: 'boolean', description: 'For action=run: start a detached process and return immediately; check with action=progress.' },
      json: { type: 'boolean', description: 'For action=progress: return structured JSON (running/done/total/percent/etaMs/lastLine) instead of text.' },
      all: { type: 'boolean', description: 'For action=run: migrate everything (skip the 1-session first-run probe).' },
      sessionIds: { type: 'array', items: { type: 'string' }, description: 'For action=run: import only these session ids (overrides since/limit). Use to import one oversized conversation.' },
      maxMb: { type: 'integer', description: 'For action=run: raise the per-session size guard (MB). Default 32.' },
      confirm: { type: 'boolean', description: 'For action=undo: actually delete instead of just previewing.' },
      minTurns: { type: 'integer', description: 'Skip sessions with fewer than N turns after fetching (default 0 = keep all).' },
      since: { type: 'string', description: "Only sessions updated at/after this date (YYYY-MM-DD or ISO), or 'last' to continue from the previous run's cursor." },
      limit: { type: 'integer', description: 'Process at most N sessions this run (batch control).' },
      force: { type: 'boolean', description: 'Re-fetch sessions already recorded as migrated.' },
      downloadFiles: { type: 'boolean', description: 'Download images/attachments and embed them as base64 (default true).' },
      outDir: { type: 'string', description: 'Directory for the generated interchange files.' },
    },
    output: {
      // 注意：不能写 required —— 字段级 required 被原始校验拒绝，
      // 对象级 required 数组被 ValueSchema DSL 拒绝，两者都过才安全。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          summary: { type: 'string' },
          nextCommand: { type: 'string' },
        },
      },
      render: (args, value) => [{ type: 'text', text: String((value && value.summary) || '') }],
    },
    async execute(args) {
      const input = args || {}
      const action = String(input.action || 'status')
      const summary = await runAction(input)
      const value = { ok: !/^(失败|✘)/.test(summary), action, summary }
      // 后台跑起来后，直接把「下一步必须做什么」交给 agent，避免它忘了刷进度
      if (action === 'run' && /已启动后台迁移/.test(summary)) {
        value.nextCommand = 'deepseek_migrate({ action: "progress", json: true })'
      }
      return value
    },
  }
}
