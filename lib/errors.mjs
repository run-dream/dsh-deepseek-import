// lib/errors.mjs — 把技术错误翻译成「人话 + 下一步」。
// 小白的第一个红字决定他会不会卸载，所以这里宁可啰嗦。

const RULES = [
  {
    test: (e) => e && (e.name === 'AuthError' || /HTTP 40[13]/.test(e.message || '')),
    title: 'DeepSeek 登录过期了',
    hint: '重新扫一次码即可：ds-migrate login。已经迁完的不会重做，重跑会从断点继续。',
  },
  {
    test: (e) => e && (e.name === 'TimeoutError' || /超时|ETIMEDOUT|EAI_AGAIN/.test(String(e.message || e.code))),
    title: '网络连不上 DeepSeek',
    hint: '检查是否需要代理；先跑 ds-migrate doctor 看两个域名是否通。',
  },
  {
    test: (e) => e && /ECT?ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(String(e.code || e.message)),
    title: '网络连接被中断',
    hint: '常见于代理或网络抖动。已自动重试；持续失败就先跑 ds-migrate doctor。',
  },
  {
    test: (e) => e && (e.name === 'RateLimitError' || /429|限流/.test(String(e.message))),
    title: '请求太频繁，被 DeepSeek 限流了',
    hint: '等几分钟再跑，进度已保存；不要同时开多个迁移进程。',
  },
  {
    test: (e) => e && /ENOSPC/.test(String(e.code || e.message)),
    title: '磁盘空间不足',
    hint: '清理后重跑会从断点继续；也可以先删掉旧的 out/ 目录。',
  },
  {
    test: (e) => e && /EACCES|EPERM/.test(String(e.code || e.message)),
    hint: '没有写权限：换个目录（--out），或检查该目录属主。',
    title: '文件写入被拒绝',
  },
  {
    test: (e) => e && /NO_PLAYWRIGHT/.test(String(e.code || '')),
    title: '缺少可选组件 playwright',
    hint: '改用系统浏览器即可：ds-migrate login 会自动拉起 Chrome/Edge；或 ds-migrate token --cdp 9222。',
  },
]

/** 返回 { title, hint, detail }；不认识的错误也给一条通用建议。 */
export function humanize(error) {
  const detail = String((error && (error.message || error.code)) || error || '未知错误')
  for (const rule of RULES) {
    try {
      if (rule.test(error)) return { title: rule.title, hint: rule.hint, detail }
    } catch { /* 规则本身出错就跳过 */ }
  }
  return {
    title: '出错了',
    hint: '先跑 ds-migrate doctor 看环境；如果仍无法解决，把上面的 detail 附在 issue 里。',
    detail,
  }
}

/** 渲染成多行文本。 */
export function renderError(error) {
  const { title, hint, detail } = humanize(error)
  return [`✘ ${title}`, `  ${hint}`, `  详情：${detail}`].join('\n')
}
