"""Read-only verification after the disposable deleted-tags test exits."""
from pathlib import Path
from zipfile import ZipFile
import argparse
import hashlib
import json
import sqlite3

ROOT = Path(__file__).resolve().parents[1]


def verify(name):
    if not name.startswith('zotero-test-') or not all(c.isascii() and (c.isalnum() or c == '-') for c in name):
        raise ValueError('Invalid disposable directory')
    folder = (ROOT / 'tmp' / name).resolve()
    assert folder.parent == (ROOT / 'tmp').resolve()
    result = json.loads((folder / 'result.json').read_text(encoding='utf-8'))
    assert result['status'] == 'passed', result.get('error')
    fixture = result['fixture']
    db = sqlite3.connect((folder / 'data/zotero.sqlite').as_uri() + '?mode=ro', uri=True)
    container_id = db.execute('SELECT itemID FROM items WHERE key=?', (fixture['containerKey'],)).fetchone()[0]
    assert db.execute('SELECT COUNT(*) FROM itemTags WHERE itemID=?', (container_id,)).fetchone()[0] == 0
    attachments = db.execute('SELECT key,path FROM itemAttachments JOIN items USING(itemID) WHERE parentItemID=?', (container_id,)).fetchall()
    assert len(attachments) >= 2
    for key, path in attachments:
        assert db.execute('SELECT COUNT(*) FROM itemTags JOIN items USING(itemID) WHERE key=?', (key,)).fetchone()[0] == 0
        assert path.startswith('storage:')
        data = (folder / 'data/storage' / key / path[len('storage:'):]).read_bytes()
        assert json.loads(data)['format'] == 'READING_FLOW_FILE_SYNC_V2'
        if key == fixture['oldFileKey']:
            assert hashlib.md5(data).hexdigest() == fixture['oldFileHash']
    html = db.execute('SELECT note FROM itemNotes JOIN items USING(itemID) WHERE key=?', (fixture['noteKey'],)).fetchone()[0]
    prefix = '<div class="zotero-note znv1">'
    if html.startswith(prefix) and html.endswith('</div>'):
        html = html[len(prefix):-6]
    assert html == fixture['originalHTML']
    db.close()
    package = ROOT / 'output/reading-flow-2.2.3.xpi'
    assert package.read_bytes() == (folder / 'profile/extensions/reading-flow@local.xpi').read_bytes()
    with ZipFile(package) as archive:
        for name in archive.namelist():
            assert archive.read(name) == (ROOT / name).read_bytes(), name
    report = {'nativeChecks': len(result['checks']), 'postExitChecks': 4,
              'sha256': hashlib.sha256(package.read_bytes()).hexdigest()}
    (folder / 'post-exit-verification.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test-name', default='zotero-test-v223')
    verify(parser.parse_args().test_name)
