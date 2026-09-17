/**
 * MagicTrick — prompt window.
 *
 * A small OS window (created by the background through messenger.windows):
 * the input is focused on open, Enter sends, Esc closes.
 */
"use strict";

const input = document.getElementById("instruction");

window.focus();
input.focus();
input.select();

// Resize the OS window to exactly fit the content (input + OK button).
// outerHeight − innerHeight is the window chrome (title bar); the width is
// content-driven but capped so it stays pleasant on large monitors.
(async () => {
  try {
    const content = document.documentElement;
    const chromeHeight = window.outerHeight - window.innerHeight;
    const chromeWidth = window.outerWidth - window.innerWidth;
    const width = Math.max(320, Math.min(720, content.scrollWidth + chromeWidth + 2));
    const height = content.scrollHeight + chromeHeight + 2;
    const current = await messenger.windows.getCurrent();
    await messenger.windows.update(current.id, { width, height });
    input.focus(); // resizing can steal focus — give it back
  } catch {
    // Cosmetic only; the window simply keeps its default size.
  }
})();

document.getElementById("prompt-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = input.value.trim();
  if (!value) return;
  // Deliver the message before closing: closing the window first would tear
  // down this context and the message would never arrive.
  messenger.runtime
    .sendMessage({ type: "run-custom", prompt: value })
    .catch(() => {})
    .finally(() => window.close());
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.close();
});
