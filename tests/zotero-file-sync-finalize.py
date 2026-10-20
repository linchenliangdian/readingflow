"""Read-only post-exit verification of a disposable native file-sync test."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]


def finalize(name):
    if not name.startswith('zotero-test-') or not all(c.isascii() and (c.isalnum() or c == '-') for c in name):
        raise ValueError('Invalid disposable test directory')
    folder = (ROOT / 'tmp' / name).resolve()
    assert folder.parent == (ROOT / 'tmp').resolve()
    result = json.loads((folder / 'result.json').read_text(encoding='utf-8'))
    assert result['status'] == 'passed', result.get('error')
    db = sqlite3.connect((folder / 'data/zotero.sqlite').as_uri() + '?mode=ro', uri=True)
    fixture = result['fixture']
    for key in fixture['legacyKeys']:
        assert db.execute('SELECT COUNT(*) FROM items JOIN deletedItems USING(itemID) WHERE key=?', (key,)).fetchone()[0] == 1
    for key in fixture['protectedKeys']:
        assert db.execute('SELECT COUNT(*) FROM items LEFT JOIN deletedItems USING(itemID) WHERE key=? AND deletedItems.itemID IS NULL', (key,)).fetchone()[0] == 1
    for note in fixture['originalNotes']:
        row = db.execute('SELECT note FROM itemNotes JOIN items USING(itemID) WHERE key=?', (note['key'],)).fetchone()
        assert row
        # Zotero stores a native wrapper which Item.getNote() omits.
        prefix = '<div class="zotero-note znv1">'
        html = row[0][len(prefix):-6] if row[0].startswith(prefix) and row[0].endswith('</div>') else row[0]
        assert html == note['html']
        assert list((folder / 'data/storage' / note['imageKey']).glob('*.png'))
    db.close()
    package = ROOT / 'output/reading-flow-2.2.0.xpi'
    installed = folder / 'profile/extensions/reading-flow@local.xpi'
    assert installed.read_bytes() == package.read_bytes(), 'Installed package differs from candidate'
    with ZipFile(package) as archive:
        for entry in archive.namelist():
            assert archive.read(entry) == (ROOT / entry).read_bytes(), entry
        entries = len(archive.namelist())
    verification = {
        'nativeChecks': len(result['checks']), 'postExitChecks': 4,
        'installedRuntimeFiles': entries, 'sha256': hashlib.sha256(package.read_bytes()).hexdigest(),
        'legacyNotesInTrash': len(fixture['legacyKeys']), 'protectedNotesPreserved': len(fixture['protectedKeys']),
        'originalNativeNotesPreserved': len(fixture['originalNotes']), 'actualCloudSync': False,
    }
    (folder / 'post-exit-verification.json').write_text(json.dumps(verification, indent=2), encoding='utf-8')
    print(json.dumps(verification, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test-name', default='zotero-test-v220')
    finalize(parser.parse_args().test_name)
