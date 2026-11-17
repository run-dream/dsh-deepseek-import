// 韧性：登录失效中止、失败重试、未知片段的计数
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthError } from '../lib/api.mjs'
import { deepseekToInterchange } from '../lib/convert.mjs'
import { migrateAccount } from '../lib/migrate.mjs'

const outDir = await mkdtemp(join(tmpdir(), 'dsm-res-'))
const sessions = [
  { id: 'a', title: 'A', updated_at: 1710003600 },
  { id: 'b', title: 'B', updated_at: 1710003600 },
]
const conv = (id) => ({
  chat_session: { id, title: id, inserted_at: 1710000000, current_message_id: 2 },
  chat_messages: [
    { message_id: 1, parent_id: null, role: 'USER', inserted_at: 1710000000, content: 'q' },
    { message_id: 2, parent_id: 1, role: 'ASSISTANT', inserted_at: 1710000010, content: 'a' },
  ],
})

// 1) 登录态失效 → 立刻中止，不把剩下的都记成失败
let fetched = 0
const authApi = {
  async listSessions() { return sessions },
  async fetchSession() { fetched += 1; throw new AuthError('登录态失效（HTTP 401）') },
  async fetchFile() { return null },
}
const authRun = await migrateAccount({ api: authApi, state: { version: 1, sessions: {}, imported: {} }, options: { outDir, retries: 2 }, onProgress: () => {} })
assert.equal(authRun.authExpired, true, '应标记登录态失效')
assert.equal(authRun.failed, 0, '登录失效不应计入失败条数')
assert.equal(fetched, 1, '只应尝试第一条就中止')

// 2) 首次失败、重试成功
let calls = 0
const flakyApi = {
  async listSessions() { return sessions.slice(0, 1) },
  async fetchSession(id) { calls += 1; if (calls === 1) throw new Error('网络抖动'); return conv(id) },
  async fetchFile() { return null },
}
const flakyRun = await migrateAccount({ api: flakyApi, state: { version: 1, sessions: {}, imported: {} }, options: { outDir, retries: 2 }, onProgress: () => {} })
assert.equal(flakyRun.items.length, 1, '重试后应成功')
assert.equal(flakyRun.failed, 0)
assert.equal(calls, 2, '应恰好重试一次')

// 3) 重试仍失败 → 记录到 failures
const badApi = {
  async listSessions() { return sessions.slice(0, 1) },
  async fetchSession() { throw new Error('持续失败') },
  async fetchFile() { return null },
}
const badRun = await migrateAccount({ api: badApi, state: { version: 1, sessions: {}, imported: {} }, options: { outDir, retries: 2 }, onProgress: () => {} })
assert.equal(badRun.failed, 1)
assert.equal(badRun.failures.length, 1)
assert.match(badRun.failures[0].error, /持续失败/)

// 4) 未知 fragment 类型要计数并留名字
const unknown = deepseekToInterchange({
  session: { id: 'x', title: 'x', current_message_id: 1 },
  messages: [{
    message_id: 1, parent_id: null, role: 'USER', inserted_at: 1710000000,
    fragments: [{ type: 'REQUEST', content: 'q' }, { type: 'BRAND_NEW_THING', content: '?' }],
  }],
})
assert.equal(unknown.stats.skippedBlocks, 1)
assert.deepEqual(unknown.stats.unknownFragmentTypes, ['BRAND_NEW_THING'])
console.log('resilience.test OK')

// 5) 超大会话：按响应字节判定、记录字节、不记为失败
{
  const { filterByIds } = await import('../lib/migrate.mjs')
  assert.deepEqual(filterByIds([{ id: 'a' }, { id: 'b' }], ['b']).map((x) => x.id), ['b'])
  assert.equal(filterByIds([{ id: 'a' }], []), null, '空数组表示不限')

  const bigApi = {
    async listSessions() { return [{ id: 'big', title: '巨型会话', updated_at: 1710003600 }] },
    async fetchSessionMeta() { return { data: { chat_messages: [] }, bytes: 90 * 1024 * 1024 } },
    async fetchFile() { return null },
  }
  const bigState = { version: 1, sessions: {}, imported: {} }
  const bigRun = await migrateAccount({ api: bigApi, state: bigState, options: { outDir, maxSessionBytes: 32 * 1024 * 1024 }, onProgress: () => {} })
  assert.equal(bigRun.items.length, 0)
  assert.equal(bigRun.failed, 0, '超大不算失败')
  assert.equal(bigRun.skipped, 1)
  assert.equal(bigRun.tooLarge.length, 1)
  assert.ok(bigRun.tooLarge[0].bytes > 32 * 1024 * 1024, '应记录实际体积')
  assert.equal(bigState.sessions.big.skipped, 'too-large', '状态里要能查到，供 list-skipped 使用')

  // 放宽上限后可以单独导入
  const okRun = await migrateAccount({
    api: { ...bigApi, async fetchSessionMeta() { return { data: conv('big'), bytes: 90 * 1024 * 1024 } } },
    state: { version: 1, sessions: {}, imported: {} },
    options: { outDir, sessionIds: ['big'], maxSessionBytes: 600 * 1024 * 1024 },
    onProgress: () => {},
  })
  assert.equal(okRun.items.length, 1, '放宽上限 + 指定 id 应成功导入')
  console.log('resilience.oversize OK')
}
