"""Build regressions use synthetic packages confined to a temporary workspace."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile


SPEC = importlib.util.spec_from_file_location(
    "reading_flow_build", Path(__file__).resolve().parents[1] / "build.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class ResourceVersionBuildTests(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).resolve().parents[1] / "tmp"
        parent.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="build-version-test-", dir=parent)
        assert Path(self.temp.name).resolve().parent == parent.resolve()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.version = "9.8.7"
        self.manifest = {
            "manifest_version": 2, "name": "Synthetic build fixture", "version": self.version,
            "icons": {size: "content/icons/pyramid.svg" for size in ("32", "48", "96")},
            "applications": {"zotero": {"id": "reading-flow@local", "strict_min_version": "9.0",
                "strict_max_version": "10.0.*", "update_url": "https://github.com/example/fixture/releases/latest/download/updates.json"}},
        }
        for name in builder.FILES:
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text("// synthetic fixture\n", encoding="utf-8")
        (self.root / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        (self.root / "content/icons/pyramid.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"/>', encoding="utf-8")
        self.resources = ["style.css?v=" + self.version, "core.js?v=" + self.version, "app.js?v=" + self.version]
        self.xhtml = self.root / "content/app.xhtml"
        self.write_resources()

    def write_resources(self, resources=None):
        style, *scripts = self.resources if resources is None else resources
        markup = '<html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="' + style + '"/>'
        markup += ''.join('<script src="' + source + '"></script>' for source in scripts)
        self.xhtml.write_text(markup + '</head><body/></html>', encoding="utf-8")

    def build(self):
        with patch.object(builder, "ROOT", self.root):
            builder.build()

    def test_current_resource_versions_build_and_remain_identical_in_the_installed_package(self):
        self.build()
        package = self.root / "output" / ("reading-flow-" + self.version + ".xpi")
        with ZipFile(package) as archive:
            self.assertEqual(archive.read("content/app.xhtml"), self.xhtml.read_bytes())
            self.assertEqual(json.loads(archive.read("manifest.json"))["version"], self.version)
        self.assertFalse((Path(__file__).resolve().parents[1] / "output" / package.name).exists())

    def test_each_stale_or_unversioned_resource_blocks_packaging_before_an_output_is_created(self):
        for index in range(3):
            for replacement in [self.resources[index].split('?')[0], self.resources[index].replace(self.version, "9.8.6")]:
                with self.subTest(resource=index, replacement=replacement):
                    resources = list(self.resources)
                    resources[index] = replacement
                    self.write_resources(resources)
                    with self.assertRaisesRegex(ValueError, "current manifest version"):
                        self.build()
                    self.assertFalse((self.root / "output").exists())

    def test_a_missing_script_blocks_packaging_instead_of_silently_skipping_its_version_check(self):
        self.write_resources(self.resources[:2])
        with self.assertRaisesRegex(ValueError, "current manifest version"):
            self.build()
        self.assertFalse((self.root / "output").exists())


if __name__ == "__main__":
    unittest.main()
