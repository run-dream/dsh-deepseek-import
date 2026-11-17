// lib/undo.mjs — 一键撤销：删掉本工具导入的 DSH 会话，并清理导入登记。
//
// 只处理「来源路径在 dsh-deepseek-import/out 之下」的登记，绝不碰用户自己的会话。
// 原始 DeepSeek 数据完全不在此列——撤销只影响本机 DSH 里新增的那些会话副本。

import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const REGISTRY_PATH = join(homedir(), '.dsh', 'dsh-chat-import', 'imports.json')
export const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

/** 从 registry 里挑出属于本工具的导入登记。 */
export async function listImported({ registryPath = REGISTRY_PATH, outDir } = {}) {
  let registry
  try {
    registry = JSON.parse(await readFile(registryPath, 'utf8'))
  } catch {
    return { registry: null, entries: [] }
  }
  const imports = (registry && registry.imports) || {}
  const root = outDir ? resolve(outDir) : null
  const entries = []
  for (const [sourcePath, record] of Object.entries(imports)) {
    if (!record || typeof record !== 'object') continue
    const abs = resolve(sourcePath)
    const belongs = root ? abs.startsWith(root + '/') || abs.startsWith(root + '\\') : /dsh-deepseek-import[\\/]out/.test(abs)
    if (!belongs) continue
    entries.push({ sourcePath: abs, sessionId: record.dshId || record.sessionId || record.session || '', record })
  }
  return { registry, entries }
}

/** 在 sessions 根下找某个会话目录（工作区分组不同，所以递归一层）。 */
export async function findSessionDirs(sessionId, { sessionsRoot = SESSIONS_ROOT } = {}) {
  if (!sessionId) return []
  const found = []
  let workspaces = []
  try { workspaces = await readdir(sessionsRoot, { withFileTypes: true }) } catch { return found }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const candidate = join(sessionsRoot, workspace.name, sessionId)
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) found.push(candidate)
    } catch { /* 不在这个工作区 */ }
  }
  return found
}

/**
 * 撤销。dryRun=true 只报告不动手。
 * 返回 { entries, removedSessions, missingSessions, registryUpdated }
 */
export async function undoImported({ registryPath = REGISTRY_PATH, outDir, sessionsRoot = SESSIONS_ROOT, dryRun = false } = {}) {
  const { registry, entries } = await listImported({ registryPath, outDir })
  const result = { entries: entries.length, removedSessions: 0, missingSessions: 0, registryUpdated: false, details: [] }

  for (const entry of entries) {
    const dirs = await findSessionDirs(entry.sessionId, { sessionsRoot })
    if (!dirs.length) {
      result.missingSessions += 1
      result.details.push({ sessionId: entry.sessionId, status: 'missing' })
      continue
    }
    for (const dir of dirs) {
      if (!dryRun) {
        const backup = `${dir}.undo-${Date.now()}`
        // 先改名再删：即使删到一半失败，也还能人工找回
        await rename(dir, backup).catch(() => {})
        await rm(backup, { recursive: true, force: true }).catch(() => {})
      }
      result.removedSessions += 1
      result.details.push({ sessionId: entry.sessionId, status: dryRun ? 'would-remove' : 'removed', dir })
    }
  }

  if (!dryRun && registry) {
    for (const entry of entries) delete registry.imports[entry.sourcePath]
    registry.version = registry.version || 1
    const tmp = `${registryPath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(registry, null, 2), 'utf8')
    await rename(tmp, registryPath)
    result.registryUpdated = true
  }
  return result
}
