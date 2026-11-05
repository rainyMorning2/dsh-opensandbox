import { shellJoin } from './util.mjs'

export const POLICY_RUNNER = '/opt/dsh-policy/landlock-run'

/** Keep credentials and loader overrides out of the privileged launch prefix. */
export function workloadCommand(argv, env, { secureExecution, workloadUid, workloadGid }) {
  if (!secureExecution) return shellJoin(argv)
  let guard = [], command = argv
  if (argv[0] === POLICY_RUNNER) {
    const separator = argv.indexOf('--')
    if (separator < 1 || separator === argv.length - 1) throw Error('Invalid sandbox policy invocation')
    guard = argv.slice(0, separator + 1)
    command = argv.slice(separator + 1)
  }
  return shellJoin([
    '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
    '/usr/bin/setpriv', `--reuid=${workloadUid}`, `--regid=${workloadGid}`, '--clear-groups',
    '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--',
    ...guard, '/usr/bin/env', '-i', '--', ...environmentEntries(env), ...command,
  ])
}

function environmentEntries(env) {
  return Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || String(value).includes('\0')) throw Error('Invalid workload environment entry')
    if (/^(EXECD_|OPENSANDBOX_|OPEN_SANDBOX_)/.test(key)) throw Error('Sandbox control environment cannot be passed to workloads')
    return `${key}=${String(value)}`
  })
}
