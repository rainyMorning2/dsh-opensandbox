/** Static Workspace grants and a directory picker restricted to those grants. */
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WorkspacePathPolicy, WorkspacePathDeniedError } from '@deepseek-ai/dsh-workspace'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import BrowseDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-browse'

const contains = (root, path) => {
  const rest = relative(root, path)
  return rest === '' || (rest !== '..' && !/^\.\.[\\/]/.test(rest) && !isAbsolute(rest))
}

/** One deployment-wide static grant table; login integration supplies a later provider. */
export class StaticWorkspacePolicy extends WorkspacePathPolicy {
  static Config = z.object({
    roots: z.array(z.string()).required(),
    defaultWorkspace: z.string().required(),
  })

  constructor(ctx, config) {
    super(ctx)
    this.config = config
    this.roots = []
    this.initial = undefined
  }

  async [Service.init]() {
    if (this.config.roots.length === 0) throw new Error('Workspace access requires at least one authorized root')
    for (const path of this.config.roots) {
      if (!isAbsolute(path)) throw new Error('Workspace roots must be absolute paths')
      const canonical = await realpath(path)
      if (!(await stat(canonical)).isDirectory()) throw new Error('Workspace root is not a directory')
      if (!this.roots.includes(canonical)) this.roots.push(canonical)
    }
    this.initial = await this.resolve(this.config.defaultWorkspace)
  }

  allows(path) {
    return this.roots.some(root => contains(root, path))
  }

  async resolve(path) {
    if (typeof path !== 'string' || !isAbsolute(path) || !this.allows(resolve(path))) throw new WorkspacePathDeniedError(String(path))
    const canonical = await realpath(path)
    if (!this.allows(canonical)) throw new WorkspacePathDeniedError(path)
    if (!(await stat(canonical)).isDirectory()) throw new Error('Workspace path is not a directory')
    return canonical
  }

  async defaultDirectory() {
    if (this.initial === undefined) throw new Error('Workspace policy is not ready')
    return await this.resolve(this.initial)
  }
}

const row = (path, selectable) => ({ name: basename(path) || path, path, hidden: basename(path).startsWith('.'), selectable })

/** Parent levels contain only grant branches; authorized levels expose their own directories. */
export class AuthorizedDirectoryPicker extends BrowseDirectoryPicker {
  static inject = ['workspacePathPolicy']
  static Config = z.object({ maxEntries: z.natural().min(1).default(1000) })

  constructor(ctx, config) {
    super(ctx, config)
    this.config = config
    this.hostBrowse = super.capability()
    this.browse = {
      kind: 'browse',
      list: (path, signal) => this.listAuthorized(path, signal),
      createDirectory: (path, name) => this.createAuthorized(path, name),
    }
  }

  capability() { return this.browse }

  async listAuthorized(path, signal) {
    const policy = this.ctx.workspacePathPolicy
    const target = path === undefined ? await policy.defaultDirectory() : resolve(path)
    try {
      signal?.throwIfAborted()
      if (path !== undefined && !isAbsolute(path)) throw new Error('An absolute directory path is required')
      const selectable = policy.allows(target)
      let entries
      let truncated = false
      let canonical = target
      if (selectable) {
        canonical = await policy.resolve(target)
        const listing = await this.hostBrowse.list(canonical, signal)
        const names = listing.entries
        truncated = listing.truncated
        entries = []
        for (const entry of names) {
          signal?.throwIfAborted()
          const candidate = join(canonical, entry.name)
          try {
            await policy.resolve(candidate)
          } catch (error) {
            if (!(error instanceof WorkspacePathDeniedError) && !['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(error.code)) throw error
            // Unavailable directories and links outside the grant are omitted.
            continue
          }
          entries.push(row(candidate, true))
        }
      } else {
        const branches = new Set()
        for (const root of policy.roots) {
          if (contains(target, root)) {
            const segment = relative(target, root).split(/[\\/]/)[0]
            if (segment) branches.add(join(target, segment))
          }
        }
        if (branches.size === 0) throw new Error('Directory is outside the authorized Workspace roots')
        entries = [...branches].map(branch => row(branch, policy.allows(branch)))
      }
      const crumbs = []
      let current = canonical
      for (;;) {
        crumbs.unshift({ ...row(current, policy.allows(current)), hidden: false })
        const parent = dirname(current)
        if (parent === current) break
        current = parent
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      return {
        path: canonical, home: await policy.defaultDirectory(), crumbs,
        entries: entries.slice(0, this.config.maxEntries),
        truncated: truncated || entries.length > this.config.maxEntries, selectable,
      }
    } catch (error) {
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', target, `Cannot browse directory: ${error.message}`)
    }
  }

  async createAuthorized(path, name) {
    try {
      if (!name.trim() || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new Error('A single folder name is required')
      const parent = await this.ctx.workspacePathPolicy.resolve(path)
      const child = join(parent, name)
      await this.hostBrowse.createDirectory(parent, name)
      return await this.ctx.workspacePathPolicy.resolve(child)
    } catch (error) {
      if (error instanceof DirectoryPickerError) throw error
      throw new DirectoryPickerError(error.code === 'EEXIST' ? 'directory-exists' : 'directory-create-failed', path,
        `Cannot create folder: ${error.message}`)
    }
  }
}

/** Mount the shared grant policy before the restricted browse backend. */
export async function apply(ctx, config) {
  await ctx.plugin(StaticWorkspacePolicy, config).await()
  await ctx.plugin(AuthorizedDirectoryPicker, { maxEntries: config.maxEntries ?? 1000 }).await()
  ctx.inject(['agents', 'workspacePathPolicy'], scoped => {
    scoped.on('agent/created', async ({ agent }) => {
      await scoped.workspacePathPolicy.resolve(agent.session.header.cwd)
    }, { global: true })
  })
}

export const Config = z.object({
  roots: z.array(z.string()).required(),
  defaultWorkspace: z.string().required(),
  maxEntries: z.natural().min(1).default(1000),
})
export default { name: 'opensandbox-workspace-access', Config, apply }
