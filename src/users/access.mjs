const role = (resource, actions) => ({ name: `deployment-user:${resource}`, resource, actions })
export const globalRole = role('global', [
  'session/list', 'session/control', 'session/modelCatalog', 'session/canOpenWorkspacePath',
  'session/create', 'workspace/follow', 'workspace/create', 'workspace/initializeDefault',
  'directoryPicker/list', 'directoryPicker/createDirectory',
])
export const sessionRole = role('session', [
  'session/list', 'session/control', 'session/create', 'session/rename', 'session/prompt', 'session/cancel',
  'session/page', 'session/events', 'session/follow', 'session/state', 'session/observeEvent',
  'session/observeState', 'session/observeProjections', 'session/projections', 'session/wait',
  'workspace/follow', 'skills/list', 'toolResults/watch', 'goals/get',
  'workspaceFiles/list', 'workspaceFiles/stat', 'workspaceFiles/read', 'workspaceFiles/readBytes',
  'workspaceFiles/readAll', 'workspaceFiles/watch',
  'terminal/environment', 'terminal/shells', 'terminal/list', 'terminal/create', 'terminal/retain',
  'terminal/attach', 'terminal/rename', 'terminal/close',
  'event:api-session/activity', 'event:api-session/added', 'event:api-session/error',
  'event:api-session/removed', 'event:api-session/status',
])
export const workspaceRole = role('workspace', ['workspace/follow', 'session/create'])

/** Explicit allowlist: attachments, arbitrary commands, presets and administration stay denied. */
export class UserAccess {
  constructor(accounts, workspaces, headers) {
    this.accounts = accounts
    this.workspaces = workspaces
    this.headers = headers
  }
  bindings(principal) {
    const user = this.accounts.users.get(principal.userId)
    if (!user?.enabled) return []
    const condition = ({ action, args }) => {
      const request = args?.request
      if (action === 'session/create' && request) {
        if (request.agentPreset !== undefined && request.agentPreset !== 'standard') return { kind: 'deny', reason: 'preset-not-allowed' }
        if (request.cwd !== undefined && !this.accounts.allows(user, request.cwd)) return { kind: 'deny', reason: 'workspace-denied' }
      }
      if (action === 'workspace/create' && request && !this.accounts.allows(user, request.path)) return { kind: 'deny', reason: 'workspace-denied' }
      if (action === 'session/prompt' && request?.content?.some(part => part.type !== 'text')) return { kind: 'deny', reason: 'attachments-not-enabled' }
      return { kind: 'allow' }
    }
    const result = [{ role: globalRole, resource: { kind: 'global' }, condition }]
    for (const workspace of this.workspaces()) {
      if (this.accounts.allows(user, workspace.path)) result.push({ role: workspaceRole, resource: { kind: 'workspace', id: workspace.id }, condition })
    }
    for (const [id, header] of this.headers) {
      if (this.accounts.allows(user, header.cwd)) result.push({ role: sessionRole, resource: { kind: 'session', id }, condition })
    }
    return result
  }
}
