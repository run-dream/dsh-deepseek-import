// 后台任务：参数拼装与状态渲染
import assert from 'node:assert/strict'
import { buildRunArgs, readRunStatus, renderRunStatus } from '../lib/background.mjs'

assert.deepEqual(buildRunArgs({}), ['run'])
assert.deepEqual(buildRunArgs({ since: 'last' }), ['run', '--since', 'last'])
assert.deepEqual(buildRunArgs({ limit: 100, minTurns: 2 }), ['run', '--limit', '100', '--min-turns', '2'])
assert.deepEqual(buildRunArgs({ force: true, downloadFiles: false }), ['run', '--force', '--no-files'])
assert.deepEqual(buildRunArgs({ outDir: '/tmp/x', limit: 0 }), ['run', '--out', '/tmp/x'], 'limit=0 不传')

// 没有 run.json 时状态应为「无记录」
const status = await readRunStatus()
assert.equal(typeof status.running, 'boolean')
const text = renderRunStatus({ running: false, info: null, lines: [], lastLine: '' })
assert.match(text, /还没有后台迁移记录/)

// 有记录时的渲染
const rendered = renderRunStatus({
  running: true,
  info: { pid: 1234, startedAt: Date.now() },
  lines: ['拉取 3/10 x', '4/10 y → 2 轮'],
  lastLine: '4/10 y → 2 轮',
})
assert.match(rendered, /进行中（pid 1234/)
assert.match(rendered, /4\/10 y → 2 轮/)
console.log('background.test OK')

// 结构化进度解析
import { summarizeRunStatus } from '../lib/background.mjs'

const live = summarizeRunStatus({
  running: true,
  info: { pid: 9, startedAt: 1000 },
  lines: ['拉取 3/40 a', '3/40 a → 8 轮', '拉取 5/40 b'],
  lastLine: '拉取 5/40 b',
})
assert.equal(live.done, 5, '取日志里最大的 done')
assert.equal(live.total, 40)
assert.equal(live.percent, 13)
assert.equal(live.running, true)
assert.equal(live.finished, false)

const done = summarizeRunStatus({
  running: false,
  info: { pid: 9, startedAt: 1000 },
  lines: ['40/40 b → 2 轮', '完成：2 条会话 / 3 轮 / 跳过 0 / 失败 0'],
  lastLine: '完成：2 条会话',
})
assert.equal(done.finished, true)
assert.equal(done.percent, 100)

const aborted = summarizeRunStatus({
  running: false,
  info: { pid: 9, startedAt: 1000 },
  lines: ['3/40 a', '已中止（登录态失效）'],
  lastLine: '已中止（登录态失效）',
})
assert.equal(aborted.aborted, true)

assert.equal(summarizeRunStatus({ running: false, info: null, lines: [], lastLine: '' }).percent, 0)
console.log('background.summary OK')
