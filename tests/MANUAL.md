# MagicTrick — manual test checklist

Automated coverage: `tests/ai.test.mjs` (endpoint chain, prompts) and
`tests/e2e.py` (Marionette GUI harness — partial: synthetic input events are
blocked by Thunderbird's trust checks, so button activation needs human hands).

## Deploy to your real Thunderbird

One command builds the xpi and (re)installs it — always uninstall-first, so it
is safe to run after every edit:

```sh
python3 tools/reinstall.py        # requires: pip install marionette_driver
```

- Thunderbird already runs with Marionette → live reinstall, ~3 s, no restart
- Thunderbird runs without Marionette → clean quit + relaunch with `-marionette`
  (happens once; afterwards every run is live)
- Thunderbird closed → it is launched for you

Thunderbird keeps the Marionette port open on localhost afterwards — that is
what makes the no-restart reinstalls possible. If that bothers you, quit
Thunderbird normally; the next `reinstall.py` run just starts it again.

Manual alternative: build `magictrick.xpi`
(`zip magictrick.xpi manifest.json ai.js prompts.js background.js compose.js icons/`)
→ **Tools → Add-ons and Themes → ⚙ → Install Add-on From File…** → confirm.
Removing later is one click in the Add-ons Manager; nothing is left behind.

## What to test (5 minutes)

Write an email to yourself; you never need to send it.

1. **Split pair** — `[ 🪄 MagicTrick ][ ▾ ]`: one click on the wand
   polishes; ▾ opens the menu (with prompt / Manage attachment rules — no
   polish entry, the wand already does that). Both add-ons must be
   installed. Right-clicking the wand also offers all three.
2. **Grammar fix** — draft a few sentences with obvious errors, click the
   wand (or Ctrl+Shift+G): ✨ badge appears while working, corrected text
   lands within seconds. The answer REPLACES the draft — it must never be an
   annotation like "Incorrect spelling: … should be …".
2b. **Formatting** — draft with a bullet list (and an error inside a bullet);
   after polishing the list must still be a list.
3. **Ctrl+Z** — one press restores the exact previous draft.
4. **Reply safety** — reply to a real email, click MagicTrick: only your text
   above the quote changes; the quoted conversation and your signature stay
   byte-identical.
5. **Auto-reply** — open a reply, delete all of your own text, click MagicTrick:
   a contextual reply appears (in the thread's language).
6. **Ctrl+Shift+G** — same as clicking the button.
7. **MagicTrick with prompt…** — right-click the button → the menu item → a dark
   input bar appears over the editor. Try "make it more formal". Enter runs,
   Esc cancels, ✕ closes.
8. **Failure path** — disconnect the network, click MagicTrick: after the
   timeouts you get a notification and the draft is unchanged.
9. **Recipient assistant** — draft "Hello Pietro, how are you? Giorgio has
   attached the correspondence." where Pietro is an address-book contact and
   Giorgio is just someone you exchange email with (no contact entry): Pietro
   appears in To, Giorgio in Cc, notification lists both.
10. **Attachment rules** — right-click the button → "manage attachment
    rules…" → register phrase "reference letters" with a small PDF. Draft
    "Attached you can find my reference letters." and run MagicTrick:
    the file is attached and listed in the notification.

Report anything odd with: what you did, what you expected, what happened
(the exact notification text if one appeared).
