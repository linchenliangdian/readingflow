"""Run the isolated smoke test through Zotero's localhost-only debugger."""
import json
import argparse
from pathlib import Path
import socket
import time

ROOT = Path(__file__).resolve().parents[1]

def main(scenario="v2", inspect=False):
    TEST_ROOT = ROOT / "tmp" / ("zotero-test-sync" if scenario == "sync" else "zotero-test-v2" if scenario in ("v2", "cold") else "zotero-test")
    settings = json.loads((TEST_ROOT / "test-settings.json").read_text(encoding="utf-8")) if (TEST_ROOT / "test-settings.json").is_file() else {"port": 9223}
    deadline = time.time() + 30
    while True:
        try:
            sock = socket.create_connection(("127.0.0.1", settings["port"]), timeout=2)
            break
        except OSError:
            if time.time() >= deadline:
                raise
            time.sleep(0.5)
    sock.settimeout(15)
    stream = sock.makefile("rb")
    def receive():
        prefix = bytearray()
        while True:
            byte = stream.read(1)
            if not byte:
                raise EOFError("Debugger closed")
            if byte == b":":
                break
            prefix.extend(byte)
        return json.loads(stream.read(int(prefix)))
    def request(packet):
        payload = json.dumps(packet).encode()
        sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            reply = receive()
            if reply.get("from") == packet["to"] and "type" not in reply:
                if "error" in reply:
                    raise RuntimeError(reply)
                return reply
    def evaluate(actor, code):
        pending = request({"to": actor, "type": "evaluateJSAsync", "text": code})
        while True:
            reply = receive()
            if reply.get("type") == "evaluationResult" and reply.get("resultID") == pending["resultID"]:
                if reply.get("hasException"):
                    raise RuntimeError(reply)
                return reply
    hello = receive()
    print("Debugger greeting:", json.dumps(hello)[:300])
    descriptor = request({"to": "root", "type": "getProcess", "id": 0})
    print("Descriptor:", json.dumps(descriptor))
    form = descriptor.get("processDescriptor", descriptor.get("form", descriptor))
    target = request({"to": form["actor"], "type": "getTarget"})
    print("Target:", json.dumps(target)[:1500])
    target_form = target.get("process", target.get("target", target.get("form", target)))
    console_actor = target_form["consoleActor"]
    profile_code = 'JSON.stringify({profile:ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs").Zotero.Profile.dir,data:ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs").Zotero.DataDirectory.dir})'
    profile_reply = evaluate(console_actor, profile_code)
    print("Isolation:", json.dumps(profile_reply))
    identity = json.loads(profile_reply["result"])
    if Path(identity["profile"]).resolve() != (TEST_ROOT / "profile").resolve() or Path(identity["data"]).resolve() != (TEST_ROOT / "data").resolve():
        raise RuntimeError("Debugger does not belong to the expected isolated profile/data; refused execution")
    if inspect:
        expression = '(function(){const Z=ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs").Zotero;const w=Z.getMainWindow();return JSON.stringify({selected:w.Zotero_Tabs.selectedID,handles:Z.ReadingFlow?.inspect(w).map(h=>({kind:h.kind,item:h.item,noteKey:h.note?.key,panelSelected:h.deck.selectedPanel===h.panel,frameURL:h.frame.contentWindow?.location.href,frameReady:h.frame.contentDocument?.readyState,app:!!h.toolsWindow?.ReadingFlowApp,core:!!h.toolsWindow?.ReadingFlowCore,editorInstance:!!h.editor.getCurrentInstance(),editorInitialized:h.editor._initialized,toolsConfig:!!h.toolsWindow?.ReadingFlowConfig,body:h.frame.contentDocument?.body?.textContent?.slice(0,400)}))});})()'
        reply = evaluate(console_actor, expression)
        print("Inspection:", json.dumps(reply, ensure_ascii=False))
        (TEST_ROOT / "rdp-inspect.json").write_text(json.dumps(reply, ensure_ascii=False, indent=2), encoding="utf-8")
        sock.close()
        return
    runner_uri = (TEST_ROOT / "runner.js").as_uri()
    expression = '(function(){const Z=ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs").Zotero;const scope=new Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal());Object.assign(scope,{Services,IOUtils,PathUtils,ChromeUtils,setTimeout,clearTimeout,setInterval,clearInterval});Z.__readingFlowSmokeSandbox=scope;Services.scriptloader.loadSubScript(' + json.dumps(runner_uri) + ',scope,"UTF-8");return "isolated smoke dispatched";})()'
    reply = evaluate(console_actor, expression)
    print("Dispatch:", json.dumps(reply))
    (TEST_ROOT / "rdp-dispatch.json").write_text(json.dumps(reply, indent=2), encoding="utf-8")
    if scenario in ("v2", "cold", "sync"):
        # Keep this debugger connection and sandbox alive until the finite runner ends.
        deadline = time.time() + 300
        diagnosed = False
        while time.time() < deadline:
            current_result = json.loads((TEST_ROOT / settings.get("resultFilename", "result.json")).read_text(encoding="utf-8"))
            if current_result.get("status") in ("passed", "failed", "passed-awaiting-preview"):
                print("Smoke result:", json.dumps({"status": current_result["status"], "checks": len(current_result.get("checks", [])), "error": current_result.get("error")}, ensure_ascii=False), flush=True)
                break
            if not diagnosed and deadline - time.time() < 140:
                expression = '(function(){const Z=ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs").Zotero;const w=Z.getMainWindow();return JSON.stringify(Z.ReadingFlow?.inspect(w).map(h=>({kind:h.kind,item:h.item,frameURL:h.frame.contentWindow?.location.href,frameReady:h.frame.contentDocument?.readyState,app:!!h.toolsWindow?.ReadingFlowApp,editorInstance:!!h.editor.getCurrentInstance(),editorInitialized:h.editor._initialized,toolsConfig:!!h.toolsWindow?.ReadingFlowConfig})));})()'
                reply = evaluate(console_actor, expression)
                print("Runtime diagnosis:", json.dumps(reply, ensure_ascii=False), flush=True)
                (TEST_ROOT / "rdp-inspect.json").write_text(json.dumps(reply, ensure_ascii=False, indent=2), encoding="utf-8")
                diagnosed = True
            time.sleep(0.5)
        else:
            raise TimeoutError("The finite isolated smoke runner did not produce a result within 300 seconds")
    sock.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=("v1", "v2", "cold", "sync"), default="v2")
    parser.add_argument("--inspect", action="store_true", help="Read runtime handles without dispatching a second smoke test")
    args = parser.parse_args()
    main(args.scenario, args.inspect)
