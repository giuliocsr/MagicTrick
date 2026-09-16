# MagicTrick — manual test checklist

Automated coverage: `tests/ai.test.mjs` (endpoint chain, prompts) and
`tests/e2e.py` (Marionette GUI harness — partial: synthetic input events are
blocked by Thunderbird's trust checks, so button activation needs human hands).

## Install in your real Thunderbird

**Permanent install (recommended):**

1. Build (or ask for) `magictrick.xpi`:
   ```sh
   zip magictrick.xpi manifest.json ai.js prompts.js background.js compose.js icons/
   ```
2. Thunderbird → **Tools → Add-ons and Themes → ⚙ → Install Add-on From File…**
   → pick `magictrick.xpi` → confirm.
3. Removing later: Add-ons Manager → MagicTrick → Remove. Nothing else is left
   behind (no settings, no stored data).

**Edit → retest loop** (when a new build is ready): rebuild the xpi, install it
again the same way — Thunderbird replaces the old version in place. Already-open
compose windows from before the update should be closed and reopened once.

Alternative for quick iterations: **about:debugging → This Thunderbird →
Load Temporary Add-on → `manifest.json`** in the repo. Reload button reapplies
edits instantly, but it disappears on every Thunderbird restart (and cannot be
active while the permanent install exists).

## What to test (5 minutes)

Write an email to yourself; you never need to send it.

1. **Button** — wand-with-sparkles icon in the compose toolbar; tooltip reads
   "MagicTrick — fix this email with AI" (the "MagicTrick" text label shows when
   the toolbar is in "icons and text" mode — right-click toolbar to switch).
2. **One-click grammar fix** — draft a few sentences with obvious errors,
   click MagicTrick: ✨ badge appears while working, corrected text lands within
   a few seconds. Greeting, line breaks and paragraphs survive.
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

Report anything odd with: what you did, what you expected, what happened
(the exact notification text if one appeared).
