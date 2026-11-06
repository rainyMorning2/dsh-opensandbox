import { Service } from '@deepseek-ai/cordis'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/** Deployment identity resolves filesystem scopes without exposing accounts to consumers. */
export class UserDataDirectories extends Service {
  constructor(ctx, accounts) { super(ctx, 'dataDirectories'); this.accounts = accounts }

  resolve(agent, { workspace }) {
    const cwd = agent?.session?.header?.cwd
    const owner = this.accounts.owner(cwd)
    const principal = this.ctx.get('invocation')?.peer.principal
    if (!owner?.dataRoot || (principal && (principal.kind !== 'deployment-user' || principal.userId !== owner.id))) throw Error('Data directory access denied')
    for (const path of [cwd, owner.dataRoot, ...owner.roots]) {
      if (realpathSync(path) !== resolve(path)) throw Error('Configured directory was redirected')
    }
    return {
      dataRoot: owner.dataRoot,
      workspace: this.accounts.resolveFor(owner, workspace),
      deliveryRoots: [...owner.roots],
      importRoots: [owner.dataRoot],
    }
  }
}
