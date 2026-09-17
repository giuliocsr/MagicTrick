/**
 * MagicTrick — compose script.
 *
 * Runs inside the compose surface and:
 *   - finds the editing document (the email body being composed)
 *   - splits it into the user's draft and the quoted thread/signature
 *   - applies AI results to the draft region ONLY, as a single editor
 *     transaction — so one Ctrl+Z reverts the whole MagicTrick edit
 *     (plain-text answers become paragraphs; HTML answers keep the draft's
 *     formatting, sanitised to a safe tag whitelist)
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

  /** Serialised HTML of the draft region (nodes [0, end)). */
  function regionHtml(doc, body, end) {
    const wrapper = doc.createElement("div");
    for (let i = 0; i < end; i++) {
      wrapper.appendChild(body.childNodes[i].cloneNode(true));
    }
    return wrapper.innerHTML;
  }

  /**
   * Collect the draft text, the quoted conversation text and the draft HTML.
   * @returns {{draftText: string, conversationText: string, draftHtml: string, error?: string}}
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
      draftHtml: regionHtml(doc, body, boundary).trim(),
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

  const SAFE_TAGS = new Set([
    "P", "DIV", "BR", "UL", "OL", "LI", "B", "STRONG", "I", "EM", "U",
    "A", "H1", "H2", "H3", "H4", "H5", "H6", "SPAN",
  ]);

  /**
   * Whitelist sanitiser for AI-returned HTML: keeps the formatting tags we
   * asked the model to preserve and drops everything else (unwrapping, not
   * deleting, so text survives). Only http(s)/mailto links survive on <a>.
   */
  function sanitizeHtml(html) {
    const doc = getEditorDoc();
    const holder = doc.createElement("div");
    holder.innerHTML = html;
    const sanitize = (element) => {
      for (const child of [...element.children]) sanitize(child);
      if (!SAFE_TAGS.has(element.tagName)) {
        element.replaceWith(...element.childNodes);
        return;
      }
      if (element.tagName === "A") {
        const href = element.getAttribute("href") || "";
        if (!/^(https?:|mailto:)/i.test(href)) element.removeAttribute("href");
        element.removeAttribute("target");
      } else {
        for (const attr of [...element.attributes]) element.removeAttribute(attr.name);
      }
    };
    sanitize(holder);
    return holder.innerHTML;
  }

  /**
   * Replace the draft region and return {ok, error?}. `options.html` marks the
   * text as pre-formatted (sanitised) HTML; plain text becomes paragraphs.
   * The replacement goes through execCommand so the editor records it as one
   * transaction: a single Ctrl+Z restores the previous draft exactly.
   */
  function apply(text, options) {
    const doc = getEditorDoc();
    if (!doc) return { ok: false, error: "editor not found" };
    try {
      const body = doc.body;
      const boundary = draftBoundaryIndex(body);
      const win = doc.defaultView;
      win.focus();

      const html = options && options.html ? sanitizeHtml(text) : htmlFromText(text);

      const selection = win.getSelection();
      const range = doc.createRange();
      range.setStart(body, 0);
      range.setEnd(body, boundary); // collapsed when the draft is empty
      selection.removeAllRanges();
      selection.addRange(range);

      const ok = doc.execCommand("insertHTML", false, html);
      selection.collapseToEnd();
      return ok ? { ok: true } : { ok: false, error: "the editor refused the insertion" };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
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
      return Promise.resolve(apply(String(msg.text || ""), { html: !!msg.html }));
    }

    return undefined;
  });
})();
