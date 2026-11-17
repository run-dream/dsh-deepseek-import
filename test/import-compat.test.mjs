// 用真正的 dsh-chat-import 转换器验证我们产出的 interchange v1 能被解析。
import assert from 'node:assert/strict'
import { deepseekToInterchange } from '../lib/convert.mjs'
import { session, messages } from './fixture.mjs'

const IMPORTER = `${process.env.HOME}/.dsh/profiles/web/node_modules/dsh-chat-import/lib/convert/index.mjs`
let convertLocalJsonl
try {
  ;({ convertLocalJsonl } = await import(IMPORTER))
} catch {
  console.log('import-compat.test SKIP（本机没有装 dsh-chat-import，装好后可跑）')
  process.exit(0)
}

const assets = { 'f-img': { data: 'iVBORw0KGgo=', mediaType: 'image/png' } }
const { document } = deepseekToInterchange({ session, messages, assets })
const raw = JSON.stringify(document)

const parsed = convertLocalJsonl(raw, {})
const keys = Object.keys(parsed)
console.log('parsed keys:', keys.join(','))
assert.ok(!parsed.skipReason, '不应被判为跳过：' + (parsed.skipReason || ''))
assert.equal(parsed.detectedFormat, 'generic', '应识别为 generic（文件标记）')
const turns = parsed.turns || parsed.messages || []
assert.ok(Array.isArray(turns) && turns.length === 2, '轮数应一致，实际 ' + turns.length)
const flat = JSON.stringify(parsed)
assert.ok(flat.includes('旧格式思维'), '思维链必须保留')
assert.ok(flat.includes('新格式回答'), '正文必须保留')
assert.ok(!flat.includes('另一个分支'), '分支外的消息不能进来')
console.log('import-compat.test OK')

// 验收线：降级计数必须全 0
const counters = {
  malformedTurns: parsed.malformedTurns || 0,
  malformedSteps: parsed.malformedSteps || 0,
  skippedBlocks: parsed.skippedBlocks || 0,
  imagesDegraded: parsed.imagesDegraded || 0,
  droppedToolResults: parsed.droppedToolResults || 0,
}
assert.deepEqual(counters, { malformedTurns: 0, malformedSteps: 0, skippedBlocks: 0, imagesDegraded: 0, droppedToolResults: 0 },
  '降级计数必须全 0，实际 ' + JSON.stringify(counters))
console.log('降级计数全 0 ✓', JSON.stringify(counters))
