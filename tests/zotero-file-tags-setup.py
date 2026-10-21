"""Prepare disposable native reproduction of the deleted-data-tags regression."""
from pathlib import Path
import argparse
import json
import runpy

ROOT = Path(__file__).resolve().parents[1]


def setup(name):
    runpy.run_path(str(ROOT / 'tests/zotero-hot-upgrade-setup.py'))['setup'](
        ROOT / 'output/reading-flow-2.2.2.xpi', None,
        ROOT / 'output/reading-flow-2.2.3.xpi', name)
    folder = ROOT / 'tmp' / name
    source = (ROOT / 'tests/zotero-file-tags-bootstrap.js').read_text(encoding='utf-8')
    for token, value in {
        '__EXPECTED_PROFILE__': str(folder / 'profile'), '__EXPECTED_DATA__': str(folder / 'data'),
        '__RESULT_PATH__': str(folder / 'result.json'),
        '__PACKAGE_STAGES__': json.loads((folder / 'package-stages.json').read_text(encoding='utf-8')),
    }.items():
        source = source.replace(token, json.dumps(value))
    (folder / 'runner.js').write_text('const { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");\n' + source + '\nZotero.__readingFlowSmokePromise=runSmokeTest();\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test-name', default='zotero-test-v223')
    setup(parser.parse_args().test_name)
