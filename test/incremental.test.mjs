// 增量迁移：游标解析与过滤
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INCREMENTAL_OVERLAP_MS, migrateAccount, resolveSince } from '../lib/migrate.mjs'

// 没有记录 → null（等价全量）
assert.equal(resolveSince('last', {}), null)
assert.equal(resolveSince('last-run', { lastRun: {} }), null)
assert.equal(resolveSince(undefined, {}), null)

// 有记录 → 上次游标（秒）*1000 再减重叠窗口
const last = { lastRun: { maxUpdatedAt: 1794824230.776 } }
assert.equal(resolveSince('last', last), Math.round(1794824230.776 * 1000 - INCREMENTAL_OVERLAP_MS))

// 固定时间
assert.equal(new Date(resolveSince('2026-01-01T00:00:00Z', {})).toISOString(), '2026-01-01T00:00:00.000Z')

// 端到端：since=last 只挑出更新的会话
const outDir = await mkdtemp(join(tmpdir(), 'dsm-inc-'))
const sessions = [
  { id: 'old', title: 'old', updated_at: 1700000000 },
  { id: 'new', title: 'new', updated_at: 1794900000 },
]
const conv = (id) => ({
  chat_session: { id, title: id, inserted_at: 1794900000, current_message_id: 2 },
  chat_messages: [
    { message_id: 1, parent_id: null, role: 'USER', inserted_at: 1794900000, content: 'q' },
    { message_id: 2, parent_id: 1, role: 'ASSISTANT', inserted_at: 1794900010, content: 'a' },
  ],
})
const api = {
  async listSessions() { return sessions },
  async fetchSession(id) { return conv(id) },
  async fetchFile() { return null },
}
const state = { version: 1, sessions: {}, imported: {}, lastRun: { maxUpdatedAt: 1794800000 } }
const run = await migrateAccount({ api, state, options: { outDir, since: 'last' }, onProgress: () => {} })
assert.equal(run.items.length, 1, '只应处理上次游标之后的会话')
assert.equal(run.items[0].id, 'new')

// 跑完写入新游标（取本次处理的最大 updated_at）
assert.ok(state.lastRun.maxUpdatedAt >= 1794900000, '应记录到本次最大 updated_at')
assert.equal(state.lastRun.incremental, true)

// 全量时 incremental=false
const state2 = { version: 1, sessions: {}, imported: {} }
await migrateAccount({ api, state: state2, options: { outDir }, onProgress: () => {} })
assert.equal(state2.lastRun.incremental, false)
console.log('incremental.test OK')
