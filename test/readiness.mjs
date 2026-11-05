import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { OpenSandboxClient, commandOutputText } from '../src/client.mjs'

assert.equal(commandOutputText({ text: 'one' }), 'one\n')
assert.equal(commandOutputText({ text: 'one\n' }), 'one\n')
assert.equal(commandOutputText({ text: '' }), '\n')
assert.equal(commandOutputText({}), '')

let created = 0
const probes = new Map()
const deleted = new Set()
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.method === 'POST' && req.url === '/v1/sandboxes') {
    req.resume()
    res.end(JSON.stringify({ id: `probe${++created}` })); return
  }
  const sandbox = req.url.match(/^\/v1\/sandboxes\/(probe\d+)$/)
  if (sandbox && req.method === 'GET') { res.end(JSON.stringify({ status: { state: 'Running' } })); return }
  if (sandbox && req.method === 'DELETE') { deleted.add(sandbox[1]); res.statusCode = 204; res.end(); return }
  const endpoint = req.url.match(/^\/v1\/sandboxes\/(probe\d+)\/endpoints\/44772$/)
  if (endpoint) { res.end(JSON.stringify({ endpoint: `127.0.0.1:${server.address().port}/execd/${endpoint[1]}` })); return }
  const ping = req.url.match(/^\/execd\/(probe\d+)\/ping$/)
  if (ping) {
    const count = (probes.get(ping[1]) ?? 0) + 1
    probes.set(ping[1], count)
    assert.equal(req.headers['open-sandbox-api-key'], undefined)
    assert.equal(req.headers['x-execd-access-token'], 'sandbox-token')
    res.statusCode = ping[1] === 'probe2' ? 401 : ping[1] === 'probe3' || count < 3 ? 503 : 200
    res.end('{}'); return
  }
  res.statusCode = 404; res.end('{}')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const client = new OpenSandboxClient({ domain: `127.0.0.1:${server.address().port}`, apiKey: 'test-key', sandboxWaitMs: 3000 })
  const body = { env: { EXECD_ACCESS_TOKEN: 'sandbox-token' } }
  assert.equal(await client.createSandbox(body), 'probe1')
  assert.equal(probes.get('probe1'), 3)
  await assert.rejects(client.createSandbox(body), error => error.status === 401)
  assert.equal(probes.get('probe2'), 1)
  assert.equal(deleted.has('probe2'), true)
  client.sandboxWaitMs = 300
  await assert.rejects(client.createSandbox(body), error => error.name === 'TimeoutError')
  assert.equal(deleted.has('probe3'), true)
  await client.killSandbox('probe1')
  assert.equal(deleted.has('probe1'), true)
  assert.equal(client.execdTokens.size, 0)
  console.log('readiness ok')
} finally {
  server.closeAllConnections()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
