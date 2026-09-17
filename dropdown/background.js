/**
 * MagicTrick ▾ — the dropdown half of the split button.
 *
 * Thunderbird allows each extension exactly one compose button, so the split
 * button ([wand = polish][▾ = menu]) is realised as two neighbouring add-ons:
 * the main MagicTrick button and this menu-typed dropdown. Every entry simply
 * forwards a command to the main extension.
 */
"use strict";

const MAIN_EXTENSION = "magictrick@giuliocsr.github.io";
const CONTEXTS = ["compose_action_menu"];

messenger.menus.create({
  id: "mt-fix",
  title: "✨ Polish this draft",
  contexts: CONTEXTS,
});
messenger.menus.create({ type: "separator", contexts: CONTEXTS });
messenger.menus.create({
  id: "mt-prompt",
  title: "MagicTrick with prompt…",
  contexts: CONTEXTS,
});
messenger.menus.create({
  id: "mt-rules",
  title: "Manage attachment rules…",
  contexts: CONTEXTS,
});

messenger.menus.onClicked.addListener((info) => {
  const commands = {
    "mt-fix": "fix",
    "mt-prompt": "prompt",
    "mt-rules": "rules",
  };
  const command = commands[info.menuItemId];
  if (command) {
    messenger.runtime.sendMessage(MAIN_EXTENSION, { magictrickCommand: command }).catch(() => {});
  }
});
