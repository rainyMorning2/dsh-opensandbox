import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MountPolicy } from '../src/mounts.mjs'
import { assertUserSandbox } from '../user-access.mjs'
import { Accounts } from '../src/users/accounts.mjs'
import { UserDataDirectories } from '../src/users/data-directories.mjs'
import { Context } from '@deepseek-ai/cordis'
import { OpenSandboxFileSystem } from '../src/fs.mjs'
import { OpenSandboxSubprocess } from '../src/subprocess.mjs'
import { OpenSandboxSandboxProvider } from '../src/sandbox.mjs'

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-user-data-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const [fallback, a, b, ad, bd, protectedPath] = ['fallback', 'a', 'b', 'a-data', 'b-data', 'state'].map(name => join(base, name))
  for (const path of [fallback, a, b, ad, bd, protectedPath]) mkdirSync(path)
  const config = { workspaceRoot: fallback, workspaceParents: [a, b], protectedPaths: [protectedPath],
    sessionWorkspaceOnly: true, allowDynamic: false,
    userDataRoots: [{ workspaceRoot: a, dataRoot: ad }, { workspaceRoot: b, dataRoot: bd }] }
  return { base, fallback, a, b, ad, bd, config, policy: new MountPolicy(config) }
}

test('user data and workspace share one sandbox with exactly two user mounts', t => {
  const f = fixture(t)
  for (const [workspace, data] of [[f.a, f.ad], [f.b, f.bd]]) {
    const target = f.policy.resolveMount(join(data, 'sessions/task/temp'), workspace)
    assert.equal(target.key, f.policy.resolveMount(workspace, workspace).key)
    assert.deepEqual(f.policy.volumesFor(target.root, target.sessionRoot).map(v => v.host.path).sort(), [workspace, data].sort())
    assert.equal(f.policy.isReadable(join(data, 'input.docx'), { sessionRoot: workspace }), true)
    assert.equal(f.policy.isWritable(join(data, 'result.xlsx'), { sessionRoot: workspace }), true)
    assert.equal(f.policy.isWritable(data, { sessionRoot: workspace, mode: 'read-only' }), false)
  }
  assert.notEqual(f.policy.resolveMount(f.a, f.a).key, f.policy.resolveMount(f.b, f.b).key)
  assert.equal(f.policy.isReadable(f.ad), false)
  assert.equal(f.policy.isReadable(f.bd, { sessionRoot: f.a }), false)
  assert.equal(f.policy.isWritable(f.bd, { sessionRoot: f.a }), false)
  assert.throws(() => f.policy.resolveMount(f.bd, f.a), /outside/)
  const link = join(f.ad, 'escape'); symlinkSync(f.bd, link)
  assert.equal(f.policy.isReadable(link, { sessionRoot: f.a }), false)
  assert.throws(() => f.policy.resolveMount(link, f.a), /outside/)
  assert.throws(() => f.policy.addDynamic(f.bd, 'rw'), /disabled/)
  const nested = join(f.a, 'project'); mkdirSync(nested)
  assert.equal(f.policy.userDataRootFor(nested), f.ad)
  const nestedTarget = f.policy.resolveMount(nested, nested)
  assert.equal(nestedTarget.key, f.policy.resolveMount(f.a, f.a).key)
  assert.deepEqual(f.policy.volumesFor(nestedTarget.root, nestedTarget.sessionRoot).map(v => [v.host.path, v.mountPath]).sort(), [[f.a, f.a], [f.ad, f.ad]].sort())
  assert.equal(f.policy.isWritable(join(f.a, 'other-project'), { sessionRoot: nested }), true)
  renameSync(nested, join(f.a, 'original-project')); symlinkSync(f.b, nested)
  assert.throws(() => f.policy.resolveMount(nested, nested), /redirected/)
  assert.throws(() => f.policy.isReadable(f.bd, { sessionRoot: nested }), /redirected/)
})

test('account roots cannot share data or overlap workspaces and control state', t => {
  const f = fixture(t), passwordHash = 'scrypt$' + 'a'.repeat(32) + '$' + 'b'.repeat(64)
  const config = { version: 1, users: [
    { id: 'a', username: 'a', passwordHash, defaultWorkspace: f.a, dataRoot: f.ad },
    { id: 'b', username: 'b', passwordHash, defaultWorkspace: f.b, dataRoot: f.bd },
  ] }
  assert.equal(new Accounts(config).owner(f.a).dataRoot, f.ad)
  for (const bad of [f.ad, f.a, join(f.base, 'state')]) {
    const changed = structuredClone(config); changed.users[1].dataRoot = bad
    assert.throws(() => new Accounts(changed, [join(f.base, 'state')]), /overlap/)
  }
  assert.throws(() => new MountPolicy({ ...f.config, userDataRoots: [{ workspaceRoot: f.a, dataRoot: f.a }] }), /overlap/)
})

test('file reads, downloads and mutations remain scoped when an Agent changes', async t => {
  const f = fixture(t), ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  let cwd = f.a
  ctx.provide('agents', { currentInitiator: () => ({ session: { header: { cwd } } }) })
  const fs = new OpenSandboxFileSystem(ctx, { mountPolicy: f.policy, cwd: f.fallback })
  writeFileSync(join(f.ad, 'private.txt'), 'alice')
  const target = await fs.resolve(join(f.ad, 'private.txt'), { cwd: f.a })
  assert.equal(Buffer.from(await fs.readBytes(target, undefined, 100)).toString(), 'alice')
  const output = await fs.resolve(join(f.ad, 'output.txt'))
  await fs.writeText(output, 'output', { kind: 'createIfAbsent' })
  assert.equal(await fs.readText(output), 'output')
  cwd = f.b
  for (const read of [() => fs.readText(target), () => fs.readBytes(target, undefined, 100), () => fs.stat(target),
    () => fs.deleteFile(target), () => fs.patchText(target, []), () => fs.moveFile(target, output, {})]) {
    await assert.rejects(read(), error => error.code === 'FS_SANDBOX_DENIED')
  }
  await assert.rejects(fs.resolve(join(f.ad, 'private.txt'), { cwd: f.a }), error => error.code === 'FS_SANDBOX_DENIED')
})

test('workspace mode grants Landlock only the current workspace and user data', async t => {
  const f = fixture(t), ctx = new Context()
  ctx.provide('agents', { currentInitiator: () => ({ session: { header: { cwd: f.a } } }) })
  const world = new OpenSandboxSubprocess(ctx, { ...f.config, secureExecution: true, workloadUid: 1000, workloadGid: 1000 })
  const sandbox = new OpenSandboxSandboxProvider(ctx, { secureExecution: true })
  t.after(async () => { await world.close(); await ctx.fiber.dispose() })
  const wrapped = await sandbox.confine(['/bin/true'], { mode: 'workspace-write', workspaceRoot: f.b })
  assert.ok(wrapped.argv.includes(f.a)); assert.ok(wrapped.argv.includes(f.ad))
  assert.ok(!wrapped.argv.includes(f.b)); assert.ok(!wrapped.argv.includes(f.bd))
  const readOnly = await sandbox.confine(['/bin/true'], { mode: 'read-only' })
  assert.ok(!readOnly.argv.includes(f.ad))
})


test('directory service returns the same account roots as the mount policy', async t => {
  const f = fixture(t), ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const passwordHash = 'scrypt$' + 'a'.repeat(32) + '$' + 'b'.repeat(64)
  const accounts = new Accounts({ version: 1, users: [
    { id: 'a', username: 'a', passwordHash, defaultWorkspace: f.a, dataRoot: f.ad },
    { id: 'b', username: 'b', passwordHash, defaultWorkspace: f.b, dataRoot: f.bd },
  ] })
  const service = new UserDataDirectories(ctx, accounts)
  for (const [workspace, dataRoot] of [[f.a, f.ad], [f.b, f.bd]]) {
    const directories = service.resolve({ session: { header: { cwd: workspace } } }, { workspace })
    assert.equal(directories.dataRoot, dataRoot)
    assert.deepEqual(directories.deliveryRoots, [workspace])
    const target = f.policy.resolveMount(dataRoot, workspace)
    assert.deepEqual(f.policy.volumesFor(target.root, target.sessionRoot).map(v => v.mountPath).sort(), [directories.workspace, directories.dataRoot].sort())
  }
  assert.throws(() => service.resolve({ session: { header: { cwd: f.a } } }, { workspace: f.b }), /outside|denied/i)
})


test('operator-approved reference and embedding mounts cannot include private user roots', async t => {
  const f = fixture(t), ctx = new Context(), reference = join(f.base, 'reference'), cache = join(f.base, 'embedding')
  mkdirSync(reference); mkdirSync(cache)
  const world = new OpenSandboxSubprocess(ctx, { ...f.config, secureExecution: true, apiKey: 'synthetic-key',
    workloadUid: 1000, workloadGid: 1000, allowDynamicMounts: false,
    extraReadOnlyMounts: [reference], extraWritableMounts: [cache] })
  new OpenSandboxFileSystem(ctx, { mountPolicy: world.mountPolicy, cwd: f.fallback })
  t.after(async () => { await world.close(); await ctx.fiber.dispose() })
  const passwordHash = 'scrypt$' + 'a'.repeat(32) + '$' + 'b'.repeat(64)
  const accounts = new Accounts({ version: 1, users: [
    { id: 'a', username: 'a', passwordHash, defaultWorkspace: f.a, dataRoot: f.ad },
    { id: 'b', username: 'b', passwordHash, defaultWorkspace: f.b, dataRoot: f.bd },
  ] })
  const grants = { sharedReadOnlyRoots: [reference], sharedWritableRoots: [cache] }
  assert.doesNotThrow(() => assertUserSandbox(ctx, accounts, grants))
  assert.throws(() => assertUserSandbox(ctx, accounts), /Shared mounts/)
  assert.throws(() => assertUserSandbox(ctx, accounts, { sharedWritableRoots: [reference, cache] }), /Shared mounts/)
  assert.throws(() => assertUserSandbox(ctx, accounts, { ...grants, sharedWritableRoots: [f.bd] }), /overlaps/)
  const volumes = world.mountPolicy.volumesFor(f.a, f.a)
  assert.equal(volumes.find(v => v.host.path === reference).readOnly, true)
  assert.equal(volumes.find(v => v.host.path === cache).readOnly, undefined)
  assert.ok(!volumes.some(v => v.host.path === f.b || v.host.path === f.bd))
})
