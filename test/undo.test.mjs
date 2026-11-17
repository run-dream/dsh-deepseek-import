// 撤销：只删本工具导入的会话，且能原子清理登记
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listImported, undoImported } from '../lib/undo.mjs'

const root = await mkdtemp(join(tmpdir(), 'dsm-undo-'))
const outDir = join(root, 'out')
const sessionsRoot = join(root, 'sessions')
const workspace = join(sessionsRoot, 'ws')
await mkdir(outDir, { recursive: true })
await mkdir(join(workspace, 'import-mine'), { recursive: true })
await mkdir(join(workspace, 'import-other'), { recursive: true })
const registryPath = join(root, 'imports.json')
await writeFile(registryPath, JSON.stringify({
  version: 1,
  imports: {
    [join(outDir, 'a.interchange.json')]: { dshId: 'import-mine' },
    ['/somewhere/else/b.jsonl']: { dshId: 'import-other' },
  },
}))

const listed = await listImported({ registryPath, outDir })
assert.equal(listed.entries.length, 1, '只应认出 out 目录下的登记')
assert.equal(listed.entries[0].sessionId, 'import-mine')

const preview = await undoImported({ registryPath, outDir, sessionsRoot, dryRun: true })
assert.equal(preview.removedSessions, 1)
assert.equal(preview.registryUpdated, false, 'dry-run 不写登记')

const done = await undoImported({ registryPath, outDir, sessionsRoot })
assert.equal(done.removedSessions, 1)
assert.equal(done.registryUpdated, true)

const registry = JSON.parse(await readFile(registryPath, 'utf8'))
assert.ok(!(join(outDir, 'a.interchange.json') in registry.imports), '本工具登记应被清掉')
assert.ok('/somewhere/else/b.jsonl' in registry.imports, '别人的登记必须保留')
console.log('undo.test OK')
