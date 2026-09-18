/**
 * MagicTrick — prompt window.
 *
 * A small OS window (created by the background through messenger.windows).
 * The editor is pre-filled with the ACTIVE standard instruction (the saved
 * one if set, else the built-in), so the user always sees what the AI is
 * normally told. Enter applies once; "Apply for all future emails" also
 * persists the text as the new standard.
 */
"use strict";

const textarea = document.getElementById("instruction");
let hasSaved = false;

window.focus();
textarea.focus();

// Pre-fill with the active standard instruction.
messenger.runtime
  .sendMessage({ type: "get-standard" })
  .then((data) => {
    if (data && typeof data.instruction === "string") {
      textarea.value = data.instruction;
      hasSaved = !!data.saved;
      updateRestoreVisibility();
      textarea.focus();
      textarea.select();
    }
  })
  .catch(() => {});

// Resize the OS window to exactly fit the content.
(async () => {
  try {
    const content = document.documentElement;
    const chromeHeight = window.outerHeight - window.innerHeight;
    const chromeWidth = window.outerWidth - window.innerWidth;
    const width = Math.max(360, Math.min(760, content.scrollWidth + chromeWidth + 2));
    const height = content.scrollHeight + chromeHeight + 2;
    const current = await messenger.windows.getCurrent();
    await messenger.windows.update(current.id, { width, height });
    textarea.focus(); // resizing can steal focus — give it back
  } catch {
    // Cosmetic only; the window simply keeps its default size.
  }
})();

function updateRestoreVisibility() {
  document.getElementById("restore").hidden = !hasSaved;
}

/** Send the instruction to the compose window and close. */
function applyOnce() {
  const value = textarea.value.trim();
  if (!value) return;
  // Deliver the message before closing: closing the window first would tear
  // down this context and the message would never arrive.
  messenger.runtime
    .sendMessage({ type: "run-custom", prompt: value })
    .catch(() => {})
    .finally(() => window.close());
}

async function applyAlways() {
  const value = textarea.value.trim();
  if (!value) return;
  try {
    await messenger.storage.local.set({ standardInstruction: value });
  } catch {
    // Storage failures should not block the one-time run.
  }
  applyOnce();
}

async function restoreBuiltin() {
  try {
    await messenger.storage.local.remove("standardInstruction");
  } catch {
    // Ignore; the textarea refill below still helps.
  }
  // Give the background's storage.onChanged listener a beat to catch up.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const data = await messenger.runtime.sendMessage({ type: "get-standard" }).catch(() => null);
  textarea.value = (data && data.instruction) || "";
  hasSaved = false;
  updateRestoreVisibility();
  textarea.focus();
}

textarea.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.close();
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    applyOnce();
  }
});

// Programmatic submit (and Ctrl+Enter semantics) apply once.
document.getElementById("prompt-form").addEventListener("submit", (event) => {
  event.preventDefault();
  applyOnce();
});

document.getElementById("apply-once").addEventListener("click", applyOnce);
document.getElementById("apply-always").addEventListener("click", applyAlways);
document.getElementById("restore").addEventListener("click", restoreBuiltin);
