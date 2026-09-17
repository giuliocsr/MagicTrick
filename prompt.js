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
