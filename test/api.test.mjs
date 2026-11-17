// 文件下载 URL 构造的回归测试：signed_path → files.deepseeksvc.com/api + ty=p|r
import assert from 'node:assert/strict'
import { DeepSeekApi, FILE_BASE_URL } from '../lib/api.mjs'

const calls = []
const fetchImpl = async (url) => {
  calls.push(String(url))
  if (String(url).includes('ty=r')) return { ok: false, status: 400, headers: new Map(), text: async () => '' }
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'image/webp']]),
    arrayBuffer: async () => Buffer.from('RIFFxxxxWEBP'),
  }
}

const api = new DeepSeekApi({ token: 't', fetchImpl, minIntervalMs: 0 })
const ref = { id: 'file-abc', signedPath: '/file?file_id=abc&state=SIG', isImage: true }
const got = await api.fetchFile(ref)
assert.ok(got && got.buffer.length > 0, '应拿到内容')
assert.equal(got.contentType, 'image/webp')
assert.equal(calls[0], `${FILE_BASE_URL}/file?file_id=abc&state=SIG&ty=p`, '图片必须用 ty=p')

calls.length = 0
const doc = await api.fetchFile({ id: 'file-doc', signedPath: '/file?file_id=d&state=S', isImage: false })
assert.equal(calls[0], `${FILE_BASE_URL}/file?file_id=d&state=S&ty=r`, '非图片应优先 ty=r')
assert.ok(doc, 'ty=r 失败应回退 ty=p')

// HTML 垃圾响应必须被丢弃
calls.length = 0
const htmlFetch = async () => ({
  ok: true, status: 200, headers: new Map([['content-type', 'text/html']]),
  arrayBuffer: async () => Buffer.from('<html></html>'),
})
const api2 = new DeepSeekApi({ token: 't', fetchImpl: htmlFetch, minIntervalMs: 0 })
assert.equal(await api2.fetchFile(ref), null, 'HTML 响应不能被当成文件')
console.log('api.test OK')
