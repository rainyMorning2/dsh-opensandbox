/** Explicit synthetic-container regression; never use a real user's workspace as this root. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { OpenSandboxSubprocess } from '../src/subprocess.mjs'
import { OpenSandboxSandboxProvider } from '../src/sandbox.mjs'

if (!process.env.DSH_USERS_SANDBOX_ROOT || !process.env.OPEN_SANDBOX_API_KEY_FILE) throw Error('Explicit test workspace and API-key file required')
const root = resolve(process.env.DSH_USERS_SANDBOX_ROOT)
const a = join(root, 'alice'), b = join(root, 'bob'), fallback = join(root, 'bootstrap')
for (const p of [a, b, fallback]) await mkdir(p, { recursive: true })
await writeFile(join(a, 'private.txt'), 'alice-only')
await writeFile(join(b, 'private.txt'), 'bob-only')
const config = {
  domain: process.env.OPEN_SANDBOX_DOMAIN, apiKeyFile: process.env.OPEN_SANDBOX_API_KEY_FILE,
  image: process.env.DSH_USERS_SANDBOX_IMAGE, secureExecution: true,
  workspaceRoot: fallback, workspaceParents: [a, b], sessionWorkspaceOnly: true,
  allowDynamicMounts: false, timeoutSeconds: 300, cpu: '1', memory: '256Mi',
}
const ctx = new Context(), world = new OpenSandboxSubprocess(ctx, config), sandbox = new OpenSandboxSandboxProvider(ctx, config)
let checks = 0
const check = (condition, message) => { assert.ok(condition, message); checks++ }
async function command(cwd, mode, script, env = {}) {
  const wrapped = await sandbox.confine(['/bin/bash', '-c', script], { mode, workspaceRoot: cwd })
  const child = world.spawn({ argv: wrapped.argv, cwd, env, stdio: { stdin: 'ignore', stdout: { maxBytes: 32768 }, stderr: { maxBytes: 32768 } } })
  const result = await child.done
  return { ...result, stdout: child.collected.stdout.readFrom(0).text, stderr: child.collected.stderr.readFrom(0).text }
}
try {
  const [idA, idB] = await Promise.all([world.ensureSandboxFor(a, a), world.ensureSandboxFor(b, b)])
  check(idA !== idB, 'separate workspace sandboxes')
  check(world.client.execdTokens.get(idA) !== world.client.execdTokens.get(idB), 'independent credentials')
  const endpointA = await world.client.execdBase(idA), endpointB = await world.client.execdBase(idB)
  for (const headers of [{}, world.client.execdHeaders(idB)]) {
    const res = await fetch(endpointA + '/command', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'true' }), signal: AbortSignal.timeout(5000) })
    check(res.status === 401, 'missing/wrong sandbox credential refused'); await res.body?.cancel()
  }
  for (const cwd of [a, b]) {
    let r = await command(cwd, 'workspace-write', 'printf workspace-ok > allowed.txt; cat allowed.txt')
    check(r.exitCode === 0 && r.stdout.includes('workspace-ok'), 'workspace write succeeds')
    check(await readFile(join(cwd, 'allowed.txt'), 'utf8') === 'workspace-ok', 'workspace write persisted')
    r = await command(cwd, 'workspace-write', 'printf no > /home/dsh/denied.txt')
    check(r.exitCode !== 0 && /permission denied/i.test(r.stderr), 'workspace mode rejects home write')
    r = await command(cwd, 'danger-full-access', 'printf full-ok > /home/dsh/full.txt; cat /home/dsh/full.txt; id -u')
    check(r.exitCode === 0 && r.stdout.includes('full-ok') && r.stdout.includes(String(process.getuid())), 'full writes home without root')
    r = await command(cwd, 'workspace-write', 'printf no > /home/dsh/full.txt')
    check(r.exitCode !== 0, 'downgrade restores confinement')
    const other = cwd === a ? b : a
    r = await command(cwd, 'danger-full-access', `test ! -e ${JSON.stringify(join(other, 'private.txt'))}`)
    check(r.exitCode === 0, 'full cannot see other workspace')
    r = await command(cwd, 'danger-full-access', 'test ! -w /opt/dsh-policy/landlock-run && test ! -w /usr/bin/setpriv && test ! -r /proc/1/environ')
    check(r.exitCode === 0, 'full cannot modify launcher or read root environment')
    const target = new URL(cwd === a ? endpointB : endpointA); target.hostname = '172.17.0.1'
    const probe = `import urllib.request,urllib.error,os,glob\nr=[]\nfor url in ['http://127.0.0.1:44772/command',${JSON.stringify(target.toString().replace(/\/$/, '') + '/command')}]:\n try: urllib.request.urlopen(urllib.request.Request(url,data=b'{"command":"true"}',headers={'Content-Type':'application/json'}),timeout=5);r.append(200)\n except urllib.error.HTTPError as e:r.append(e.code)\nassert r==[401,401],r\nassert 'EXECD_ACCESS_TOKEN' not in os.environ\nfor p in glob.glob('/proc/[0-9]*/environ'):\n try: assert b'EXECD_ACCESS_TOKEN=' not in open(p,'rb').read()\n except (PermissionError,FileNotFoundError,ProcessLookupError): pass\nprint('control-boundary-ok')`
    r = await command(cwd, 'danger-full-access', 'python3 -c ' + "'" + probe.replaceAll("'", "'\\''") + "'")
    check(r.exitCode === 0 && r.stdout.includes('control-boundary-ok'), 'own/cross execd blocked; control credentials not readable')
  }
  const terminal = await world.spawnTerminal({ cwd: a, argv: ['/bin/bash', '--noprofile', '--norc', '-i'], cols: 80, rows: 24, env: {} })
  let text = '', timer
  const output = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error('PTY did not return identity')), 10000)
    terminal.output.on('data', chunk => { text += String(chunk); if (text.includes('pty-identity:' + process.getuid())) resolve() })
    terminal.output.on('error', reject)
  })
  try { await terminal.write('printf "pty-identity:%s\\n" "$(id -u)"\r'); await output; checks++ } finally { clearTimeout(timer); await terminal.terminate() }
  console.log(JSON.stringify({ result: 'passed', checks, realSandboxContainers: true, modelCalls: 0 }))
} finally {
  await world.close(); await sandbox.close(); await ctx.fiber.dispose()
}
