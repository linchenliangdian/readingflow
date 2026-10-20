"""Prepare a fresh project-local profile for native centralized file migration checks."""
from pathlib import Path
import argparse
import json
import runpy

ROOT = Path(__file__).resolve().parents[1]


def setup(test_name):
    runpy.run_path(str(ROOT / 'tests/zotero-hot-upgrade-setup.py'))['setup'](
        ROOT / 'output/reading-flow-2.1.8.xpi', None,
        ROOT / 'output/reading-flow-2.2.0.xpi', test_name)
    folder = ROOT / 'tmp' / test_name
    source = (ROOT / 'tests/zotero-file-sync-bootstrap.js').read_text(encoding='utf-8')
    values = {
        '__EXPECTED_PROFILE__': str(folder / 'profile'),
        '__EXPECTED_DATA__': str(folder / 'data'),
        '__RESULT_PATH__': str(folder / 'result.json'),
        '__PACKAGE_PATH__': str(ROOT / 'output/reading-flow-2.2.0.xpi'),
        '__PDF_FIXTURE_PATH__': str(folder / 'reader-fixture.pdf'),
        '__CONTENT_URI__': (ROOT / 'content').as_uri() + '/',
        '__FIXTURE_URI__': (ROOT / 'tests/zotero-file-sync-fixtures.js').as_uri(),
    }
    for token, value in values.items():
        source = source.replace(token, json.dumps(value))
    (folder / 'runner.js').write_text(
        'const { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");\n' + source +
        '\nZotero.__readingFlowSmokePromise = runSmokeTest();\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test-name', default='zotero-test-v220')
    setup(parser.parse_args().test_name)
