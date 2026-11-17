// lib/state.mjs — 断点续跑状态：每条会话「拉到什么程度」，以及导入过的 source → session 映射。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const HOME_DIR = join(homedir(), '.dsh', 'dsh-deepseek-import')
export const STATE_PATH = join(HOME_DIR, 'state.json')
export const AUTH_PATH = join(HOME_DIR, 'auth.json')
export const OUT_DIR = join(HOME_DIR, 'out')

const EMPTY = { version: 1, sessions: {}, imported: {}, updatedAt: 0 }

export async function loadState(path = STATE_PATH) {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    return { ...EMPTY, ...parsed, sessions: parsed.sessions || {}, imported: parsed.imported || {} }
  } catch (error) {
    if (error.code === 'ENOENT') return { ...EMPTY }
    throw error
  }
}

export async function saveState(state, path = STATE_PATH) {
  await mkdir(dirname(path), { recursive: true })
  state.updatedAt = Date.now()
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await rename(tmp, path)
}

export function markFetched(state, session, extra = {}) {
  state.sessions[String(session.id)] = {
    title: session.title || '',
    updatedAt: Number(session.updated_at) || 0,
    fetchedAt: Date.now(),
    ...extra,
  }
}

export function isFetched(state, sessionId) {
  return Boolean(state.sessions[String(sessionId)])
}

export function recordImported(state, sourceId, result) {
  state.imported[String(sourceId)] = {
    sessionId: result && result.sessionId ? result.sessionId : null,
    importedAt: Date.now(),
    outcome: result && result.status ? result.status : 'unknown',
  }
}
