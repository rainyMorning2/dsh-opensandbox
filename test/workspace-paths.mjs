import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MountPolicy, OpenSandboxFileSystem } from '../index.mjs'

const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-paths-'))
const a = join(base, 'a'), b = join(base, 'b'), fallback = join(base, 'fallback')
const ctx = new Context()
try {
  for (const path of [a, b, fallback, join(a, 'nested')]) await mkdir(path)
  await writeFile(join(a, 'text.txt'), 'own file\n')
  await writeFile(join(b, 'private.txt'), 'other file\n')
  await symlink(b, join(a, 'escape'))
  ctx.provide('agents', { currentInitiator: () => ({ session: { header: { cwd: a } } }) })
  const policy = new MountPolicy({ workspaceRoot: fallback, workspaceParents: [base], sessionWorkspaceOnly: true })
  assert.deepEqual(policy.volumesFor(a, a).map(v => [v.host.path, v.mountPath]), [[a, a]])
  assert.deepEqual(policy.volumesFor(join(a, 'nested'), join(a, 'nested')).map(v => v.host.path), [join(a, 'nested')])
  assert.throws(() => policy.resolveMount(b, a), /outside the session workspace/)
  const fs = new OpenSandboxFileSystem(ctx, { cwd: fallback, mountPolicy: policy })
  assert.equal(await fs.readText(await fs.resolve('text.txt', { cwd: a })), 'own file\n')
  assert.equal(await fs.readText(await fs.resolve('../text.txt', { cwd: join(a, 'nested') })), 'own file\n')
  for (const path of [join(b, 'private.txt'), join(a, 'escape/private.txt'), join(fallback, 'private.txt')]) {
    await assert.rejects(fs.resolve(path, { cwd: a }), /outside the sandbox mount roots/)
  }
  await assert.rejects(fs.resolve(join(b, 'private.txt'), { cwd: b }), /outside the sandbox mount roots/)
  assert.equal(await fs.lstat(join(base, '.git')), undefined)
  await assert.rejects(fs.resolve(join(base, '.git')), error => error.code === 'FS_NOT_FOUND')
  assert.equal(fs.processPath(await fs.resolve('text.txt', { cwd: a })), join(a, 'text.txt'))
  console.log('workspace paths: same-path mounts, descendant cwd, sibling/link/fallback denial passed')
} finally {
  await ctx.fiber.dispose()
  await rm(base, { recursive: true, force: true })
}
