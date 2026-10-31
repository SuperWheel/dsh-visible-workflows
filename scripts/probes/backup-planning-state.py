#!/usr/bin/env python3
"""Private state-only backup, to execute only after Desktop is stopped.

Fixed source/destination. No credentials, Host lock, installed plugin or runtime copied.
No restore function. Refuses symlinks, changed source inventory and existing destination.
"""
import argparse
import importlib.util
import json
import os
import shutil
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('preservation_snapshot', Path(__file__).with_name('snapshot-planning-data-preservation.py'))
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)
SOURCE = snapshot.STATE
DESTINATION = snapshot.REPO / '.cache/planning-entry-20261019-speed1/state-backup'
BEFORE = snapshot.OUTPUT / 'preservation-before.json'


def backup(source, destination, baseline):
    snapshot.no_symlinks(source)
    snapshot.no_symlinks(destination)
    if destination.exists():
        raise ValueError('Private backup destination already exists; refusing overwrite')
    if baseline['stateDirectory'] != str(source):
        raise ValueError('Baseline belongs to a different state directory')
    inventory = {str(p.relative_to(source)): snapshot.sha(snapshot.read_regular(p)) for p in snapshot.state_files(source)}
    if inventory != baseline['files']:
        raise ValueError('State differs from baseline; investigate before backup')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.state-backup.partial-', dir=destination.parent))
    os.chmod(temporary, 0o700)
    try:
        for relative, expected in inventory.items():
            target = temporary / relative
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            for parent in [target.parent, *target.parent.parents]:
                if parent == temporary.parent:
                    break
                os.chmod(parent, 0o700)
            raw = snapshot.read_regular(source / relative)
            if snapshot.sha(raw) != expected:
                raise ValueError('State changed while copying; backup rejected')
            with target.open('xb') as stream:
                os.chmod(target, 0o600)
                stream.write(raw)
            if snapshot.sha(snapshot.read_regular(target)) != expected:
                raise ValueError('Private copy hash mismatch')
        current = {str(p.relative_to(source)): snapshot.sha(snapshot.read_regular(p)) for p in snapshot.state_files(source)}
        if current != inventory:
            raise ValueError('State changed during backup; backup rejected')
        manifest = {'stateDirectory': str(source), 'files': inventory, 'credentialFilesCopied': False,
                    'automaticRestore': False, 'sourceChangedDuringCopy': False}
        with (temporary / 'backup-manifest.json').open('x') as stream:
            os.chmod(temporary / 'backup-manifest.json', 0o600)
            json.dump(manifest, stream, indent=2)
            stream.write('\n')
        # Destination cannot exist; rename is preceded by another fail-closed path check.
        snapshot.no_symlinks(destination)
        if destination.exists():
            raise ValueError('Destination appeared during backup')
        temporary.rename(destination)
    except BaseException:
        shutil.rmtree(temporary)
        raise
    return {'backupDirectory': str(destination), 'files': len(inventory), 'hashesVerified': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--desktop-stopped', action='store_true', required=True,
                        help='Operator has closed Desktop and checked that no state writer remains; this is not a new permission request.')
    parser.parse_args()
    baseline = json.loads(snapshot.read_regular(BEFORE))
    print(json.dumps(backup(SOURCE, DESTINATION, baseline)))


if __name__ == '__main__':
    main()
