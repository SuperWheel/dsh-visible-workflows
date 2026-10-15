#!/usr/bin/env python3
"""Build a pinned private Graphon core runtime, without pip, uv or system installs.

Only the build machine uses Python to assemble the archive. End users run the
bundled interpreter. Cross-built Windows payloads are explicitly static-only.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LOCK_PATH = ROOT / 'runtime/packaging/runtime-lock.json'
MAX_ASSET_BYTES = 50_000_000


def sha256(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def safe_name(name: str) -> str:
    name = name.rstrip('/')
    parts = PurePosixPath(name).parts
    if not name or name.startswith('/') or '\\' in name or ':' in name or any(p in ('.', '..') for p in parts):
        raise ValueError(f'Unsafe archive path: {name!r}')
    if str(PurePosixPath(name)) != name:
        raise ValueError(f'Non-canonical archive path: {name!r}')
    return name


def download(asset: dict, cache: Path) -> Path:
    expected = asset['sha256']
    name = urllib.parse.unquote(asset['url'].rsplit('/', 1)[1])
    target = cache / f'{expected}-{name}'
    if target.exists():
        if target.is_symlink():
            raise ValueError(f'Cache entry is a symlink: {target}')
        if sha256(target) == expected:
            return target
        target.unlink()
    temporary = target.with_suffix(target.suffix + '.download')
    request = urllib.request.Request(asset['url'], headers={'User-Agent': 'DSH-Graphon-runtime-builder/1.0'})
    digest = hashlib.sha256()
    count = 0
    try:
        with urllib.request.urlopen(request, timeout=90) as response, temporary.open('xb') as output:
            while chunk := response.read(256 * 1024):
                count += len(chunk)
                if count > MAX_ASSET_BYTES:
                    raise ValueError('Asset exceeds the expected build size limit')
                digest.update(chunk)
                output.write(chunk)
        if asset.get('size') is not None and count != asset['size']:
            raise ValueError(f'Asset size mismatch: {name}')
        if digest.hexdigest() != expected:
            raise ValueError(f'Asset SHA-256 mismatch: {name}')
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def extract_python(archive: Path, stage: Path) -> None:
    # CPython's upstream archives contain internal symlinks. Validate destinations
    # before extracting; the final payload dereferences them into regular files.
    with tarfile.open(archive, 'r:gz') as tar:
        for item in tar.getmembers():
            safe_name(item.name)
            if item.name.split('/')[0] != 'python':
                raise ValueError('Unexpected Python archive root')
            if item.issym() or item.islnk():
                target = (stage / item.name).parent / item.linkname if item.issym() else stage / item.linkname
                if not target.resolve().is_relative_to(stage.resolve()):
                    raise ValueError('Python archive link escapes staging directory')
            elif not item.isfile() and not item.isdir():
                raise ValueError('Unsupported Python archive entry')
        tar.extractall(stage, filter='data')


def install_wheel(wheel: Path, site: Path) -> None:
    with zipfile.ZipFile(wheel) as archive:
        if sum(x.file_size for x in archive.infolist()) > 40_000_000:
            raise ValueError('Unexpected oversized core wheel')
        for entry in archive.infolist():
            name = safe_name(entry.filename)
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError('Wheel contains symbolic link')
            parts = name.split('/')
            if parts[0].endswith('.data'):
                if len(parts) < 3 or parts[1] not in ('purelib', 'platlib'):
                    raise ValueError(f'Unimplemented wheel install scheme: {name}')
                name = '/'.join(parts[2:])
            target = site / name
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    raise ValueError(f'Overlapping wheel file: {name}')
                target.write_bytes(archive.read(entry))
                target.chmod(0o644)


def clean_env(cache: Path) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith('PYTHON') and k not in ('LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH')}
    env.update(TIKTOKEN_CACHE_DIR=str(cache), PYTHONNOUSERSITE='1', PYTHONDONTWRITEBYTECODE='1', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
    return env


def verify_windows_pe(stage: Path) -> dict:
    count = 0
    templates = []
    for path in stage.rglob('*'):
        if not path.is_file() or path.suffix.lower() not in ('.exe', '.dll', '.pyd'):
            continue
        with path.open('rb') as stream:
            header = stream.read(64)
            if len(header) < 64 or header[:2] != b'MZ':
                raise ValueError(f'Invalid Windows binary header: {path.name}')
            offset = struct.unpack_from('<I', header, 60)[0]
            stream.seek(offset)
            pe = stream.read(6)
            if len(pe) != 6 or pe[:4] != b'PE\0\0':
                raise ValueError(f'Invalid Windows PE header: {path.name}')
            machine = struct.unpack_from('<H', pe, 4)[0]
            relative = path.relative_to(stage).as_posix()
            # PBS includes pip/distlib's launchers for generating packages for
            # other architectures. These are installer template data, not the
            # interpreter or imported extension modules we execute.
            if '/pip/_vendor/distlib/' in relative and path.name in ('w64-arm.exe','t64-arm.exe','w32.exe','t32.exe'):
                expected = 0xAA64 if '-arm.exe' in path.name else 0x14C
                if machine != expected: raise ValueError('Unexpected distlib launcher template architecture')
                templates.append({'path':relative,'machine':hex(machine)})
                continue
            if machine != 0x8664:
                raise ValueError(f'Windows binary is not AMD64: {path.name}')
        count += 1
    if count == 0:
        raise ValueError('No Windows binary files to verify')
    return {'runtimePEArchitecture':'AMD64','verifiedAMD64Files':count,'otherArchitectureInstallerTemplates':templates,'wheelPlatformTags':'win_amd64 or any'}


PROBE = r'''
import importlib.metadata,json,socket,sys
def offline(*a,**kw): raise RuntimeError('Runtime probe attempted network access')
socket.socket.connect=offline
socket.socket.connect_ex=offline
socket.create_connection=offline
from graphon.graph_engine import GraphEngine
from graphon.graph import Graph
from graphon.nodes.llm.runtime_protocols import LLMProtocol
from graphon.nodes.iteration.iteration_node import IterationNode
from graphon.nodes.loop.loop_node import LoopNode
from graphon.nodes.human_input.human_input_node import HumanInputNode
import tiktoken,jinja2
assert tiktoken.get_encoding('cl100k_base').encode('Graphon offline 测试')
assert jinja2.Template('{% for x in xs %}{{x}}{% endfor %}').render(xs=[1,2])=='12'
for name in ['transformers','unstructured','pandas','pypdf','uv']:
    try: importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError: pass
    else: raise RuntimeError('Forbidden heavy dependency installed: '+name)
print(json.dumps({'python':sys.version.split()[0],'graphon':importlib.metadata.version('graphon'),'encoding':'cl100k_base','offline':True}))
'''


def build(target: str, lock: dict, cache: Path, output: Path, no_probe: bool) -> dict:
    spec = lock['platforms'][target]
    forbidden = {'transformers', 'pandas', 'unstructured', 'pypdf', 'pypdfium2', 'python-docx', 'pypandoc', 'webvtt-py', 'uv'}
    if len(spec['wheels']) != 28 or forbidden.intersection(p['name'] for p in spec['wheels']):
        raise ValueError('Core dependency manifest violated')
    if target == 'windows-x64' and any(not p['url'].endswith(('win_amd64.whl','any.whl')) for p in spec['wheels']):
        raise ValueError('Windows wheel platform tag does not match pinned target')
    assets = [spec['python'], *spec['wheels'], lock['tokenizer']]
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        paths = list(pool.map(lambda a: download(a, cache), assets))
    stage = Path(tempfile.mkdtemp(prefix=f'build-{target}-', dir=cache.parent))
    try:
        extract_python(paths[0], stage)
        site = stage / ('python/Lib/site-packages' if target == 'windows-x64' else 'python/lib/python3.12/site-packages')
        site.mkdir(parents=True, exist_ok=True)
        for wheel in paths[1:-1]:
            install_wheel(wheel, site)
        token_cache = stage / 'tokenizer-cache'
        token_cache.mkdir()
        token_name = hashlib.sha1(lock['tokenizer']['url'].encode()).hexdigest()
        shutil.copyfile(paths[-1], token_cache / token_name)
        license_dir = stage / 'licenses'
        shutil.copytree(ROOT / 'runtime/packaging/licenses', license_dir)
        # Retain original interpreter, package licenses and full Graphon source.
        expected = {p['name']:p['version'] for p in spec['wheels']}
        (stage / 'core-dependencies.json').write_text(json.dumps({'graphon':lock['graphonVersion'],'packages':expected,'mode':'controlled-core','originalMetadataRetained':True},indent=2)+'\n')
        executable = stage / spec['pythonExecutable']
        if not executable.is_file():
            raise ValueError('Bundled Python executable missing')
        native = (target == 'macos-arm64' and sys.platform == 'darwin' and platform.machine() == 'arm64') or (target == 'windows-x64' and sys.platform == 'win32' and platform.machine().lower() in ('amd64','x86_64'))
        verification = {'mode':'static-only','executed':False}
        if native and not no_probe:
            completed = subprocess.run([str(executable),'-I','-B','-c',PROBE],env=clean_env(token_cache),capture_output=True,text=True,timeout=60)
            if completed.returncode:
                raise RuntimeError('Native private runtime probe failed:\n'+completed.stderr)
            verification = {'mode':'native-offline-import-probe','executed':True,'result':json.loads(completed.stdout)}
        elif target == 'windows-x64':
            verification = {'mode':'static-only','executed':False,'result':verify_windows_pe(stage)}
        # Remove interpreter-generated caches, never dependency sources/licenses.
        for path in sorted(stage.rglob('__pycache__'),reverse=True):
            if path.is_dir() and not path.is_symlink(): shutil.rmtree(path)
        for path in stage.rglob('*.pyc'):
            path.unlink()
        output.mkdir(parents=True,exist_ok=True)
        archive_name = f'graphon-core-0.7.0-{target}.tar.gz'
        archive_path = output / archive_name
        temporary = archive_path.with_suffix('.tmp')
        total = 0
        count = 0
        omitted_aliases = []
        with temporary.open('wb') as raw, gzip.GzipFile(fileobj=raw,mode='wb',filename='',mtime=0,compresslevel=9) as gz, tarfile.open(fileobj=gz,mode='w',format=tarfile.USTAR_FORMAT,dereference=True) as tar:
            for path in sorted(stage.rglob('*')):
                if path.is_dir(): continue
                if not path.resolve().is_relative_to(stage.resolve()):
                    raise ValueError('Payload link escapes staging directory')
                # The host always executes the exact versioned interpreter. PBS
                # convenience aliases would duplicate its large static binary
                # when dereferenced; omit aliases, never the real interpreter.
                if path.is_symlink():
                    omitted_aliases.append(path.relative_to(stage).as_posix())
                    continue
                name = safe_name(path.relative_to(stage).as_posix())
                info = tar.gettarinfo(str(path),arcname=name)
                if not info.isfile(): raise ValueError('Payload must contain regular files only')
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ''
                info.mode = 0o755 if os.access(path,os.X_OK) else 0o644
                with path.open('rb') as stream: tar.addfile(info,stream)
                total += info.size
                count += 1
        temporary.replace(archive_path)
        manifest = {
            'schemaVersion':1,'platform':target,'graphonVersion':lock['graphonVersion'],'pythonVersion':lock['pythonVersion'],
            'archive':archive_name,'sha256':sha256(archive_path),'archiveBytes':archive_path.stat().st_size,
            'expandedFileBytes':total,'fileCount':count,'pythonExecutable':spec['pythonExecutable'],
            'pythonExecutableSha256':sha256(executable),'dependencyManifest':'core-dependencies.json',
            'dependencyManifestSha256':sha256(stage/'core-dependencies.json'),
            'tokenizer':{'encoding':lock['tokenizer']['encoding'],'path':'tokenizer-cache/'+token_name,'sha256':lock['tokenizer']['sha256'],'estimatedForUnmatchedModels':True},
            'packages':[{'name':p['name'],'version':p['version']} for p in spec['wheels']],
            'verification':verification,'lockSha256':sha256(LOCK_PATH),
            'omittedInterpreterAliases':omitted_aliases,
        }
        (output / f'{target}.json').write_text(json.dumps(manifest,indent=2)+'\n')
        print(json.dumps(manifest,ensure_ascii=False),flush=True)
        return manifest
    finally:
        shutil.rmtree(stage)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform',choices=['macos-arm64','windows-x64','all'],default='macos-arm64')
    parser.add_argument('--cache',type=Path,default=ROOT/'.cache/graphon-runtime/downloads')
    parser.add_argument('--output',type=Path,default=ROOT/'runtime-assets')
    parser.add_argument('--skip-native-probe',action='store_true',help='Create an explicitly unexecuted artifact; release builds should not use this on the target platform')
    args = parser.parse_args()
    args.cache.mkdir(parents=True,exist_ok=True)
    lock = json.loads(LOCK_PATH.read_text())
    for target in (list(lock['platforms']) if args.platform=='all' else [args.platform]):
        build(target,lock,args.cache,args.output,args.skip_native_probe)


if __name__=='__main__':
    main()
