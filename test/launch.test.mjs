// 浏览器自动拉起里的纯逻辑测试（不真的启动浏览器）
import assert from 'node:assert/strict'
import { buildLaunchArgs, candidateBrowsers } from '../lib/launch.mjs'

const args = buildLaunchArgs({ port: 9333, profileDir: 'C:\\tmp\\prof' })
assert.equal(args[0], '--remote-debugging-port=9333')
assert.equal(args[1], '--user-data-dir=C:\\tmp\\prof')
assert.ok(args.includes('--no-first-run'))
assert.ok(args.includes('https://chat.deepseek.com/'), '默认打开 DeepSeek 登录页')

const custom = buildLaunchArgs({ port: 9222, profileDir: '/tmp/x', url: 'https://example.com' })
assert.equal(custom.at(-1), 'https://example.com')
assert.equal(buildLaunchArgs({ profileDir: '/tmp/x' })[0], '--remote-debugging-port=9222', '端口缺省 9222')

// 环境变量优先
process.env.DSH_BROWSER_PATH = '/opt/fake/chrome'
const candidates = await candidateBrowsers()
assert.equal(candidates[0].command, '/opt/fake/chrome', 'DSH_BROWSER_PATH 应排在第一位')
assert.ok(candidates.some((c) => /chrome|chromium|edge/i.test(c.command)), '应包含常见浏览器候选')
console.log('launch.test OK')
