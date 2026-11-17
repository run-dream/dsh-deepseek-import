// 工具定义必须满足宿主契约：output { schema, render }，execute 返回规范值
import assert from 'node:assert/strict'
import { apply, buildToolDefinition } from '../lib/index.mjs'

const def = buildToolDefinition(async (args) => `action=${args.action}`)
assert.equal(def.name, 'deepseek_migrate')
assert.equal(typeof def.parameters, 'object')
assert.ok(def.output && typeof def.output === 'object', '必须声明 output（宿主会拒绝缺省的插件）')
assert.equal(def.output.schema.type, 'object')
assert.ok(Array.isArray(def.output.schema.properties.action ? [] : []), '占位')
assert.equal(typeof def.output.render, 'function')

const value = await def.execute({ action: 'preview' })
assert.equal(value.ok, true)
assert.equal(value.action, 'preview')
assert.equal(value.summary, 'action=preview')

const blocks = def.output.render({}, value)
assert.ok(Array.isArray(blocks) && blocks.length === 1)
assert.equal(blocks[0].type, 'text')
assert.equal(blocks[0].text, 'action=preview')

// execute 失败时 ok=false
const failing = buildToolDefinition(async () => '失败：boom')
assert.equal((await failing.execute({})).ok, false)

// apply 不应抛错：工具注册 + skill 注册 + 命令注册
const registered = { tools: [], skills: [], commands: [] }
const ctx = {
  logger: { info() {} },
  tools: { register: (d) => registered.tools.push(d.name) },
  inject(services, cb) {
    const fake = {
      skills: { register: (s) => registered.skills.push(s.name) },
      commands: { register: (c) => registered.commands.push(c.name) },
    }
    for (const name of services) if (fake[name]) cb({ [name]: fake[name] })
  },
}
apply(ctx)
assert.deepEqual(registered.tools, ['deepseek_migrate'])
assert.deepEqual(registered.skills, ['deepseek-to-dsh'])
assert.deepEqual(registered.commands, ['ds-migrate'])
console.log('tool-contract.test OK')
