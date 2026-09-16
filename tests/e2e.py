#!/usr/bin/env python3
"""
MagicTrick — end-to-end GUI test harness.

Launches Thunderbird with a throwaway profile (seeded with a test account and
the extension installed unpacked — the profile lives in the snap-writable home
area and is deleted afterwards, so the real Thunderbird is never touched).
Automation goes through Marionette (Thunderbird's own automation channel,
driven here with the reference marionette_driver): it opens real compose
windows, sets the draft, CLICKS THE REAL MagicTrick toolbar button, and
asserts on the editor DOM.

Covered: grammar fix, quote/signature preservation, empty-draft auto-reply,
and single-Ctrl+Z undo. (AI chain fallback: tests/ai.test.mjs.
Menu + prompt bar UI: tests/MANUAL.md.)

Usage:  python3 tests/e2e.py        (requires: pip install marionette_driver)
"""
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from marionette_driver.marionette import Marionette

ROOT = Path(__file__).resolve().parent.parent
ADDON_ID = "magictrick@giuliocsr.github.io"
# Snap Thunderbird cannot see /tmp — keep the profile inside its home area.
PROFILE = Path.home() / "snap" / "thunderbird" / "common" / "magictrick-e2e-profile"
THUNDERBIRD = os.environ.get("THUNDERBIRD_BIN", "thunderbird")
MARIONETTE_PORT = 2828

EXTENSION_FILES = ["manifest.json", "ai.js", "prompts.js", "background.js", "compose.js", "icons"]

PREFS = {
    "extensions.autoDisableScopes": 0,
    "extensions.startupScanScopes": 5,
    "mail.provider.suppress_dialog_on_startup": True,
    "mailnews.start_page.enabled": False,
    "mail.shell.checkDefaultClient": False,
    "app.update.enabled": False,
    # Minimal test account so compose windows can open (mozmill-style seed).
    "mail.account.account1.server": "server1",
    "mail.account.account2.identities": "id1",
    "mail.account.account2.server": "server2",
    "mail.accountmanager.accounts": "account1,account2",
    "mail.accountmanager.defaultaccount": "account2",
    "mail.accountmanager.localfoldersserver": "server1",
    "mail.identity.id1.fullName": "MagicTrick Tester",
    "mail.identity.id1.useremail": "tester@magictrick.local",
    "mail.identity.id1.valid": True,
    "mail.server.server1.hostname": "Local Folders",
    "mail.server.server1.type": "none",
    "mail.server.server1.userName": "nobody",
    "mail.server.server2.hostname": "mail.magictrick.local",
    "mail.server.server2.type": "pop3",
    "mail.server.server2.userName": "tester",
    # Never try to connect to the fake server (avoids password prompts).
    "mail.server.server2.login_at_startup": False,
    "mail.server.server2.check_new_mail": False,
}

# The chrome-privileged Marionette sandbox already exposes Services as a global.
SERVICES = ""

QUOTE = (
    '<div class="moz-cite-prefix">On 09/16/2026 05:00 PM, Alice Martin wrote:</div>'
    '<blockquote type="cite"><p>Alice original message words that must never change.</p></blockquote>'
    '<pre class="moz-signature">-- <br>Giulio</pre>'
)
BAD_DRAFT = (
    "<p>He go to store yesterday and buyed three apple for hisself.</p>"
    "<p>I hopes he share them with we.</p>" + QUOTE
)
QUOTE_ONLY = (
    '<div class="moz-cite-prefix">On 09/16/2026 05:00 PM, Alice Martin wrote:</div>'
    '<blockquote type="cite"><p>Can we meet tomorrow at 10 to discuss the Q3 budget? '
    "Please bring the latest numbers.</p></blockquote>"
)

results = []


def report(name, ok, detail=""):
    results.append(ok)
    indent = "\n         ".join(detail.splitlines())
    print(f"  {'✅ PASS' if ok else '❌ FAIL'}  {name}" + (f"\n         {indent}" if detail else ""))


class Harness:
    def __init__(self):
        self.tb = None
        self.m = None

    def setup(self):
        shutil.rmtree(PROFILE, ignore_errors=True)
        ext_dir = PROFILE / "extensions" / ADDON_ID
        ext_dir.mkdir(parents=True)
        (PROFILE / "prefs.js").write_text(
            "\n".join(
                f'user_pref("{k}", {json_str(v)});' for k, v in PREFS.items()
            )
            + "\n"
        )
        for name in EXTENSION_FILES:
            src = ROOT / name
            dst = ext_dir / name
            if src.is_dir():
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)

        print("Launching headless Thunderbird with throwaway profile…")
        self.tb = subprocess.Popen(
            [
                THUNDERBIRD,
                "-no-remote",
                "-headless",
                "-profile",
                str(PROFILE),
                "-marionette",
                "-remote-allow-system-access",  # required for chrome-context scripting
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        deadline = time.time() + 90
        while True:
            try:
                self.m = Marionette(host="127.0.0.1", port=MARIONETTE_PORT)
                self.m.start_session()
                break
            except Exception:
                if time.time() > deadline:
                    raise RuntimeError("Marionette never came up")
                time.sleep(1)
        self.m.set_context(Marionette.CONTEXT_CHROME)
        try:
            self.m._send_message("WebDriver:SetTimeouts", {"script": 240000})
        except Exception:
            pass  # the default script timeout is generous enough on most builds
        print("Marionette connected. Running scenarios…\n")

    def teardown(self):
        try:
            self.exec(
                f"""{SERVICES}
                for (const cw of Services.wm.getEnumerator("msgcompose")) {{
                  try {{
                    cw.document.getElementById("messageEditor").contentDocument.body.innerHTML = "";
                    cw.close();
                  }} catch (e) {{}}
                }}
                return null;"""
            )
        except Exception:
            pass
        try:
            self.m and self.m.delete_session()
        except Exception:
            pass
        if self.tb:
            self.tb.terminate()
            try:
                self.tb.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.tb.kill()
        shutil.rmtree(PROFILE, ignore_errors=True)

    def exec(self, script):
        """Run chrome-privileged JS; async code just returns a promise."""
        return self.m.execute_script(f"return (async () => {{\n{script}\n}})();")


def json_str(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def open_compose(h, body_html):
    # NOTE: the window-opening chain must be awaited INSIDE the chrome script —
    # Marionette destroys the sandbox when the script returns, cancelling any
    # pending work it spawned.
    diagnostics = None
    for attempt in range(2):
        found = h.exec(
            """const win = Services.wm.getMostRecentWindow("mail:3pane");
               if (!win) throw new Error("no 3pane window");
               let openError = null;
               try {
                 if (typeof win.MsgNewMessage === "function") win.MsgNewMessage();
                 else win.goDoCommand("cmd_newMessage");
               } catch (e) { openError = String(e); }
               const deadline = Date.now() + 15000;
               return (async () => {
                 while (Date.now() < deadline) {
                   await new Promise((r) => setTimeout(r, 300));
                   const cw = Services.wm.getMostRecentWindow("msgcompose");
                   if (cw && cw.document.getElementById("messageEditor")) return { ok: true };
                 }
                 const windows = [...Services.wm.getEnumerator(null)].map(
                   (w) => w.document.documentElement.getAttribute("windowtype") || w.location.href);
                 const console_ = [];
                 try {
                   Services.console.getMessageLog().slice(-15).forEach((m) => {
                     if (m.message && /error|fail/i.test(m.message)) console_.push(m.message.slice(0, 200));
                   });
                 } catch (e) {}
                 return { ok: false, openError, windows, console_ };
               })();"""
        )
        if found and found.get("ok"):
            break
        diagnostics = found
    else:
        raise RuntimeError(f"compose window never appeared: {diagnostics}")
    h.exec(
        f"""{SERVICES}
        const cw = Services.wm.getMostRecentWindow("msgcompose");
        cw.document.getElementById("messageEditor").contentDocument.body.innerHTML = {json_str(body_html)};
        return null;"""
    )
    time.sleep(1.5)  # let the compose script settle at document_idle


def click_magic_trick(h):
    clicked = h.exec(
        f"""{SERVICES}
        const cw = Services.wm.getMostRecentWindow("msgcompose");
        const button = [...cw.document.querySelectorAll("toolbarbutton")].find((b) =>
          (b.getAttribute("tooltiptext") || "").startsWith("MagicTrick"));
        if (!button) return {{ error: "MagicTrick button not found in compose toolbar" }};
        // Toolbar buttons act on the command event; synthetic clicks alone
        // are not always enough.
        button.dispatchEvent(new cw.Event("command", {{ bubbles: true }}));
        button.click();
        if (typeof button.doCommand === "function") button.doCommand();
        return {{ ok: true }};"""
    )
    if not (clicked and clicked.get("ok")):
        raise RuntimeError(clicked and clicked.get("error", "button click failed"))


def read_editor(h):
    return h.exec(
        f"""{SERVICES}
        const cw = Services.wm.getMostRecentWindow("msgcompose");
        const doc = cw.document.getElementById("messageEditor").contentDocument;
        return {{ html: doc.body.innerHTML, text: doc.body.textContent || "" }};"""
    )


def wait_for_editor_change(h, original_html, timeout=90):
    start = time.time()
    while True:
        time.sleep(2)
        state = read_editor(h)
        if state["html"] != original_html:
            return state
        if time.time() - start > timeout:
            return state


def test_fix_and_undo(h):
    open_compose(h, BAD_DRAFT)
    before = read_editor(h)
    click_magic_trick(h)
    after = wait_for_editor_change(h, before["html"])

    text = after["text"]
    fix_ok = (
        "went to the store" in text
        and "bought" in text
        and "apples" in text
        and "buyed" not in text
        and "Alice original message words that must never change." in text
        and "Alice Martin" in text
        and "Giulio" in text
        and "moz-signature" in after["html"]
    )
    report("grammar fix: draft corrected, quote and signature untouched", fix_ok,
           "" if fix_ok else "text: " + text[:400])

    undone = h.exec(
        f"""{SERVICES}
        const cw = Services.wm.getMostRecentWindow("msgcompose");
        const doc = cw.document.getElementById("messageEditor").contentDocument;
        doc.execCommand("undo");
        return doc.body.innerHTML;"""
    )
    report("undo: one editor undo restores the exact previous draft", undone == before["html"],
           "" if undone == before["html"] else f"before: {before['html'][:200]}\nundone: {undone[:200]}")


def test_auto_reply(h):
    open_compose(h, QUOTE_ONLY)
    before = read_editor(h)
    click_magic_trick(h)
    after = wait_for_editor_change(h, before["html"])

    import re
    reply_match = re.search(r"<p[^>]*>[^<]{25,}", after["html"])
    reply_index = reply_match.start() if reply_match else -1
    quote_index = after["html"].find("moz-cite-prefix")
    ok = (
        reply_index != -1
        and quote_index != -1
        and reply_index < quote_index
        and "Can we meet tomorrow at 10" in after["text"]
        and len(" ".join(after["text"].split())) > 60
    )
    report("empty draft: contextual auto-reply generated above intact quote", ok,
           "" if ok else "html: " + after["html"][:400])


def main():
    if shutil.which(THUNDERBIRD) is None:
        sys.exit(f"Thunderbird binary not found: {THUNDERBIRD}")
    h = Harness()
    try:
        h.setup()
        test_fix_and_undo(h)
        test_auto_reply(h)
    finally:
        h.teardown()
    passed = sum(results)
    print(f"\n{passed}/{len(results)} passed" + (" — all good ✨" if passed == len(results) else " — FAILURES above"))
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
