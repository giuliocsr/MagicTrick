/**
 * MagicTrick — background orchestration.
 *
 * The compose button is a menu-typed action: clicking it opens the native
 * dropdown (like Thunderbird's attach button). The first entry runs the
 * polish pipeline; Ctrl+Shift+G runs it directly.
 *
 * Flow of a run:
 *   menu "Polish this draft" / Ctrl+Shift+G / prompt bar submit
 *     → tabs.executeScript (idempotent compose.js injection)
 *     → tabs.sendMessage(tab, {command:"collect"})   (compose.js)
 *     → contact candidates + attachment rules        (contacts.js / attachments.js)
 *     → one AI call (draft + thread, HTML when formatted) (ai.js / prompts.js)
 *     → apply corrected text (single undoable transaction, format preserved)
 *     → merge deterministic To/Cc additions, attach matching files
 */
"use strict";

/* global MagicTrickAI, MagicTrickPrompts, MagicTrickContacts, MagicTrickAttachments */

const BUTTON_TITLE = "MagicTrick — fix this email with AI";

/** True when the HTML carries formatting the AI must preserve. */
const FORMATTING_RE = /<(ul|ol|li|b|strong|i|em|u|a\s|table|h[1-6])\b/i;

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

// The button's native dropdown (menu-typed compose action)…
messenger.menus.create({
  id: "magictrick-fix",
  title: "✨ Polish this draft",
  contexts: ["compose_action_menu", "compose_action"],
});
messenger.menus.create({ type: "separator", contexts: ["compose_action_menu", "compose_action"] });
messenger.menus.create({
  id: "magictrick-with-prompt",
  title: "MagicTrick with prompt…",
  contexts: ["compose_action_menu", "compose_action"],
});
messenger.menus.create({
  id: "magictrick-manage-attachments",
  title: "Manage attachment rules…",
  contexts: ["compose_action_menu", "compose_action"],
});

messenger.menus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === "magictrick-fix") {
    runMagicTrick(tab.id, { mode: "auto" });
    return;
  }
  if (info.menuItemId === "magictrick-manage-attachments") {
    openRulesPage();
    return;
  }
  if (info.menuItemId === "magictrick-with-prompt") {
    // Ask the compose script to show the in-window prompt bar; it will call us
    // back with {type:"run-custom", prompt} when the user submits it.
    ensureComposeScript(tab.id)
      .then(() => messenger.tabs.sendMessage(tab.id, { command: "customPrompt" }))
      .catch(() => notifyConnectionProblem());
  }
});

// Ctrl+Shift+G: run the polish pipeline on the active compose window.
messenger.commands?.onCommand.addListener((command) => {
  if (command !== "_execute_compose_action") return;
  findActiveComposeTab().then((tabId) => {
    if (tabId != null) runMagicTrick(tabId, { mode: "auto" });
  });
});

async function findActiveComposeTab() {
  try {
    const active = await messenger.tabs.query({ active: true });
    const compose = active.find((t) => t.type === "messageCompose");
    return compose ? compose.id : null;
  } catch {
    return null;
  }
}

/** Open the attachment-rules page (options page), with a robust fallback. */
async function openRulesPage() {
  try {
    await messenger.runtime.openOptionsPage();
  } catch {
    try {
      await messenger.tabs.create({ url: messenger.runtime.getURL("options.html") });
    } catch {
      notify("Could not open the attachment-rules page.");
    }
  }
}

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

    let extract;
    try {
      extract = await messenger.tabs.sendMessage(tabId, { command: "collect" });
      if (extract && extract.error) throw new Error(extract.error);
    } catch (err) {
      throw new Error(
        "Could not reach this compose window. " +
          "If it was open before MagicTrick was installed or updated, close and reopen it, then try again."
      );
    }
    const draft = extract ? extract.draftText : "";
    const conversation = extract ? extract.conversationText : "";
    const draftHtml = extract ? extract.draftHtml || "" : "";

    const mode = opts.mode === "custom" ? "custom" : !draft.trim() ? "reply" : "fix";
    if (mode === "reply" && !conversation.trim()) {
      notify("Nothing to do: the draft is empty and there is no conversation to reply to.");
      return;
    }

    // Local context: contact candidates and registered attachment rules.
    const candidates = await MagicTrickContacts.findContactCandidates(draft).catch(() => []);
    const attachments = await MagicTrickAttachments.matchedAttachments(draft).catch(() => []);

    // Formatted drafts travel as HTML so lists/links/emphasis survive the trip.
    const formatted = FORMATTING_RE.test(draftHtml);
    const messages = MagicTrickPrompts.buildMessages(
      mode,
      opts.prompt,
      draft,
      conversation,
      formatted ? draftHtml : null
    );
    const answer = MagicTrickPrompts.stripAnswerPreamble(await MagicTrickAI.aiComplete(messages));

    let applyMsg = { command: "apply", text: answer };
    if (formatted) {
      if (FORMATTING_RE.test(answer)) {
        applyMsg = { command: "apply", text: answer, html: true };
      } else {
        // The model lost the formatting — fall back to plain text rather
        // than inserting a mangled structure.
        applyMsg = { command: "apply", text: answer.replace(/<[^>]+>/g, "") };
      }
    }
    const applied = await messenger.tabs.sendMessage(tabId, applyMsg);
    if (!applied || !applied.ok) {
      throw new Error((applied && applied.error) || "Could not update the compose window.");
    }

    const summary = [mode === "reply" ? "✨ reply drafted" : "✨"];

    // Recipients: deterministic local classification (greeted → To, other
    // referenced candidates → Cc), merged into the existing fields without
    // duplicates. setComposeDetails accepts plain email strings.
    if (candidates.length) {
      const wanted = MagicTrickPrompts.classifyRecipients(draft, candidates);
      const details = await messenger.compose.getComposeDetails(tabId);
      const current = {
        to: (details.to || []).map(String),
        cc: (details.cc || []).map(String),
      };
      const present = new Set(
        [...current.to, ...current.cc].map((entry) => entry.toLowerCase())
      );
      const additions = {
        to: wanted.to.filter((email) => !present.has(email.toLowerCase())),
        cc: wanted.cc.filter((email) => !present.has(email.toLowerCase())),
      };
      if (additions.to.length || additions.cc.length) {
        await messenger.compose.setComposeDetails(tabId, {
          to: [...current.to, ...additions.to],
          cc: [...current.cc, ...additions.cc],
        });
        if (additions.to.length) summary.push(`To: ${additions.to.join(", ")}`);
        if (additions.cc.length) summary.push(`Cc: ${additions.cc.join(", ")}`);
      }
    }

    // Attachments: every rule whose phrase appears in the draft.
    for (const { name, file } of attachments) {
      await messenger.compose.addAttachment(tabId, { file, name });
      summary.push(`📎 ${name}`);
    }

    if (summary.length > 1) notify(summary.join("  ·  "));
  } catch (err) {
    notify(String(err.message || err).slice(0, 300));
  } finally {
    inFlight.delete(tabId);
    await setBusy(tabId, false);
  }
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
