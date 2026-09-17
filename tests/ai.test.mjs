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
const { buildMessages, stripAnswerPreamble, classifyRecipients } = require("../prompts.js");
const { parseMailbox } = require("../contacts.js");

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
/* Recipient assistance (deterministic, local)                          */
/* ------------------------------------------------------------------ */

test("classifyRecipients: greeted contact → To, other referenced → Cc", () => {
  const candidates = [
    { name: "Pietro Bianchi", email: "pietro.bianchi@example.com" },
    { name: "Giorgio Rossi", email: "giorgio.rossi@example.com" },
  ];
  const draft =
    "Hello Pietro, how are you? Giorgio has attached the correspondence. " +
    "Attached, you can find my reference letters.";
  assert.deepEqual(classifyRecipients(draft, candidates), {
    to: ["pietro.bianchi@example.com"],
    cc: ["giorgio.rossi@example.com"],
  });
});

test("classifyRecipients: no greeting → everyone Cc", () => {
  const candidates = [{ name: "Giorgio Rossi", email: "giorgio@example.com" }];
  assert.deepEqual(classifyRecipients("Please thank Giorgio for the letter.", candidates), {
    to: [],
    cc: ["giorgio@example.com"],
  });
});

test("classifyRecipients: empty candidates", () => {
  assert.deepEqual(classifyRecipients("Hello Pietro", []), { to: [], cc: [] });
});

/* ------------------------------------------------------------------ */
/* Answer cleanup: replace, never annotate                            */
/* ------------------------------------------------------------------ */

test("stripAnswerPreamble removes a leading 'here is the corrected text' line", () => {
  assert.equal(stripAnswerPreamble("Here is the corrected text:\n\nHello."), "Hello.");
  assert.equal(stripAnswerPreamble("Corrected version:\nHello."), "Hello.");
  assert.equal(stripAnswerPreamble("Here's the corrected draft:\nHello."), "Hello.");
  // A normal first line must survive untouched.
  assert.equal(stripAnswerPreamble("Corrected: this is my actual sentence."), "Corrected: this is my actual sentence.");
  assert.equal(stripAnswerPreamble("Hello Pietro, how are you?"), "Hello Pietro, how are you?");
});

test("fix prompt demands replacement output, not annotations", () => {
  const messages = buildMessages("fix", "", "Amber alert does not vork.", "");
  assert.match(messages[0].content, /REPLACE the draft verbatim/);
  assert.match(messages[0].content, /no lists of errors/);
});

test("formatted drafts travel as HTML with preservation rules", () => {
  const messages = buildMessages("fix", "", "bullet text", "", "<ul><li>Amber alert</li></ul>");
  assert.match(messages[1].content, /DRAFT TO CORRECT \(HTML\)/);
  assert.match(messages[1].content, /<ul><li>Amber alert<\/li><\/ul>/);
  assert.match(messages[0].content, /EXACTLY the \nsame tags|EXACTLY the same tags/);
  const plain = buildMessages("fix", "", "plain", "");
  assert.doesNotMatch(plain[1].content, /\(HTML\)/);
});

/* ------------------------------------------------------------------ */
/* Mailbox header parsing (contact sources)                            */
/* ------------------------------------------------------------------ */

test("parseMailbox understands all common header shapes", () => {
  assert.deepEqual(parseMailbox("Giorgio Rossi <hiimgiorgio@gmail.com>"), {
    name: "Giorgio Rossi",
    email: "hiimgiorgio@gmail.com",
  });
  assert.deepEqual(parseMailbox("hiimgiorgio@gmail.com"), {
    name: "hiimgiorgio@gmail.com",
    email: "hiimgiorgio@gmail.com",
  });
  assert.deepEqual(parseMailbox('"Doe, Jane" <jane@x.test>'), { name: "Doe, Jane", email: "jane@x.test" });
  assert.equal(parseMailbox(""), null);
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

test("realistic grammar fix completes within 5 seconds", { timeout: 60000 }, async () => {
  const messages = buildMessages(
    "fix",
    "",
    "He go to store yesterday and buyed three apple for hisself.\n" +
      "I hopes he share them with we. It were a good day for him and me.",
    "On 09/16/2026 05:00 PM, Alice Martin wrote:\nDid you get the groceries?"
  );
  const t0 = performance.now();
  const answer = await aiComplete(messages);
  const elapsed = performance.now() - t0;
  assert.ok(/went to the store/.test(answer), `unexpected answer: ${answer.slice(0, 120)}`);
  assert.ok(elapsed < 5000, `grammar fix took ${Math.round(elapsed)}ms (budget 5000ms)`);
});

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
