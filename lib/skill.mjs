// lib/skill.mjs — 把 skill/SKILL.md 注册成宿主运行时 skill。
// 装上插件就自动拥有这个技能（自然语言触发），不需要用户手工往 ~/.dsh/skills 里拷文件。

import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL_NAME = 'deepseek-to-dsh'

const SKILL_FILE = new URL('../skill/SKILL.md', import.meta.url)

/** 去掉 YAML frontmatter（运行时注册时元信息走参数，不留在正文里）。 */
export function stripFrontmatter(markdown) {
  const text = String(markdown || '')
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end < 0) return text
  const after = text.indexOf('\n', end + 1)
  return after < 0 ? '' : text.slice(after + 1)
}

export function buildSkill(content) {
  const body = stripFrontmatter(content).trim()
  if (!body) return null
  return {
    name: SKILL_NAME,
    description:
      '把用户整个 DeepSeek 账号的对话（含思维链、联网搜索证据、图片、附件）批量迁移进 DeepSeek Harness。' +
      '当用户说“把 DeepSeek 的对话迁到 dsh / 搬到 dsh / 导入 dsh / 把以前的聊天搬过来 / 换到 dsh 接着聊”时使用。',
    whenToUse:
      '用户想把 DeepSeek 网页/APP 里的历史对话搬到 dsh，或提到迁移、搬家、导入历史会话时。' +
      'Also when the user asks to migrate DeepSeek chat history into DSH.',
    source: 'runtime',
    content: body,
    resourceBase: { kind: 'directory', path: dirname(fileURLToPath(SKILL_FILE)) },
  }
}

/** skills 是可选宿主服务：缺席时静默跳过，命令与工具照常可用。 */
export function registerSkill(ctx, { readFile } = {}) {
  if (!ctx || typeof ctx.inject !== 'function') return
  ctx.inject(['skills'], (skillsCtx) => {
    let content
    try {
      const read = readFile || ((p) => readFileSync(p, 'utf8'))
      content = read(fileURLToPath(SKILL_FILE))
    } catch (error) {
      console.warn('[dsh-deepseek-account-import] SKILL.md 读取失败，跳过 skill 注册：' + String((error && error.message) || error))
      return
    }
    const skill = buildSkill(content)
    if (!skill) {
      console.warn('[dsh-deepseek-account-import] SKILL.md 内容为空，跳过 skill 注册')
      return
    }
    skillsCtx.skills.register(skill)
  })
}
