/** Explicit real-container probe; the operator supplies two disposable workspace directories. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { OpenSandboxSubprocess } from '../src/subprocess.mjs'
import { sseEvents, commandOutputText } from '../src/client.mjs'

if (!process.env.DSH_USERS_SANDBOX_ROOT || !process.env.OPEN_SANDBOX_API_KEY_FILE) throw Error('Explicit disposable DSH_USERS_SANDBOX_ROOT and OPEN_SANDBOX_API_KEY_FILE are required')
const base = resolve(process.env.DSH_USERS_SANDBOX_ROOT)
const a = join(base, 'alice'), b = join(base, 'bob'), fallback = join(base, 'bootstrap')
await mkdir(fallback, { recursive: true })
const ctx = new Context()
const world = new OpenSandboxSubprocess(ctx, {
  domain: process.env.OPEN_SANDBOX_DOMAIN ?? '127.0.0.1:4082',
  apiKeyFile: process.env.OPEN_SANDBOX_API_KEY_FILE,
  image: process.env.DSH_USERS_SANDBOX_IMAGE ?? 'dsh-opensandbox-dev:local',
  workspaceRoot: fallback, workspaceParents: [a, b], sessionWorkspaceOnly: true,
  allowDynamicMounts: false, timeoutSeconds: 180, cpu: '1', memory: '512Mi',
})
const ids = []
let checks = 0
const check = (condition, message) => { assert.ok(condition, message); checks++ }
async function command(id, cwd, script) {
  const response = await world.client.command(id, { command: script, cwd, timeout: 20 })
  let output = '', errors = ''
  for await (const event of sseEvents(response)) {
    if (event.type === 'stdout') output += commandOutputText(event)
    if (event.type === 'error') errors += JSON.stringify(event.error)
  }
  if (errors) throw Error(errors)
  return output
}
try {
  const first = await world.ensureSandboxFor(a, a), second = await world.ensureSandboxFor(b, b)
  ids.push(first, second)
  check(first !== second, 'distinct workspace containers')
  check(await world.ensureSandboxFor(a, a) === first, 'same workspace reuses its container')
  for (const [id, own, other, label] of [[first, a, b, 'alice'], [second, b, a, 'bob']]) {
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
    check((await command(id, own, 'cat private.txt')).includes(label + ' private file'), 'own file visible')
    check((await command(id, own, `if test -e ${quote(join(other, 'private.txt'))}; then printf leaked; else printf denied; fi`)).trim() === 'denied', 'other workspace not mounted')
    await command(id, own, `printf ${quote(label + '-persisted')} > probe-output.txt`)
    check(await readFile(join(own, 'probe-output.txt'), 'utf8') === label + '-persisted', 'container writes persist on host')
    check((await command(id, own, 'command -v bash; command -v python3; command -v rg')).split('\n').filter(Boolean).length === 3, 'runtime commands available')
  }
  await symlink(b, join(a, 'probe-escape'))
  check((await command(first, a, 'if test -e probe-escape/private.txt; then printf leaked; else printf denied; fi')).trim() === 'denied', 'outward link cannot reveal sibling mount')
  await assert.rejects(world.ensureSandboxFor(b, a)); checks++
  await world.client.killSandbox(first)
  const replacement = await world.ensureSandboxFor(a, a)
  ids.push(replacement)
  check(replacement !== first, 'reaped sandbox recreated')
  check((await command(replacement, a, 'cat probe-output.txt')).trim() === 'alice-persisted', 'files survive sandbox recreation')
  await writeFile(join(base, 'container-report.json'), JSON.stringify({ checks, containers: ids, image: world.config.image, result: 'passed' }, null, 2) + '\n')
  console.log(JSON.stringify({ checks, result: 'passed', realSandboxContainers: true }))
} finally {
  await world.close()
  await ctx.fiber.dispose()
  for (const id of ids) assert.equal(await world.client.getSandbox(id), undefined, 'test container cleanup')
}
