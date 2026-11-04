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
disabled = ['subprocess', 'sandbox', 'fs-sandbox', 'harness-dev-context', 'directory-picker', 'directory-picker-browse',
    'tool-plugin-manager', 'tool-jobs', 'ui-plugin-manager', 'ui-cordis', 'ui-permission', 'ui-agent-preset',
    'ui-settings-account', 'ui-settings-general', 'ui-settings-models', 'ui-settings-plugin-inventory',
    'ui-settings-session-log', 'ui-settings-plugins', 'ui-settings-shell', 'ui-settings-agent-loop',
    'ui-settings-subagent', 'ui-settings-web-search', 'ui-jobs', 'ui-schedule', 'preset-cordis', 'preset-ptc', 'preset-minimal', 'cordis-client-runner']
patch = [{'id': name, 'disabled': True} for name in disabled]
standard = json.loads(subprocess.check_output(['node', str(plugin / 'dev/users/standard-preset.mjs'), str(a.repo.resolve())], text=True))
patch += [{'id': 'preset-standard', 'config': standard}]
patch += [
    {'id': 'connection', 'config': {'browserAuthentication': 'provider', 'trustedHosts': [__import__('urllib.parse', fromlist=['urlparse']).urlparse(a.origin).netloc]}},
    {'id': 'approval', 'config': {'policy': 'never'}},
    {'id': 'permission', 'config': {'defaultPreset': 'workspace-write', 'presets': {'workspace-write': {'sandbox': 'workspace-write', 'approval': 'never'}}}},
    {'insert': [
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
    os.chdir(a.repo)
    os.execvpe('pnpm', ['pnpm', 'dsh', '--profile', 'web', '--patch', str(patch_path),
        '--host', a.host, '--port', str(a.port), '--public-url', a.origin+'/', '--no-open'], env)
