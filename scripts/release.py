"""Prepare, verify, and optionally publish a stable Zotero update release.

Local preparation is network-free. --publish uses the authenticated GitHub CLI;
it never replaces an existing asset or edits a published release.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
ADDON_ID = "reading-flow@local"
STABLE_VERSION = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\Z")
REPOSITORY = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+\Z")


def repository_name(value):
    if not REPOSITORY.fullmatch(value or "") or value.split("/")[-1] in {".", ".."}:
        raise ValueError("Repository must be a GitHub OWNER/REPO name")
    return value


def stable_version(value):
    if not isinstance(value, str) or not STABLE_VERSION.fullmatch(value):
        raise ValueError("Only stable MAJOR.MINOR.PATCH versions are supported")
    return tuple(map(int, value.split(".")))


def update_url(repository):
    return f"https://github.com/{repository_name(repository)}/releases/latest/download/updates.json"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def prepare(repository, tag, xpi, output_dir, source_root=ROOT):
    repository = repository_name(repository)
    xpi, output_dir = Path(xpi), Path(output_dir)
    source = json.loads((source_root / "manifest.json").read_text(encoding="utf-8"))
    package = json.loads((source_root / "package.json").read_text(encoding="utf-8"))
    version = source["version"]
    stable_version(version)
    if tag != f"v{version}" or package["version"] != version:
        raise ValueError("Tag, manifest.json, and package.json versions must match")
    expected_name = f"reading-flow-{version}.xpi"
    if xpi.name != expected_name:
        raise ValueError(f"Expected versioned XPI filename: {expected_name}")
    data = xpi.read_bytes()
    with ZipFile(xpi) as archive:
        if archive.testzip() is not None or len(archive.namelist()) != len(set(archive.namelist())):
            raise ValueError("XPI has corrupt or duplicate entries")
        manifest = json.loads(archive.read("manifest.json"))
    app = manifest["applications"]["zotero"]
    if manifest["version"] != version or app["id"] != ADDON_ID:
        raise ValueError("XPI addon ID or version does not match this release")
    if source["applications"]["zotero"]["id"] != ADDON_ID:
        raise ValueError("Source addon ID changed; this would strand existing installations")
    if app["update_url"] != update_url(repository):
        raise ValueError("XPI update_url must point to this repository's latest updates.json asset")
    compatibility = {key: app[key] for key in ("strict_min_version", "strict_max_version")}
    source_app = source["applications"]["zotero"]
    if any(value != source_app[key] for key, value in compatibility.items()):
        raise ValueError("Packaged compatibility differs from the source manifest")
    sha256 = digest(data)
    feed = {"addons": {ADDON_ID: {"updates": [{
        "version": version,
        "update_link": f"https://github.com/{repository}/releases/download/{tag}/{xpi.name}",
        "update_hash": f"sha256:{sha256}",
        "applications": {"zotero": compatibility},
    }]}}}
    output_dir.mkdir(parents=True, exist_ok=True)
    feed_path = output_dir / "updates.json"
    hash_path = output_dir / f"{xpi.name}.sha256"
    feed_path.write_text(json.dumps(feed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    hash_path.write_text(f"{sha256}  {xpi.name}\n", encoding="utf-8", newline="\n")
    metadata = {
        "repository": repository, "tag": tag, "version": version,
        "addon_id": ADDON_ID, "update_url": update_url(repository),
        "xpi": xpi.name, "sha256": sha256,
        "assets": [xpi.name, feed_path.name, hash_path.name],
    }
    (output_dir / "release-metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return metadata, [xpi, feed_path, hash_path]


def gh_api(endpoint, *, method="GET", payload=None, binary=False, data_file=None):
    """Use gh's credential handling without placing a token in arguments or logs."""
    command = ["gh", "api", endpoint, "--method", method,
               "--header", "Accept: application/octet-stream" if binary
               else "Accept: application/vnd.github+json"]
    request = None
    if payload is not None:
        command += ["--input", "-"]
        request = json.dumps(payload).encode("utf-8")
    if data_file is not None:
        command += ["--header", "Content-Type: application/octet-stream", "--input", str(data_file)]
    result = subprocess.run(command, input=request, capture_output=True, check=False)
    if result.returncode:
        # The only expected missing resources are the initial latest/tag lookups.
        message = result.stderr.decode("utf-8", errors="replace").strip()
        if method == "GET" and "HTTP 404" in message:
            return None
        raise RuntimeError(f"GitHub API request failed ({method} {endpoint}): {message}")
    return result.stdout if binary else json.loads(result.stdout)


def verify_asset(repository, asset, path):
    if asset.get("state") != "uploaded" or asset.get("size") != path.stat().st_size:
        raise ValueError(f"Existing release asset is incomplete or different: {path.name}")
    expected = f"sha256:{digest(path.read_bytes())}"
    remote_digest = asset.get("digest")
    if remote_digest:
        if remote_digest != expected:
            raise ValueError(f"Existing release asset has a different SHA-256: {path.name}")
    else:
        data = gh_api(f"repos/{repository}/releases/assets/{asset['id']}", binary=True)
        if data is None or f"sha256:{digest(data)}" != expected:
            raise ValueError(f"Existing release asset has different bytes: {path.name}")


def find_release(repository, tag):
    prefix = f"repos/{repository}/releases"
    release = gh_api(f"{prefix}/tags/{tag}")
    if release is not None:
        return release
    # The REST tag endpoint finds published releases only. The authenticated
    # list endpoint also includes drafts, allowing a failed upload to resume.
    page = 1
    while True:
        releases = gh_api(f"{prefix}?per_page=100&page={page}")
        if not isinstance(releases, list):
            raise ValueError("Could not read releases while checking for an existing draft")
        matches = [item for item in releases if item.get("tag_name") == tag]
        if len(matches) > 1:
            raise ValueError("Multiple releases have the same tag; inspect the repository")
        if matches:
            return matches[0]
        if len(releases) < 100:
            return None
        page += 1


def ensure_forward_release(latest, tag, version):
    if latest and latest["tag_name"] != tag:
        latest_tag = latest["tag_name"]
        if not latest_tag.startswith("v") or stable_version(latest_tag[1:]) >= stable_version(version):
            raise ValueError("Refusing to replace latest with an older or unrecognized release")


def publish(metadata, paths):
    """Upload a complete draft before making it visible to Zotero's stable feed."""
    repository, tag, version = (metadata[key] for key in ("repository", "tag", "version"))
    prefix = f"repos/{repository}"
    repo = gh_api(prefix)
    if repo is None or repo.get("private") is not False:
        raise ValueError("Zotero automatic updates require a public GitHub repository")
    release = find_release(repository, tag)
    latest = gh_api(f"{prefix}/releases/latest")
    ensure_forward_release(latest, tag, version)
    if release is None:
        # Verify that the tag already exists; never create or move a release tag.
        if gh_api(f"{prefix}/git/ref/tags/{tag}") is None:
            raise ValueError(f"Publish the existing Git tag {tag} before releasing")
        release = gh_api(f"{prefix}/releases", method="POST", payload={
            "tag_name": tag, "name": f"Reading flow {version}",
            "body": f"Reading flow {version}\n\nInstall the versioned XPI in Zotero 9. "
                    "This release includes the automatic update feed and SHA-256 checksum.",
            "draft": True, "prerelease": False,
        })
    if release.get("prerelease") or release.get("tag_name") != tag:
        raise ValueError("Existing release is a prerelease or has the wrong tag")
    existing = gh_api(f"{prefix}/releases/{release['id']}/assets?per_page=100")
    by_name = {asset["name"]: asset for asset in existing}
    expected_names = {path.name for path in paths}
    if set(by_name) - expected_names:
        raise ValueError("Unexpected assets found; inspect the release before retrying")
    for path in paths:
        if path.name in by_name:
            verify_asset(repository, by_name[path.name], path)
        elif not release.get("draft"):
            raise ValueError("Published release is missing an asset; create a new version")
        else:
            endpoint = f"https://uploads.github.com/repos/{repository}/releases/{release['id']}/assets?name={path.name}"
            uploaded = gh_api(endpoint, method="POST", data_file=path)
            verify_asset(repository, uploaded, path)
    # Re-read the server inventory before publishing, including byte-level hashes.
    complete = gh_api(f"{prefix}/releases/{release['id']}/assets?per_page=100")
    by_name = {asset["name"]: asset for asset in complete}
    if set(by_name) != expected_names:
        raise ValueError("Release asset set is incomplete or changed during upload")
    for path in paths:
        verify_asset(repository, by_name[path.name], path)
    if release.get("draft"):
        # Check again after uploading, in case a maintainer published elsewhere.
        ensure_forward_release(gh_api(f"{prefix}/releases/latest"), tag, version)
        release = gh_api(f"{prefix}/releases/{release['id']}", method="PATCH", payload={
            "draft": False, "prerelease": False, "make_latest": "true",
        })
    print(f"Verified published release: {release['html_url']}")
    return release


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--tag", required=True)
    parser.add_argument("--xpi", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "output")
    parser.add_argument("--publish", action="store_true", help="Publish using authenticated gh; default is local only")
    args = parser.parse_args(argv)
    try:
        metadata, paths = prepare(args.repository, args.tag, args.xpi, args.output_dir)
        print(json.dumps(metadata, ensure_ascii=False, indent=2))
        if args.publish:
            publish(metadata, paths)
    except (ValueError, KeyError, OSError, RuntimeError) as error:
        parser.exit(1, f"Release failed: {error}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
