import z from '@deepseek-ai/schemastery'
import { WorkspacePathPolicy, WorkspacePathDeniedError } from '@deepseek-ai/dsh-workspace'
import { dirname, resolve } from 'node:path'
import { Accounts, contains } from './src/users/accounts.mjs'
import { LoginSessions } from './src/users/sessions.mjs'
import { UserLogin } from './src/users/http.mjs'
import { UserAccess } from './src/users/access.mjs'
import { AuthorizedDirectoryPicker } from './workspace-access.mjs'
import { OpenSandboxSubprocess } from './src/subprocess.mjs'
import { OpenSandboxFileSystem } from './src/fs.mjs'

export const name = 'opensandbox-user-access'
export const inject = ['connection', 'remoteAccess', 'workspaceRegistry', 'sessionQuery', 'agents', 'webServer', 'subprocess', 'fs']
export const Config = z.object({
  configFile: z.string().required(),
  sessionDatabase: z.string().required(),
  publicOrigin: z.string().required(),
  lifetimeSeconds: z.natural().min(60).max(2592000).default(86400),
  maxSessions: z.natural().min(1).max(10000).default(1000),
  maxFailures: z.natural().min(1).default(5),
  retrySeconds: z.natural().min(1).default(60),
  maxPending: z.natural().min(1).max(16).default(4),
})

export class UserWorkspacePolicy extends WorkspacePathPolicy {
  constructor(ctx, accounts) { super(ctx); this.accounts = accounts }
  user() {
    const principal = this.ctx.invocation?.peer.principal
    if (principal !== undefined) {
      const user = principal.kind === 'deployment-user' ? this.accounts.users.get(principal.userId) : undefined
      if (!user?.enabled) throw new WorkspacePathDeniedError('')
      return user
    }
    const agent = this.ctx.get('agents')?.currentInitiator()
    if (agent === undefined) return undefined
    const user = this.accounts.owner(agent.session.header.cwd)
    if (!user) throw new WorkspacePathDeniedError(String(agent.session.header.cwd))
    return user
  }
  get roots() { const user = this.user(); return user ? user.roots : this.accounts.roots }
  allows(path) { return this.accounts.allows({ roots: this.roots }, path) }
  async resolve(path) {
    try { return this.accounts.resolveFor({ roots: this.roots }, path) }
    catch { throw new WorkspacePathDeniedError(String(path)) }
  }
  async defaultDirectory() {
    const user = this.user()
    if (!user) throw new WorkspacePathDeniedError('No authenticated user')
    return await this.resolve(user.defaultWorkspace)
  }
}

export function assertUserSandbox(ctx, accounts) {
  if (!(ctx.subprocess instanceof OpenSandboxSubprocess) || !(ctx.fs instanceof OpenSandboxFileSystem)) throw Error('User access requires OpenSandbox subprocess and filesystem providers')
  if (!ctx.subprocess.config.apiKey) throw Error('User sandboxes require an OpenSandbox API key')
  const policy = ctx.subprocess.mountPolicy
  if (ctx.fs.mountPolicy !== policy || policy.allowDynamic || !policy.sessionWorkspaceOnly) throw Error('User access requires a shared, session-only mount policy without dynamic grants')
  if ([...policy.mounts.values()].some(mount => mount.source !== 'workspace') || policy.trustedReadPaths.length) throw Error('User access does not permit shared mounts or trusted host reads')
  for (const root of policy.workspaceParents) {
    if (!accounts.roots.includes(root)) throw Error('Sandbox workspaceParents must be exact configured user roots')
  }
  for (const root of accounts.roots) {
    if (!policy.workspaceParents.includes(root)) throw Error('Sandbox is missing a user root')
    if (contains(root, policy.workspaceRoot) || contains(policy.workspaceRoot, root)) throw Error('Fallback workspace must be separate from user roots')
  }
  if (Object.keys(ctx.subprocess.config.containerEnv).some(key => !['PATH', 'HOME', 'TERM', 'LANG'].includes(key))) throw Error('User sandbox must not forward deployment environment')
}

export async function apply(ctx, config) {
  const protectedPaths = [resolve(dirname(config.sessionDatabase)), resolve(process.env.DSH_HOME ?? '.dsh')]
  const accounts = Accounts.read(config.configFile, protectedPaths)
  assertUserSandbox(ctx, accounts)
  await ctx.plugin(UserWorkspacePolicy, accounts).await()
  await ctx.plugin(AuthorizedDirectoryPicker, { maxEntries: 1000 }).await()
  const headers = new Map()
  const remember = header => {
    headers.set(header.id, header)
    ctx.remoteAccess.invalidate()
  }
  ctx.on('session/created', session => remember(session.header), { global: true })
  for (const record of await ctx.sessionQuery.listSessions()) remember(record.header)
  ctx.on('agent/created', ({ agent }) => {
    const owner = accounts.owner(agent.session.header.cwd)
    if (!owner) throw Error('Agent workspace is outside configured users')
    const parent = agent.session.header.parentSession
    if (parent && accounts.owner(headers.get(parent)?.cwd)?.id !== owner.id) throw Error('Child Agent cannot change user workspace')
    if (!(agent.ctx.get('subprocess') instanceof OpenSandboxSubprocess) || !(agent.ctx.get('fs') instanceof OpenSandboxFileSystem)) throw Error('User Agent cannot replace the sandbox providers')
    for (const tool of ['plugin_manager', 'plugin_market', 'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit', 'session_query']) {
      if (agent.ctx.get('tools')?.get(tool, agent)) throw Error(`User Agent cannot expose global tool: ${tool}`)
    }
    remember(agent.session.header)
  }, { global: true })
  const access = new UserAccess(accounts, () => ctx.workspaceRegistry.list(), headers)
  ctx.remoteAccess.registerPolicy('deployment-user', access)
  ctx.on('domain/changed', change => { if (change.domain === 'workspace') ctx.remoteAccess.invalidate() }, { global: true })
  const sessions = new LoginSessions(config.sessionDatabase, accounts, config)
  const login = new UserLogin(accounts, sessions, ctx.connection, config)
  const timer = setInterval(() => { login.sweep().catch(error => ctx.logger.error('Login expiry cleanup failed', error)) }, 1000)
  timer.unref()
  ctx.effect(() => async () => { clearInterval(timer); await login.close(); sessions.close() }, 'user login lifetime')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/auth', handler: (req, res) => login.handle(req, res) }), 'user login routes')
  ctx.connection.registerBrowserIdentity(login)
  ctx.effect(() => ctx.webServer.tapIndex(html => html.replace('</body>', '<a href="/auth/logout" style="position:fixed;right:16px;top:12px;z-index:10000;background:Canvas;color:CanvasText;padding:6px 10px;border:1px solid GrayText;border-radius:6px">退出登录</a></body>')), 'user logout link')
}
