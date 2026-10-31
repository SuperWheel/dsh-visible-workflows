#!/usr/bin/env python3
"""Read-only fixed-profile snapshot. Emits hashes/IDs/counts, never history bodies.

Writes only docs/evidence/planning-speed-20261019/desktop-install/ by default.
The live state root is fixed; symbolic links and non-regular state files fail closed.
"""
import hashlib
import json
import os
import stat
from datetime import datetime, timezone
from pathlib import Path

STATE = Path.home() / '.dsh/visible-dynamic-workflows'
REPO = Path(__file__).absolute().parents[2]
OUTPUT = REPO / 'docs/evidence/planning-speed-20261019/desktop-install'
ALGORITHM = 'python-json-sort_keys-true-ensure_ascii-false-default-separators'
FILES = ('library.json', 'editor-state.json')
DIRECTORIES = ('planning', 'runs', 'history', 'creation-budgets')
ACTIVE_PLANNING_STATES = {'queued', 'collecting', 'planning', 'distilling', 'authoring',
                          'validating', 'repairing', 'optimizing', 'regressing',
                          'awaiting_input', 'publishing', 'cancelling'}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return sha(json.dumps(value, sort_keys=True, ensure_ascii=False).encode())


def no_symlinks(path):
    path = Path(path).absolute()
    for item in [*reversed(path.parents), path]:
        if item.is_symlink():
            raise ValueError('Symbolic links are forbidden in preservation paths')
    return path


def read_regular(path):
    path = no_symlinks(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('Expected a regular state file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return stream.read()
    finally:
        os.close(fd)


def state_files(root):
    root = no_symlinks(root)
    if not root.is_dir():
        raise ValueError('State root must be an existing directory')
    result = []
    for name in FILES:
        path = root / name
        no_symlinks(path)
        if path.exists():
            if not path.is_file():
                raise ValueError('Named state file is not regular')
            result.append(path)
    for name in DIRECTORIES:
        directory = no_symlinks(root / name)
        if not directory.exists():
            continue
        if not directory.is_dir():
            raise ValueError('Named state directory is not a directory')
        for current, dirs, files in os.walk(directory, followlinks=False):
            for item in dirs + files:
                path = no_symlinks(Path(current) / item)
                if not path.is_dir() and not path.is_file():
                    raise ValueError('Unsupported state entry')
            result.extend(Path(current) / item for item in files)
    return sorted(result)


def entity_hashes(items, key='id'):
    result = {}
    for item in items:
        identity = item[key]
        if not isinstance(identity, str) or identity in result:
            raise ValueError('Invalid or duplicate entity identity')
        result[identity] = canonical(item)
    return result


def capture(root):
    paths = state_files(root)
    raw = {str(p.relative_to(root)): read_regular(p) for p in paths}
    library = json.loads(raw['library.json'])
    editor = json.loads(raw.get('editor-state.json', b'{}'))
    tasks = json.loads(raw.get('planning/tasks.json', b'{}')).get('tasks', [])
    before = {'stateDirectory': str(root), 'capturedAt': datetime.now(timezone.utc).isoformat(),
              'algorithm': ALGORITHM, 'workflowHashes': entity_hashes(library['workflows']),
              'presetHash': canonical(library.get('presets', [])),
              'presetHashes': entity_hashes(library.get('presets', [])),
              'libraryPlanningReceiptHashes': entity_hashes(library.get('planningReceipts', []), 'key'),
              'files': {name: sha(value) for name, value in raw.items()}}
    editor_entity = {'stateDirectory': str(root), 'sourceFileSha256': before['files'].get('editor-state.json'),
                     'algorithm': ALGORITHM, 'hashes': {name: entity_hashes(editor.get(name, []), 'key' if name == 'planningReceipts' else 'id')
                     for name in ['proposals', 'drafts', 'planningReceipts']}}
    task_entity = {'stateDirectory': str(root), 'sourceFileSha256': before['files'].get('planning/tasks.json'),
                   'algorithm': ALGORITHM, 'hashes': {'tasks': entity_hashes(tasks)}}
    runs = [json.loads(value) for name, value in raw.items() if name.startswith('runs/') and name.endswith('.json')]
    statuses = {s: sum(row.get('status') == s for row in runs) for s in sorted({str(row.get('status', 'unknown')) for row in runs})}
    summary = {'stateDirectory': str(root), 'capturedAt': before['capturedAt'], 'readOnly': True,
               'workflowIds': list(before['workflowHashes']), 'presetIds': list(before['presetHashes']),
               'counts': {'workflows': len(before['workflowHashes']), 'presets': len(before['presetHashes']),
                          'editor': {key: len(value) for key, value in editor_entity['hashes'].items()},
                          'planningTasks': len(tasks), 'files': len(raw),
                          **{key: sum(name.startswith(key + '/') for name in raw) for key in DIRECTORIES}},
               'runStatusCounts': statuses,
               'activeRunIds': [r['id'] for r in runs if r.get('status') in {'running', 'waiting', 'paused', 'pausing', 'budget_waiting', 'queued', 'starting', 'cancelling'}],
               'activePlanningTaskIds': [t['id'] for t in tasks if t.get('state') in ACTIVE_PLANNING_STATES],
               'planningActivityScope': 'Persisted tasks only; in-memory preview and native Agent activity require a separate live check',
               'filesIndexSha256': canonical(before['files']), 'historyBodiesExported': False,
               'credentialsIncluded': False, 'nonAtomic': True,
               'excluded': ['Credentials and all other root state files/directories', 'Graphon runtime installations', 'host.lock'],
               'authorization': 'Installation and synthetic acceptance already authorized in current session; check other tasks for actual conflict.'}
    # Detect a changing corpus, including new/deleted files, before writing any evidence.
    current = {str(p.relative_to(root)): sha(read_regular(p)) for p in state_files(root)}
    if current != before['files']:
        raise ValueError('State changed during snapshot; investigate and retake')
    summary['changedDuringRead'] = False
    return before, editor_entity, task_entity, summary


def main():
    no_symlinks(OUTPUT)
    result = capture(STATE)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, value in zip(['preservation-before.json', 'editor-entity-baseline.json', 'planning-task-entity-baseline.json', 'preservation-summary.json'], result):
        target = no_symlinks(OUTPUT / name)
        if target.exists():
            raise ValueError('Snapshot already exists; preserve the original baseline instead of overwriting')
    for name, value in zip(['preservation-before.json', 'editor-entity-baseline.json', 'planning-task-entity-baseline.json', 'preservation-summary.json'], result):
        with (OUTPUT / name).open('x') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
    print(json.dumps({'snapshotWritten': str(OUTPUT), 'files': len(result[0]['files']), 'counts': result[3]['counts'], 'activeRunIds': result[3]['activeRunIds']}))


if __name__ == '__main__':
    main()
