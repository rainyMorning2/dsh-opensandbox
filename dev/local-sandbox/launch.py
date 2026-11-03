#!/usr/bin/env python3
"""Launch source DSH with local OpenSandbox, or verify two isolated Sessions."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import tomllib
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["verify", "web"])
    plugin = Path(__file__).resolve().parents[2]
    parser.add_argument("--repo", type=Path, default=plugin.parent / "deepseek-harness")
    parser.add_argument("--config", type=Path, default=Path.home() / ".sandbox.toml")
    parser.add_argument("--workspaces", type=Path, default=Path("/tmp/dsh-sandbox-demo"))
    parser.add_argument("--port", type=int, default=4090)
    parser.add_argument("--home", type=Path, help="Reuse this DSH home in Web mode; verification always uses an isolated home")
    parser.add_argument("--access-config", type=Path, default=plugin / "dev/local-sandbox/workspace-access.json", help="Static authorized Workspace roots for Web mode")
    args = parser.parse_args()
    repo = args.repo.resolve()
    if not (repo / "apps/cli/src/bin.ts").is_file():
        parser.error(f"DSH source checkout not found: {repo}")
    server_config = tomllib.loads(args.config.read_text())["server"]
    if not server_config.get("api_key"):
        parser.error("Set server.api_key in the OpenSandbox config first")
    root = args.workspaces.resolve()
    if args.mode == "verify":
        for label in ["a", "b"]:
            workspace = root / f"session-{label}"
            (workspace / "nested").mkdir(parents=True, exist_ok=True)
            private = workspace / "private.txt"
            if not private.exists():
                private.write_text(f"Session {label} private file\n")
            link = workspace / "other-session-link"
            target = root / f"session-{'b' if label == 'a' else 'a'}"
            if link.is_symlink():
                if link.resolve() != target:
                    parser.error(f"Unexpected test symlink: {link}")
            elif link.exists():
                parser.error(f"Test symlink path already exists: {link}")
            else:
                link.symlink_to(target, target_is_directory=True)
        fallback = root / "bootstrap"
        fallback.mkdir(exist_ok=True)
        private = fallback / "private.txt"
        if not private.exists():
            private.write_text("Fallback workspace must not be visible to ordinary Sessions\n")
    else:
        (root / "session-a").mkdir(parents=True, exist_ok=True)
        fallback = root / "bootstrap"
        fallback.mkdir(exist_ok=True)
    rg_path = subprocess.check_output([
        "node", "-e",
        'const {createRequire}=require("module"); const r=createRequire(process.cwd()+"/packages/fs/tool-fs-search/package.json"); console.log(r("@vscode/ripgrep").rgPath)',
    ], cwd=repo, text=True).strip()
    state = Path(tempfile.mkdtemp(prefix="dsh-source-opensandbox-"))
    home = state / "home" if args.mode == "verify" else (args.home.expanduser().resolve() if args.home else Path("/tmp/dsh-opensandbox-source-home"))
    env = os.environ.copy()
    env.update({
        "OPEN_SANDBOX_API_KEY": server_config["api_key"],
        "DSH_HOME": str(home),
        "DSH_AGENTS_HOME": str(home / "agents"),
        "DSH_TELEMETRY_DISABLED": "1",
        "DSH_TOOLS_MODE": "native",
        "DSH_SOURCE_REPO": str(repo),
        "DSH_SANDBOX_PROBE_RUN": uuid.uuid4().hex,
        "DSH_SANDBOX_PROBE_STATE": str(state),
        "DSH_SANDBOX_WORKSPACES": str(root),
    })
    # Both services run on this host; prevent a configured proxy from intercepting local API calls.
    for key in ["NO_PROXY", "no_proxy"]:
        env[key] = ",".join(filter(None, [env.get(key), "127.0.0.1", "localhost"]))
    plugin_config = {
        "domain": f"127.0.0.1:{server_config.get('port', 8080)}",
        "image": "dsh-opensandbox-dev:local",
        "workspaceRoot": str(fallback),
        "workspaceParents": [str(root)],
        "sessionWorkspaceOnly": True,
        "allowDynamicMounts": False,
        "timeoutSeconds": 900,
        "cpu": "1",
        "memory": "512Mi",
        "executableMappings": {rg_path: "/usr/bin/rg"},
    }
    patch = [{"id": name, "disabled": True} for name in ["subprocess", "sandbox", "fs-sandbox"]]
    if args.mode == "web":
        access_config = json.loads(args.access_config.read_text())
        plugin_config["workspaceParents"] = access_config["roots"]
        patch += [{"id": name, "disabled": True} for name in ["harness-dev-context", "directory-picker", "directory-picker-browse"]]
    inserts = [{"id": "opensandbox-world", "name": str(plugin / "index.mjs"), "config": plugin_config}]
    if args.mode == "web":
        inserts += [{"id": "workspace-access", "name": str(plugin / "workspace-access.mjs"), "config": access_config}]
    if args.mode == "verify":
        inserts.insert(0, {"id": "workspace-access", "name": str(plugin / "workspace-access.mjs"), "config": {"roots": [str(root / "session-a"), str(root / "session-b")], "defaultWorkspace": str(root / "session-a")}})
        patch += [{"id": name, "disabled": True} for name in ["headless-startup", "headless-runner", "llm-deepseek", "session-title-llm"]]
        patch += [
            {"id": "sandbox-policy", "inject": [], "config": {"mode": "workspace-write", "workspaceRoot": str(fallback)}},
            {"id": "agent-default-model", "config": {"provider": "sandbox-probe", "model": "sandbox-probe"}},
            {"id": "approval", "config": {"policy": "never"}},
            {"id": "permission", "config": {"defaultPreset": "workspace-write", "presets": {"workspace-write": {"sandbox": "workspace-write", "approval": "never"}}}},
        ]
        inserts += [{"id": f"sandbox-probe-{name}", "name": str(Path(__file__).with_name(f"{name}.mjs"))} for name in ["model", "driver"]]
    patch.append({"insert": inserts})
    patch_path = state / "opensandbox.patch.yml"
    patch_path.write_text(json.dumps(patch, indent=2) + "\n")
    command = ["pnpm", "dsh", "--profile", "headless" if args.mode == "verify" else "web", "--patch", str(patch_path)]
    if args.mode == "web":
        command[4:4] = ["--patch", str(repo / "apps/web/tests/pin-browse-picker.overlay.yml")]
        command += ["--port", str(args.port), "--no-open"]
    print(f"Source checkout: {repo}\nPlugin checkout: {plugin}\nDSH home: {home}\nRun state: {state}", flush=True)
    result = subprocess.run(command, cwd=repo, env=env)
    if args.mode == "verify":
        print(f"Verification report: {state / 'report.json'}", flush=True)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
