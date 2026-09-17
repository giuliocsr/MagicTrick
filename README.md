# MagicTrick 🪄✨

One-click AI email polishing for [Thunderbird](https://www.thunderbird.net/) — a magic-wand
button in the compose window that fixes the grammar of what you just wrote, drafts a reply
when you haven't written anything yet, and always leaves one press of <kbd>Ctrl+Z</kbd>
between you and regret.

**Free. Keyless. No setup, no accounts, no API keys, no options page.**

## What it does

| Action | Result |
|---|---|
| Click **MagicTrick** with text in the composer | The draft's grammar, spelling and punctuation are corrected in place. Tone, language and meaning are preserved. |
| Click **MagicTrick** in an empty reply | A contextual reply is drafted for you, in the thread's language, based on the conversation below. |
| Right-click the button → **MagicTrick with prompt…** | An input bar appears inside the composer — type any instruction ("make it more formal", "translate to German", "shorten to 3 sentences") and press <kbd>Enter</kbd>. |
| <kbd>Ctrl+Shift+G</kbd> | Same as clicking the button. |
| Right-click → **MagicTrick: manage attachment rules…** | Register files you routinely send ("reference letters" → `reference-letters.pdf`); from then on, whenever a rule's phrase appears in your draft, the file is attached automatically. |
| Mentions of your contacts | People from your address books whose names appear in the draft are added automatically: the person greeted goes to **To**, other referenced contacts to **Cc**. A notification always lists what was added. |
| <kbd>Ctrl+Z</kbd> after any MagicTrick edit | The previous text is restored exactly. Every edit is a single undoable editor transaction. |

When you are replying, the quoted conversation is sent to the model **as read-only
context** — names, terminology, language — but only *your* draft is ever corrected or
replaced. Other people's messages are never touched or rewritten.

## ⚠️ Privacy — read this once

MagicTrick works with **no API key and no account** by using free, anonymous, community-run
AI endpoints ([LLM7](https://llm7.io), [Pollinations](https://pollinations.ai)). That
convenience has a price: **your email text passes through third-party services you have no
data agreement with.** They may log it, and their terms may change.

> **Do not use MagicTrick for confidential correspondence.** If you need confidentiality,
> this tool — in its current keyless form — is not for you. (A bring-your-own-endpoint mode
> is on the roadmap.)

## How it works

```
compose window                      background script                AI endpoints
─────────────                       ────────────────                 ────────────
[🪄 MagicTrick] click ───────────▶  collect draft + thread ──┐
                                    build prompt              ├──▶ LLM7 (GLM flash)
                                    (fix / reply / custom)    │    └─▶ Pollinations
                                    ◀─────────────────────────┘         (fallback chain)
draft region replaced ◀───────────  corrected text
(single undoable transaction)
```

- The **draft region** is detected structurally: everything above the first
  `blockquote`, `moz-cite-prefix`, `moz-forward-container` or signature — so quoted
  messages and your signature are off-limits by construction.
- Replacement happens through the editor's command system (`insertHTML` on the selected
  draft range), which records **one transaction**: a single <kbd>Ctrl+Z</kbd> undoes it.
- Two fast keyless endpoints are raced **in parallel** (LLM7 Mistral Nemo and
  Pollinations `openai-fast`); the first valid answer wins and the losing request is
  aborted, with a slower backstop endpoint if both fail. Typical turnaround is well
  under 5 seconds; the extension also pre-warms the connections at startup so the
  first click of a session is fast too.
- Reasoning-heavy free models are deliberately avoided: they can think for 10-30 s
  before answering. If you swap endpoints in `ai.js`, keep replacements fast.
- If the button seems dead in a compose window that was already open when you installed
  MagicTrick, close and reopen that window once.

## Install

### From source (recommended for now)

1. Download or clone this repository.
2. Zip the extension files (not the repo folder itself):
   ```sh
   zip magictrick.xpi manifest.json background.js ai.js compose.js icons/
   ```
3. In Thunderbird: **Tools → Add-ons and Themes → ⚙ → Install Add-on From File…**
   → select `magictrick.xpi`.
4. Removal is the usual one click in the Add-ons Manager. Nothing else is left behind —
   MagicTrick stores no settings and keeps no data.

### For development

```sh
# Deploy the current working tree into your real Thunderbird (build + reinstall)
python3 tools/reinstall.py

# AI endpoint chain + prompt construction (plain Node, hits the live endpoints)
node --test tests/ai.test.mjs

# GUI harness (Thunderbird + Marionette; headless, throwaway profile)
pip install marionette_driver
python3 tests/e2e.py

# Manual checklist (button, prompt bar, real Ctrl+Z — needs human hands)
# see tests/MANUAL.md
```

The GUI harness covers what synthetic automation can reach; Thunderbird blocks
untrusted synthetic input on extension toolbar buttons, so the final word on
click behaviour is `tests/MANUAL.md`. Alternatively use
**about:debugging → Load Temporary Add-on** on a scratch profile.

## Project layout

```
manifest.json   MailExtension manifest (MV2, Thunderbird 128+)
background.js   button/menu orchestration, prompt construction, busy & error states
ai.js           keyless endpoint chain (OpenAI-compatible, anonymous)
compose.js      compose-window script: draft/quote split, undoable replacement, prompt bar
icons/          wand-and-sparkles icon (SVG source + rendered PNGs)
```

## Limitations

- Inline formatting inside the corrected region (bold, links) becomes plain text; the
  quoted thread and signature are preserved untouched.
- The editor technique relies on `execCommand`, which browsers deprecate but Thunderbird's
  editor still implements natively. Tested on Thunderbird 128–155; re-test on major
  upgrades.
- Plain-text replies rely on heuristics (`> ` markers, `-- ` signature line) to find where
  the quote starts; HTML replies use Thunderbird's structural markup and are exact.
- Anonymous endpoints are rate-limited in fair-use ways; heavy daily use may occasionally
  hit throttling (the fallback chain absorbs most of it).

## Notes on recipient assistance

Recipients are chosen **locally and deterministically** — the AI never picks
addresses. Your address books are scanned for contacts whose name actually
appears in the draft; the person greeted ("Hello Pietro") is added to To, other
referenced contacts to Cc. Only those few names ever leave your machine (and
only as part of the draft text itself, which is sent anyway). Remove an address
by deleting its pill in the compose window as usual.

## Roadmap

- [ ] Bring-your-own-endpoint mode (Z.AI free tier / OpenAI / local Ollama) for privacy
- [ ] Selection-only correction (fix just the highlighted paragraph)
- [ ] Attachment-rule suggestions via the context of the conversation

## License

[MIT](LICENSE) © Giulio Golinelli
