#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
SOURCE_REPO_ROOT = Path(
    os.environ.get("CLAB_WORKLOAD_REPO", "/Users/steve/clab-trade")
).resolve()
SOURCE_DEPLOY_ROOT = SOURCE_REPO_ROOT / "k8s-deploy"
DEFAULT_OUTPUT = (
    ROOT / "workloads" / "clab-version" / "service-version-catalog-configmap.yaml"
)
K8S_STG_REPO_URL = "https://github.com/steve-8000/k8s-stg.git"
WORKLOAD_SOURCE_REPO_URL = "git@github.com:steve-8000/clab-trade.git"
WORKLOAD_SOURCE_PATH = "k8s-deploy/*"


def run_git(*args: str, cwd: Path, check: bool = True) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )
    if check and result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "git command failed")
    return result.stdout.strip()


def metadata_value(path: Path, prefix: str) -> str:
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith(prefix):
            return line.split(":", 1)[1].strip()
    raise ValueError(f"Could not find '{prefix}' in {path}")


def split_artifact_version(value: str) -> tuple[str, str]:
    if "@" in value:
        artifact, version = value.split("@", 1)
        return artifact, version
    last_segment = value.rsplit("/", 1)[-1]
    if ":" in last_segment:
        artifact, version = value.rsplit(":", 1)
        return artifact, version
    return value, ""


def last_commit_for_path(repo_root: Path, path: Path) -> str:
    return run_git(
        "log",
        "-1",
        "--format=%H",
        "--",
        str(path.relative_to(repo_root)),
        cwd=repo_root,
    )


def repo_is_dirty(repo_root: Path, scope: str | None = None) -> bool:
    args = ["status", "--porcelain"]
    if scope is not None:
        args.extend(["--", scope])
    status = run_git(
        *args,
        cwd=repo_root,
        check=False,
    )
    return bool(status)


def parse_workload_manifest(path: Path) -> dict[str, Any]:
    kind = ""
    name = ""
    namespace = ""
    image = ""
    in_metadata = False

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if raw_line.startswith("kind: "):
            kind = raw_line.split(":", 1)[1].strip()
            continue
        if raw_line == "metadata:":
            in_metadata = True
            continue
        if in_metadata and raw_line and not raw_line.startswith("  "):
            in_metadata = False
        if in_metadata:
            if raw_line.startswith("  name: ") and not name:
                name = raw_line.split(":", 1)[1].strip()
                continue
            if raw_line.startswith("  namespace: ") and not namespace:
                namespace = raw_line.split(":", 1)[1].strip()
                continue
        stripped = raw_line.strip()
        if stripped.startswith("image: ") and not image:
            image = stripped.split(":", 1)[1].strip()

    if not all([kind, name, namespace, image]):
        raise ValueError(f"Incomplete workload manifest parsing for {path}")

    artifact, version = split_artifact_version(image)
    return {
        "name": name,
        "namespace": namespace,
        "kind": kind,
        "deployType": "image",
        "artifact": artifact,
        "version": version,
        "sourcePath": str(path.relative_to(SOURCE_REPO_ROOT)),
        "gitCommit": last_commit_for_path(SOURCE_REPO_ROOT, path),
    }


def parse_chart_version(chart_path: Path) -> tuple[str, str]:
    dependency_name = ""
    dependency_version = ""
    in_dependencies = False

    for raw_line in chart_path.read_text(encoding="utf-8").splitlines():
        if raw_line == "dependencies:":
            in_dependencies = True
            continue
        if (
            in_dependencies
            and raw_line.startswith("  - name: ")
            and not dependency_name
        ):
            dependency_name = raw_line.split(":", 1)[1].strip()
            continue
        if (
            in_dependencies
            and raw_line.startswith("    version: ")
            and not dependency_version
        ):
            dependency_version = raw_line.split(":", 1)[1].strip()
            break

    if not dependency_name:
        dependency_name = metadata_value(chart_path, "name")
    return dependency_name, dependency_version


def parse_application_manifest(path: Path) -> dict[str, str]:
    name = ""
    namespace = ""
    source_path = ""
    in_metadata = False
    in_source = False
    in_destination = False

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if raw_line == "metadata:":
            in_metadata = True
            in_source = False
            in_destination = False
            continue
        if raw_line == "spec:":
            in_metadata = False
            continue
        if raw_line.startswith("  source:"):
            in_source = True
            in_destination = False
            continue
        if raw_line.startswith("  destination:"):
            in_destination = True
            in_source = False
            continue

        if in_metadata and raw_line.startswith("  name: ") and not name:
            name = raw_line.split(":", 1)[1].strip()
            continue
        if in_source and raw_line.startswith("    path: ") and not source_path:
            source_path = raw_line.split(":", 1)[1].strip()
            continue
        if in_destination and raw_line.startswith("    namespace: ") and not namespace:
            namespace = raw_line.split(":", 1)[1].strip()
            continue

    if not all([name, namespace, source_path]):
        raise ValueError(f"Incomplete application manifest parsing for {path}")

    return {
        "name": name,
        "namespace": namespace,
        "sourcePath": source_path,
    }


def collect_workloads() -> list[dict[str, Any]]:
    manifests = sorted(SOURCE_DEPLOY_ROOT.glob("*/*-deployment.yaml"))
    manifests.extend(sorted(SOURCE_DEPLOY_ROOT.glob("*/*-statefulset.yaml")))
    return sorted(
        (parse_workload_manifest(path) for path in manifests),
        key=lambda item: (item["namespace"], item["name"]),
    )


def collect_argocd_apps() -> list[dict[str, Any]]:
    applications: list[dict[str, Any]] = []
    for app_manifest in sorted((ROOT / "argocd-config").glob("*.yaml")):
        if app_manifest.name in {
            "clab-version.yaml",
            "platform-project.yaml",
            "workloads-project.yaml",
            "workloads-appset.yaml",
        }:
            continue
        if metadata_value(app_manifest, "kind") != "Application":
            continue
        app = parse_application_manifest(app_manifest)
        source_dir = ROOT / app["sourcePath"]
        chart_path = source_dir / "Chart.yaml"
        if chart_path.exists():
            artifact, version = parse_chart_version(chart_path)
            tracked_path = chart_path
            deploy_type = "helm"
        else:
            artifact = app["name"]
            version = ""
            tracked_path = source_dir
            deploy_type = "kustomize"
        applications.append(
            {
                "name": app["name"],
                "namespace": app["namespace"],
                "kind": "Application",
                "deployType": deploy_type,
                "artifact": artifact,
                "version": version,
                "sourcePath": app["sourcePath"],
                "gitCommit": last_commit_for_path(ROOT, tracked_path),
            }
        )
    return sorted(applications, key=lambda item: (item["namespace"], item["name"]))


def render_block(name: str, value: Any) -> str:
    serialized = json.dumps(value, indent=2, sort_keys=False)
    lines = [f"  {name}: |"]
    lines.extend(f"    {line}" for line in serialized.splitlines())
    return "\n".join(lines)


def render_configmap() -> str:
    workloads = collect_workloads()
    argocd_apps = collect_argocd_apps()
    summary = {
        "catalogRepo": {
            "path": str(ROOT),
            "branch": run_git("branch", "--show-current", cwd=ROOT),
            "headCommit": run_git("rev-parse", "HEAD", cwd=ROOT),
        },
        "workloadSource": {
            "path": str(SOURCE_REPO_ROOT),
            "branch": run_git("branch", "--show-current", cwd=SOURCE_REPO_ROOT),
            "headCommit": run_git("rev-parse", "HEAD", cwd=SOURCE_REPO_ROOT),
        },
        "gitops": {
            "rootRepo": K8S_STG_REPO_URL,
            "rootPath": "argocd-config",
            "workloadSourceRepo": WORKLOAD_SOURCE_REPO_URL,
            "workloadSourcePath": WORKLOAD_SOURCE_PATH,
        },
        "counts": {
            "workloads": len(workloads),
            "argocdApplications": len(argocd_apps),
        },
    }
    manifest = [
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        "  name: service-version-catalog",
        "  namespace: clab-version",
        "  labels:",
        "    app.kubernetes.io/name: service-version-catalog",
        "    app.kubernetes.io/part-of: clab-version",
        "    app.kubernetes.io/managed-by: sync-service-versions",
        "data:",
        render_block("summary.json", summary),
        render_block("workloads.json", workloads),
        render_block("argocd-apps.json", argocd_apps),
        "",
    ]
    return "\n".join(manifest)


def ensure_source_repo_clean() -> None:
    if repo_is_dirty(SOURCE_REPO_ROOT, "k8s-deploy"):
        raise RuntimeError(
            f"Workload source repo has uncommitted changes under {SOURCE_DEPLOY_ROOT}"
        )


def cmd_render(output: Path | None) -> int:
    if output is not None:
        ensure_source_repo_clean()
    rendered = render_configmap()
    if output is None:
        sys.stdout.write(rendered)
        return 0
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered, encoding="utf-8")
    return 0


def cmd_check(output: Path) -> int:
    try:
        ensure_source_repo_clean()
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    rendered = render_configmap()
    if not output.exists():
        print(f"Missing generated manifest: {output}", file=sys.stderr)
        return 1
    current = output.read_text(encoding="utf-8")
    if current != rendered:
        print(f"Out of sync: {output}", file=sys.stderr)
        return 1
    print(f"In sync: {output}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build and sync the service version catalog ConfigMap."
    )
    parser.add_argument(
        "command",
        choices=["render", "sync", "check"],
        help="render prints to stdout, sync writes the manifest, check verifies the manifest is up to date",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"Output path for sync/check (default: {DEFAULT_OUTPUT.relative_to(ROOT)})",
    )
    args = parser.parse_args()

    try:
        if args.command == "render":
            return cmd_render(None)
        if args.command == "sync":
            return cmd_render(args.output)
        return cmd_check(args.output)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
