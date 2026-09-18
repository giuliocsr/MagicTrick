/**
 * MagicTrick — settings page (opened as a Thunderbird tab from the wand's
 * right-click menu). Two sections: attachment rules and the standard prompt.
 */
"use strict";

/* ── Section menu ─────────────────────────────────────────────────── */
for (const button of document.querySelectorAll("#section-menu .section")) {
  button.addEventListener("click", () => {
    for (const other of document.querySelectorAll("#section-menu .section")) {
      other.classList.toggle("active", other === button);
    }
    for (const panel of document.querySelectorAll(".panel")) {
      panel.hidden = panel.id !== button.dataset.section;
    }
  });
}

/* ── Registered files rules ───────────────────────────────────────── */
const form = document.querySelector("#add-form");
const keywordsInput = document.querySelector("#keywords");
const fileInput = document.querySelector("#file");
const statusEl = document.querySelector("#status");
const tbody = document.querySelector("#rules-table tbody");

function flash(element, message) {
  element.textContent = message;
  setTimeout(() => (element.textContent = ""), 4000);
}

function renderRules(rules) {
  tbody.textContent = "";
  if (!rules.length) {
    const row = document.createElement("tr");
    row.className = "empty";
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = "No rules yet — register your first file above.";
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }
  for (const rule of rules) {
    const row = document.createElement("tr");
    const phrases = document.createElement("td");
    phrases.textContent = rule.keywords.join(", ");
    const file = document.createElement("td");
    file.textContent = rule.name;
    const size = document.createElement("td");
    size.textContent = `${(rule.size / 1024).toFixed(1)} kB`;
    const actions = document.createElement("td");
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      await MagicTrickAttachments.deleteAttachmentRule(rule.id);
      flash(statusEl, `Removed ${rule.name}`);
      refreshRules();
    });
    actions.appendChild(remove);
    row.append(phrases, file, size, actions);
    tbody.appendChild(row);
  }
}

async function refreshRules() {
  renderRules(await MagicTrickAttachments.listAttachmentRules());
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const keywords = keywordsInput.value.split(",").map((k) => k.trim()).filter(Boolean);
  if (!keywords.length || !fileInput.files.length) return;
  try {
    const meta = await MagicTrickAttachments.addAttachmentRule(keywords, fileInput.files[0]);
    form.reset();
    flash(statusEl, `Registered “${meta.name}”`);
    refreshRules();
  } catch (err) {
    flash(statusEl, `Could not register: ${err.message || err}`);
  }
});

refreshRules();

/* ── Standard prompt ──────────────────────────────────────────────── */
const promptArea = document.querySelector("#standard-prompt");
const promptStatus = document.querySelector("#prompt-status");
const restoreButton = document.querySelector("#restore-prompt");

async function refreshPrompt() {
  const data = await messenger.runtime
    .sendMessage({ type: "get-standard" })
    .catch(() => null);
  if (!data) return;
  promptArea.value = data.instruction;
  restoreButton.hidden = !data.saved;
}

document.querySelector("#save-prompt").addEventListener("click", async () => {
  const value = promptArea.value.trim();
  if (!value) return;
  await messenger.storage.local.set({ standardInstruction: value });
  restoreButton.hidden = false;
  flash(promptStatus, "Saved — applies to polish and auto-reply");
});

restoreButton.addEventListener("click", async () => {
  await messenger.storage.local.remove("standardInstruction");
  await new Promise((resolve) => setTimeout(resolve, 150));
  await refreshPrompt();
  flash(promptStatus, "Built-in instruction restored");
});

refreshPrompt();
