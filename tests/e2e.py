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
# Dedicated port: the user's real Thunderbird may run Marionette on the
# default 2828 (tools/reinstall.py) — never collide with it.
MARIONETTE_PORT = 2829

EXTENSION_FILES = [
    "manifest.json",
    "ai.js",
    "prompts.js",
    "contacts.js",
    "attachments.js",
    "background.js",
    "compose.js",
    "options.html",
    "options.js",
    "options.css",
    "icons",
]

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
    # Bind THIS instance's Marionette to the dedicated harness port.
    "marionette.port": 2829,
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
        # Safety: prove we are talking to OUR throwaway instance, never the
        # user's real Thunderbird.
        profile_path = self.m.execute_script(
            'return Services.dirsvc.get("ProfD", Ci.nsIFile).path;'
        )
        if profile_path != str(PROFILE):
            self.m.delete_session()
            raise RuntimeError(
                f"Marionette belongs to the wrong profile ({profile_path}) — aborting"
            )
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
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\r", "\\r")
        .replace("\n", "\\n")
        .replace("\t", "\\t")
    )
    return '"' + escaped + '"'


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
        const doc = cw.document.getElementById("messageEditor").contentDocument;
        // Insert through the editor's command system: assigning innerHTML
        // behind its back races with editor init and gets wiped.
        doc.defaultView.focus();
        doc.execCommand("selectAll", false, null);
        doc.execCommand("insertHTML", false, {json_str(body_html)});
        return null;"""
    )
    time.sleep(1.5)  # let the compose script settle


def run_polish_via_button(h, timeout=90):
    """Click the MagicTrick button (menu-typed) and run 'Polish this draft'.

    This is the exact path a user takes: the button's native dropdown opens
    (menu-typed compose action) and its first entry fires the pipeline.
    Returns the deadline timestamp for the change wait.
    """
    opened = h.exec(
        """const cw = Services.wm.getMostRecentWindow("msgcompose");
           const b = cw.document.getElementById("magictrick_giuliocsr_github_io-composeAction-toolbarbutton");
           if (!b) throw new Error("MagicTrick button not found");
           b.click();
           const deadline = Date.now() + 5000;
           return (async () => {
             while (Date.now() < deadline) {
               await new Promise((r) => setTimeout(r, 200));
               const popup = b.querySelector("menupopup");
               if (popup && popup.state === "open") return true;
             }
             return false;
           })();"""
    )
    if not opened:
        raise RuntimeError("button dropdown did not open")
    clicked = h.exec(
        """const cw = Services.wm.getMostRecentWindow("msgcompose");
           const b = cw.document.getElementById("magictrick_giuliocsr_github_io-composeAction-toolbarbutton");
           const item = [...b.querySelectorAll("menuitem")]
               .find((mi) => (mi.label || "").includes("Polish this draft"));
           if (!item) return { error: "menu item not found: " +
               [...b.querySelectorAll("menuitem")].map((mi) => mi.label).join(",") };
           item.doCommand();
           return { ok: true };"""
    )
    if not (clicked and clicked.get("ok")):
        raise RuntimeError(clicked and clicked.get("error", "menu activation failed"))
    return time.time() + timeout


def activate_menu_item(h):
    """Right-click the MagicTrick button and run the 'with prompt' menu item.

    Synthetic mouse clicks on extension toolbar buttons are rejected by
    Thunderbird's trust checks, but the context menu opens and the extension
    menu item's doCommand() fires the real handler — the same pipeline as a
    button click.
    """
    h.exec(
        """const cw = Services.wm.getMostRecentWindow("msgcompose");
           const b = cw.document.getElementById("magictrick_giuliocsr_github_io-composeAction-toolbarbutton");
           if (!b) throw new Error("MagicTrick button not found in compose toolbar");
           const rect = b.getBoundingClientRect();
           b.dispatchEvent(new cw.MouseEvent("contextmenu", {
               bubbles: true, cancelable: true, view: cw, button: 2,
               clientX: rect.x + 5, clientY: rect.y + 5 }));
           return null;"""
    )
    clicked = h.exec(
        """const cw = Services.wm.getMostRecentWindow("msgcompose");
           const item = [...cw.document.querySelectorAll("menuitem")]
               .find((mi) => (mi.label || "").includes("MagicTrick with prompt"));
           if (!item) return { error: "menu item not found" };
           item.doCommand();
           const popup = item.closest("menupopup");
           if (popup && typeof popup.hidePopup === "function") popup.hidePopup();
           return { ok: true };"""
    )
    if not (clicked and clicked.get("ok")):
        raise RuntimeError(clicked and clicked.get("error", "menu activation failed"))


def run_with_prompt(h, instruction, timeout=90):
    """Activate via the menu, fill the prompt bar, press Enter, wait for the edit."""
    activate_menu_item(h)
    deadline = time.time() + 15
    while time.time() < deadline:
        bar = h.exec(
            """const cw = Services.wm.getMostRecentWindow("msgcompose");
               const ed = cw.document.getElementById("messageEditor");
               const doc = ed.contentDocument;
               const bar = doc.getElementById("magictrick-bar");
               return bar ? { input: !!bar.querySelector("input") } : null;"""
        )
        if bar and bar.get("input"):
            break
        time.sleep(0.5)
    else:
        raise RuntimeError("prompt bar never appeared")
    h.exec(
        f"""const cw = Services.wm.getMostRecentWindow("msgcompose");
            const doc = cw.document.getElementById("messageEditor").contentDocument;
            const input = doc.getElementById("magictrick-bar").querySelector("input");
            input.value = {json_str(instruction)};
            input.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", {{
                key: "Enter", bubbles: true, cancelable: true }}));
            return null;"""
    )
    return time.time() + timeout


def read_editor(h):
    return h.exec(
        f"""{SERVICES}
        const cw = Services.wm.getMostRecentWindow("msgcompose");
        const doc = cw.document.getElementById("messageEditor").contentDocument;
        return {{ html: doc.body.innerHTML, text: doc.body.textContent || "" }};"""
    )


def wait_for_editor_change(h, original_html, timeout=90):
    """Wait until the editor html differs; returns (state, elapsed_seconds)."""
    start = time.time()
    while True:
        time.sleep(0.25)
        state = read_editor(h)
        if state["html"] != original_html:
            return state, time.time() - start
        if time.time() - start > timeout:
            return state, time.time() - start


FIX_INSTRUCTION = (
    "Fix ONLY grammar, spelling and punctuation in the draft above the quoted "
    "message. Keep meaning, tone, paragraphs, the quote and the signature "
    "untouched. Reply with the corrected draft text only."
)


def test_fix_and_undo(h):
    open_compose(h, BAD_DRAFT)
    before = read_editor(h)
    deadline = run_polish_via_button(h)
    after, elapsed = wait_for_editor_change(h, before["html"])

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
    fix_ok = fix_ok and elapsed < 5.0
    report("grammar fix: draft corrected, quote and signature untouched", fix_ok,
           f"{elapsed:.1f}s" if fix_ok else f"{elapsed:.1f}s — text: " + text[:400])

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
    run_with_prompt(
        h,
        "The draft is empty. Write the user's reply to the quoted email below: "
        "professional, concise, matching the thread's language. "
        "Reply with the reply text only.",
    )
    after, elapsed = wait_for_editor_change(h, before["html"])

    import re
    reply_match = re.search(r"<p[^>]*>[^<]{8,}", after["html"])
    reply_index = reply_match.start() if reply_match else -1
    quote_index = after["html"].find("moz-cite-prefix")
    ok = (
        reply_index != -1
        and quote_index != -1
        and reply_index < quote_index
        and "Can we meet tomorrow at 10" in after["text"]
        and len(" ".join(after["text"].split())) > 25
    )
    ok = ok and elapsed < 5.0
    report("empty draft: contextual auto-reply generated above intact quote", ok,
           f"{elapsed:.1f}s" if ok else f"{elapsed:.1f}s — html: " + after["html"][:400])


RECIPIENT_DRAFT = (
    "<p>Hello Pietro, how are you?</p>"
    "<p>Giorgio has attached the correspondence. Attached, you can find my reference letters.</p>"
)


def seed_contacts(h):
    """Two contacts in the Personal Address Book, via Thunderbird's own services."""
    seeded = h.exec(
        """const { MailServices } = ChromeUtils.importESModule(
               "resource:///modules/MailServices.sys.mjs");
           const book = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
           const add = (displayName, email) => {
             if (book.getCardFromProperty("PrimaryEmail", email, false)) return;
             const card = Cc["@mozilla.org/addressbook/cardproperty;1"]
               .createInstance(Ci.nsIAbCard);
             card.displayName = displayName;
             card.setProperty("FirstName", displayName.split(" ")[0]);
             card.setProperty("LastName", displayName.split(" ").slice(1).join(" "));
             card.primaryEmail = email;
             book.addCard(card);
           };
           add("Pietro Bianchi", "pietro.bianchi@example.com");
           add("Giorgio Rossi", "giorgio.rossi@example.com");
           return "seeded";"""
    )
    if seeded != "seeded":
        raise RuntimeError(f"contact seeding failed: {seeded}")


def test_recipient_assistant(h):
    open_compose(h, RECIPIENT_DRAFT)
    before = read_editor(h)
    run_with_prompt(
        h,
        "Fix ONLY grammar, spelling and punctuation. Keep everything else "
        "unchanged. Reply with the corrected draft text only.",
    )
    after, elapsed = wait_for_editor_change(h, before["html"])
    # Recipients land just after the text — poll for them instead of guessing.
    read_fields = """const cw = Services.wm.getMostRecentWindow("msgcompose");
        const read = (rowId) => {
          const row = cw.document.getElementById(rowId);
          if (!row) return "";
          return [...row.querySelectorAll("input")].map((i) => i.value.toLowerCase()).join(",");
        };
        return { to: read("addressRowTo"), cc: read("addressRowCc") };"""
    deadline = time.time() + 6
    fields = h.exec(read_fields)
    while time.time() < deadline and not (fields["to"] or fields["cc"]):
        time.sleep(0.5)
        fields = h.exec(read_fields)
    ok = (
        elapsed < 5.0
        and "pietro.bianchi@example.com" in fields["to"]
        and "giorgio.rossi@example.com" in fields["cc"]
    )
    report(
        "recipient assistant: Pietro → To, Giorgio → Cc from the address book",
        ok,
        f"{elapsed:.1f}s — to: {fields['to'] or '(none)'} · cc: {fields['cc'] or '(none)'}"
        f" — text: {after['text'][:70]}",
    )


FORMAT_DRAFT = (
    "<p>Hi Pietro, how are you?</p>"
    '<ul><li>Attention to the police</li><li>Amber alert does not vork</li></ul>'
)


def seed_history_message(h):
    """A message from Alessia (NOT an address-book contact) in Local Folders,
    so recipient resolution must come from message history."""
    raw = (
        "From: Alessia Verdi <alessia.verdi@gmail.com>\r\n"
        "To: MagicTrick Tester <tester@magictrick.local>\r\n"
        "Subject: Project update\r\n"
        "Message-ID: <mt-history-1@magictrick.local>\r\n"
        "Date: Tue, 16 Sep 2026 12:00:00 +0200\r\n"
        "\r\n"
        "The project is going well, talk soon.\r\n"
    )
    seeded = h.exec(
        f"""const {{ MailServices }} = ChromeUtils.importESModule(
               "resource:///modules/MailServices.sys.mjs");
           const root = MailServices.accounts.localFoldersServer.rootFolder;
           let folder = root.getChildNamed("MTHistory");
           if (!folder) {{
             root.createSubfolder("MTHistory", null);
             folder = root.getChildNamed("MTHistory");
           }}
           if (!folder) throw new Error("could not create MTHistory folder");
           folder.QueryInterface(Ci.nsIMsgLocalMailFolder)
               .addMessage({json_str(raw)});
           return "seeded";"""
    )
    if seeded != "seeded":
        raise RuntimeError(f"history seeding failed: {seeded}")


def test_format_preserved(h):
    open_compose(h, FORMAT_DRAFT)
    before = read_editor(h)
    run_polish_via_button(h)
    after, elapsed = wait_for_editor_change(h, before["html"])
    text = after["text"]
    html = after["html"]
    ok = (
        elapsed < 5.0
        and "<ul>" in html
        and "<li>" in html
        and "vork" not in text
        and "work" in text.lower()
        and "Attention to the police" in text
    )
    report(
        "format preservation: bullet list survives the AI round trip",
        ok,
        f"{elapsed:.1f}s — html: {html[:200]}",
    )


HISTORY_DRAFT = (
    "<p>Hi Pietro, how's it going?</p>"
    "<p>Alessia will join the call tomorrow.</p>"
)


def test_recipient_from_history(h):
    open_compose(h, HISTORY_DRAFT)
    before = read_editor(h)
    run_polish_via_button(h)
    wait_for_editor_change(h, before["html"])
    read_fields = """const cw = Services.wm.getMostRecentWindow("msgcompose");
        const read = (rowId) => {
          const row = cw.document.getElementById(rowId);
          if (!row) return "";
          return [...row.querySelectorAll("input")].map((i) => i.value.toLowerCase()).join(",");
        };
        return { to: read("addressRowTo"), cc: read("addressRowCc") };"""
    deadline = time.time() + 6
    fields = h.exec(read_fields)
    while time.time() < deadline and not fields["cc"]:
        time.sleep(0.5)
        fields = h.exec(read_fields)
    ok = (
        "pietro.bianchi@example.com" in fields["to"]
        and "alessia.verdi@gmail.com" in fields["cc"]
    )
    report(
        "recipient from message history (not in address book)",
        ok,
        f"to: {fields['to'] or '(none)'} · cc: {fields['cc'] or '(none)'}",
    )


def main():
    if shutil.which(THUNDERBIRD) is None:
        sys.exit(f"Thunderbird binary not found: {THUNDERBIRD}")
    h = Harness()
    try:
        h.setup()
        seed_contacts(h)  # before any run: the extension caches contacts
        seed_history_message(h)
        test_fix_and_undo(h)
        test_auto_reply(h)
        test_recipient_assistant(h)
        test_format_preserved(h)
        test_recipient_from_history(h)
    finally:
        h.teardown()
    passed = sum(results)
    print(f"\n{passed}/{len(results)} passed" + (" — all good ✨" if passed == len(results) else " — FAILURES above"))
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
