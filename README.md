# MagicTrick 🪄✨

One-click AI email polishing for [Thunderbird](https://www.thunderbird.net/) — a magic-wand
button in the compose window that fixes the grammar of what you just wrote, drafts a reply
when you haven't written anything yet, and always leaves one press of <kbd>Ctrl+Z</kbd>
between you and regret.

**Free. Keyless. No setup, no accounts, no API keys.**

## What it does

| Action | Result |
|---|---|
| Click the **wand** (or <kbd>Ctrl+Shift+G</kbd>) | The draft's grammar, spelling and punctuation are corrected in place. Tone, language and meaning are preserved. Formatted drafts (bullet lists, links, emphasis) travel as HTML and keep their formatting. |
| Click the wand in an empty reply | A contextual reply is drafted for you, in the thread's language, based on the conversation below, signed off with your sender **first name** ("Best regards, Giulio") inferred from the sending address. |
| Right-click → **MagicTrick with prompt…** | A small OS window titled "MagicTrick — your instruction" opens, auto-sized to its content, pre-filled with the active standard instruction, input focused. **Apply this time** runs it once; **Apply for all future emails** also saves it as the new standard — used for both the polish and the auto-reply, with the thread/sender/format context still appended automatically. A "Restore built-in" link reverts. |
| Right-click → **Settings** | Opens a focused Thunderbird tab (light theme, wand logo) with three sections: **Registered files rules** (register files you routinely send — "reference letters" → `reference-letters.pdf`, auto-attached whenever the phrase appears in a draft; they survive restarts), **Standard prompt** (view, save or restore the instruction sent to the AI) and **Diagnostics** (the last AI-chain events). |
| Mentions of your contacts | People whose names appear in the draft are added automatically — from your address books **and from your message history**: the person greeted goes to **To**, other referenced people to **Cc**. A notification always lists what was added. |
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
- Formatted drafts are sent as HTML with strict "same tags, same structure" rules; the
  answer is sanitised against a whitelist (paragraphs, lists, emphasis, links) and, if
  the model drops the formatting, MagicTrick falls back to clean plain text instead of
  inserting mangled markup.
- Recipients are picked **locally**: address books plus recent correspondents (message
  history) are scanned for people whose names appear in the draft — the AI never chooses
  addresses, so nothing can be invented.
- Two fast keyless endpoints are raced **in parallel** (LLM7 Mistral Nemo and
  Pollinations `openai-fast`); the first valid answer wins and the losing request is
  aborted, with a slower backstop endpoint if both fail. Typical turnaround is well
  under 5 seconds; the extension also pre-warms the connections at startup so the
  first click of a session is fast too.
- Reasoning-heavy free models are deliberately avoided: they can think for 10-30 s
  before answering. If you swap endpoints in `ai.js`, keep replacements fast.
- Request pacing keeps the anonymous tiers happy: the endpoint that won the
  previous run leads alone (the other joins only as a late hedge), endpoints
  answering 429 sit out a short cooldown, and any chain failure under 12 s is
  retried once automatically.
- **Settings → Diagnostics** shows the last chain events (which endpoint, ok /
  429 / timeout / network error, latency) — paste those into a bug report.
- There is deliberately **no startup warm-up request**: the background page sleeps
  when idle and every wake would re-run one, racing your first click into the
  endpoints' anonymous concurrency limits. Failures are logged to Thunderbird's
  error console (Tools → Developer Tools → Error Console) as `[MagicTrick]`.
- If the AI declines an instruction (e.g. a deliberately offensive custom prompt),
  MagicTrick does **not** replace your draft: a notification reports what the AI
  said instead. The models are asked to treat the text as your own draft at your
  explicit request, but no attempt is made to bypass their safety filters.
- If the button seems dead in a compose window that was already open when you installed
  MagicTrick, close and reopen that window once.

## Install

### From source (recommended for now)

1. Download or clone this repository.
2. Build the package (or run `python3 tools/reinstall.py`, which also installs it):
   ```sh
   zip magictrick.xpi manifest.json ai.js prompts.js contacts.js attachments.js background.js compose.js options.html options.js options.css icons/*.png
   ```
3. In Thunderbird: **Tools → Add-ons and Themes → ⚙ → Install Add-on From File…**
   → select `magictrick.xpi`.
4. Removal is the usual one click in the Add-ons Manager. Registered
   attachment-rule files persist across Thunderbird restarts and add-on
   updates; uninstalling the add-on removes them (that is Thunderbird
   deleting the extension's storage, not a MagicTrick setting).

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

- Formatting preservation depends on the model cooperating: if it drops the HTML
  structure, MagicTrick falls back to plain text (the notification still shows the edit).
  The quoted thread and signature are always preserved untouched.
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
