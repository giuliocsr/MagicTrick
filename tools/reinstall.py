#!/usr/bin/env python3
"""
MagicTrick — deploy script.

Builds magictrick.xpi from the working tree and (re)installs it into the user's
real Thunderbird via Marionette:

  - Thunderbird already running with Marionette → live reinstall, no restart
  - Thunderbird running without Marionette      → clean quit (SIGTERM) and
                                                  relaunch with -marionette
  - Thunderbird not running                     → launch with -marionette

The script always uninstalls first (ignored when not installed) and then
installs the fresh build, so it is safe to run after every edit.

Usage:   python3 tools/reinstall.py [--yes]
Requires: pip install --break-system-packages marionette_driver

Notes:
  - Thunderbird is relaunched with the Marionette port open on localhost only.
    Subsequent runs reuse it and no longer need to restart Thunderbird.
  - A clean SIGTERM quit is used (same as quitting the app; drafts autosave).
"""
import argparse
import shutil
import signal
import socket
import subprocess
import sys
import time
import zipfile
from pathlib import Path

from marionette_driver.marionette import Marionette

ROOT = Path(__file__).resolve().parent.parent
XPI = ROOT / "magictrick.xpi"
DROPDOWN_XPI = ROOT / "dropdown" / "magictrick-dropdown.xpi"
ADDON_ID = "magictrick@giuliocsr.github.io"
DROPDOWN_ADDON_ID = "magictrick-menu@giuliocsr.github.io"
PORT = 2828
THUNDERBIRD = "thunderbird"
PACKAGE_FILES = [
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
    "prompt.html",
    "prompt.js",
    "prompt.css",
    "icons/wand-16.png",
    "icons/wand-32.png",
    "icons/wand-64.png",
]

DROPDOWN_PACKAGE_FILES = [
    "manifest.json",
    "background.js",
    "icons/wand-chevron-16.png",
    "icons/wand-chevron-32.png",
    "icons/wand-chevron-64.png",
]


def build_xpi():
    def build(target, base, names):
        missing = [name for name in names if not (base / name).is_file()]
        if missing:
            sys.exit(f"missing files, cannot package {target}: {', '.join(missing)}")
        target.unlink(missing_ok=True)
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
            for name in names:
                zf.write(base / name, name)
        print(f"📦 built {target} ({target.stat().st_size} bytes)")

    build(XPI, ROOT, PACKAGE_FILES)
    build(DROPDOWN_XPI, ROOT / "dropdown", DROPDOWN_PACKAGE_FILES)


def thunderbird_pids():
    result = subprocess.run(
        ["pgrep", "-x", "thunderbird-bin"], capture_output=True, text=True
    )
    return [int(pid) for pid in result.stdout.split()]


def marionette_port_open():
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=1):
            return True
    except OSError:
        return False


def close_thunderbird(pids):
    print(" gracefully closing Thunderbird…")
    for pid in pids:
        try:
            subprocess.run(["kill", "-TERM", str(pid)], check=False)
        except OSError:
            pass
    deadline = time.time() + 45
    while time.time() < deadline:
        if not thunderbird_pids():
            return
        time.sleep(1)
    sys.exit(
        "Thunderbird did not close within 45s — close it manually and run this "
        "script again."
    )


def launch_thunderbird():
    print(" launching Thunderbird with Marionette…")
    subprocess.Popen(
        [THUNDERBIRD, "-marionette", "-remote-allow-system-access"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    deadline = time.time() + 90
    while time.time() < deadline:
        if marionette_port_open():
            return
        time.sleep(1)
    sys.exit("Marionette never came up on port 2828.")


def connect():
    deadline = time.time() + 30
    while True:
        try:
            m = Marionette(host="127.0.0.1", port=PORT, socket_timeout=120)
            m.start_session()
            return m
        except Exception:
            if time.time() > deadline:
                raise
            time.sleep(1)


def reinstall():
    m = connect()
    try:
        was_installed = False
        for addon_id in (ADDON_ID, DROPDOWN_ADDON_ID):
            try:
                m._send_message("Addon:Uninstall", {"id": addon_id})
                was_installed = True
            except Exception:
                pass  # simply not installed yet
        m._send_message("Addon:Install", {"path": str(XPI), "temporary": False})
        m._send_message(
            "Addon:Install", {"path": str(DROPDOWN_XPI), "temporary": False}
        )

        # Verify through the add-on manager when chrome scripting is allowed.
        try:
            m.set_context(Marionette.CONTEXT_CHROME)
            info = m.execute_script(
                "const { AddonManager } = ChromeUtils.importESModule("
                '"resource://gre/modules/AddonManager.sys.mjs");\n'
                f"return AddonManager.getAddonByID({ADDON_ID!r})"
                ".then(a => a ? {version: a.version, active: a.isActive} : null);"
            )
        except Exception:
            info = None
    finally:
        try:
            m.delete_session()
        except Exception:
            pass

    action = "reinstalled" if was_installed else "installed"
    if info:
        state = f"v{info['version']}, {'active ✅' if info['active'] else 'INACTIVE ⚠️'}"
    else:
        state = "(could not verify — check the Add-ons Manager)"
    print(f"✨ MagicTrick {action}: {state}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument(
        "--yes",
        action="store_true",
        help="do not ask before closing a running Thunderbird (default when "
        "not attached to a terminal)",
    )
    args = parser.parse_args()

    if shutil.which(THUNDERBIRD) is None:
        sys.exit(f"Thunderbird binary not found: {THUNDERBIRD}")
    if shutil.which("pgrep") is None:
        sys.exit("pgrep not found")

    build_xpi()

    if marionette_port_open():
        print("🔁 Thunderbird already has Marionette — live reinstall, no restart.")
    else:
        pids = thunderbird_pids()
        if pids:
            if sys.stdin.isatty() and not args.yes:
                answer = input(
                    "Thunderbird is running without Marionette and must be closed "
                    "and reopened once.\nContinue? [Y/n] "
                )
                if answer.strip().lower() == "n":
                    sys.exit("aborted")
            close_thunderbird(pids)
        launch_thunderbird()

    reinstall()
    print("🧪 Open a NEW compose window (Write → new message) and click the wand.")


if __name__ == "__main__":
    main()
