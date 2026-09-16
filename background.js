/**
 * MagicTrick — background orchestration.
 *
 * Listens for the compose-window toolbar button (and its context menu),
 * coordinates the compose script (draft extraction / replacement) and the AI
 * backend chain, and keeps the button state and error notifications in order.
 *
 * Flow of a "fix" run:
 *   composeAction click
 *     → tabs.sendMessage(tab, {command:"collect"})   (compose.js)
 *     → build prompt (draft + thread context)
 *     → aiComplete(...)                              (ai.js)
 *     → tabs.sendMessage(tab, {command:"apply"})     (compose.js)
 */
"use strict";

/* global MagicTrickAI */

const BUTTON_TITLE = "MagicTrick — fix this email with AI";

/** Tab ids with a run currently in flight (one run per compose window). */
const inFlight = new Set();

messenger.composeAction.onClicked.addListener((tab) => {
  if (tab && tab.id != null) runMagicTrick(tab.id, { mode: "auto" });
});

messenger.menus.create({
  id: "magictrick-with-prompt",
  title: "MagicTrick with prompt…",
  contexts: ["compose_action"],
});

messenger.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "magictrick-with-prompt" && tab && tab.id != null) {
    // Ask the compose script to show the in-window prompt bar; it will call us
    // back with {type:"run-custom", prompt} when the user submits it.
    messenger.tabs
      .sendMessage(tab.id, { command: "customPrompt" })
      .catch((err) => notifyConnectionProblem(err));
  }
});

messenger.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "run-custom" && sender.tab && sender.tab.id != null) {
    runMagicTrick(sender.tab.id, { mode: "custom", prompt: String(msg.prompt || "") });
  }
});

/**
 * Full pipeline for one compose window.
 * @param {number} tabId compose tab
 * @param {{mode: "auto"|"custom", prompt?: string}} opts
 */
async function runMagicTrick(tabId, opts) {
  if (inFlight.has(tabId)) return;
  inFlight.add(tabId);
  await setBusy(tabId, true);
  try {
    let draft, conversation;
    try {
      const extract = await messenger.tabs.sendMessage(tabId, { command: "collect" });
      if (extract && extract.error) throw new Error(extract.error);
      draft = extract ? extract.draftText : "";
      conversation = extract ? extract.conversationText : "";
    } catch (err) {
      throw new Error(
        "Could not reach this compose window. " +
          "If it was open before MagicTrick was installed or updated, close and reopen it, then try again."
      );
    }

    const mode = opts.mode === "custom" ? "custom" : !draft.trim() ? "reply" : "fix";
    if (mode === "reply" && !conversation.trim()) {
      notify("Nothing to do: the draft is empty and there is no conversation to reply to.");
      return;
    }

    const messages = buildMessages(mode, opts.prompt, draft, conversation);
    const result = await MagicTrickAI.aiComplete(messages);

    const applied = await messenger.tabs.sendMessage(tabId, { command: "apply", text: result });
    if (!applied || !applied.ok) {
      throw new Error((applied && applied.error) || "Could not update the compose window.");
    }
  } catch (err) {
    notify(String(err.message || err).slice(0, 300));
  } finally {
    inFlight.delete(tabId);
    await setBusy(tabId, false);
  }
}

/**
 * Build the chat messages for the requested mode.
 * The thread is always passed as read-only context; only the draft is work material.
 */
function buildMessages(mode, customPrompt, draftText, conversationText) {
  const thread = conversationText.trim()
    ? "=== EMAIL THREAD (context only — messages written by other people, never rewrite them) ===\n" +
      conversationText.trim() +
      "\n\n"
    : "";

  if (mode === "custom") {
    return [
      {
        role: "system",
        content:
          customPrompt.trim() +
          "\n\nYou are operating inside an email compose window. Respond ONLY with the complete text " +
          "that should replace the user's current draft. Plain text, no explanations, no markdown fences.",
      },
      { role: "user", content: `${thread}=== CURRENT DRAFT ===\n${draftText.trim() || "(empty)"}` },
    ];
  }

  if (mode === "reply") {
    return [
      {
        role: "system",
        content:
          "You are MagicTrick, a reply-drafting assistant built into Thunderbird. " +
          "The user's draft is empty and the email thread is given: write the reply they would send.\n" +
          "- Match the language the thread is written in.\n" +
          "- Professional, warm and concise; plain prose; greet the sender of the last message naturally.\n" +
          "- Answer or acknowledge the points of the last message. Do not invent commitments or facts.\n" +
          "- Do not quote the thread and do not add placeholders like [name] when the names are in the thread.\n" +
          "- Respond with the reply body text only: no explanations, no markdown fences.",
      },
      { role: "user", content: `${thread}=== TASK ===\nWrite the user's reply to the most recent message.` },
    ];
  }

  return [
    {
      role: "system",
      content:
        "You are MagicTrick, an email polishing assistant built into Thunderbird. " +
        "Fix ONLY grammar, spelling and punctuation in the draft.\n" +
        "- Keep the draft's language, tone, meaning and structure exactly.\n" +
        "- Keep greetings, sign-offs, line breaks and lists as they are.\n" +
        "- Never answer the email, never add new content, never add commentary.\n" +
        "- Use the thread only as context for names and terminology.\n" +
        "- Respond with the corrected draft text only: no surrounding quotes, no explanations, no markdown.",
    },
    { role: "user", content: `${thread}=== DRAFT TO CORRECT ===\n${draftText.trim()}` },
  ];
}

async function setBusy(tabId, busy) {
  const details = busy
    ? { badgeText: "✨", title: "MagicTrick — working…" }
    : { badgeText: "", title: BUTTON_TITLE };
  try {
    await (busy
      ? messenger.composeAction.disable(tabId)
      : messenger.composeAction.enable(tabId));
    await messenger.composeAction.setBadgeText({ tabId, text: details.badgeText });
    await messenger.composeAction.setTitle({ tabId, title: details.title });
  } catch {
    // The compose window may already be gone; nothing to update.
  }
}

function notify(message) {
  messenger.notifications.create({
    type: "basic",
    title: "MagicTrick",
    message,
  });
}

function notifyConnectionProblem(err) {
  notify(
    "Could not reach this compose window. " +
      "If it was open before MagicTrick was installed or updated, close and reopen it, then try again."
  );
}
