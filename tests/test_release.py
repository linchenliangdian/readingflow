"""Offline release checks; fixtures never access an account or Zotero profile."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile


SPEC = importlib.util.spec_from_file_location(
    "reading_flow_release", Path(__file__).resolve().parents[1] / "scripts" / "release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        temp_parent = Path(__file__).resolve().parents[1] / "tmp"
        temp_parent.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix="release-test-", dir=temp_parent)
        # Validate the recursively removed target stays in the test workspace.
        assert Path(self.tmp.name).resolve().parent == temp_parent.resolve()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repository = "example/reading-flow"
        self.version = "2.1.1"
        self.tag = "v" + self.version
        self.manifest = {
            "manifest_version": 2, "name": "Reading flow", "version": self.version,
            "applications": {"zotero": {
                "id": release.ADDON_ID, "update_url": release.update_url(self.repository),
                "strict_min_version": "9.0", "strict_max_version": "9.0.*",
            }},
        }
        self.write_source()
        self.xpi = self.root / ("reading-flow-" + self.version + ".xpi")
        self.write_xpi()
        self.out = self.root / "release"

    def write_source(self, package_version=None):
        (self.root / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        (self.root / "package.json").write_text(
            json.dumps({"version": package_version or self.manifest["version"]}), encoding="utf-8")

    def write_xpi(self, manifest=None):
        with ZipFile(self.xpi, "w") as archive:
            archive.writestr("manifest.json", json.dumps(manifest or self.manifest))
            archive.writestr("bootstrap.js", "// synthetic release fixture\n")

    def prepare(self, tag=None):
        return release.prepare(
            self.repository, tag or self.tag, self.xpi, self.out, source_root=self.root)

    def test_feed_identifies_exact_addon_version_asset_compatibility_and_sha256(self):
        metadata, paths = self.prepare()
        feed = json.loads((self.out / "updates.json").read_text(encoding="utf-8"))
        self.assertEqual(list(feed["addons"]), [release.ADDON_ID])
        update, = feed["addons"][release.ADDON_ID]["updates"]
        digest = hashlib.sha256(self.xpi.read_bytes()).hexdigest()
        self.assertEqual(update, {
            "version": self.version,
            "update_link": "https://github.com/example/reading-flow/releases/download/"
                           "v2.1.1/reading-flow-2.1.1.xpi",
            "update_hash": "sha256:" + digest,
            "applications": {"zotero": {"strict_min_version": "9.0", "strict_max_version": "9.0.*"}},
        })
        self.assertEqual(metadata["sha256"], digest)
        self.assertEqual(metadata["update_url"], self.manifest["applications"]["zotero"]["update_url"])
        self.assertEqual((self.out / (self.xpi.name + ".sha256")).read_text(encoding="utf-8"),
                         digest + "  " + self.xpi.name + "\n")
        self.assertEqual({p.name for p in paths}, {self.xpi.name, "updates.json", self.xpi.name + ".sha256"})

    def test_tag_and_package_must_match_source_version(self):
        for tag in ("v2.1.0", "2.1.1", "v2.1.1-beta.1"):
            with self.subTest(tag=tag), self.assertRaisesRegex(ValueError, "versions must match"):
                self.prepare(tag)
        self.write_source(package_version="2.1.0")
        with self.assertRaisesRegex(ValueError, "versions must match"):
            self.prepare()

    def test_generated_assets_use_lf_bytes_on_every_platform(self):
        self.prepare()
        for name in ("updates.json", self.xpi.name + ".sha256", "release-metadata.json"):
            with self.subTest(name=name):
                data = (self.out / name).read_bytes()
                self.assertIn(b"\n", data)
                self.assertNotIn(b"\r", data)
                self.assertTrue(data.endswith(b"\n"))

    def test_stable_feed_rejects_prerelease_build_metadata_and_ambiguous_versions(self):
        for version in ("2.1.1-beta.1", "2.1.1+local", "2.1", "02.1.1", "2.1.1\n", "v2.1.1"):
            with self.subTest(version=version), self.assertRaises(ValueError):
                release.stable_version(version)

    def test_repository_name_cannot_inject_a_different_host_or_path(self):
        for repository in ("https://github.com/example/reading-flow", "example/../reading-flow",
                           "example/reading-flow?token=private", "example/reading flow", "example/.."):
            with self.subTest(repository=repository), self.assertRaises(ValueError):
                release.update_url(repository)

    def test_rejects_xpi_version_id_url_and_compatibility_drift(self):
        variants = []
        wrong_version = copy.deepcopy(self.manifest)
        wrong_version["version"] = "2.1.0"
        variants.append(wrong_version)
        for key, value in (("id", "other-addon@example.invalid"),
                           ("update_url", "https://reading-flow.invalid/updates.json"),
                           ("update_url", "https://github.com/elsewhere/reading-flow/releases/latest/download/updates.json"),
                           ("strict_max_version", "*")):
            manifest = copy.deepcopy(self.manifest)
            manifest["applications"]["zotero"][key] = value
            variants.append(manifest)
        for manifest in variants:
            with self.subTest(manifest=manifest), self.assertRaises(ValueError):
                self.write_xpi(manifest)
                self.prepare()

    def test_changed_xpi_bytes_change_both_public_hashes(self):
        before, _ = self.prepare()
        with ZipFile(self.xpi, "a") as archive:
            archive.writestr("LICENSE", "synthetic test fixture")
        after, _ = self.prepare()
        self.assertNotEqual(before["sha256"], after["sha256"])
        feed = json.loads((self.out / "updates.json").read_text(encoding="utf-8"))
        self.assertEqual(feed["addons"][release.ADDON_ID]["updates"][0]["update_hash"],
                         "sha256:" + hashlib.sha256(self.xpi.read_bytes()).hexdigest())

    def fake_server(self, *, private=False, prerelease=False, draft=True, latest=None,
                    existing_assets=None, incomplete_reread=False, tag_lookup_missing=False,
                    listed_draft=True, tag_ref_exists=True):
        calls = []
        assets = list(existing_assets or [])
        inventory_reads = 0
        existing = {"id": 42, "tag_name": self.tag, "draft": draft, "prerelease": prerelease,
                    "html_url": "https://github.com/example/reading-flow/releases/tag/" + self.tag}

        def api(endpoint, *, method="GET", payload=None, binary=False, data_file=None):
            nonlocal inventory_reads
            calls.append((method, endpoint, payload, data_file))
            prefix = "repos/" + self.repository
            if endpoint == prefix:
                return {"private": private}
            if endpoint == prefix + "/releases/tags/" + self.tag:
                return None if tag_lookup_missing else existing
            if endpoint == prefix + "/releases/latest":
                return latest
            if endpoint.startswith(prefix + "/releases?per_page=100&page="):
                return [existing] if listed_draft and endpoint.endswith("page=1") else []
            if endpoint == prefix + "/git/ref/tags/" + self.tag:
                return {"ref": "refs/tags/" + self.tag} if tag_ref_exists else None
            if method == "POST" and endpoint == prefix + "/releases":
                self.assertEqual(payload["tag_name"], self.tag)
                self.assertTrue(payload["draft"])
                self.assertFalse(payload["prerelease"])
                return existing
            if endpoint == prefix + "/releases/42/assets?per_page=100":
                inventory_reads += 1
                if incomplete_reread and inventory_reads > 1:
                    return assets[:-1]
                return list(assets)
            if method == "POST" and endpoint.startswith("https://uploads.github.com/"):
                path = Path(data_file)
                asset = {"id": len(assets) + 1, "name": path.name, "state": "uploaded",
                         "size": path.stat().st_size,
                         "digest": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()}
                assets.append(asset)
                return asset
            if method == "PATCH" and endpoint == prefix + "/releases/42":
                existing.update(payload)
                return existing
            raise AssertionError("Unexpected API call: " + endpoint)

        return api, calls, assets

    def test_draft_is_published_only_after_all_assets_are_uploaded_and_verified(self):
        metadata, paths = self.prepare()
        api, calls, assets = self.fake_server()
        with patch.object(release, "gh_api", api):
            result = release.publish(metadata, paths)
        self.assertFalse(result["draft"])
        self.assertEqual({a["name"] for a in assets}, set(metadata["assets"]))
        self.assertEqual([c[0] for c in calls].count("POST"), 3)
        self.assertEqual(calls[-1][0], "PATCH")
        self.assertEqual(calls[-1][2], {"draft": False, "prerelease": False, "make_latest": "true"})

    def test_incomplete_final_inventory_never_becomes_latest(self):
        metadata, paths = self.prepare()
        api, calls, _ = self.fake_server(incomplete_reread=True)
        with patch.object(release, "gh_api", api), self.assertRaisesRegex(ValueError, "incomplete or changed"):
            release.publish(metadata, paths)
        self.assertFalse(any(c[0] == "PATCH" for c in calls))

    def test_initial_release_is_created_as_draft_after_existing_tag_is_verified(self):
        metadata, paths = self.prepare()
        api, calls, _ = self.fake_server(tag_lookup_missing=True, listed_draft=False)
        with patch.object(release, "gh_api", api):
            release.publish(metadata, paths)
        creation = next(i for i, call in enumerate(calls)
                        if call[0] == "POST" and call[1].endswith("/releases"))
        ref_lookup = next(i for i, call in enumerate(calls) if "/git/ref/tags/" in call[1])
        self.assertLess(ref_lookup, creation)
        self.assertEqual(calls[-1][0], "PATCH")

    def test_missing_git_tag_never_creates_a_release_or_new_tag(self):
        metadata, paths = self.prepare()
        api, calls, _ = self.fake_server(
            tag_lookup_missing=True, listed_draft=False, tag_ref_exists=False)
        with patch.object(release, "gh_api", api), self.assertRaisesRegex(ValueError, "existing Git tag"):
            release.publish(metadata, paths)
        self.assertTrue(all(call[0] == "GET" for call in calls))

    def test_rest_tag_404_recovers_draft_without_creating_duplicate_release(self):
        metadata, paths = self.prepare()
        api, calls, _ = self.fake_server(tag_lookup_missing=True, listed_draft=True)
        with patch.object(release, "gh_api", api):
            release.publish(metadata, paths)
        self.assertTrue(any("/releases?per_page=100&page=1" in call[1] for call in calls))
        self.assertFalse(any(call[0] == "POST" and call[1].endswith("/releases") for call in calls))

    def test_resuming_draft_preserves_matching_asset_and_uploads_only_missing_assets(self):
        metadata, paths = self.prepare()
        preserved = paths[0]
        asset = {"id": 1, "name": preserved.name, "state": "uploaded",
                 "size": preserved.stat().st_size,
                 "digest": "sha256:" + hashlib.sha256(preserved.read_bytes()).hexdigest()}
        api, calls, _ = self.fake_server(
            tag_lookup_missing=True, listed_draft=True, existing_assets=[asset])
        with patch.object(release, "gh_api", api):
            release.publish(metadata, paths)
        uploaded = [Path(call[3]).name for call in calls if call[0] == "POST" and call[3] is not None]
        self.assertEqual(set(uploaded), {"updates.json", self.xpi.name + ".sha256"})
        self.assertNotIn(preserved.name, uploaded)

    def test_private_repository_prerelease_and_stable_downgrade_do_not_publish(self):
        metadata, paths = self.prepare()
        for kwargs in ({"private": True}, {"prerelease": True},
                       {"latest": {"tag_name": "v2.2.0"}}, {"latest": {"tag_name": "v2.1.2-beta.1"}}):
            api, calls, _ = self.fake_server(**kwargs)
            with self.subTest(kwargs=kwargs), patch.object(release, "gh_api", api), self.assertRaises(ValueError):
                release.publish(metadata, paths)
            self.assertFalse(any(c[0] in {"POST", "PATCH"} for c in calls))

    def test_published_release_is_verified_without_mutation_or_asset_replacement(self):
        metadata, paths = self.prepare()
        assets = [{"id": i, "name": path.name, "state": "uploaded", "size": path.stat().st_size,
                   "digest": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()}
                  for i, path in enumerate(paths, 1)]
        api, calls, _ = self.fake_server(draft=False, existing_assets=assets)
        with patch.object(release, "gh_api", api):
            release.publish(metadata, paths)
        self.assertTrue(all(c[0] == "GET" for c in calls))
        assets[0]["digest"] = "sha256:" + "0" * 64
        api, calls, _ = self.fake_server(draft=False, existing_assets=assets)
        with patch.object(release, "gh_api", api), self.assertRaisesRegex(ValueError, "different SHA-256"):
            release.publish(metadata, paths)
        self.assertTrue(all(c[0] == "GET" for c in calls))

    def test_missing_public_asset_cannot_be_added_after_publication(self):
        metadata, paths = self.prepare()
        api, calls, _ = self.fake_server(draft=False)
        with patch.object(release, "gh_api", api), self.assertRaisesRegex(ValueError, "missing an asset"):
            release.publish(metadata, paths)
        self.assertTrue(all(c[0] == "GET" for c in calls))


if __name__ == "__main__":
    unittest.main()
