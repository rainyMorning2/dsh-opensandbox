import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { StaticWorkspacePolicy, AuthorizedDirectoryPicker } from '../workspace-access.mjs'

const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-grants-'))
const ctx = new Context()
const a = join(base, 'a'), b = join(base, 'b')
try {
  await mkdir(join(a, 'nested'), { recursive: true })
  await mkdir(b)
  await symlink(b, join(a, 'escape'))
  await ctx.plugin(StaticWorkspacePolicy, { roots: [a], defaultWorkspace: a }).await()
  await ctx.plugin(AuthorizedDirectoryPicker, { maxEntries: 1000 }).await()
  const policy = ctx.workspacePathPolicy, picker = ctx.directoryPicker.capability()
  assert.equal(await policy.defaultDirectory(), a)
  assert.equal(await policy.resolve(join(a, 'nested')), join(a, 'nested'))
  for (const path of [base, b, join(a, '../b'), join(a, 'escape'), 'relative']) await assert.rejects(policy.resolve(path))
  const initial = await picker.list()
  assert.equal(initial.path, a)
  assert.equal(initial.selectable, true)
  assert.deepEqual(initial.entries.map(e => e.name), ['nested'])
  const parent = await picker.list(base)
  assert.equal(parent.selectable, false)
  assert.deepEqual(parent.entries.map(e => [e.path, e.selectable]), [[a, true]])
  const grandparent = await picker.list(dirname(base))
  assert.deepEqual(grandparent.entries.map(e => [e.path, e.selectable]), [[base, false]])
  await assert.rejects(picker.list(b))
  await assert.rejects(picker.list(join(a, 'escape')))
  await assert.rejects(picker.list('relative'))
  assert.equal(await picker.createDirectory(a, 'created'), join(a, 'created'))
  assert.equal(await picker.createDirectory(join(a, 'nested'), 'child'), join(a, 'nested/child'))
  await assert.rejects(picker.createDirectory(base, 'denied'))
  await assert.rejects(picker.createDirectory(join(a, 'escape'), 'denied'))
  await assert.rejects(picker.createDirectory(a, '../b'))
  const cancelled = AbortSignal.abort(new Error('cancelled'))
  await assert.rejects(picker.list(a, cancelled), /cancelled/)
  console.log('workspace access: root/child selection, filtered parents, creation and bypass denial passed')
} finally {
  await ctx.fiber.dispose()
  await rm(base, { recursive: true, force: true })
}
