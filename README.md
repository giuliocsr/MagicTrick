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
- Endpoints are tried **in order**; if one is down, throttled or returns an empty answer,
  the next one is used. If all fail you get a notification and your text is untouched.
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
npm install -g web-ext
web-ext run --target thunderbird-desktop
```

`web-ext` launches Thunderbird with an isolated throwaway profile and reloads the
extension on every file save — your real profile is never touched. Alternatively use
Thunderbird's **about:debugging → Load Temporary Add-on** (also leaves no permanent trace).

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

## Roadmap

- [ ] Bring-your-own-endpoint mode (Z.AI free tier / OpenAI / local Ollama) for privacy
- [ ] Selection-only correction (fix just the highlighted paragraph)
- [ ] Keyboard shortcut (<kbd>Ctrl+Shift+G</kbd>)
- [ ] Recipient assistant: suggest To/CC/BCC additions found in the thread
- [ ] Attachment rules: "when I write *attaching reference letters*, attach these files"

## License

[MIT](LICENSE) © Giulio Golinelli
