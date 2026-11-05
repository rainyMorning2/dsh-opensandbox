#!/usr/bin/env python3
"""Fresh single-process users profile over the pinned sibling source harness."""
import argparse, json, os, subprocess
from pathlib import Path

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--users', type=Path, required=True)
p.add_argument('--home', type=Path, required=True)
p.add_argument('--origin', required=True)
p.add_argument('--port', type=int, default=4091)
p.add_argument('--host', default='127.0.0.1')
p.add_argument('--sandbox-domain', default='127.0.0.1:4080')
p.add_argument('--image', default='dsh-opensandbox-dev:local')
p.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[3] / 'deepseek-harness')
p.add_argument('--patch', type=Path, action='append', default=[])
p.add_argument('--write-patch-only', action='store_true')
a = p.parse_args()
plugin = Path(__file__).resolve().parents[2]
home = a.home.resolve()
home.mkdir(parents=True, exist_ok=True, mode=0o700)
fallback = home / 'sandbox-bootstrap'
fallback.mkdir(exist_ok=True, mode=0o700)
users = json.loads(a.users.read_text())
roots = [root for user in users['users'] if user.get('enabled', True) for root in user.get('workspaceRoots', [user['defaultWorkspace']])]
rg = subprocess.check_output(['node', '-e', 'const {createRequire}=require("module");const r=createRequire(process.cwd()+"/packages/fs/tool-fs-search/package.json");process.stdout.write(r("@vscode/ripgrep").rgPath)'], cwd=a.repo, text=True)
# Keep the native Workspace browser module paired with the restricted host controller.
workspace_adapter = home / 'workspace-controller-adapter'
workspace_adapter.mkdir(exist_ok=True)
workspace_package = a.repo.resolve() / 'packages/api/workspace-controller'
workspace_manifest = json.loads((workspace_package / 'package.json').read_text())
(workspace_adapter / 'package.json').write_text(json.dumps({
    'name': workspace_manifest['name'], 'type': 'module',
    'exports': {'.': './index.mjs', './client': './client.js', './package.json': './package.json'},
    'dsh': workspace_manifest['dsh'],
}))
(workspace_adapter / 'index.mjs').write_text('export { default } from ' + json.dumps((plugin / 'dev/users/workspace-controller.mjs').as_uri()) + ';\n')
workspace_client = workspace_adapter / 'client.js'
if workspace_client.is_symlink():
    workspace_client.unlink()
workspace_client.symlink_to(workspace_package / 'lib/client.js')
disabled = ['subprocess', 'sandbox', 'fs-sandbox', 'settings-controller', 'workspace-controller', 'agent-default-model', 'harness-dev-context', 'directory-picker', 'directory-picker-browse',
    'tool-plugin-manager', 'tool-jobs', 'ui-plugin-manager', 'ui-cordis', 'ui-permission', 'ui-agent-preset',
    'ui-settings-account', 'ui-settings-general', 'ui-settings-models', 'ui-settings-plugin-inventory',
    'ui-settings-session-log', 'ui-settings-plugins', 'ui-settings-shell', 'ui-settings-agent-loop',
    'ui-settings-subagent', 'ui-settings-web-search', 'ui-jobs', 'ui-schedule', 'preset-cordis', 'preset-ptc', 'preset-minimal', 'cordis-client-runner']
patch = [{'id': name, 'disabled': True} for name in disabled]
standard = json.loads(subprocess.check_output(['node', str(plugin / 'dev/users/standard-preset.mjs'), str(a.repo.resolve())], text=True))
patch += [{'id': 'preset-standard', 'config': standard},
          {'id': 'terminal-controller', 'config': {'shell': {'path': '/bin/bash', 'name': 'bash', 'args': ['-i']}, 'shellCandidates': ['/bin/bash', '/bin/sh']}}]
patch += [
    {'id': 'connection', 'config': {'browserAuthentication': 'provider', 'trustedHosts': [__import__('urllib.parse', fromlist=['urlparse']).urlparse(a.origin).netloc]}},
    {'id': 'approval', 'config': {'policy': 'never'}},
    {'id': 'permission', 'config': {'defaultPreset': 'workspace-write', 'presets': {'workspace-write': {'sandbox': 'workspace-write', 'approval': 'never'}}}},
    {'insert': [
        {'id': 'deployment-default-model', 'name': str(plugin / 'dev/users/default-model.mjs'), 'config': {
            'provider': os.environ.get('DSH_MODEL_PROVIDER') or 'deepseek-official',
            'model': os.environ.get('DSH_MODEL') or 'deepseek-flash',
            'reasoningEffort': os.environ.get('DSH_REASONING_EFFORT') or 'max',
        }},
        {'id': 'deployment-workspace-controller', 'name': str(workspace_adapter / 'index.mjs')},
        {'id': 'deployment-user-ui', 'name': str(plugin / 'dev/users/ui/index.mjs')},
        {'id': 'ui-directory-picker-browse', 'name': '@deepseek-ai/dsh-client-ui-directory-picker-browse'},
        {'id': 'opensandbox-world', 'name': str(plugin / 'index.mjs'), 'config': {
            'domain': a.sandbox_domain, 'image': a.image,
            'workspaceRoot': str(fallback), 'workspaceParents': roots,
            'sessionWorkspaceOnly': True, 'allowDynamicMounts': False,
            'protectedPaths': [str(home), str(a.users.resolve())],
            'timeoutSeconds': 43200, 'cpu': '1', 'memory': '1Gi',
            'executableMappings': {rg: '/usr/bin/rg'},
        }},
        {'id': 'deployment-users', 'name': str(plugin / 'user-access.mjs'), 'config': {
            'configFile': str(a.users.resolve()), 'sessionDatabase': str(home / 'user-auth/logins.sqlite'),
            'publicOrigin': a.origin,
        }},
    ]},
]
patch_path = home / 'users.patch.yml'
patch_path.write_text(json.dumps(patch, indent=2)+'\n')
patch_path.chmod(0o600)
if a.write_patch_only:
    print(patch_path)
else:
    env = dict(os.environ, DSH_HOME=str(home), DSH_TELEMETRY_DISABLED='1')
    extra_patches = [arg for path in a.patch for arg in ('--patch', str(path.resolve()))]
    os.chdir(a.repo)
    os.execvpe('pnpm', ['pnpm', 'dsh', '--profile', 'web', *extra_patches, '--patch', str(patch_path),
        '--host', a.host, '--port', str(a.port), '--public-url', a.origin+'/', '--no-open'], env)
