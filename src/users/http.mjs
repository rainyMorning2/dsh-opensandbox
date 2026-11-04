import { verifyPassword, digest } from './accounts.mjs'

const cookieName = 'dsh-user-session'
export function readCookie(request) {
  const raw = request.headers instanceof Headers ? request.headers.get('cookie') : request.headers.cookie
  if (typeof raw !== 'string') return undefined
  const values = raw.split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`))
  return values.length === 1 ? values[0].slice(cookieName.length + 1) : undefined
}
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>登录工作区</title><body><main><h1>登录工作区</h1><form action="/auth/login" method="post"><p><label>用户名 <input name="username" autocomplete="username" required maxlength="128"></label></p><p><label>密码 <input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label></p><button>登录</button></form></main></body></html>`
const logoutPage = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>退出登录</title><form action="/auth/logout" method="post"><button>退出登录</button></form></html>'
const response = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin',
    'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", ...headers })
  res.end(body)
}

export class UserLogin {
  constructor(accounts, sessions, connection, { publicOrigin, maxFailures = 5, retrySeconds = 60, maxPending = 4 }) {
    this.accounts = accounts
    this.sessions = sessions
    this.connection = connection
    this.origin = new URL(publicOrigin)
    if (this.origin.origin !== publicOrigin || (this.origin.protocol !== 'https:' && (this.origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(this.origin.hostname)))) throw Error('publicOrigin must be an HTTPS origin (HTTP only on loopback)')
    this.secure = this.origin.protocol === 'https:'
    this.maxFailures = maxFailures
    this.retrySeconds = retrySeconds
    this.maxPending = maxPending
    this.pending = 0
    this.attempts = new Map()
    this.peers = new Map()
    this.closed = false
    this.inflight = new Set()
  }
  authenticate(request) {
    if (this.closed) return undefined
    const entry = this.sessions.read(readCookie(request))
    if (!entry) return undefined
    let peer = this.peers.get(entry.key)?.peer
    if (!peer) {
      peer = this.connection.createPeer({ principal: { kind: 'deployment-user', userId: entry.user.id }, interactions: 'answer' })
      this.peers.set(entry.key, { peer, expiresAt: entry.expiresAt })
    }
    return peer
  }
  unauthorized(_request, res) { response(res, 303, '', { location: '/auth/login' }) }
  cookie(token, expiresAt) {
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}${this.secure ? '; Secure' : ''}`
  }
  async sweep() {
    for (const [key, entry] of this.peers) {
      if (entry.expiresAt <= Date.now()) { this.peers.delete(key); await entry.peer.dispose() }
    }
  }
  handle(req, res) {
    const operation = this.run(req, res).catch(() => {
      if (!res.headersSent) response(res, 503, '登录服务暂不可用')
      else res.end()
    })
    this.inflight.add(operation)
    operation.finally(() => this.inflight.delete(operation))
    return operation
  }
  async run(req, res) {
    if (this.closed) return response(res, 503, '登录服务暂不可用')
    if (req.headers.host !== this.origin.host || req.headers['sec-fetch-site'] === 'cross-site') return response(res, 403, '拒绝访问')
    const path = new URL(req.url, this.origin).pathname
    if (!['/auth/login', '/auth/logout'].includes(path)) return response(res, 404, '未找到')
    if (req.method === 'GET') {
      if (path === '/auth/login' && this.authenticate(req)) return response(res, 303, '', { location: '/' })
      return response(res, 200, path === '/auth/login' ? page : logoutPage)
    }
    if (req.method !== 'POST') return response(res, 405, '不支持的请求', { allow: 'GET, POST' })
    if (req.headers.origin !== this.origin.origin) return response(res, 403, '拒绝访问')
    if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') return response(res, 415, '不支持的表单格式')
    if (path === '/auth/logout') {
      const token = readCookie(req)
      this.sessions.revoke(token)
      const key = token ? digest(token) : ''
      const peer = this.peers.get(key)?.peer
      this.peers.delete(key)
      await peer?.dispose()
      return response(res, 303, '', { location: '/auth/login', 'set-cookie': this.cookie('', 0), 'clear-site-data': '"cache", "storage"' })
    }
    if (this.pending >= this.maxPending) return response(res, 429, '请稍后重试', { 'retry-after': String(this.retrySeconds) })
    this.pending++
    const timeout = setTimeout(() => req.destroy(), 10000)
    try {
      let body = ''
      for await (const chunk of req) {
        body += chunk.toString('utf8')
        if (Buffer.byteLength(body) > 8192) return response(res, 413, '表单过大')
      }
      const params = new URLSearchParams(body)
      const user = this.accounts.names.get(params.get('username'))
      const key = user?.id ?? '<unknown>'
      const previous = this.attempts.get(key)
      const now = Date.now()
      const attempt = previous && previous.until > now ? previous : { failures: 0, until: now + this.retrySeconds * 1000 }
      this.attempts.set(key, attempt)
      if (attempt.failures >= this.maxFailures) return response(res, 429, '请稍后重试', { 'retry-after': String(this.retrySeconds) })
      attempt.failures++
      // Unknown accounts perform the same password derivation, without revealing account existence.
      const hash = user?.passwordHash ?? this.accounts.users.values().next().value.passwordHash
      const valid = await verifyPassword(params.get('password'), hash)
      if (this.closed) return response(res, 503, '登录服务暂不可用')
      if (!valid || !user?.enabled || params.getAll('username').length !== 1 || params.getAll('password').length !== 1) return response(res, 401, '用户名或密码错误。<a href="/auth/login">重新登录</a>')
      this.attempts.delete(key)
      const old = readCookie(req)
      const oldPeer = old ? this.peers.get(digest(old))?.peer : undefined
      this.sessions.revoke(old)
      if (old) this.peers.delete(digest(old))
      await oldPeer?.dispose()
      const { token, expiresAt } = this.sessions.issue(user)
      return response(res, 303, '', { location: '/', 'set-cookie': this.cookie(token, expiresAt), 'clear-site-data': '"cache", "storage"' })
    } finally { clearTimeout(timeout); this.pending-- }
  }
  async close() {
    this.closed = true
    await Promise.all(this.inflight)
    await Promise.all([...this.peers.values()].map(entry => entry.peer.dispose()))
    this.peers.clear()
  }
}
