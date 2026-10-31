#!/usr/bin/env python3
"""Read-only preservation check; reads only named plugin state and baseline paths.

Usage: python3 scripts/probes/verify-planning-data-preservation.py BEFORE INSTALL
       [--entity-baseline FILE] [--task-entity-baseline FILE] [--test-manifest FILE ...]
Prints JSON to stdout. Does not write live data or inspect conversation contents.
"""
import argparse
import hashlib
import json
from pathlib import Path


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    # This is the exact algorithm used by preservation-before.json.
    return digest(json.dumps(value, sort_keys=True, ensure_ascii=False).encode())


def read_bytes(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Expected a regular non-symlink evidence file: {path.name}")
    return path.read_bytes()


def read_json(path):
    return json.loads(read_bytes(path))


def safe_path(root, relative):
    part = Path(relative)
    if part.is_absolute() or ".." in part.parts:
        raise ValueError("Baseline contains an unsafe relative path")
    if part.parts[0] not in {"library.json", "editor-state.json", "runs", "history", "planning", "creation-budgets"}:
        raise ValueError("Baseline path is outside the allowed plugin state")
    path = root / part
    for parent in [path, *path.parents]:
        if parent == root.parent:
            break
        if parent.is_symlink():
            raise ValueError("Evidence path traverses a symbolic link")
    return path


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("before")
parser.add_argument("installation")
parser.add_argument("--entity-baseline")
parser.add_argument("--task-entity-baseline")
parser.add_argument("--test-manifest", action="append", default=[])
args = parser.parse_args()
before, installation = read_json(args.before), read_json(args.installation)
root = Path(before["stateDirectory"])
if not root.is_absolute() or root.is_symlink():
    raise ValueError("Invalid plugin state directory")
allowed_workflows, allowed_sessions = set(), set()
for file in args.test_manifest:
    manifest = read_json(file)
    if manifest["stateDirectory"] != str(root):
        raise ValueError("Test manifest belongs to another state directory")
    allowed_workflows.update(manifest["workflowIds"])
    allowed_sessions.update(s["id"] for s in manifest["sessions"] if s["role"] == "root")

library = read_json(root / "library.json")
by_id = {flow["id"]: flow for flow in library["workflows"]}
if len(by_id) != len(library["workflows"]):
    raise ValueError("Duplicate workflow identity")
workflow_checks = {key: {"exists": key in by_id, "unchanged": key in by_id and canonical(by_id[key]) == expected}
                   for key, expected in before["workflowHashes"].items()}
file_checks = {}
for relative, expected in before["files"].items():
    path = safe_path(root, relative)
    exists = path.exists()
    file_checks[relative] = {"exists": exists, "unchanged": exists and digest(read_bytes(path)) == expected}
history = {key: value for key, value in file_checks.items() if key.startswith(("runs/", "history/"))}
budget_files = {key: value for key, value in file_checks.items() if key.startswith("creation-budgets/")}
profile = Path(installation["target"]).parent.parent
config_checks = {}
for name in ["cordis.yml", "cordis.patch.yml"]:
    expected = installation.get("profile", {}).get(name)
    config_checks[name] = {"baselineRecorded": expected is not None,
                          "unchanged": expected is not None and digest(read_bytes(profile / name)) == expected}

editor_file = root / "editor-state.json"
editor = read_json(editor_file) if editor_file.exists() else {"proposals": [], "drafts": []}
entity = read_json(args.entity_baseline) if args.entity_baseline else None
editor_checks = None
if entity:
    if entity.get("sourceFileSha256") != before["files"].get("editor-state.json"):
        raise ValueError("Entity baseline is not linked to the captured editor file hash")
    if entity.get("algorithm") != "python-json-sort_keys-true-ensure_ascii-false-default-separators":
        raise ValueError("Entity canonical algorithm differs")
    editor_checks = {}
    for group in ["proposals", "drafts", "planningReceipts"]:
        key_name = "key" if group == "planningReceipts" else "id"
        current = {item[key_name]: item for item in editor.get(group, [])}
        editor_checks[group] = {key: {"exists": key in current, "unchanged": key in current and canonical(current[key]) == expected}
                                for key, expected in entity.get("hashes", {}).get(group, {}).items()}

def classify(items, id_key="id", prior=None):
    prior = set(prior or [])
    values = [item for item in items if item[id_key] not in prior]
    synthetic = [item[id_key] for item in values if item.get("workflowId", item.get("id")) in allowed_workflows]
    return {"count": len(values), "allowlistedSyntheticIds": synthetic,
            "unattributedIds": [item[id_key] for item in values if item[id_key] not in synthetic]}

new_flows = classify(library["workflows"], prior=before["workflowHashes"])
editor_additions = {group: classify(editor.get(group, []), "key" if group == "planningReceipts" else "id",
                                   (entity or {}).get("hashes", {}).get(group, {}))
                    for group in ["proposals", "drafts", "planningReceipts"]} if entity else None
tasks_file = root / "planning/tasks.json"
tasks = read_json(tasks_file).get("tasks", []) if tasks_file.exists() else []
task_entity = read_json(args.task_entity_baseline) if args.task_entity_baseline else None
task_checks = None
if task_entity:
    if task_entity.get("stateDirectory") != str(root):
        raise ValueError("Task entity baseline belongs to another state directory")
    if task_entity.get("sourceFileSha256") != before["files"].get("planning/tasks.json"):
        raise ValueError("Task entity baseline is not linked to the captured task file hash")
    if task_entity.get("algorithm") != "python-json-sort_keys-true-ensure_ascii-false-default-separators":
        raise ValueError("Task entity canonical algorithm differs")
    current_tasks = {item["id"]: item for item in tasks}
    if len(current_tasks) != len(tasks):
        raise ValueError("Duplicate planning task identity")
    task_checks = {key: {"exists": key in current_tasks, "unchanged": key in current_tasks and canonical(current_tasks[key]) == expected}
                   for key, expected in task_entity.get("hashes", {}).get("tasks", {}).items()}
task_counts = {"total": len(tasks), "allowlistedSynthetic": sum(t.get("sessionId") in allowed_sessions for t in tasks)}
editor_preserved = (all(value["unchanged"] for group in editor_checks.values() for value in group.values()) if editor_checks is not None
                    else file_checks.get("editor-state.json", {}).get("unchanged", False))
checks = {
    "originalWorkflowsUnchanged": all(value["unchanged"] for value in workflow_checks.values()),
    "presetsUnchanged": canonical(library["presets"]) == before["presetHash"],
    "originalRunAndHistoryFilesUnchanged": all(value["unchanged"] for value in history.values()),
    "originalEditorEntitiesUnchanged": editor_preserved,
    "cordisConfigurationUnchanged": all(value["unchanged"] for value in config_checks.values()),
}
if task_checks is not None:
    checks["originalPlanningTaskEntitiesUnchanged"] = all(value["unchanged"] for value in task_checks.values())
    checks["originalBudgetFilesUnchanged"] = all(value["unchanged"] for value in budget_files.values())
print(json.dumps({"algorithm": "python-json-sort_keys-true-ensure_ascii-false-default-separators",
                  "baselineSha256": digest(read_bytes(args.before)), "checks": checks,
                  "allCapturedOriginalDataPreserved": all(checks.values()),
                  "originalWorkflowCount": len(workflow_checks), "workflows": workflow_checks,
                  "presets": {"unchanged": checks["presetsUnchanged"]},
                  "originalRunAndHistoryFileCount": len(history), "runAndHistoryFiles": history,
                  "originalBudgetFileCount": len(budget_files), "budgetFiles": budget_files,
                  "aggregateFiles": {key: value for key, value in file_checks.items() if key in {"library.json", "editor-state.json", "planning/tasks.json"}},
                  "editorEntities": editor_checks, "planningTaskEntities": task_checks, "cordis": config_checks,
                  "additions": {"workflows": new_flows, "editor": editor_additions, "planningTaskCounts": task_counts},
                  "limitations": (["规划任务原实体摘要未在安装前采集，不能证明未知旧任务未变。"] if task_checks is None else []) + [
                                  "仅校验基线列出的预算文件；未记录的旧预算不推断为已验证。",
                                  "新增实体仅按显式测试 manifest 标记，不检查或读取任何对话消息或凭据。"]}, ensure_ascii=False, indent=2))
if not all(checks.values()):
    raise SystemExit(1)
