"""Read-only verification after the isolated tag test exits."""
from pathlib import Path
from zipfile import ZipFile
import argparse
import hashlib
import json
import sqlite3

ROOT = Path(__file__).resolve().parents[1]


def verify(name):
    if not name.startswith('zotero-test-') or not all(c.isascii() and (c.isalnum() or c == '-') for c in name):
        raise ValueError('Invalid disposable test directory')
    folder = (ROOT / 'tmp' / name).resolve()
    assert folder.parent == (ROOT / 'tmp').resolve()
    result = json.loads((folder / 'result.json').read_text(encoding='utf-8'))
    assert result['status'] == 'passed', result.get('error')
    fixture = result['fixture']
    db = sqlite3.connect((folder / 'data/zotero.sqlite').as_uri() + '?mode=ro', uri=True)
    tags = lambda key: db.execute('SELECT name,type FROM itemTags JOIN tags USING(tagID) JOIN items USING(itemID) WHERE key=?', (key,)).fetchall()
    assert tags(fixture['oldNoteKey']) == [('Personal research', 1)]
    assert not tags(fixture['newNoteKey']) and not tags(fixture['retryNoteKey'])
    html = db.execute('SELECT note FROM itemNotes JOIN items USING(itemID) WHERE key=?', (fixture['oldNoteKey'],)).fetchone()[0]
    prefix = '<div class="zotero-note znv1">'
    if html.startswith(prefix) and html.endswith('</div>'):
        html = html[len(prefix):-6]
    assert html == fixture['oldHTML']
    db.close()
    package = ROOT / 'output/reading-flow-2.2.1.xpi'
    assert package.read_bytes() == (folder / 'profile/extensions/reading-flow@local.xpi').read_bytes()
    with ZipFile(package) as archive:
        for name in archive.namelist():
            assert archive.read(name) == (ROOT / name).read_bytes(), name
    verified = {'nativeChecks': len(result['checks']), 'postExitChecks': 4,
                'sha256': hashlib.sha256(package.read_bytes()).hexdigest()}
    (folder / 'post-exit-verification.json').write_text(json.dumps(verified, indent=2), encoding='utf-8')
    print(json.dumps(verified, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test-name', default='zotero-test-v221c')
    verify(parser.parse_args().test_name)
