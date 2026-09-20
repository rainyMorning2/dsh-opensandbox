# @codebam/dsh-opensandbox

Run the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) execution world inside
[OpenSandbox](https://github.com/opensandbox-group/OpenSandbox) containers.

The plugin registers three dsh services:

| Service | Replacement | Effect |
| --- | --- | --- |
| `ctx.subprocess` | `@deepseek-ai/dsh-subprocess-local` | Commands and PTY shells run through OpenSandbox execd. |
| `ctx.sandbox` | `@deepseek-ai/dsh-sandbox-local` | Reports the container world's confinement facts to dsh's stock sandbox-aware consumers. |
| `ctx.fs` | `@deepseek-ai/dsh-fs-sandbox` | Host filesystem backend fenced by the same mount table: file tools read and write only under the configured sandbox mounts, plus explicit harness read paths. |

The package is itself a dsh profile bundle (`dsh.bundle.patch` points at its `cordis.patch.yml`),
so the Web Plugins page can install it and switch the whole world on and off; the bundle layer
disables the three rows above that it replaces. See [Install](#install).

Because `ctx.subprocess` is the shared execution seam, these existing dsh plugins keep working
over the container world without code changes:

- `@deepseek-ai/dsh-bash-sandbox` — the model-facing `bash` tool
- `@deepseek-ai/dsh-terminal-bash` — persistent PTY sessions (`bash`)
- `@deepseek-ai/dsh-tool-fs-search` — `grep`/`glob` run inside the sandbox
- dsh's permission/escalation flow and `sandbox:policy` context

The session's immutable workspace is bind-mounted into the sandbox at the same absolute path, so
the container and `ctx.fs` see the same files. This is the key difference from a single-project
plugin: dsh web sessions can open any project directory under a configured `workspaceParents`
root, and each session gets its own sandbox mounted with that exact workspace root. The
configured `workspaceRoot` remains the fallback for calls without a session cwd.

The filesystem backend is host-side, but the plugin fences it with the session workspace and the
same mount table the container uses: a model-facing `read`, `write`, or `edit` cannot resolve a
path outside the session workspace, the configured mounts, or the narrow `trustedReadPaths` list
(used for harness-owned reads such as user skills and `~/.dsh/AGENTS.md`). Context-free harness
discovery may read under `workspaceParents` (minus `protectedPaths`); it cannot turn one of those
directories into a bind mount. Command execution is still the kernel boundary; the filesystem
fence is the policy boundary that keeps the model's file tools from escaping the session
workspace and mount table.

## Requirements

- Node.js >= 20 (dsh bundles a newer Node).
- A reachable OpenSandbox lifecycle server with the Docker runtime.
- The OpenSandbox server must allow-list the host paths you mount. In its TOML:

  ```toml
  [storage]
  allowed_host_paths = ["/home/your-user", "/persistent", "/tmp", "/nix/store"]
  ```

- The sandbox image must contain `/bin/sh` and a `sleep` that accepts `infinity`
  (`debian:*`, `ubuntu:*`, `python:*` and similar images do).

### Known limitations

- The filesystem fence is a trusted-code policy check over model-controlled paths, not a kernel
  boundary. The container remains the kernel boundary for untrusted code (prompt-injected agents,
  generated programs, shells). Use the mount table and host-side configuration for defence in
  depth, not as a replacement for container isolation.
- `spawnTerminal` needs a WebSocket to execd, so this plugin asks the lifecycle
  API for each sandbox's **direct** published endpoint (the official SDK default,
  `use_server_proxy=false`) instead of routing through the server's own proxy.
  That is deliberate: in the stock server image the API-proxy WebSocket route
  never completes its handshake to the sandbox and then crashes while reporting
  that failure on a `websockets` API mismatch. A deployment where the client
  cannot reach the sandbox's published port directly is not supported.
- Confinement inside the container is the container itself: `confine()` reports `partial`
  enforcement for confined modes because read-only/workspace-only semantics are not re-expressed
  per command. The `ctx.fs` fence applies the mount table to file-tool targets instead.
- Mounted host paths must be allow-listed by the server
  (`[storage] allowed_host_paths`); a command cwd outside the session workspace and mount table
  fails before any sandbox is created rather than falling back to the host.
- `workspaceParents` deliberately grants context-free harness reads (and the ability to open a
  dsh session) under those roots. Keep the list narrow, and put credential trees in
  `protectedPaths`. A session workspace that contains a protected path is refused.
- `extraWritableMounts` and `/directory-add <path> rw` are host-operator grants. The workspace is
  read-write by default; every other path is read-only unless a human explicitly says otherwise.
- dsh's `danger-full-access` escalation cannot widen the mount table. It can lift dsh's session
  policy, but a read-only mount stays read-only and a path outside the table stays denied.
- Dynamic mounts are in-memory per dsh process and never persist. A restart returns to the
  reviewed profile configuration; put durable grants in the profile.

## Install

The package declares a dsh profile bundle (`dsh.bundle.patch`), so it can be installed and
switched from the Web sidebar's **Plugins** page:

```bash
dsh plugin --profile dsh-tui add @codebam/dsh-opensandbox
```

The same install is **Add plugin** on the Plugins page, where the spec may be the package name,
a version range, or the absolute path of this checkout. The installed bundle gets the page's
on/off switch, and the bundle's own page gets the `opensandbox-world` row switch. The bundle
layer disables the `subprocess`, `sandbox`, and `fs-sandbox` rows itself, so switching the
bundle off restores dsh's built-in execution world with no second edit. Use the bundle switch,
not the `opensandbox-world` row switch, for that transition: the row switch unmounts only the
plugin and leaves the layer's built-in providers disabled. Enablement is stored in
the profile: the bundle list in its `package.json` and `disabled` overrides in its
`cordis.patch.yml`. A profile whose files are deployment-managed (Nix, home-manager, a
read-only profile tree) can still carry the plugin patch by hand; the page then shows
`opensandbox-world` in its read-only inventory but has no bundle row to switch. Do not mix the
two forms in one profile: a second `insert` of `opensandbox-world`, or a row whose `name` differs
from `@codebam/dsh-opensandbox`, leaves the composed tree with a duplicate or mismatched row that
the Plugins page will not switch.

A hand-managed profile installs the package with npm instead:

```bash
npm install @codebam/dsh-opensandbox
```

dsh provides the `@deepseek-ai/*` peer packages at runtime, so they are marked optional and are
not fetched from npm by this package.

## Configure dsh

Connection, image, and mount-table values are host facts, so the bundled layer inserts the row
without configuration. With the bundle installed, put the deployment's values in the profile's
own `cordis.patch.yml`, which is applied after every bundle layer; the id-targeted override below
wins over the row the bundle inserted:

```yaml
- id: opensandbox-world
  config:
    # Connection (or set OPEN_SANDBOX_API_KEY / OPEN_SANDBOX_DOMAIN in dsh's environment).
    apiKeyFile: /run/user/1000/opensandbox/api-key
    domain: 127.0.0.1:8090

    # Sandbox image and workspace.
    image: docker.io/library/debian:bookworm-slim
    workspaceRoot: /home/your-user/project

    # Host directories that are part of the reviewed boundary. Use
    # extraWritableMounts only when the agent must write there; it is a
    # host-operator-only grant.
    extraReadOnlyMounts:
      - /nix/store
    extraWritableMounts: []

    # Harness-owned host reads (user skills, ~/.dsh/AGENTS.md). Keep this
    # list narrow: every entry is reachable by the model-facing read tool.
    trustedReadPaths:
      - /home/your-user/.dsh/AGENTS.md
      - /home/your-user/.dsh/skills

    # dsh web sessions may open any project under these roots; each
    # session still binds only its own workspace root into its sandbox.
    workspaceParents:
      - /home/your-user/Documents/git

    # Credential/control trees ctx.fs must not read and the server guard
    # must not allow mounting a parent of.
    protectedPaths:
      - /home/your-user/.ssh
      - /home/your-user/.gnupg
      - /home/your-user/.dsh
      - /home/your-user/.config/gh
      - /home/your-user/.config/sops

    # Limits and lifetime.
    timeoutSeconds: 43200
    cpu: "4"
    memory: 8Gi
```

### Hand-managed profile

A profile that does not install the bundle performs the row swap in `cordis.patch.yml` itself.
Disable the two local providers and the host-fs backend, then insert the row and copy the fields
from the `config:` mapping above under the inserted row:

```yaml
- id: subprocess
  disabled: true

- id: sandbox
  disabled: true

# The shipped fs backend fences writes but leaves reads unconfined.
- id: fs-sandbox
  disabled: true

- insert:
    - id: opensandbox-world
      name: '@codebam/dsh-opensandbox'
      config:
        # … the config mapping shown above
```

Relative `name` values resolve from dsh's profile `node_modules`, where
`npm install @codebam/dsh-opensandbox` places the package. An absolute path to `index.mjs`
also works, but a path-named row is outside the bundle inventory and stays read-only in the
Plugins page.

### Deployment-managed profiles

A Nix or home-manager deployment can keep owning the profile's `cordis.patch.yml` and still use
the bundle: install the package once with `dsh plugin --profile <name> add ...` (or list it in the
profile's `package.json` dependencies and `dsh.profile.bundles`), remove the hand-written row swap
from the managed patch, and keep only id-targeted overrides there for host configuration and
environment-conditional enablement. The bundle selection then lives in `package.json`, while the
managed patch still wins for `config` and can preserve a per-process escape hatch. A row switch
on the bundle's page also records its `disabled` override in that patch, so a deployment that
rewrites the file reasserts its own default on the next activation; the bundle switch itself
lives in `package.json`. A Nix package of this plugin must install `cordis.patch.yml` next to
`index.mjs`; the npm `files` list is the contract for what ships.

```yaml
- id: subprocess
  disabled: !!js "!process.env.DSH_NO_OPENSANDBOX"

- id: sandbox
  disabled: !!js "!process.env.DSH_NO_OPENSANDBOX"

- id: fs-sandbox
  disabled: !!js "!process.env.DSH_NO_OPENSANDBOX"

- id: opensandbox-world
  disabled: !!js "Boolean(process.env.DSH_NO_OPENSANDBOX)"
  config:
    # … the config mapping shown above
```

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `OPEN_SANDBOX_API_KEY` | Lifecycle/execd API key. |
| `apiKeyFile` | `OPEN_SANDBOX_API_KEY_FILE` | File holding the API key; read at startup. |
| `domain` | `OPEN_SANDBOX_DOMAIN` or `localhost:8080` | Lifecycle host, optionally with port. |
| `protocol` | `OPEN_SANDBOX_PROTOCOL` or `http` | `http` or `https`. |
| `image` | `docker.io/library/debian:bookworm-slim` | Sandbox image URI. Pin a digest in production. |
| `workspaceRoot` | `process.cwd()` | Host directory mounted read-write at the same path. |
| `extraReadOnlyMounts` | `["/nix/store"]` | Extra host dirs mounted read-only at the same path. An empty list means this default, because the loader materializes an absent optional array as `[]`. |
| `extraWritableMounts` | `[]` | Host dirs mounted read-write at the same path. Host-operator-only: never source this from model output or an untrusted file. |
| `trustedReadPaths` | `[]` | Host paths `ctx.fs` may read for harness-owned features (skills, user instructions) without mounting them into the container and without allowing writes. |
| `workspaceParents` | `[]` | Host directories under which a dsh session may open a project (for example a code root). They authorise a session workspace but are never bind-mounted themselves, so a sibling project cannot become a model `workdir` mount. |
| `protectedPaths` | `[]` | Host credential/control trees that must stay hidden from `ctx.fs` unless a trusted read path explicitly covers them. The OpenSandbox server guard should name the same paths to reject bind mounts of their parents. |
| `allowDynamicMounts` | `true` | Offer the human `/directory-add`, `/directory-remove`, and `/directory-list` commands. The added mounts live only in this dsh process. |
| `provideFilesystem` | `true` | Mount the plugin's mount-fenced `ctx.fs`. Set `false` only if another trusted provider supplies `ctx.fs`; the shipped `dsh-fs-sandbox` leaves reads unconfined. |
| `timeoutSeconds` | `43200` | Sandbox TTL; the server minimum is 60. The cached sandbox is revalidated before each command, so a server-reaped sandbox is replaced instead of leaving commands on a dead endpoint. |
| `requestTimeoutMs` | `300000` | Lifecycle HTTP timeout. |
| `sandboxWaitMs` | `180000` | Max wait for a new sandbox to report `Running`. |
| `commandTimeoutMs` | `0` (disabled) | Optional execd-side per-command timeout. |
| `cpu` / `memory` | `"4"` / `"8Gi"` | Container resource limits. |
| `home` | `/root` | Container `HOME`. |
| `env` | `{}` | Extra environment variables for every sandbox command. Wins over `forwardEnv`. |
| `forwardEnv` | `[]` | Host environment variable names to forward into the sandbox (`GH_TOKEN`, `SSH_AUTH_SOCK`). Unset names are skipped, not blanked. |

## What runs where

- One sandbox is created lazily per session workspace (or configured mount root) and revalidated against the lifecycle server before a command uses it. If the server reaped it at its TTL, the plugin creates a replacement instead of reusing the dead endpoint.
- A session workspace must be under `workspaceRoot`/`workspaceParents`, must not contain a `protectedPaths` entry, and must not overlap a configured mount. The model may choose a `workdir` only inside that session workspace or a configured mount; sibling directories under a workspace parent are rejected as bind roots.
- Setup, cleanup, and usage are recorded in the sandbox metadata (`codebam.dsh.workspace`).
- The container `PATH` is the host `PATH` restricted to directories a mount makes visible, plus
  `/run/current-system/sw/bin`, `/etc/profiles/per-user/$USER/bin` and `~/.nix-profile/bin` when
  they exist. That fallback matters because a dsh started by a systemd user unit inherits systemd's
  minimal `PATH`, which carries no `/nix/store` entries at all.
- `danger-full-access` still runs in the OpenSandbox world; the plugin never falls back to host
  execution.
- Confined modes report `enforcement: "partial"`, because the container bounds host file effects
  but does not re-express workspace-only/read-only semantics inside the container. The `ctx.fs`
  fence applies the mount table to the model's file tools instead.
- A read-only store means `nix build` cannot add paths from inside the sandbox. Host builds,
  signed commits, and pushes are separate grants, not defaults.

### Scoping another directory at runtime

`/directory-add <absolute-host-path> [ro|rw]` is a human slash command, not a model tool: the
command registry runs it directly in the interactive UI and never sends it to the model. It mounts
an existing host directory at the same absolute path inside the sandbox, read-only by default;
`rw` is an explicit read-write grant. Existing sandboxes are recycled, so the next command starts
from the new boundary. A path that is already visible through a configured mount is rejected
instead of being nested or shadowed.

`/directory-list` prints the effective mount table and `/directory-remove <path>` removes a
runtime-added mount. Mounts added this way are in-memory only: they disappear when dsh exits, so a
restart returns to the profile's reviewed configuration.

### Builds, credentials, and the daemon socket

Those capabilities are not enabled by default. If you grant them, you are widening the sandbox
boundary to include the host Nix daemon and/or host credentials:

- **Builds** need `/etc/nix` and `/nix/var/nix/daemon-socket` mounted read-only. The container's
  `nix` then talks to the host daemon, which owns the store and builds unsandboxed from the
  agent's point of view; treat that as granting host build authority.
- **Commits and pushes** need git/GPG config, agent sockets, and forwarded tokens. A read-only GPG
  homedir cannot sign by itself; any wrapper that makes signing work is also handing the agent the
  ability to sign. Forward `GH_TOKEN` only if `gh` should act as you.

Prefer an explicit human-launched elevated session (or `/directory-add` on exact directories) over
making any of these grants the default for ordinary agent sessions.

## Publishing

```bash
npm run check
npm pack --dry-run
npm publish --access public
```

The package name is scoped and `publishConfig.access` is `public`, so the explicit flag is only a
reminder.

## Development

```bash
npm install
npm run check
```

There is no build step: the published files are the same ESM files dsh loads.

`npm test` runs the mount-policy/filesystem fence tests, asserts the profile-bundle manifest and
`cordis.patch.yml` through dsh's own overlay parser, and runs a mock E2E over an in-process fake
OpenSandbox server (it asserts the execd request schema, SSE framing, metadata labels, mount
modes, and PTY frames). The tests import dsh runtime modules, which npm cannot fetch, so point
the checkout at any dsh install's modules first:

```bash
ln -sfn "$DSH_HOME/profiles/node_modules" node_modules   # DSH_HOME defaults to ~/.dsh
npm test
```

## License

MIT

OpenSandbox and DeepSeek Harness are separate projects with their own licenses. This plugin talks
to OpenSandbox over its HTTP/WebSocket APIs and mounts the dsh capability seams provided by the
harness.
