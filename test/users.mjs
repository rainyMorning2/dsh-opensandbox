import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, symlink, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Accounts, hashPassword } from '../src/users/accounts.mjs'
import { LoginSessions } from '../src/users/sessions.mjs'
import { UserLogin } from '../src/users/http.mjs'
import { UserAccess } from '../src/users/access.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-users-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const a = join(root, 'alice'), b = join(root, 'bob')
  await mkdir(a); await mkdir(b); await mkdir(join(a, 'child'))
  const password = 'synthetic-password-for-tests'
  const passwordHash = await hashPassword(password)
  const config = { version: 1, users: [
    { id: 'a', username: 'alice', passwordHash, defaultWorkspace: a },
    { id: 'b', username: 'bob', passwordHash, defaultWorkspace: b },
  ] }
  return { root, a, b, password, config, accounts: new Accounts(config) }
}

test('config rejects shared, nested, symlink and protected roots; defaults stay in own grant', async t => {
  const f = await fixture(t)
  await symlink(f.b, join(f.a, 'escape'))
  assert.equal(f.accounts.allows(f.accounts.users.get('a'), join(f.a, 'escape')), false)
  assert.equal(f.accounts.allows(f.accounts.users.get('a'), f.b), false)
  assert.equal(f.accounts.resolveFor(f.accounts.users.get('a'), join(f.a, 'child')), join(f.a, 'child'))
  for (const path of [f.a, join(f.a, 'child'), join(f.a, 'escape')]) {
    const config = structuredClone(f.config); config.users[1].defaultWorkspace = path
    assert.throws(() => new Accounts(config))
  }
  assert.throws(() => new Accounts(f.config, [f.root]))
  assert.throws(() => new Accounts(f.config, [join(f.a, 'credentials')]))
  const wrong = structuredClone(f.config); wrong.users[0].workspaceRoots = [f.b]
  assert.throws(() => new Accounts(wrong))
})

test('opaque credentials survive restart, expire, revoke, and reject account config changes', async t => {
  const f = await fixture(t), file = join(f.root, 'state/logins.sqlite')
  let sessions = new LoginSessions(file, f.accounts, { lifetimeSeconds: 60 })
  const now = Date.now(), login = sessions.issue(f.accounts.users.get('a'), now)
  assert.equal(sessions.read(login.token).user.id, 'a')
  sessions.close()
  assert.equal((await readFile(file)).includes(Buffer.from(login.token)), false)
  sessions = new LoginSessions(file, f.accounts)
  assert.equal(sessions.read(login.token, now + 1000).user.id, 'a')
  assert.equal(sessions.read(login.token, now + 60000), undefined)
  sessions.revoke(login.token); assert.equal(sessions.read(login.token), undefined)
  const changed = sessions.issue(f.accounts.users.get('a')); sessions.close()
  const config = structuredClone(f.config); config.users[0].enabled = false
  sessions = new LoginSessions(file, new Accounts(config))
  assert.equal(sessions.read(changed.token), undefined); sessions.close()
})

test('policy gives only own resources and rejects administration, presets and unscoped attachments', async t => {
  const f = await fixture(t)
  const access = new UserAccess(f.accounts, () => [{ id: 'wa', path: f.a }, { id: 'wb', path: f.b }], new Map([
    ['sa', { cwd: f.a }], ['sb', { cwd: f.b }], ['unknown', {}],
  ]))
  const grants = access.bindings({ userId: 'a' })
  assert.deepEqual(grants.map(g => g.resource), [{ kind: 'global' }, { kind: 'workspace', id: 'wa' }, { kind: 'session', id: 'sa' }])
  for (const action of ['session/attachment', 'fileUploads/upload', 'pluginManager/listBundles', 'settings/set']) assert.equal(grants.some(g => g.role.actions.includes(action)), false)
  assert.equal(grants[0].role.actions.includes('session/selectModel'), false)
  assert.equal(grants.find(g => g.resource.id === 'sa').role.actions.includes('session/selectModel'), true)
  for (const action of ['settings/update', 'settings/replace', 'settings/mutate', 'session/initializeDefaultModel']) assert.equal(grants.some(g => g.role.actions.includes(action)), false)
  assert.equal(grants[0].role.actions.includes('workspaceFiles/changes'), false)
  assert.equal(grants.find(g => g.resource.id === 'sa').role.actions.includes('workspaceFiles/changes'), true)
  for (const action of ['event:approval/request', 'event:user-questions/request', 'userQuestions/attachWait', 'userQuestions/answer']) {
    assert.equal(grants[0].role.actions.includes(action), false)
    assert.equal(grants.find(g => g.resource.id === 'sa').role.actions.includes(action), true)
  }
  const condition = grants[0].condition
  assert.equal(condition({ action: 'commands/execute', args: { line: '/plan', submittedAttachments: [] } }).kind, 'allow')
  for (const mode of ['workspace-write', 'danger-full-access']) assert.equal(condition({ action: 'commands/execute', args: { line: '/permission ' + mode } }).kind, 'allow')
  assert.equal(condition({ action: 'commands/execute', args: { line: '/permission read-only' } }).kind, 'deny')
  assert.equal(condition({ action: 'commands/execute', args: { line: '/permission unrestricted', submittedAttachments: [] } }).kind, 'deny')
  assert.equal(condition({ action: 'session/create', args: { request: { cwd: f.b } } }).kind, 'deny')
  assert.equal(condition({ action: 'session/create', args: { request: { agentPreset: 'host' } } }).kind, 'deny')
  assert.equal(condition({ action: 'session/prompt', args: { request: { content: [{ type: 'image' }] } } }).kind, 'deny')
})

test('HTTP login binds distinct peers, refresh and restart keep identity, logout aborts existing peer', async t => {
  const f = await fixture(t)
  const file = join(f.root, 'state/logins.sqlite')
  let sessions = new LoginSessions(file, f.accounts)
  const connection = { createPeer({ principal }) {
    const lifetime = new AbortController()
    return { principal, signal: lifetime.signal, async dispose() { lifetime.abort() } }
  } }
  let login
  const server = createServer((req, res) => login.handle(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  login = new UserLogin(f.accounts, sessions, connection, { publicOrigin: origin, maxFailures: 2 })
  t.after(async () => { await login.close(); sessions.close(); await new Promise(resolve => server.close(resolve)) })
  const post = (username, password = f.password, extra = {}) => fetch(origin + '/auth/login', {
    method: 'POST', redirect: 'manual', headers: { Origin: origin, 'content-type': 'application/x-www-form-urlencoded', ...extra },
    body: new URLSearchParams({ username, password }),
  })
  assert.equal((await post('alice', f.password, { Origin: 'http://foreign.invalid' })).status, 403)
  const a = await post('alice'), b = await post('bob')
  assert.equal(a.status, 303); assert.equal(b.status, 303)
  const ac = a.headers.get('set-cookie').split(';')[0], bc = b.headers.get('set-cookie').split(';')[0]
  assert.match(a.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
  const ap = login.authenticate({ headers: { cookie: ac } })
  assert.equal(ap.principal.userId, 'a')
  assert.equal(login.authenticate({ headers: { cookie: bc } }).principal.userId, 'b')
  assert.equal(login.authenticate({ headers: { cookie: ac } }), ap)
  assert.equal(login.authenticate({ headers: { cookie: ac + '; ' + bc } }), undefined)
  await login.close(); sessions.close()
  sessions = new LoginSessions(file, f.accounts)
  login = new UserLogin(f.accounts, sessions, connection, { publicOrigin: origin, maxFailures: 2 })
  const restored = login.authenticate({ headers: { cookie: ac } })
  assert.equal(restored.principal.userId, 'a')
  const logout = await fetch(origin + '/auth/logout', { method: 'POST', redirect: 'manual', headers: {
    Origin: origin, cookie: ac, 'content-type': 'application/x-www-form-urlencoded',
  }, body: '' })
  assert.equal(logout.status, 303); assert.equal(restored.signal.aborted, true)
  assert.equal(login.authenticate({ headers: { cookie: ac } }), undefined)
  assert.equal((await post('alice', 'wrong')).status, 401)
  assert.equal((await post('alice', 'wrong')).status, 401)
  assert.equal((await post('alice', 'wrong')).status, 429)
})
