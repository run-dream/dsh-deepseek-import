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

// 用宿主自带的 schema 校验器验证（装了 dsh 才跑，否则跳过）
{
  let assertSupported = null
  try {
    const mod = await import('/home/ruanjun01/.local/share/mise/installs/node/22.22.3/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
    assertSupported = mod.assertSupportedJsonSchema
    globalThis.__dshTools = mod
  } catch {
    try {
      const mod = await import('@deepseek-ai/dsh-tools')
      assertSupported = mod.assertSupportedJsonSchema
      globalThis.__dshTools = mod
    } catch { /* 没装 dsh，跳过 */ }
  }
  const T = globalThis.__dshTools
  const assertSupportedParameterMap = (params) => T.parameterSchemaSpecToJsonSchema(params)
  const assertSupportedOutputSchema = (schema) => T.valueSchemaSpecToJsonSchema(schema)
  if (!assertSupported) {
    console.log('tool-contract.schema SKIP（本机没有 dsh-tools 校验器）')
  } else {
    assertSupported(def.output.schema)
    assertSupported({ type: 'object', properties: def.parameters, additionalProperties: false })
    // 走宿主真实的两条编译路径（注册与出参校验各用一条）
    assertSupportedParameterMap(def.parameters)
    assertSupportedOutputSchema(def.output.schema)
    assert.throws(() => assertSupported({
      type: 'object',
      properties: { ok: { type: 'boolean', required: true } },
    }), /required is not supported/, '字段级 required 必须被拒（这正是线上炸过的那种写法）')
    console.log('tool-contract.schema OK')
  }
}
