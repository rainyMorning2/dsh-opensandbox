import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, lstatSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { digest } from './accounts.mjs'

/** Persistent opaque login sessions; only token digests reach disk. */
export class LoginSessions {
  constructor(path, accounts, { lifetimeSeconds = 86400, maxSessions = 1000 } = {}) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw Error('Login database must not be a symlink')
    this.accounts = accounts
    this.lifetimeSeconds = lifetimeSeconds
    this.maxSessions = maxSessions
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec('CREATE TABLE IF NOT EXISTS logins (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, revision TEXT NOT NULL, expires_at INTEGER NOT NULL)')
  }
  issue(user, now = Date.now()) {
    this.db.prepare('DELETE FROM logins WHERE expires_at <= ?').run(now)
    if (this.db.prepare('SELECT count(*) AS n FROM logins').get().n >= this.maxSessions) throw Error('Login capacity reached')
    const token = randomBytes(32).toString('base64url')
    const expiresAt = now + this.lifetimeSeconds * 1000
    this.db.prepare('INSERT INTO logins VALUES (?, ?, ?, ?)').run(digest(token), user.id, user.revision, expiresAt)
    return { token, expiresAt }
  }
  read(token, now = Date.now()) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) return undefined
    const entry = this.db.prepare('SELECT * FROM logins WHERE token = ?').get(digest(token))
    const user = this.accounts.users.get(entry?.user_id)
    return entry && entry.expires_at > now && user?.enabled && user.revision === entry.revision
      ? { user, expiresAt: entry.expires_at, key: digest(token) } : undefined
  }
  revoke(token) { if (typeof token === 'string') this.db.prepare('DELETE FROM logins WHERE token = ?').run(digest(token)) }
  close() { this.db.close() }
}
