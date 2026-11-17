import assert from 'node:assert/strict'
import { deepseekToInterchange } from '../lib/convert.mjs'
import { session, messages } from './fixture.mjs'

const assets = { 'f-img': { data: 'iVBORw0KGgo=', mediaType: 'image/png' } }
const { document, stats } = deepseekToInterchange({ session, messages, assets })

assert.equal(document.interchange, 'dsh-chat-import')
assert.equal(document.version, 1)
assert.equal(document.meta.id, 'sess-1')
assert.equal(document.meta.createdAt, 1710000000000)
assert.equal(document.turns.length, 2, '两个用户提问 = 两轮')
assert.equal(document.turns[0].prompt, '旧格式提问')
assert.equal(document.turns[0].promptBlocks.some(b => b.type === 'image'), true)
assert.equal(document.turns[0].steps[0].content[0].type, 'reasoning')
assert.equal(document.turns[1].steps[0].content.some(b => b.text === '另一个分支（不该出现）'), false)
assert.equal(JSON.stringify(document).includes('另一个分支'), false, '非当前分支必须被裁掉')
assert.equal(stats.malformedTurns, 0)
assert.equal(stats.imagesDegraded, 0)
const parsed = JSON.parse(JSON.stringify(document))
assert.equal(parsed.turns[1].steps[0].content.map(b => b.type).join(','), 'reasoning,text,text')
console.log('convert.test OK', JSON.stringify(stats))
