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
