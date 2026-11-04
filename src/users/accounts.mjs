import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { realpathSync, statSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const derive = promisify(scrypt)
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
export const contains = (root, path) => {
  const rest = relative(root, path)
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`))
}
export const digest = value => createHash('sha256').update(value).digest('hex')
const hashPattern = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{64})$/

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw Error('Password must contain 12–1024 characters')
  const salt = randomBytes(16).toString('hex')
  const key = await derive(password, salt, 32, options)
  return `scrypt$${salt}$${key.toString('hex')}`
}
export async function verifyPassword(password, encoded) {
  const match = hashPattern.exec(encoded)
  if (!match || typeof password !== 'string' || password.length > 1024) return false
  const key = await derive(password, match[1], 32, options)
  return timingSafeEqual(key, Buffer.from(match[2], 'hex'))
}

export class Accounts {
  constructor(config, protectedPaths = []) {
    if (config?.version !== 1 || !Array.isArray(config.users) || !config.users.length || config.users.length > 100) throw Error('User config requires version 1 and 1–100 users')
    this.users = new Map()
    this.names = new Map()
    const claimed = []
    for (const entry of config.users) {
      if (!entry || typeof entry.id !== 'string' || typeof entry.username !== 'string' || typeof entry.passwordHash !== 'string' || (entry.enabled !== undefined && typeof entry.enabled !== 'boolean')) throw Error('Invalid user fields')
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(entry.id ?? '') || !/^[a-zA-Z0-9_.@-]{1,128}$/.test(entry.username ?? '')) throw Error('Invalid user id or username')
      if (this.users.has(entry.id) || this.names.has(entry.username)) throw Error('Duplicate user id or username')
      if (!hashPattern.test(entry.passwordHash ?? '')) throw Error('Invalid password hash')
      const roots = entry.workspaceRoots ?? [entry.defaultWorkspace]
      if (!Array.isArray(roots) || !roots.length || roots.length > 32) throw Error('Workspace roots are required')
      const canonical = roots.map(path => {
        if (typeof path !== 'string' || !isAbsolute(path)) throw Error('Workspace roots must be absolute')
        const real = realpathSync(path)
        if (!statSync(real).isDirectory() || real !== resolve(path)) throw Error('Workspace roots must be canonical existing directories')
        for (const protectedPath of protectedPaths) {
          if (contains(real, protectedPath) || contains(protectedPath, real)) throw Error('Workspace overlaps protected deployment data')
        }
        for (const previous of claimed) {
          if (contains(real, previous) || contains(previous, real)) throw Error('Workspace roots must not overlap')
        }
        claimed.push(real)
        return real
      })
      const defaultWorkspace = this.resolveFor({ roots: canonical }, entry.defaultWorkspace)
      const user = { id: entry.id, username: entry.username, passwordHash: entry.passwordHash,
        enabled: entry.enabled !== false, roots: canonical, defaultWorkspace }
      user.revision = digest(JSON.stringify(user))
      this.users.set(user.id, Object.freeze(user))
      this.names.set(user.username, user)
    }
  }
  static read(path, protectedPaths = []) {
    return new Accounts(JSON.parse(readFileSync(path, 'utf8')), [realpathSync(path), ...protectedPaths])
  }
  allows(user, path) {
    if (!user || typeof path !== 'string' || !isAbsolute(path)) return false
    const normalized = resolve(path)
    if (!user.roots.some(root => contains(root, normalized))) return false
    try { return user.roots.some(root => contains(root, realpathSync(path))) }
    catch { return false }
  }
  resolveFor(user, path) {
    if (!this.allows(user, path) || !statSync(realpathSync(path)).isDirectory()) throw Error('Workspace access denied')
    return realpathSync(path)
  }
  owner(path) {
    return [...this.users.values()].find(user => user.enabled && this.allows(user, path))
  }
  get roots() { return [...this.users.values()].filter(user => user.enabled).flatMap(user => user.roots) }
}
