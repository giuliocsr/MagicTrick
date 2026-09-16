/**
 * MagicTrick — compose script.
 *
 * Runs inside the compose surface and:
 *   - finds the editing document (the email body being composed)
 *   - splits it into the user's draft and the quoted thread/signature
 *   - applies AI results to the draft region ONLY, as a single editor
 *     transaction — so one Ctrl+Z reverts the whole MagicTrick edit
 *   - shows the in-window input bar for custom prompts
 *
 * The script works in TWO injection contexts, depending on the Thunderbird
 * build: injected into the compose window (the classic compose_scripts path,
 * where #messageEditor lives in this document), or injected by
 * tabs.executeScript directly INTO the editor document (modern builds), where
 * this document IS the email body.
 */
"use strict";

(() => {
  if (window.__magictrickLoaded) return;
  window.__magictrickLoaded = true;

  const api = typeof messenger !== "undefined" ? messenger : browser;

  /* ------------------------------------------------------------------ *
   * Editor access
   * ------------------------------------------------------------------ */

  /** @returns {Document|null} the document being edited (the email body) */
  function getEditorDoc() {
    // Injected into the compose window: the editor is our #messageEditor.
    const editor = document.getElementById("messageEditor");
    if (editor && editor.contentDocument && editor.contentDocument.body) {
      return editor.contentDocument;
    }
    // Injected into the editor document itself (tabs.executeScript): we ARE
    // the email body.
    if (document.body && (document.designMode === "on" || document.body.isContentEditable)) {
      return document;
    }
    // Fallback: any design-mode iframe hosted by the compose window.
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        const doc = frame.contentDocument;
        if (doc && doc.body && (doc.designMode === "on" || doc.body.isContentEditable)) {
          return doc;
        }
      } catch {
        // Cross-origin frame — not ours, keep looking.
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Draft / quote splitting
   *
   * Thunderbird reply and forward structures we recognise:
   *   <div class="moz-cite-prefix">On … wrote:</div>
   *   <blockquote type="cite">…quoted message…</blockquote>
   *   <pre class="moz-signature">-- \nsignature</pre> / <div class="moz-signature">
   *   <div class="moz-forward-container">…forwarded message…</div>
   * Plain-text compose instead uses "> " lines and a "-- " separator.
   * ------------------------------------------------------------------ */

  const QUOTE_CLASSES = ["moz-cite-prefix", "moz-forward-container"];

  /** First line of `text` that is not empty, trimmed. */
  function firstMeaningfulLine(text) {
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t) return t;
    }
    return "";
  }

  function isSignatureNode(node) {
    return (
      node.nodeType === Node.ELEMENT_NODE &&
      node.classList &&
      node.classList.contains("moz-signature")
    );
  }

  /** Heuristics for plain-text quoting inside a single node's text. */
  function startsPlainTextQuote(text) {
    const first = firstMeaningfulLine(text);
    if (first === "--" || first === "-- ") return true; // signature separator
    if (first.startsWith(">")) return true; // quoted line
    if (/^on .+ (wrote|schrieb|écrit|ha scritto|escribió):/i.test(first)) return true;
    if (/^-{3,}\s*(original message|forwarded message)\s*-{0,}/i.test(first)) return true;
    return false;
  }

  /**
   * Index of the first body child that belongs to the quoted thread (or to the
   * signature): everything before it is the user's draft.
   */
  function draftBoundaryIndex(body) {
    const kids = body.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const node = kids[i];
      if (node.nodeType === Node.ELEMENT_NODE) {
        const name = node.localName.toLowerCase();
        if (name === "blockquote") return i;
        if (isSignatureNode(node)) return i;
        if (QUOTE_CLASSES.some((c) => node.classList.contains(c))) return i;
      }
      if (startsPlainTextQuote(node.textContent || "")) return i;
    }
    return kids.length;
  }

  /** Human-readable text of one node, honouring visual line breaks. */
  function nodeText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    if (node.nodeType === Node.ELEMENT_NODE) {
      try {
        return node.innerText || node.textContent || "";
      } catch {
        return node.textContent || "";
      }
    }
    return "";
  }

  /**
   * Collect the draft text and the quoted conversation text.
   * @returns {{draftText: string, conversationText: string, error?: string}}
   */
  function collect() {
    const doc = getEditorDoc();
    if (!doc) return { error: "editor not found" };
    const body = doc.body;
    const boundary = draftBoundaryIndex(body);

    let draft = "";
    for (let i = 0; i < boundary; i++) draft += nodeText(body.childNodes[i]) + "\n";

    let conversation = "";
    for (let i = boundary; i < body.childNodes.length; i++) {
      const node = body.childNodes[i];
      if (isSignatureNode(node)) continue; // our own signature is not context
      conversation += nodeText(node) + "\n";
    }

    return {
      draftText: draft.replace(/\n{3,}/g, "\n\n").trim(),
      conversationText: conversation.replace(/\n{3,}/g, "\n\n").trim(),
    };
  }

  /* ------------------------------------------------------------------ *
   * Replacement (single undoable editor transaction)
   * ------------------------------------------------------------------ */

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Plain text → simple HTML: blank lines split paragraphs, single newlines are <br>. */
  function htmlFromText(text) {
    return text
      .split(/\n{2,}/)
      .map((para) => para.trim())
      .filter(Boolean)
      .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
      .join("");
  }

  /**
   * Replace the draft region with `text` and return {ok, error?}.
   * The replacement goes through execCommand so the editor records it as one
   * transaction: a single Ctrl+Z restores the previous draft exactly.
   */
  function apply(text) {
    const doc = getEditorDoc();
    if (!doc) return { ok: false, error: "editor not found" };
    try {
      const body = doc.body;
      const boundary = draftBoundaryIndex(body);
      const win = doc.defaultView;
      win.focus();

      const selection = win.getSelection();
      const range = doc.createRange();
      range.setStart(body, 0);
      range.setEnd(body, boundary); // collapsed when the draft is empty
      selection.removeAllRanges();
      selection.addRange(range);

      const ok = doc.execCommand("insertHTML", false, htmlFromText(text));
      selection.collapseToEnd();
      return ok ? { ok: true } : { ok: false, error: "the editor refused the insertion" };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  /* ------------------------------------------------------------------ *
   * Custom-prompt input bar (rendered inside the editor document)
   * ------------------------------------------------------------------ */

  const BAR_STYLE = `
    #magictrick-bar {
      position: fixed;
      top: 8px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      display: flex;
      gap: 8px;
      align-items: center;
      max-width: min(92%, 720px);
      padding: 8px 10px;
      background: #2b2233;
      color: #f5f0fa;
      border: 1px solid #6b5a8a;
      border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
      font: 13px sans-serif;
    }
    #magictrick-bar .mt-spark { font-size: 15px; }
    #magictrick-bar input {
      flex: 1;
      min-width: 200px;
      padding: 5px 8px;
      border: 1px solid #6b5a8a;
      border-radius: 6px;
      background: #1c1622;
      color: #f5f0fa;
      font: 13px sans-serif;
    }
    #magictrick-bar button {
      padding: 5px 10px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font: 13px sans-serif;
    }
    #magictrick-bar .mt-go { background: #8a63d2; color: #fff; }
    #magictrick-bar .mt-go:hover { background: #9b78dc; }
    #magictrick-bar .mt-cancel { background: transparent; color: #cfc4e0; }
  `;

  /**
   * Show the prompt bar in the compose editor.
   * @returns {Promise<string|null>} the prompt, or null when cancelled
   */
  function showPromptBar() {
    return new Promise((resolve) => {
      const doc = getEditorDoc();
      if (!doc) {
        resolve(null);
        return;
      }
      doc.getElementById("magictrick-bar")?.remove();

      if (!doc.getElementById("magictrick-style")) {
        const style = doc.createElement("style");
        style.id = "magictrick-style";
        style.textContent = BAR_STYLE;
        doc.documentElement.appendChild(style);
      }

      const bar = doc.createElement("div");
      bar.id = "magictrick-bar";
      bar.innerHTML =
        '<span class="mt-spark">✨</span>' +
        '<input type="text" placeholder="Your instruction — replaces the built-in one. Enter to cast, Esc to cancel.">' +
        '<button class="mt-go" title="Run">Cast</button>' +
        '<button class="mt-cancel" title="Cancel">✕</button>';
      doc.body.appendChild(bar);

      const input = bar.querySelector("input");
      let settled = false;
      const close = (value) => {
        if (settled) return;
        settled = true;
        bar.remove();
        resolve(value);
      };

      bar.querySelector(".mt-go").addEventListener("click", () => close(input.value));
      bar.querySelector(".mt-cancel").addEventListener("click", () => close(null));
      input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") close(input.value.trim() ? input.value : null);
        if (event.key === "Escape") close(null);
      });
      // The bar lives inside the message being composed — the moment focus
      // leaves it, remove it, so it can never leak into a sent email.
      bar.addEventListener("focusout", (event) => {
        if (!bar.contains(event.relatedTarget)) close(null);
      });
      input.focus();
    });
  }

  /* ------------------------------------------------------------------ *
   * Message handling (talks to background.js)
   * ------------------------------------------------------------------ */

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.command) return undefined;

    if (msg.command === "collect") {
      return Promise.resolve(collect());
    }

    if (msg.command === "apply") {
      return Promise.resolve(apply(String(msg.text || "")));
    }

    if (msg.command === "customPrompt") {
      showPromptBar().then((prompt) => {
        if (prompt) api.runtime.sendMessage({ type: "run-custom", prompt });
      });
      return Promise.resolve({ shown: true });
    }

    return undefined;
  });
})();
