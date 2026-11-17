// 浏览器检测层：渲染与建议逻辑（不真的扫描磁盘）
import assert from 'node:assert/strict'
import { isInstalled, renderScan } from '../lib/browsers.mjs'

// isInstalled：绝对路径与 PATH 命令
assert.equal(await isInstalled('/bin/sh'), true)
assert.equal(await isInstalled('/nonexistent/definitely-not-here'), false)
assert.equal(await isInstalled(''), false)

// 有已登录 profile → use-profile
const useProfile = renderScan({
  installed: [{ name: 'Chrome', command: 'chrome' }],
  profiles: [{ browser: 'Chrome', profile: 'Default', dir: '/x', hasToken: true }],
  cdp: [],
  recommendation: 'use-profile',
})
assert.match(useProfile, /✔ 已登录\s+Chrome \/ Default/)
assert.match(useProfile, /无需任何弹窗/)

// profile 读不到 token 但 CDP 活着 → attach-cdp
const attach = renderScan({
  installed: [{ name: 'Chrome', command: 'chrome' }],
  profiles: [{ browser: 'Chrome', profile: 'Default', dir: '/x', hasToken: false }],
  cdp: [{ port: 9222, browser: 'Chrome/157', targets: 3, hasDeepseek: true }],
  recommendation: 'attach-cdp',
})
assert.match(attach, /:9222\s+Chrome\/157（已打开 DeepSeek）/)
assert.match(attach, /连已有调试端口/)

// 装了但都没登录 → launch
assert.match(renderScan({ installed: [{ name: 'Edge', command: 'msedge' }], profiles: [], cdp: [], recommendation: 'launch' }), /拉起一个浏览器/)

// 什么都没有 → none
assert.match(renderScan({ installed: [], profiles: [], cdp: [], recommendation: 'none' }), /未检测到|只.*token-file/)
console.log('browsers.test OK')
