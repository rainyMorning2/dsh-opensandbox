/** Real source-profile regression with synthetic users and no model or sandbox-server calls. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { fileWatch } from './user-file-watch.mjs'
import { hashPassword } from '../src/users/accounts.mjs'

const plugin = resolve(import.meta.dirname, '..')
const repo = resolve(process.env.DSH_SOURCE_REPO ?? join(plugin, '../deepseek-harness'))
const root = await mkdtemp(join(tmpdir(), 'dsh-user-integration-'))
const reserve = createServer()
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
const port = reserve.address().port
await new Promise(resolve => reserve.close(resolve))
const origin = `http://127.0.0.1:${port}`
const password = 'synthetic-user-integration-password'
const passwordHash = await hashPassword(password)
const users = ['alice', 'bob'].map(id => ({ id, username: id, passwordHash, defaultWorkspace: join(root, id) }))
for (const user of users) {
  await mkdir(user.defaultWorkspace)
  await writeFile(join(user.defaultWorkspace, 'private.txt'), user.id + ' private data')
}
await symlink(users[1].defaultWorkspace, join(users[0].defaultWorkspace, 'escape'))
await writeFile(join(root, 'users.json'), JSON.stringify({ version: 1, users }), { mode: 0o600 })
const cookies = {}, ids = {}, workspaces = {}
let child, exit, output = '', checks = 0
const check = (condition, message) => { assert.ok(condition, message); checks++ }
async function start() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/API_KEY|TOKEN|PASSWORD|DSH_HOME/.test(key)) delete env[key]
  env.OPEN_SANDBOX_API_KEY = 'synthetic-test-server-key'
  child = spawn('python3', [join(plugin, 'dev/users/launch.py'), '--users', join(root, 'users.json'),
    '--home', join(root, 'home'), '--origin', origin, '--port', String(port), '--repo', repo,
    '--sandbox-domain', '127.0.0.1:9'], { cwd: plugin, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  exit = once(child, 'exit')
  output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000) })
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error('Test DSH exited: ' + output.replace(/token=[^\s&]+/g, 'token=[redacted]'))
    try { const response = await fetch(origin + '/auth/login'); if (response.status === 200) return } catch { /* Await this test's listener. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw Error('Test DSH startup timed out')
}
async function stop() {
  if (!child || child.exitCode !== null) return
  process.kill(-child.pid, 'SIGTERM')
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* Process group already exited. */ } }, 10000)
  try { await exit } finally { clearTimeout(timer) }
}
async function rpc(user, method, args) {
  const response = await fetch(origin + '/api/' + method, { method: 'POST', headers: {
    cookie: cookies[user], origin, 'content-type': 'application/json',
  }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }) })
  check(response.status === 200, method + ' HTTP response')
  return (await response.json()).result
}
try {
  await start()
  check((await fetch(origin + '/', { redirect: 'manual' })).status === 303, 'anonymous index redirects')
  check((await fetch(origin + '/api/session/list')).status === 401, 'anonymous API rejected')
  check((await fetch(origin + '/connect?token=ignored')).status === 403, 'owner connect disabled')
  if (process.env.DSH_USERS_BROWSER === '1') {
    const require = createRequire(join(repo, 'apps/web/package.json'))
    const { chromium } = require('playwright')
    const browser = await chromium.launch({ headless: true, ...(process.env.DSH_TEST_CHROMIUM ? { executablePath: process.env.DSH_TEST_CHROMIUM } : {}) })
    try {
      const page = await browser.newPage()
      await page.goto(origin)
      await page.locator('[name=username]').fill('alice')
      await page.locator('[name=password]').fill(password)
      await page.locator('button').click()
      await page.waitForURL(origin + '/')
      await page.waitForFunction(() => document.body.innerText.includes('alice') && document.body.innerText.includes('Describe what you want'), { timeout: 15000 })
      check(!((await page.locator('body').innerText()).includes('bob')), 'first-ever browser login initializes own workspace')
    } finally { await browser.close() }
  }

  for (const user of users) {
    const response = await fetch(origin + '/auth/login', { method: 'POST', redirect: 'manual', headers: {
      origin, 'content-type': 'application/x-www-form-urlencoded',
    }, body: new URLSearchParams({ username: user.id, password }) })
    check(response.status === 303, 'login ' + user.id)
    cookies[user.id] = response.headers.get('set-cookie').split(';')[0]
    const html = await (await fetch(origin + '/', { headers: { cookie: cookies[user.id] } })).text()
    check(html.includes('"owner":false'), 'page is not owner')
    const workspace = await rpc(user.id, 'workspace/initializeDefault', {})
    check(workspace.ok && workspace.value.workspace.path === user.defaultWorkspace, 'own default workspace')
    workspaces[user.id] = workspace.value.workspace.workspaceId
    const created = await rpc(user.id, 'session/create', { request: {} })
    check(created.ok, 'own session create: ' + JSON.stringify(created)); ids[user.id] = created.value.sessionId
  }
  for (const [index, user] of users.entries()) {
    const other = users[1 - index]
    const foreignAnswer = await rpc(user.id, 'userQuestions/answer', { agentId: ids[other.id], callId: 'interaction-test-call', answer: { answers: [] } })
    check(!foreignAnswer.ok && foreignAnswer.error.code === 'remote-access/denied', 'other user question answer denied before dispatch')
    const permissions = await rpc(user.id, 'permissionPresets/catalog', {})
    check(permissions.ok, 'permission catalogue available')
    check(permissions.value.defaultPreset === 'workspace-write', 'workspace permission is the default')
    check(permissions.value.defaultOptions.length === 2, 'only two permission modes exposed')
    for (const preset of ['danger-full-access', 'workspace-write']) {
      const changed = await rpc(user.id, 'commands/execute', { agentId: ids[user.id], line: '/permission ' + preset, submittedAttachments: [] })
      check(changed.ok && changed.value.result.kind === 'success', 'own permission switch ' + preset + ': ' + JSON.stringify(changed))
      const projection = await rpc(user.id, 'session/projections', { request: { sessionId: ids[user.id] } })
      check(projection.ok && projection.value.values.permissions.currentValue === preset, 'permission projection follows selection')
    }
    for (const [sessionId, line] of [[ids[other.id], '/permission danger-full-access'], [ids[user.id], '/permission read-only']]) {
      const denied = await rpc(user.id, 'commands/execute', { agentId: sessionId, line, submittedAttachments: [] })
      check(!denied.ok && denied.error.code !== 'gateway/arguments-invalid', 'other session/readonly selection rejected')
    }
    const list = await rpc(user.id, 'session/list', { _request: {} })
    check(list.ok && list.value.items.every(item => item.cwd === user.defaultWorkspace), 'session list isolates users')
    const settings = await rpc(user.id, 'settings/describe', {})
    check(settings.ok && !settings.value.writable && !settings.value.hasDocument, 'only read-only display defaults')
    check(settings.value.namespaces.every(row => ['ui-theme', 'locale', 'ui-settings', 'ui-conversation', 'ui-sidebar', 'ui-layout', 'ui-settings-general', 'ui-settings-session-log'].includes(row.ns)), 'deployment settings stay private')
    const own = await rpc(user.id, 'workspaceFiles/read', { workspaceFileScopeId: ids[user.id], path: 'private.txt', range: {} })
    check(own.ok && own.value.text.includes(user.id + ' private'), 'own file readable: ' + JSON.stringify(own))
    for (const [path, changed] of [['.', 'watch-probe.txt'], ['private.txt', 'private.txt']]) {
      const frame = await fileWatch(origin, cookies[user.id], ids[user.id], path,
        () => writeFile(join(user.defaultWorkspace, changed), user.id + ' private updated'))
      check(frame.type === 'item' && frame.value.kind === 'change', 'own file/directory change notification')
    }
    for (const [sessionId, path] of [[ids[other.id], '.'], [ids[user.id], other.defaultWorkspace], [ids[user.id], join(other.defaultWorkspace, 'private.txt')]]) {
      const frame = await fileWatch(origin, cookies[user.id], sessionId, path)
      check(frame.type === 'error', 'other user file watch refused')
    }
    for (const [method, args] of [
      ['session/create', { request: { cwd: other.defaultWorkspace } }],
      ['session/create', { request: { workspaceId: workspaces[other.id] } }],
      ['session/create', { request: { sessionId: ids[other.id], cwd: user.defaultWorkspace } }],
      ['session/create', { request: { agentPreset: 'cordis' } }],
      ['session/page', { request: { address: { kind: 'session', sessionId: ids[other.id] } } }],
      ['session/cancel', { request: { sessionId: ids[other.id] } }],
      ['directoryPicker/list', { path: other.defaultWorkspace }],
      ['directoryPicker/createDirectory', { path: other.defaultWorkspace, name: 'denied' }],
      ['workspace/create', { request: { path: other.defaultWorkspace } }],
      ['workspaceFiles/read', { workspaceFileScopeId: ids[user.id], path: join(other.defaultWorkspace, 'private.txt'), range: {} }],
      ['workspaceFiles/read', { workspaceFileScopeId: ids[other.id], path: 'private.txt', range: {} }],
      ['pluginManager/listBundles', {}], ['settings/update', { ns: 'ui-theme', patch: { preference: 'dark' } }],
    ]) {
      const result = await rpc(user.id, method, args)
      check(!result.ok && result.error.code !== 'gateway/arguments-invalid', 'cross-user/admin refusal: ' + method + ' ' + JSON.stringify(result))
    }
  }
  check(!(await rpc('alice', 'workspaceFiles/read', { workspaceFileScopeId: ids.alice, path: 'escape/private.txt', range: {} })).ok, 'outward symlink refused')
  check((await fetch(origin + '/api/file?path=' + encodeURIComponent(join(root, 'bob/private.txt')), { headers: { cookie: cookies.alice } })).status === 403, 'global file route refused')
  await stop(); await start()
  for (const user of users) {
    const list = await rpc(user.id, 'session/list', { _request: {} })
    check(list.ok && list.value.items.some(item => item.sessionId === ids[user.id]), 'cookie and session survive restart')
    const workspace = await rpc(user.id, 'workspace/initializeDefault', {})
    check(workspace.ok && workspace.value.workspace.workspaceId === workspaces[user.id], 'default workspace identity survives restart')
  }
  if (process.env.DSH_USERS_BROWSER === '1') {
    const require = createRequire(join(repo, 'apps/web/package.json'))
    const { chromium } = require('playwright')
    const browser = await chromium.launch({ headless: true, ...(process.env.DSH_TEST_CHROMIUM ? { executablePath: process.env.DSH_TEST_CHROMIUM } : {}) })
    try {
      for (const user of users) {
        const context = await browser.newContext(), page = await context.newPage()
        const frames = []
        page.on('websocket', socket => socket.on('framereceived', frame => frames.push(String(frame.payload))))
        await page.goto(origin)
        await page.locator('[name=username]').fill(user.id)
        await page.locator('[name=password]').fill(password)
        await page.locator('button').click()
        await page.waitForURL(origin + '/')
        await page.waitForFunction(user => document.body.innerText.includes(user) && !document.body.innerText.includes('Choose a workspace to start') && document.body.innerText.includes('Describe what you want'), user.id, { timeout: 15000 })
        const body = await page.locator('body').innerText()
        check(!body.includes('Failed to load plugins') && !body.includes(users.find(other => other !== user).id), 'browser shows only own workspace')
        const other = users.find(other => other !== user)
        const renamed = await rpc(other.id, 'session/rename', { request: { sessionId: ids[other.id], title: 'private-title-' + other.id } })
        check(renamed.ok, 'other user can rename own session while first browser is connected')
        await page.waitForTimeout(200)
        check(!frames.join('').includes(ids[other.id]), 'live socket never exposes another user session identity')
        await page.reload(); check(page.url() === origin + '/', 'browser refresh keeps login')
        await page.getByRole('button', { name: '退出登录' }).click()
        await page.getByRole('button', { name: '退出登录' }).click()
        await page.waitForURL(origin + '/auth/login')
        check(page.url().endsWith('/auth/login'), 'browser logout')
        await context.close()
      }
    } finally { await browser.close() }
  }
  console.log(JSON.stringify({ checks, result: 'passed', modelCalls: 0, realSandboxContainers: false, browser: process.env.DSH_USERS_BROWSER === '1' }))
} finally { await stop(); await rm(root, { recursive: true, force: true }) }
