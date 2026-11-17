// 运行时 skill 注册的测试
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildSkill, registerSkill, stripFrontmatter } from '../lib/skill.mjs'

// frontmatter 剥离
assert.equal(stripFrontmatter('---\nname: x\n---\n# 正文\n'), '# 正文\n')
assert.equal(stripFrontmatter('# 无 frontmatter'), '# 无 frontmatter')

// 构建
const raw = readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf8')
const skill = buildSkill(raw)
assert.equal(skill.name, 'deepseek-to-dsh')
assert.equal(skill.source, 'runtime')
assert.ok(skill.content.startsWith('#'), '正文应从标题开始')
assert.ok(!skill.content.includes('description:'), '正文不应残留 frontmatter 字段')
assert.ok(skill.resourceBase.path.endsWith('skill'), 'resourceBase 应指向 skill 目录')
assert.equal(buildSkill('   '), null, '空内容返回 null')

// 注册：假 ctx 验证调用形状
const calls = []
const ctx = {
  inject(services, cb) { calls.push({ services }); cb({ skills: { register: (s) => calls.push({ registered: s.name }) } }) },
}
registerSkill(ctx)
assert.deepEqual(calls[0], { services: ['skills'] })
assert.deepEqual(calls[1], { registered: 'deepseek-to-dsh' })

// skills 服务缺席时不应抛错
registerSkill({ inject() { /* 宿主没有该服务，回调不执行 */ } })
console.log('skill.test OK')
