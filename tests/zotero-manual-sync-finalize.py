"""Read-only verification after the disposable native manual-sync test exits."""
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
    assert result['transport'] == 'stubbed-native-Runner.sync-account-free'
    fixture = result['fixture']
    db = sqlite3.connect((folder / 'data/zotero.sqlite').as_uri() + '?mode=ro', uri=True)
    container_id = db.execute('SELECT itemID FROM items WHERE key=?', (fixture['containerKey'],)).fetchone()[0]
    attachments = db.execute('SELECT key,path FROM itemAttachments JOIN items USING(itemID) WHERE parentItemID=?', (container_id,)).fetchall()
    assert len(attachments) == fixture['attachmentCount']
    records, by_key = [], {}
    for key, path in attachments:
        assert path.startswith('storage:')
        data = (folder / 'data/storage' / key / path[len('storage:'):]).read_bytes()
        journal = json.loads(data)
        assert journal['format'] == 'READING_FLOW_FILE_SYNC_V2'
        records.extend(journal['records'])
        by_key[key] = hashlib.md5(data).hexdigest()
    for old in fixture['oldFiles']:
        assert by_key[old['key']] == old['hash']
    for owner in fixture['owners']:
        html = db.execute('SELECT note FROM itemNotes JOIN items USING(itemID) WHERE key=?', (owner['noteKey'],)).fetchone()[0]
        prefix = '<div class="zotero-note znv1">'
        if html.startswith(prefix) and html.endswith('</div>'):
            html = html[len(prefix):-6]
        assert html == owner['originalHTML']
        assert any(record['ownerKey'] == owner['ownerKey'] and record['state']['pyramid']['text'] == owner['finalText'] for record in records)
        cache = json.loads((folder / 'data/reading-flow' / (str(owner['libraryID']) + '-' + owner['ownerKey'] + '.json')).read_text(encoding='utf-8'))
        assert cache['pyramid']['text'] == owner['finalText']
        assert cache['readingFlowSync']['pending'] is False
    db.close()
    prefs = (folder / 'profile/prefs.js').read_text(encoding='utf-8')
    assert 'user_pref("extensions.zotero.readingFlow.syncMode", "manual");' in prefs
    package = ROOT / 'output/reading-flow-2.2.5.xpi'
    assert package.read_bytes() == (folder / 'profile/extensions/reading-flow@local.xpi').read_bytes()
    with ZipFile(package) as archive:
        for filename in archive.namelist():
            assert archive.read(filename) == (ROOT / filename).read_bytes(), filename
    report = {'nativeChecks': len(result['checks']), 'postExitChecks': 5,
              'transport': result['transport'], 'sha256': hashlib.sha256(package.read_bytes()).hexdigest()}
    (folder / 'post-exit-verification.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test-name', default='zotero-test-v225')
    verify(parser.parse_args().test_name)
