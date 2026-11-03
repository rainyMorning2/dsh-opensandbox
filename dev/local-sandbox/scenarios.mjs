export const artifact = `dsh-created-${process.env.DSH_SANDBOX_PROBE_RUN}.txt`
export const base = process.env.DSH_SANDBOX_WORKSPACES ?? '/tmp/dsh-sandbox-demo'
export function scenario(label) {
  const host = `${base}/session-${label}`
  const own = host
  const other = `${base}/session-${label === 'a' ? 'b' : 'a'}`
  return [
    { name: 'working_directory', arguments: {}, error: false, contains: own },
    { name: 'write', arguments: { file_path: `${own}/${artifact}`, content: `created-by-${label}\n` }, error: false },
    { name: 'read', arguments: { file_path: `${own}/${artifact}` }, error: false, contains: `created-by-${label}` },
    { name: 'edit', arguments: { file_path: `${own}/${artifact}`, old_string: `created-by-${label}`, new_string: `edited-by-${label}` }, error: false },
    { name: 'bash', arguments: { command: `test -f /.dockerenv && test "$PWD" = '${own}' && test ! -e '${other}/private.txt' && test ! -e '${base}/bootstrap/private.txt' && cat '${own}/${artifact}' && echo CONTAINER_ISOLATED_${label}`, description: 'Check container execution and session mounts' }, error: false, contains: `CONTAINER_ISOLATED_${label}` },
    { name: 'read', arguments: { file_path: `${other}/private.txt` }, error: true },
    { name: 'read', arguments: { file_path: `${own}/../session-${label === 'a' ? 'b' : 'a'}/private.txt` }, error: true },
    { name: 'read', arguments: { file_path: `${own}/other-session-link/private.txt` }, error: true, contains: `${own}/other-session-link/private.txt` },
    { name: 'write', arguments: { file_path: `${other}/cross-session.txt`, content: 'must not be written' }, error: true },
    { name: 'bash', arguments: { command: 'pwd', workdir: other, description: 'Check sibling workdir is refused' }, error: true },
    { name: 'read', arguments: { file_path: `${base}/bootstrap/private.txt` }, error: true },
    { name: 'working_directory', arguments: { cd: `${own}/nested` }, error: false },
    { name: 'read', arguments: { file_path: `../${artifact}` }, error: false, contains: `edited-by-${label}` },
    { name: 'bash', arguments: { command: 'pwd', workdir: '..', description: 'Return to the Session root for one command' }, error: false, contains: own },
    { name: 'working_directory', arguments: { cd: other }, error: true },
    { name: 'working_directory', arguments: { cd: '..' }, error: false },
    { name: 'glob', arguments: { pattern: artifact, path: own }, error: false, contains: artifact },
    { name: 'grep', arguments: { pattern: `edited-by-${label}`, path: own }, error: false, contains: artifact },
    { name: 'read', arguments: { file_path: artifact }, error: false, contains: `edited-by-${label}` },
  ]
}
