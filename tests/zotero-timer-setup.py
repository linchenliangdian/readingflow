"""Prepare a disposable native 2.2.3-to-2.2.4 expired-timer regression test."""
from pathlib import Path
from zipfile import ZipFile
import argparse
import json
import runpy

ROOT = Path(__file__).resolve().parents[1]


def setup(name):
    old_package = ROOT / 'output/reading-flow-2.2.3.xpi'
    runpy.run_path(str(ROOT / 'tests/zotero-hot-upgrade-setup.py'))['setup'](
        old_package, None, ROOT / 'output/reading-flow-2.2.4.xpi', name)
    folder = ROOT / 'tmp' / name
    # Pin the reproducer to the released runtime, independently of source edits.
    old_runtime = folder / 'old-runtime'
    old_runtime.mkdir()
    with ZipFile(old_package) as archive:
        for filename in ('core.js', 'sync.js', 'file-sync.js'):
            (old_runtime / filename).write_bytes(archive.read('content/' + filename))
    source = (ROOT / 'tests/zotero-timer-bootstrap.js').read_text(encoding='utf-8')
    for token, value in {
        '__EXPECTED_PROFILE__': str(folder / 'profile'), '__EXPECTED_DATA__': str(folder / 'data'),
        '__RESULT_PATH__': str(folder / 'result.json'), '__OLD_RUNTIME_URI__': old_runtime.as_uri() + '/',
        '__PACKAGE_STAGES__': json.loads((folder / 'package-stages.json').read_text(encoding='utf-8')),
    }.items():
        source = source.replace(token, json.dumps(value))
    (folder / 'runner.js').write_text('const { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");\n' + source + '\nZotero.__readingFlowSmokePromise=runSmokeTest();\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test-name', default='zotero-test-v224')
    setup(parser.parse_args().test_name)
