// 错误人话化
import assert from 'node:assert/strict'
import { humanize, renderError } from '../lib/errors.mjs'

const auth = humanize(Object.assign(new Error('登录态失效（HTTP 401）'), { name: 'AuthError' }))
assert.match(auth.title, /登录过期/)
assert.match(auth.hint, /ds-migrate login/)

const timeout = humanize(Object.assign(new Error('请求超时（30s）'), { name: 'TimeoutError' }))
assert.match(timeout.title, /网络/)

const rate = humanize(Object.assign(new Error('429 Too Many Requests'), { name: 'RateLimitError' }))
assert.match(rate.title, /限流/)

const disk = humanize(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))
assert.match(disk.title, /磁盘/)

const unknown = humanize(new Error('something odd'))
assert.equal(unknown.title, '出错了')
assert.match(unknown.hint, /doctor/)
assert.equal(unknown.detail, 'something odd')

const rendered = renderError(Object.assign(new Error('HTTP 401'), { name: 'AuthError' }))
assert.match(rendered, /^✘ /)
assert.match(rendered, /详情：/)
console.log('errors.test OK')
