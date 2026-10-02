#!/usr/bin/env python3
"""Compare packaged runtime bytes directly with the frozen workspace."""
import hashlib
import json
import sys
import zipfile
from pathlib import Path, PurePosixPath


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    if len(sys.argv) != 4:
        raise SystemExit('Usage: verify-hover-vsix-identity.py <vsix> <workspace> <report>')
    vsix, root, report_path = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    prefixes = ('out/', 'keywords/', 'node_modules/', 'images/', 'snippets/', 'syntaxes/')
    checked, failures, inventory = 0, [], []
    with zipfile.ZipFile(vsix) as archive:
        for name in archive.namelist():
            if not name.startswith('extension/') or name.endswith('/'):
                continue
            relative = name[len('extension/'):]
            entry = archive.getinfo(name)
            inventory.append({'file': relative, 'bytes': entry.file_size,
                              'compressedBytes': entry.compress_size, 'sha256': sha(archive.read(name))})
            if not (relative.startswith(prefixes) or relative == 'package.json'):
                continue
            parts = PurePosixPath(relative).parts
            if '..' in parts or not parts:
                failures.append({'file': relative, 'reason': 'unsafe-path'})
                continue
            source = root.joinpath(*parts)
            if not source.is_file():
                failures.append({'file': relative, 'reason': 'missing-source'})
                continue
            checked += 1
            if sha(archive.read(name)) != sha(source.read_bytes()):
                failures.append({'file': relative, 'reason': 'content-mismatch'})
    result = {'vsixSha256': sha(vsix.read_bytes()), 'runtimeFilesChecked': checked,
              'failures': failures, 'complete': checked > 0 and not failures,
              'packageBytes': vsix.stat().st_size, 'files': inventory}
    report_path.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'runtimeFilesChecked': checked, 'failures': len(failures),
                      'complete': result['complete']}))
    return 0 if result['complete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
