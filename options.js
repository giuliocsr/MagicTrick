/**
 * MagicTrick — options page: the attachment-rules manager.
 */
"use strict";

const form = document.querySelector("#add-form");
const keywordsInput = document.querySelector("#keywords");
const fileInput = document.querySelector("#file");
const statusEl = document.querySelector("#status");
const tbody = document.querySelector("#rules tbody");

function flash(message) {
  statusEl.textContent = message;
  setTimeout(() => (statusEl.textContent = ""), 4000);
}

function render(rules) {
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
      flash(`Removed ${rule.name}`);
      refresh();
    });
    actions.appendChild(remove);
    row.append(phrases, file, size, actions);
    tbody.appendChild(row);
  }
}

async function refresh() {
  render(await MagicTrickAttachments.listAttachmentRules());
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const keywords = keywordsInput.value.split(",").map((k) => k.trim()).filter(Boolean);
  if (!keywords.length || !fileInput.files.length) return;
  try {
    await MagicTrickAttachments.addAttachmentRule(keywords, fileInput.files[0]);
    form.reset();
    flash(`Registered ${fileInput.files.length ? "" : ""}“${keywords.join(", ")}”`);
    refresh();
  } catch (err) {
    flash(`Could not register: ${err.message || err}`);
  }
});

refresh();
