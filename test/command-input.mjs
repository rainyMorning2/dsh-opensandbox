import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { OpenSandboxSubprocess } from '../src/subprocess.mjs'

test('large stdin is uploaded privately, kept out of command argv and removed before completion', async t => {
  const ctx = new Context(), events = [], contents = new Map()
  let rejectUpload = false, origin
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers['x-execd-access-token'], 'synthetic-execd-token')
      const url = new URL(req.url, origin)
      if (url.pathname === '/files/upload') {
        if (rejectUpload) { req.resume(); res.writeHead(400); res.end(); return }
        const request = new Request(origin + req.url, { method: 'POST', headers: req.headers, body: Readable.toWeb(req), duplex: 'half' })
        const form = await request.formData(), metadata = JSON.parse(await form.get('metadata').text())
        assert.equal(metadata.mode, 600)
        assert.match(metadata.path, /^\/tmp\/\.dsh-stdin-[a-f0-9]{48}$/)
        contents.set(metadata.path, await form.get('file').text()); events.push('upload')
        res.end(); return
      }
      if (url.pathname === '/files' && req.method === 'DELETE') {
        const existed = contents.delete(url.searchParams.get('path')); events.push('cleanup')
        res.writeHead(existed ? 200 : 404); res.end(); return
      }
      if (url.pathname === '/command') {
        const chunks=[]; for await(const chunk of req)chunks.push(chunk)
        const body=JSON.parse(Buffer.concat(chunks))
        assert.ok(body.command.length < 4096)
        assert.ok(body.command.includes([...contents.keys()][0]))
        assert.equal([...contents.values()][0], '合成'.repeat(100000)); events.push('command')
        res.writeHead(200, {'content-type':'text/event-stream'})
        for(const event of [{type:'init',text:'execution'}, {type:'stdout',text:'received'}, {type:'execution_complete'}])res.write('data: '+JSON.stringify(event)+'\n\n')
        res.end(); return
      }
      res.writeHead(404);res.end()
    } catch(error) { res.writeHead(500);res.end(error.message) }
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  origin=`http://127.0.0.1:${server.address().port}`
  const world=new OpenSandboxSubprocess(ctx,{domain:origin,workspaceRoot:'/tmp'})
  world.ensureSandboxFor=async()=>'synthetic-sandbox'
  world.client.execdBases.set('synthetic-sandbox',origin)
  world.client.execdTokens.set('synthetic-sandbox','synthetic-execd-token')
  t.after(async()=>{await world.close();await ctx.fiber.dispose();await new Promise(resolve=>server.close(resolve))})
  const spec={argv:['/bin/cat'],cwd:'/tmp',stdio:{stdin:{data:'合成'.repeat(100000)},stdout:{maxBytes:1024},stderr:{maxBytes:1024}}}
  const child=world.spawn(spec)
  assert.equal((await child.done).exitCode,0)
  assert.equal(child.collected.stdout.readFrom(0).text.trim(),'received')
  assert.deepEqual(events,['upload','command','cleanup'])
  assert.equal(contents.size,0)
  rejectUpload=true
  await assert.rejects(world.spawn(spec).done,/stdin upload failed/)
  assert.equal(events.filter(e=>e==='command').length,1)
})
