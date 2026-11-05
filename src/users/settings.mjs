import { SettingsController } from '@deepseek-ai/dsh-api-settings-controller'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

const displayNamespaces = new Set(['ui-theme', 'locale', 'ui-settings', 'ui-conversation', 'ui-sidebar', 'ui-layout', 'ui-settings-general', 'ui-settings-session-log'])

/** Read-only display defaults; deployment configuration and credentials stay private. */
export class UserDisplaySettings extends SettingsController {
  constructor(ctx, { accounts }) { super(ctx); this.accounts = accounts }
  describe() {
    const principal = this.ctx.invocation?.peer.principal
    const user = principal?.kind === 'deployment-user' ? this.accounts.users.get(principal.userId) : undefined
    if (!user?.enabled) throw new RemoteError('settings/rejected', 'An authenticated deployment user is required', { ns: '' })
    return { writable: false, hasDocument: false,
      namespaces: super.describe().namespaces.filter(row => displayNamespaces.has(row.ns)) }
  }
}
