/**
 * MagicTrick — AI backend chain.
 *
 * Calls keyless (no API key, no signup) OpenAI-compatible chat-completion
 * endpoints. They are tried in order: the first one that answers wins; if one
 * is down, throttled or returns junk, the next is used automatically.
 *
 * These are free community services with no data agreement — the price of
 * "zero setup". Do not use MagicTrick for confidential email. See README.
 */
"use strict";

// Registered as a plain global because background pages in MV2 share one scope.
/* global globalThis */

const AI_ENDPOINTS = [
  {
    name: "LLM7",
    url: "https://api.llm7.io/v1/chat/completions",
    // LLM7 expects an Authorization header even for anonymous access.
    headers: { Authorization: "Bearer unused" },
    model: "GLM-5.3-Flash",
  },
  {
    name: "Pollinations",
    url: "https://gen.pollinations.ai/v1/chat/completions",
    model: "openai",
  },
  {
    name: "Pollinations (legacy)",
    url: "https://text.pollinations.ai/openai",
    model: "openai",
  },
];

const AI_REQUEST_TIMEOUT_MS = 45000;
const AI_MAX_OUTPUT_TOKENS = 2048;

/**
 * Run one request against one endpoint.
 * @returns {Promise<string>} the assistant message content
 */
async function aiCallEndpoint(endpoint, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(endpoint.headers || {}) },
      body: JSON.stringify({
        model: endpoint.model,
        messages,
        // No temperature: several free backends reject non-default values.
        max_tokens: AI_MAX_OUTPUT_TOKENS,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    // Reasoning models put their chain of thought in a sibling field; only the
    // message content is the answer. An empty content is a failure.
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("empty completion");
    }
    return aiCleanOutput(content);
  } finally {
    clearTimeout(timer);
  }
}

/** Strip the wrapping markdown fences some models add around plain answers. */
function aiCleanOutput(text) {
  let out = text.trim();
  const fence = out.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fence) out = fence[1].trim();
  return out;
}

/**
 * Complete a chat through the endpoint chain.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<string>}
 * @throws {Error} with one line per endpoint when every endpoint failed
 */
async function aiComplete(messages) {
  const errors = [];
  for (const endpoint of AI_ENDPOINTS) {
    try {
      return await aiCallEndpoint(endpoint, messages);
    } catch (err) {
      errors.push(`${endpoint.name}: ${err.message || err}`);
    }
  }
  throw new Error(`All AI endpoints failed (${errors.join(" · ")})`);
}

globalThis.MagicTrickAI = { aiComplete };

// Node (unit tests) loads this file via require().
if (typeof module !== "undefined" && module.exports) {
  module.exports = { AI_ENDPOINTS, aiCallEndpoint, aiCleanOutput, aiComplete };
}
