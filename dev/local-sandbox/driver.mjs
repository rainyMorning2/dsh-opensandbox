import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const { createUserMessage } = await import(pathToFileURL(`${process.env.DSH_SOURCE_REPO}/packages/llm/llm/src/index.ts`).href)
const { SessionId } = await import(pathToFileURL(`${process.env.DSH_SOURCE_REPO}/packages/core/session/src/index.ts`).href)
import { base, scenario, artifact } from './scenarios.mjs'
export const inject = ['agents', 'loader', 'subprocess', 'fs', 'workingDirectory']
export function apply(ctx) {
  const ready = ctx.get('appReady'), exit = ctx.get('appExit')
  const report = { sessions: [], checks: [], errors: [], runtimeContexts: [] }
  const events = new Map()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/result') {
      const list = events.get(session.id) ?? []; list.push(event); events.set(session.id, list)
    }
  }, { global: true })
  ctx.on('agent/error', ({error}) => { report.errors.push(String(error)) }, { global: true })
  const run = async () => {
    try {
      for (const label of ['a', 'b']) {
        const sessionId = SessionId(randomUUID())
        const handle = await ctx.agents.create({ sessionId, meta: { cwd: `${base}/session-${label}` }, agentOptions: { provider: 'sandbox-probe', model: 'sandbox-probe' } })
        assert.equal(ctx.workingDirectory.get(handle.agent.session), `${base}/session-${label}`)
        report.sessions.push({ label, sessionId, cwd: handle.agent.session.header.cwd, containerCwd: ctx.workingDirectory.get(handle.agent.session) })
        try {
          handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `PROBE_SESSION_${label}` }] }))
          await handle.agent.whenIdle()
          assert.deepEqual(report.errors, [], 'Agent errors before tool assertions')
          const snapshots = handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context')
          assert.ok(snapshots.length > 0, 'Missing logged runtime context')
          const runtime = snapshots.at(-1).data
          const runtimeText = runtime.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
          assert.equal(ctx.get('sandboxPolicy').resolve({ session: handle.agent.session }).workspaceRoot, `${base}/session-${label}`, 'Enforcement must retain the host directory')
          const policyText = runtimeText.split('\n\n').find(text => text.startsWith('Current DSH file policy:'))
          assert.ok(policyText?.includes(JSON.stringify(`${base}/session-${label}`)), 'Policy must describe the container workspace')
          report.runtimeContexts.push({ sessionId, policy: policyText })
          report.checks.push(`Session ${label}: logged file policy uses the shared host/container path`)

          const results = events.get(sessionId) ?? []
          writeFileSync(`${process.env.DSH_SANDBOX_PROBE_STATE}/events-${label}.json`, JSON.stringify(results, null, 2))
          assert.equal(results.length, scenario(label).length, `Session ${label} result count`)
          for (const [index, step] of scenario(label).entries()) {
            const data = results[index].data
            assert.equal(data.message.isError === true, step.error, `Session ${label} step ${index}: ${JSON.stringify(data)}`)
            if (step.contains) assert.ok(JSON.stringify(data.message.content).includes(step.contains), `Missing output ${step.contains}`)
            if (step.excludes) assert.equal(JSON.stringify(data.message.content).includes(step.excludes), false, `Unexpected host path ${step.excludes}`)
            report.checks.push(`Session ${label}: ${step.name} ${index} ${step.error ? 'denied' : 'succeeded'}`)
          }
          await ctx.agents.withInitiator(handle.agent, async () => {
            const signal = AbortSignal.timeout(20000)
            const terminal = await ctx.subprocess.spawnTerminal({
              argv: ['/bin/bash', '--noprofile', '--norc', '-i'], cwd: `${base}/session-${label}`,
              rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 1000, signal,
            })
            let output = ''
            let resolveReady, rejectReady
            const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
            const onData = chunk => {
              output += String(chunk)
              if (output.includes(`PTY_CWD=${base}/session-${label}`)) resolveReady()
            }
            const onAbort = () => rejectReady(signal.reason)
            const onError = error => rejectReady(error)
            terminal.output.on('data', onData)
            terminal.output.on('error', onError)
            signal.addEventListener('abort', onAbort, { once: true })
            terminal.done.catch(onError)
            try {
              await terminal.write('printf "\\nPTY_CWD="; pwd\n')
              await ready
              report.checks.push(`Session ${label}: PTY working directory matches the Workspace`)
            } finally {
              signal.removeEventListener('abort', onAbort)
              terminal.output.off('data', onData)
              terminal.output.off('error', onError)
              await terminal.terminate()
              await terminal.done
            }
          })
          console.log(`PASS: source DSH Session ${label}: ${results.length} real tool results`)
        } finally { await handle.dispose() }
        const resumed = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'sandbox-probe', model: 'sandbox-probe' } })
        try {
          assert.equal(resumed.agent.session.header.cwd, `${base}/session-${label}`)
          assert.equal(ctx.workingDirectory.get(resumed.agent.session), `${base}/session-${label}`)
          await ctx.agents.withInitiator(resumed.agent, async () => {
            const target = await ctx.fs.resolve(`${base}/session-${label}/${artifact}`, { cwd: `${base}/session-${label}` })
            assert.equal(await ctx.fs.readText(target), `edited-by-${label}\n`)
          })
          report.checks.push(`Session ${label}: resume retains Workspace file access`)
        } finally { await resumed.dispose() }
      }
      for (const label of ['a','b']) {
        assert.equal(readFileSync(`${base}/session-${label}/${artifact}`, 'utf8'), `edited-by-${label}\n`)
        assert.equal(existsSync(`${base}/session-${label}/cross-session.txt`), false)
      }
      report.modules = [...ctx.loader.internal.loadCache.keys()].filter(url => /\/packages\/core\/(tools|agent-loop)\//.test(url))
      assert.ok(report.modules.some(url => url.endsWith('/src/index.ts')))
      assert.equal(report.modules.some(url => url.includes('/lib/')), false)
      assert.deepEqual(report.errors, [])
      report.status = 'passed'
    } catch (error) { report.status = 'failed'; report.errors.push(error.stack ?? String(error)); console.error(error) }
    finally {
      writeFileSync(`${process.env.DSH_SANDBOX_PROBE_STATE}/report.json`, JSON.stringify(report, null, 2) + '\n')
      exit(report.status === 'passed' ? 0 : 1)
    }
  }
  ctx.effect(() => ready.onReady(() => { void run() }), 'sandbox integration verification')
}
