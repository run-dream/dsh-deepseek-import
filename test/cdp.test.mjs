// CDP 辅助函数的纯逻辑测试（不连真浏览器）
import assert from 'node:assert/strict'
import { extractTokenFromCdpResponse, pickDeepseekTarget } from '../lib/cdp.mjs'

// 目标挑选
assert.equal(pickDeepseekTarget(null), null)
assert.equal(pickDeepseekTarget([{ type: 'page', url: 'https://example.com' }]), null)
const targets = [
  { type: 'service_worker', url: 'https://chat.deepseek.com/sw.js' },
  { type: 'page', url: 'https://example.com/' },
  { type: 'page', url: 'https://chat.deepseek.com/a/chat/s/abc' },
]
assert.equal(pickDeepseekTarget(targets).url, 'https://chat.deepseek.com/a/chat/s/abc', '应选中 deepseek 页面而不是 worker')

// 响应解析：localStorage 原始 JSON 形态
const wrapped = JSON.stringify({ id: 1, result: { result: { value: JSON.stringify({ value: 'tok-123' }) } } })
assert.equal(extractTokenFromCdpResponse(wrapped), 'tok-123')

// 裸 token 形态
const bare = JSON.stringify({ id: 1, result: { result: { value: 'tok-456' } } })
assert.equal(extractTokenFromCdpResponse(bare), 'tok-456')

// 空 / 非法
assert.equal(extractTokenFromCdpResponse(JSON.stringify({ result: { result: { value: null } } })), '')
assert.equal(extractTokenFromCdpResponse('not json'), '')
assert.equal(extractTokenFromCdpResponse(''), '')
console.log('cdp.test OK')
