"""Prepare or dispatch a public-feed update test in a disposable Zotero profile.

Preparation is offline. Dispatch intentionally accesses the manifest's public
GitHub feed, and must only run after that exact release has been published.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import socket
import time
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = ROOT / "tmp" / "zotero-test-update"
SETTINGS = TEST_ROOT / "test-settings.json"


def prepare(port):
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    app = manifest["applications"]["zotero"]
    repository = "linchenliangdian/readingflow"
    url = f"https://github.com/{repository}/releases/latest/download/updates.json"
    if app["id"] != "reading-flow@local" or app["update_url"] != url:
        raise ValueError("This finite test expects the approved public Reading flow repository")
    package = ROOT / "output" / f"reading-flow-{manifest['version']}.xpi"
    with ZipFile(package) as archive:
        if json.loads(archive.read("manifest.json")) != manifest:
            raise ValueError("Build the current reviewed manifest before testing")
    profile, data = TEST_ROOT / "profile", TEST_ROOT / "data"
    if (profile / "prefs.js").exists() or (data / "zotero.sqlite").exists():
        raise ValueError("Disposable test profile was already used; preserve its result before preparing another run")
    for folder in (profile / "extensions", data):
        folder.mkdir(parents=True, exist_ok=True)
    baseline = TEST_ROOT / "baseline.xpi"
    baseline_manifest = dict(manifest, version="2.1.0", name="Reading flow isolated update baseline")
    baseline_source = '''async function startup({id}) {
  await Zotero.initializationPromise;
  var {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  var addon = await AddonManager.getAddonByID(id);
  if (addon) addon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_DISABLE;
}
function shutdown() {} function install() {} function uninstall() {}
function onMainWindowLoad() {} function onMainWindowUnload() {}
'''
    with ZipFile(baseline, "w", ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(baseline_manifest))
        archive.writestr("bootstrap.js", baseline_source)
        archive.writestr("content/icons/pyramid.svg", (ROOT / "content/icons/pyramid.svg").read_bytes())
    prefs = {
        "extensions.zotero.useDataDir": True, "extensions.zotero.dataDir": str(data),
        "extensions.autoDisableScopes": 0, "extensions.startupScanScopes": 1,
        "browser.dom.window.dump.enabled": True, "devtools.chrome.enabled": True,
        "devtools.debugger.remote-enabled": True, "devtools.debugger.prompt-connection": False,
        "devtools.debugger.force-local": True, "devtools.debugger.remote-port": port,
        "extensions.zotero.firstRun2": False, "extensions.zotero.firstRunGuidance": False,
        "extensions.zotero.showPostUpgradeBanner": False, "extensions.zotero.sync.autoSync": False,
        "extensions.zotero.httpServer.enabled": False, "extensions.zotero.automaticScraperUpdates": False,
        "extensions.zotero.retractions.enabled": False, "extensions.zotero.streaming.enabled": False,
        "extensions.zotero.triggerProxyAuthentication": False,
        "extensions.zoteroOpenOfficeIntegration.skipInstallation": True,
        "extensions.zoteroWinWordIntegration.skipInstallation": True,
        "app.update.auto": False, "extensions.update.enabled": True,
        "extensions.update.autoUpdateDefault": True, "browser.shell.checkDefaultBrowser": False,
    }
    (profile / "user.js").write_text("\n".join(
        f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k, v in prefs.items()) + "\n", encoding="utf-8")
    settings = {
        "profile": str(profile), "data": str(data), "result": str(TEST_ROOT / "result.json"),
        "baseline": str(baseline), "baselineVersion": baseline_manifest["version"],
        "package": str(package), "version": manifest["version"], "addonId": app["id"],
        "assetURL": f"https://github.com/{repository}/releases/download/v{manifest['version']}/{package.name}",
        "sha256": hashlib.sha256(package.read_bytes()).hexdigest(), "port": port,
    }
    source = (ROOT / "tests/zotero-update-bootstrap.js").read_text(encoding="utf-8")
    source = source.replace("__UPDATE_SETTINGS__", json.dumps(settings))
    source = 'const {Zotero}=ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");\n' + source
    source += "\nZotero.__readingFlowUpdatePromise=runUpdateTest();\n"
    (TEST_ROOT / "runner.js").write_text(source, encoding="utf-8")
    SETTINGS.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    Path(settings["result"]).write_text(json.dumps({"status": "awaiting-public-release"}), encoding="utf-8")
    print(json.dumps(settings, indent=2))


def dispatch():
    settings = json.loads(SETTINGS.read_text(encoding="utf-8"))
    sock = None
    deadline = time.time() + 45
    while time.time() < deadline:
        try:
            sock = socket.create_connection(("127.0.0.1", settings["port"]), timeout=2)
            break
        except OSError:
            time.sleep(0.5)
    if sock is None:
        raise TimeoutError("Start the prepared isolated Zotero debugger first")
    sock.settimeout(30)
    stream = sock.makefile("rb")

    def receive():
        prefix = bytearray()
        while True:
            byte = stream.read(1)
            if not byte:
                raise EOFError("Debugger closed")
            if byte == b":":
                return json.loads(stream.read(int(prefix)))
            prefix.extend(byte)

    def request(packet):
        payload = json.dumps(packet).encode()
        sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            reply = receive()
            if reply.get("from") == packet["to"] and "type" not in reply:
                if "error" in reply:
                    raise RuntimeError(reply)
                return reply

    def evaluate(actor, expression):
        pending = request({"to": actor, "type": "evaluateJSAsync", "text": expression})
        while True:
            reply = receive()
            if reply.get("type") == "evaluationResult" and reply.get("resultID") == pending["resultID"]:
                if reply.get("hasException"):
                    raise RuntimeError(reply)
                return reply["result"]

    try:
        receive()
        descriptor = request({"to": "root", "type": "getProcess", "id": 0})
        form = descriptor.get("processDescriptor", descriptor.get("form", descriptor))
        target = request({"to": form["actor"], "type": "getTarget"})
        target_form = target.get("process", target.get("target", target.get("form", target)))
        actor = target_form["consoleActor"]
        code = 'JSON.stringify({profile:ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs").Zotero.Profile.dir,data:ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs").Zotero.DataDirectory.dir,processID:Services.appinfo.processID})'
        identity = json.loads(evaluate(actor, code))
        for key in ("profile", "data"):
            if Path(identity[key]).resolve() != Path(settings[key]).resolve():
                raise RuntimeError("Debugger belongs to a different profile/data; refused all mutations")
        print("Verified isolation:", json.dumps(identity), flush=True)
        (TEST_ROOT / "process-identity.json").write_text(json.dumps(identity, indent=2), encoding="utf-8")
        code = '(function(){const Z=ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs").Zotero;const scope=new Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal());Object.assign(scope,{Services,IOUtils,PathUtils,ChromeUtils,setTimeout,clearTimeout,setInterval,clearInterval});Z.__readingFlowUpdateSandbox=scope;Services.scriptloader.loadSubScript(' + json.dumps((TEST_ROOT / "runner.js").as_uri()) + ',scope,"UTF-8");return "public update test dispatched";})()'
        print(evaluate(actor, code), flush=True)
        deadline = time.time() + 270
        while time.time() < deadline:
            result = json.loads(Path(settings["result"]).read_text(encoding="utf-8"))
            if result.get("status") in ("passed", "failed"):
                print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
                if result["status"] != "passed":
                    raise RuntimeError("Public update test failed")
                return
            time.sleep(0.5)
        raise TimeoutError("Public update runner did not finish")
    finally:
        stream.close()
        sock.close()


def finalize():
    """Check durable bytes only after the guarded native process has exited."""
    settings = json.loads(SETTINGS.read_text(encoding="utf-8"))
    identity = json.loads((TEST_ROOT / "process-identity.json").read_text(encoding="utf-8"))
    proof = json.loads((TEST_ROOT / "process-exit-check.json").read_text(encoding="utf-8-sig"))
    if proof.get("count") != 0 or proof.get("verifiedPID") != identity["processID"]:
        raise ValueError("First confirm no exact isolated profile/data/PID process remains")
    result = json.loads(Path(settings["result"]).read_text(encoding="utf-8"))
    if result.get("status") != "passed" or not all(check["passed"] for check in result["checks"]):
        raise ValueError("The native public-update test has not passed")
    checks = []

    def check(name, condition):
        checks.append({"name": name, "passed": bool(condition)})
        if not condition:
            raise ValueError("Post-exit check failed: " + name)

    installed = Path(settings["profile"]) / "extensions" / (settings["addonId"] + ".xpi")
    content = installed.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    check("installed public XPI SHA-256 survives process exit", digest == settings["sha256"])
    check("installed public XPI matches original release bytes", content == Path(settings["package"]).read_bytes())
    with ZipFile(installed) as archive:
        manifest = json.loads(archive.read("manifest.json"))
    check("persisted manifest is the correct addon and released version",
          manifest["version"] == settings["version"] and manifest["applications"]["zotero"]["id"] == settings["addonId"])
    extensions = json.loads((Path(settings["profile"]) / "extensions.json").read_text(encoding="utf-8"))
    addons = [addon for addon in extensions["addons"] if addon["id"] == settings["addonId"]]
    check("exactly one installed Reading flow record", len(addons) == 1)
    addon = addons[0]
    check("native persisted version and public download source match release",
          addon["version"] == settings["version"] and addon["sourceURI"] == settings["assetURL"])
    check("later explicit disable choice is durable", addon["applyBackgroundUpdates"] == 0)
    prefs = (Path(settings["profile"]) / "prefs.js").read_text(encoding="utf-8")
    check("migration preference is durable", bool(re.search(
        r'user_pref\("extensions\.zotero\.readingFlow\.githubUpdatesMigrationVersion",\s*1\);', prefs)))
    result["postExitChecks"] = checks
    result["actualInstalledSHA256"] = digest
    result["processExit"] = proof
    output = ROOT / "output" / ("zotero-update-results-" + settings["version"] + ".json")
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "passed", "nativeChecks": len(result["checks"]),
                      "postExitChecks": len(checks), "sha256": digest, "evidence": str(output)}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "dispatch", "finalize"))
    parser.add_argument("--port", type=int, default=9224)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.port)
    elif args.command == "dispatch":
        dispatch()
    else:
        finalize()
