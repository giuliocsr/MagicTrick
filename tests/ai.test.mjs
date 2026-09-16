/**
 * MagicTrick — unit tests for the AI endpoint chain and prompt construction.
 *
 * The chain tests hit the real keyless endpoints (small requests); run with:
 *   node --test tests/ai.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AI_ENDPOINTS, aiCleanOutput, aiComplete } = require("../ai.js");
const { buildMessages } = require("../prompts.js");

/* ------------------------------------------------------------------ */
/* Prompt construction                                                 */
/* ------------------------------------------------------------------ */

test("fix mode: draft and thread are placed in separate sections", () => {
  const messages = buildMessages("fix", "", "He go store.", "Alice wrote hello.");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /Fix ONLY grammar/);
  assert.match(messages[1].content, /EMAIL THREAD/);
  assert.match(messages[1].content, /DRAFT TO CORRECT/);
  assert.ok(messages[1].content.includes("Alice wrote hello."));
  assert.ok(messages[1].content.includes("He go store."));
});

test("reply mode: used for empty drafts, thread becomes context", () => {
  const messages = buildMessages("reply", "", "", "Thread about the budget.");
  assert.match(messages[0].content, /reply-drafting assistant/);
  assert.match(messages[1].content, /Thread about the budget\./);
});

test("custom mode: user instruction replaces the system prompt", () => {
  const messages = buildMessages("custom", "Translate to German.", "Hallo Welt.", "");
  assert.match(messages[0].content, /Translate to German\./);
  assert.match(messages[1].content, /CURRENT DRAFT/);
});

test("empty conversation omits the thread section", () => {
  const messages = buildMessages("fix", "", "draft", "");
  assert.doesNotMatch(messages[1].content, /EMAIL THREAD/);
});

/* ------------------------------------------------------------------ */
/* Output cleaning                                                     */
/* ------------------------------------------------------------------ */

test("markdown fences are stripped from wrapped answers", () => {
  assert.equal(aiCleanOutput("```\ncorrected text\n```"), "corrected text");
  assert.equal(aiCleanOutput("```html\n<b>x</b>\n```"), "<b>x</b>");
  assert.equal(aiCleanOutput("  plain  "), "plain");
  assert.equal(aiCleanOutput("multi\nline\nkeep"), "multi\nline\nkeep");
});

/* ------------------------------------------------------------------ */
/* Endpoint chain (network)                                            */
/* ------------------------------------------------------------------ */

test("chain answers through a keyless endpoint", { timeout: 120000 }, async () => {
  const answer = await aiComplete([
    { role: "system", content: "Answer with a single word." },
    { role: "user", content: "Reply with exactly: MAGIC" },
  ]);
  assert.match(answer, /MAGIC/i);
});

test("chain falls back when leading endpoints are broken", { timeout: 120000 }, async () => {
  const saved = AI_ENDPOINTS.map((e) => e.url);
  AI_ENDPOINTS[0].url = "https://magictrick-invalid.test/v1";
  AI_ENDPOINTS[1].url = "https://magictrick-invalid.test/v2";
  try {
    const answer = await aiComplete([
      { role: "system", content: "Answer with a single word." },
      { role: "user", content: "Reply with exactly: FALLBACK" },
    ]);
    assert.match(answer, /FALLBACK/i);
  } finally {
    AI_ENDPOINTS.forEach((e, i) => (e.url = saved[i]));
  }
});

test("chain fails loudly when every endpoint is broken", { timeout: 120000 }, async () => {
  const saved = AI_ENDPOINTS.map((e) => e.url);
  AI_ENDPOINTS.forEach((e) => (e.url = "https://magictrick-invalid.test/v3"));
  try {
    await assert.rejects(
      () =>
        aiComplete([
          { role: "user", content: "anything" },
        ]),
      (err) => {
        assert.match(err.message, /All AI endpoints failed/);
        assert.equal((err.message.match(/fetch failed/g) || []).length, AI_ENDPOINTS.length);
        return true;
      }
    );
  } finally {
    AI_ENDPOINTS.forEach((e, i) => (e.url = saved[i]));
  }
});
