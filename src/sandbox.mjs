import { POLICY_RUNNER } from './execution-policy.mjs'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'

/** Container boundary, with opt-in per-command Landlock policies for secure workloads. */
export class OpenSandboxSandboxProvider extends SandboxProvider {
  constructor(ctx, config = {}) {
    super(ctx)
    this.config = config
  }

  /** Return the world's argv unchanged; the container is the boundary. */
  async confine(argv, policy, signal) {
    signal?.throwIfAborted()
    const mode = policy?.mode ?? 'workspace-write'
    if (this.config.secureExecution) {
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) throw Error('Unsupported sandbox permission mode')
      const world = this.ctx.subprocess
      const sessionRoot = world.mountPolicy.assertMountableSessionRoot(world.sessionRootFor({ sandboxPolicy: policy }))
      const mapped = world.commandArgv(argv, sessionRoot)
      const dataRoot = world.mountPolicy.userDataRootFor(sessionRoot)
      const grant = mode === 'workspace-write' ? ['--rw', '/tmp', '--rw', sessionRoot, ...(dataRoot ? ['--rw', dataRoot] : [])] : []
      return {
        argv: mode === 'danger-full-access' ? mapped : [POLICY_RUNNER, '--ro', '/', '--rw', '/dev/null', ...grant, '--', ...mapped],
        enforcement: 'full', denialSignatures: ['permission denied'],
        runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ['landlock-run: '] }],
      }
    }
    return {
      argv: [...argv],
      enforcement: mode === 'danger-full-access' ? 'full' : 'partial',
      denialSignatures: [],
      runnerFailureRules: [],
    }
  }

  /** No provider-owned resources beyond the subprocess world. */
  async close() {}
}
