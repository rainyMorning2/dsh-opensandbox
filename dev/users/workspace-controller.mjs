import { WorkspaceController } from '@deepseek-ai/dsh-api-workspace-controller'

function filterFor(ctx, kind, action) {
  const principal = ctx.invocation?.peer.principal
  if (!principal) throw Error('Workspace mutation requires an authenticated invocation')
  const access = ctx.remoteAccess
  return ids => ids.filter(id => access.decide({ principal, action, resources: [{ kind, id }] }).kind === 'allow')
}

/** Return only admitted resources after changing a user's workspace metadata. */
export default class UserWorkspaceController extends WorkspaceController {
  async insertBefore(request) {
    const visible = filterFor(this.ctx, 'workspace', 'workspace/insertBefore')
    const value = await super.insertBefore(request)
    return { ...value, workspaceIds: visible(value.workspaceIds) }
  }
  async archiveSession(request) {
    const visible = filterFor(this.ctx, 'session', 'workspace/archiveSession')
    const value = await super.archiveSession(request)
    return { ...value, archivedSessionIds: visible(value.archivedSessionIds) }
  }
  async unarchiveSession(request) {
    const visible = filterFor(this.ctx, 'session', 'workspace/unarchiveSession')
    const value = await super.unarchiveSession(request)
    return { ...value, archivedSessionIds: visible(value.archivedSessionIds) }
  }
  async pinSession(request) {
    const visible = filterFor(this.ctx, 'session', 'workspace/pinSession')
    const value = await super.pinSession(request)
    return { ...value, pinnedSessionIds: visible(value.pinnedSessionIds) }
  }
  async unpinSession(request) {
    const visible = filterFor(this.ctx, 'session', 'workspace/unpinSession')
    const value = await super.unpinSession(request)
    return { ...value, pinnedSessionIds: visible(value.pinnedSessionIds) }
  }
}
