/**
 * MagicTrick — prompt construction, answer cleanup and recipient classification.
 *
 * Kept free of Thunderbird APIs so it can be unit-tested in plain Node
 * (loaded both as a background script and via require()).
 *
 * The standard instruction is editable and persistable: when the user saved
 * one through the prompt window ("Apply for all future emails") or the
 * Settings page, it replaces the built-in instruction for BOTH the polish
 * and the auto-reply path.
 */
"use strict";

/**
 * The built-in standard instruction: what a wand click asks the AI to do.
 * Exposed so the prompt window and Settings can pre-fill their editors and
 * offer "restore built-in".
 * @returns {string}
 */
function builtInInstruction() {
  return (
    "Fix ONLY grammar, spelling and punctuation in the draft.\n" +
    "- Keep the draft's language, tone, meaning and structure exactly.\n" +
    "- Keep greetings, sign-offs, line breaks and lists as they are.\n" +
    "- Never answer the email, never add new content, never add commentary.\n" +
    "- Use the thread only as context for names and terminology.\n" +
    "Your reply will REPLACE the draft verbatim, so output the complete corrected " +
    "text and absolutely nothing else: no explanations, no lists of errors, no " +
    "quoting of the original, no preamble like “here is the corrected text”."
  );
}

/** The built-in instruction for empty drafts (auto-reply), same editing rules. */
function builtInReplyInstruction() {
  return (
    "You are MagicTrick, a reply-drafting assistant built into Thunderbird. " +
    "The user's draft is empty and the email thread is given: write the reply they would send.\n" +
    "- Match the language the thread is written in.\n" +
    "- Professional, warm and concise; plain prose; greet the sender of the last message naturally.\n" +
    "- Answer or acknowledge the points of the last message. Do not invent commitments or facts.\n" +
    "- Do not quote the thread and do not add placeholders like [name] when the names are in the thread.\n" +
    "- End with a short closing signed with the SENDER's FIRST name only " +
    "(e.g. \"Best regards, Giulio\").\n" +
    "Your reply will REPLACE the draft verbatim, so output the complete reply text " +
    "and absolutely nothing else: no explanations, no quoting of the thread."
  );
}

/**
 * Which system instruction applies for a run.
 * @param {string|null} saved the persisted standard instruction (or null)
 * @param {"fix"|"reply"} mode
 * @returns {string}
 */
function chooseSystemPrompt(saved, mode) {
  if (saved && String(saved).trim()) return String(saved).trim();
  return mode === "reply" ? builtInReplyInstruction() : builtInInstruction();
}

/**
 * Build the chat messages for a run.
 * The thread is always passed as read-only context; only the draft is work material.
 *
 * @param {"fix"|"reply"|"custom"} mode
 * @param {string} customPrompt user instruction (mode "custom" only)
 * @param {string} draftText the user's draft (may be empty)
 * @param {string} conversationText quoted thread below the draft (may be empty)
 * @param {string|null} [draftHtml] draft HTML when formatting must be preserved
 * @param {{name: string, email: string}|null} [sender] identity the email sends from
 * @param {string|null} [savedInstruction] persisted standard instruction
 * @returns {Array<{role: string, content: string}>}
 */
function buildMessages(
  mode,
  customPrompt,
  draftText,
  conversationText,
  draftHtml,
  sender,
  savedInstruction
) {
  const thread = conversationText.trim()
    ? "=== EMAIL THREAD (context only — messages written by other people, never rewrite them) ===\n" +
      conversationText.trim() +
      "\n\n"
    : "";

  const senderBlock = sender
    ? `=== SENDER (the account this email sends from) ===\n${sender.name} <${sender.email}>\n\n`
    : "";

  // Hard rules shared by every text-producing mode. The reply IS the new draft.
  const replaceNotAnnotate =
    "Your reply will REPLACE the draft verbatim, so output the complete corrected text " +
    "and absolutely nothing else: no explanations, no lists of errors, no quoting of the " +
    "original, no preamble like “here is the corrected text”.";

  const htmlRules = draftHtml
    ? "\n- The draft is given as HTML: return the corrected draft as HTML with EXACTLY the " +
      "same tags, structure and attributes — lists, links, emphasis, headings and paragraphs " +
      "must survive unchanged. Only the words inside may be corrected."
    : "";

  // A saved instruction governs polish and auto-reply alike; closings under a
  // saved instruction still follow the sender's first name.
  const savedSigning =
    savedInstruction && mode !== "custom"
      ? "\n- If your text ends with a closing, sign it with the SENDER's FIRST name only."
      : "";

  if (mode === "custom") {
    return [
      {
        role: "system",
        content:
          String(customPrompt || "").trim() +
          "\n\nYou are editing the user's own outgoing email inside their compose window, " +
          "at their explicit request — treat the text as theirs to shape as instructed. " +
          replaceNotAnnotate +
          htmlRules +
          " Plain text output" +
          (draftHtml ? " (or HTML, matching the draft)" : "") +
          ", no markdown fences.",
      },
      {
        role: "user",
        content:
          senderBlock +
          `${thread}=== CURRENT DRAFT ${draftHtml ? "(HTML)" : ""} ===\n` +
          (draftHtml || draftText.trim() || "(empty)"),
      },
    ];
  }

  if (mode === "reply") {
    return [
      {
        role: "system",
        content: chooseSystemPrompt(savedInstruction, "reply") + savedSigning,
      },
      {
        role: "user",
        content:
          senderBlock +
          `${thread}=== TASK ===\nWrite the user's reply to the most recent message.`,
      },
    ];
  }

  return [
    {
      role: "system",
      content: chooseSystemPrompt(savedInstruction, "fix") + htmlRules + savedSigning,
    },
    {
      role: "user",
      content:
        senderBlock +
        `${thread}=== DRAFT TO CORRECT ${draftHtml ? "(HTML)" : ""} ===\n` +
        (draftHtml || draftText.trim()),
    },
  ];
}

/**
 * Remove a single leading "Here is the corrected text:" style line, which
 * even well-behaved models occasionally produce.
 * @param {string} text
 * @returns {string}
 */
function stripAnswerPreamble(text) {
  const lines = String(text).split("\n");
  const first = (lines[0] || "").trim().replace(/[:.]+$/, "");
  const preamble =
    /^(here('s| is)? (the |your )?)?(corrected|fixed|revised|polished|improved)([- ](up)? ?(text|version|draft|email|message|copy))?$/i;
  if (lines.length > 1 && preamble.test(first)) {
    return lines.slice(1).join("\n").trim();
  }
  return String(text).trim();
}

/**
 * Heuristic refusal detector: a short answer that opens with a classic
 * "I can't help with that" formula is the model declining, not a draft.
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeRefusal(text) {
  const trimmed = String(text || "").trim();
  if (trimmed.length > 400) return false;
  const opener =
    /^(i'?m sorry|sorry,|i can'?t|i cannot|i won'?t|i will not|i'?m unable|i am unable|as an ai|i apologize|unfortunately)\b/i;
  const decline =
    /can'?t (help|assist|do that|fulfill|comply|support|provide|create|generate)|cannot (help|assist|fulfill|comply|do that)|won'?t (help|assist|create|generate|be able to)|unable to (help|assist|comply|fulfill)|must decline|not able to (help|assist)/i;
  return opener.test(trimmed) && decline.test(trimmed);
}

/**
 * Deterministic recipient classification — no AI involved.
 *
 * The contact candidates (address book + message history) already cover only
 * people whose name appears in the draft. The person GREeTED (e.g. after
 * "Hello X") belongs in To; every other referenced candidate goes to Cc.
 *
 * @param {string} draftText
 * @param {Array<{name: string, email: string}>} candidates
 * @returns {{to: string[], cc: string[]}}
 */
function classifyRecipients(draftText, candidates) {
  const greeted = new Set();
  const re = /\b(?:hello|hi|hey|dear|ciao|salve|buongiorno|good morning|good afternoon|good evening)\s+([\p{L}\p{M}'’-]+)/giu;
  for (const match of String(draftText).matchAll(re)) {
    greeted.add(match[1].toLowerCase());
  }
  const to = [];
  const cc = [];
  for (const candidate of candidates || []) {
    const tokens = String(candidate.name).toLowerCase().split(/\s+/);
    const isGreeted = tokens.some((token) => greeted.has(token));
    (isGreeted ? to : cc).push(candidate.email);
  }
  return { to, cc };
}

const MagicTrickPrompts = {
  builtInInstruction,
  builtInReplyInstruction,
  chooseSystemPrompt,
  buildMessages,
  stripAnswerPreamble,
  classifyRecipients,
  looksLikeRefusal,
};

if (typeof globalThis !== "undefined") {
  globalThis.MagicTrickPrompts = MagicTrickPrompts;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = MagicTrickPrompts;
}
