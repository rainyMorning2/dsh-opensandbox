# Local source DSH with OpenSandbox

This launcher uses the sibling `deepseek-harness` source checkout, a local OpenSandbox server, and the existing DSH profile when `--home` is supplied. It does not launch an npm-installed DSH binary.

## Setup

Use the DSH `feat/workspace-access-policy` branch and Node 24.9 or newer. Install and build that source checkout with `pnpm install --frozen-lockfile` and `pnpm run build`. OpenSandbox must be listening on port 4080 with a nonempty `server.api_key` in `~/.sandbox.toml`; its host-path allowlist must admit the configured Workspace roots. The launcher reads the key internally and never places it in generated patches.

The working image is built from the Dockerfile in this directory:

```sh
docker build -t dsh-opensandbox-dev:local dev/local-sandbox
```

`opensandbox/execd:v1.1.0` is the server's execution daemon image. It remains separate from the working image above.

## Start Web

From the plugin checkout:

```sh
python3 dev/local-sandbox/launch.py web --home ~/.dsh
```

Open the authenticated URL printed by DSH. This preserves the existing profile's model settings. The launcher disables development context, host execution providers, and the unrestricted directory picker through a temporary overlay. It serves Web on port 4090 by default.

`workspace-access.json` is the static permission table:

```json
{
  "roots": ["/tmp/dsh-sandbox-demo/session-a"],
  "defaultWorkspace": "/tmp/dsh-sandbox-demo/session-a"
}
```

Roots must already exist and be directories. Root directories and descendants permit Open and New folder. Ancestors are navigation-only and display just authorized branches. Other paths, manual unauthorized submissions, and outward symlinks are refused by the backend. Add another root to grant another Workspace, then restart DSH. `defaultWorkspace` must be within a grant. Use `--access-config /path/to/grants.json` to select another table.

The host and container use the same absolute Workspace path. Each selected Workspace gets its own lazily allocated sandbox; Sessions sharing that Workspace reuse its sandbox and files. Choosing a child directory as a Workspace mounts only that child. Parent and child Workspaces share the child's underlying files because their host directories overlap.

Web mode creates the default demo directory when needed but adds no test files or symlinks. Files from earlier demo runs remain untouched. Previously mapped demo Sessions can retain `/workspace` in their working-directory event history; create a new Session for the same host Workspace when moving to same-path mounts.

## Verify

```sh
python3 dev/local-sandbox/launch.py verify
```

Verification uses an isolated DSH home, a scripted model, and real containers. It prepares two test directories, sibling symlinks, and a fallback directory under `/tmp/dsh-sandbox-demo`, then checks file reads and writes, command execution, search, PTY, Session resume, and sibling/link/fallback denials. It prints a report path and returns a nonzero status on failure. No model API key is needed. Do not point `--workspaces` at production data.

```sh
npm run check
npm test
```

These run plugin syntax checks and local tests, including static grants and same-path mount isolation.

## Scope

The static table grants directories to this deployment context. It does not implement login, tenant-owned Session lists, history authorization, plugin administration restrictions, or upload routing. Container-wide GUI file browsing is not provided: the picker selects authorized host-backed Workspaces. The Web terminal's complete controller flow needs separate verification; the execution provider's PTY is covered by the real-container probe.
