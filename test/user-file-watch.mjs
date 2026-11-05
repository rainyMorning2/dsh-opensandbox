import WebSocket from 'ws'

/** Read a watch failure or one change after ready, then close the test connection. */
export async function fileWatch(origin, cookie, sessionId, path, onReady) {
  const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/api/remote.mux', { headers: { cookie, origin } })
  const closed = new Promise(resolve => socket.once('close', resolve))
  let timer
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('File watch did not produce its expected frame')), 15000)
      socket.once('error', reject)
      socket.once('close', () => reject(Error('File watch closed before its expected frame')))
      socket.once('open', () => socket.send(JSON.stringify({ type: 'open', streamId: 'file-watch', endpoint: 'workspaceFiles/changes', payload: { args: { workspaceFileScopeId: sessionId, path } } })))
      socket.on('message', data => {
        let frame
        try { frame = JSON.parse(String(data)) } catch (error) { reject(error); return }
        if (frame.streamId !== 'file-watch') return
        if (frame.type === 'error') { resolve(frame); return }
        if (frame.type === 'item' && frame.value?.kind === 'ready') {
          if (!onReady) { resolve(frame); return }
          Promise.resolve().then(onReady).catch(reject)
        }
        if (frame.type === 'item' && frame.value?.kind === 'change') resolve(frame)
      })
    })
  } finally {
    clearTimeout(timer)
    socket.terminate()
    await closed
  }
}
