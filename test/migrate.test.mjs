import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateAccount } from '../lib/migrate.mjs'

const outDir = await mkdtemp(join(tmpdir(), 'dsm-'))
const sessions = [
  { id: 'a', title: '长会话', updated_at: 1710003600 },
  { id: 'b', title: '短会话', updated_at: 1710003600 },
]

const conversation = (turns) => ({
  chat_session: { id: turns.id, title: turns.title, inserted_at: 1710000000, current_message_id: turns.count * 2 },
  chat_messages: Array.from({ length: turns.count * 2 }, (_, i) => ({
    message_id: i + 1,
    parent_id: i === 0 ? null : i,
    role: i % 2 === 0 ? 'USER' : 'ASSISTANT',
    inserted_at: 1710000000 + i * 10,
    fragments: [{ type: i % 2 === 0 ? 'REQUEST' : 'RESPONSE', content: `m${i + 1}` }],
    ...(i === 0 ? { files: [{ id: 'img1', file_name: 'a.png', content_type: 'image/png' }] } : {}),
  })),
})

const api = {
  requests: 0,
  async listSessions({ onPage }) {
    onPage?.({ page: 1, total: sessions.length })
    return sessions
  },
  async fetchSession(id) {
    this.requests += 1
    const s = sessions.find((x) => x.id === id)
    return conversation({ id, title: s.title, count: id === 'a' ? 3 : 1 })
  },
  async fetchFile() {
    return { buffer: Buffer.from('PNGDATA'), contentType: 'image/png' }
  },
}

const state = { version: 1, sessions: {}, imported: {} }
const first = await migrateAccount({
  api, state, options: { outDir, minTurns: 0, downloadFiles: true },
  onProgress: () => {},
})
assert.equal(first.items.length, 2, '两条都应转换')
assert.equal(first.stats.turns, 4, '3 + 1 轮')
assert.equal(first.failed, 0)

const files = (await readdir(outDir)).filter((f) => f.endsWith('.interchange.json'))
assert.equal(files.length, 2)

const doc = JSON.parse(await readFile(join(outDir, 'a.interchange.json'), 'utf8'))
assert.equal(doc.interchange, 'dsh-chat-import')
assert.equal(doc.version, 1)
assert.ok(JSON.stringify(doc).indexOf('"interchange"') < 64 * 1024, '标记必须在文件前 64KB')
assert.equal(doc.turns.length, 3)
assert.ok(doc.turns[0].promptBlocks.some((b) => b.type === 'image' && b.data), '图片应以 base64 保留')

const second = await migrateAccount({ api, state, options: { outDir }, onProgress: () => {} })
assert.equal(second.items.length, 0, '重跑不应重复转换')
assert.equal(second.skipped, 2, '重跑应全部跳过')
assert.equal(api.requests, 2, '重跑不应再拉消息')

const forced = await migrateAccount({ api, state, options: { outDir, force: true }, onProgress: () => {} })
assert.equal(forced.items.length, 2, 'force 应重拉')

const filtered = await migrateAccount({
  api, state: { version: 1, sessions: {}, imported: {} },
  options: { outDir, minTurns: 2, force: true }, onProgress: () => {},
})
assert.equal(filtered.items.length, 1, 'min-turns 2 应只剩长会话')

const limited = await migrateAccount({
  api, state: { version: 1, sessions: {}, imported: {} },
  options: { outDir, limit: 1, force: true }, onProgress: () => {},
})
assert.equal(limited.items.length, 1, 'limit 1 应只处理一条')

console.log('migrate.test OK', JSON.stringify({ turns: first.stats.turns, files: files.length }))
