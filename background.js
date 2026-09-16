/**
 * MagicTrick — background orchestration.
 *
 * Listens for the compose-window toolbar button (and its context menu),
 * coordinates the compose script (draft extraction / replacement) and the AI
 * backend chain, and keeps the button state and error notifications in order.
 *
 * Flow of a "fix" run:
 *   composeAction click
 *     → tabs.executeScript (idempotent compose.js injection)
 *     → tabs.sendMessage(tab, {command:"collect"})   (compose.js)
 *     → build prompt (draft + thread context)
 *     → aiComplete(...)                              (ai.js)
 *     → tabs.sendMessage(tab, {command:"apply"})     (compose.js)
 */
"use strict";

/* global MagicTrickAI, MagicTrickPrompts */

const BUTTON_TITLE = "MagicTrick — fix this email with AI";

/** Tab ids with a run currently in flight (one run per compose window). */
const inFlight = new Set();

// Register the compose script programmatically as well: manifest
// compose_scripts alone are not reliable on every Thunderbird build.
messenger.composeScripts
  .register({ js: [{ file: "compose.js" }] })
  .catch(() => {});

// Warm up the AI endpoints at startup: the first request from a fresh
// Thunderbird process pays DNS/TLS/gateway cold-start costs, which could
// otherwise make the first click of a session unnecessarily slow.
MagicTrickAI.aiComplete([{ role: "user", content: "ok" }]).catch(() => {});

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
    ensureComposeScript(tab.id)
      .then(() => messenger.tabs.sendMessage(tab.id, { command: "customPrompt" }))
      .catch(() => notifyConnectionProblem());
  }
});

messenger.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "run-custom" && sender.tab && sender.tab.id != null) {
    runMagicTrick(sender.tab.id, { mode: "custom", prompt: String(msg.prompt || "") });
  }
});

/** Make sure compose.js is listening in the given compose tab (idempotent). */
async function ensureComposeScript(tabId) {
  try {
    await messenger.tabs.executeScript(tabId, { file: "compose.js" });
  } catch {
    // Already injected or unsupported: the sendMessage callers report problems.
  }
}

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
    await ensureComposeScript(tabId);

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
  return MagicTrickPrompts.buildMessages(mode, customPrompt, draftText, conversationText);
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

function notifyConnectionProblem() {
  notify(
    "Could not reach this compose window. " +
      "If it was open before MagicTrick was installed or updated, close and reopen it, then try again."
  );
}
