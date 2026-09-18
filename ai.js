/**
 * MagicTrick — AI backend chain.
 *
 * Calls keyless (no API key, no signup) OpenAI-compatible chat-completion
 * endpoints, racing two fast providers in parallel for low latency:
 *
 *   t=0     endpoint #1 and #2 in parallel — first valid answer wins,
 *           the losing request is aborted
 *   on fail endpoint #3 (slower backstop) as soon as both fast ones failed
 *
 * Reasoning-heavy free models are deliberately avoided: they can spend
 * 10-30 s thinking before answering (that was the original "stays on working
 * for a long time" bug). Keep replacements fast-and-simple.
 *
 * These are free community services with no data agreement — the price of
 * "zero setup". Do not use MagicTrick for confidential email. See README.
 */
"use strict";

// Registered as a plain global because background pages in MV2 share one scope.
/* global globalThis */

const AI_ENDPOINTS = [
  {
    name: "LLM7 (Mistral Nemo)",
    url: "https://api.llm7.io/v1/chat/completions",
    // LLM7 expects an Authorization header even for anonymous access, and
    // allows only ONE concurrent request per anonymous client.
    headers: { Authorization: "Bearer unused" },
    model: "mistral-Nemo-Instruct-2407",
  },
  {
    name: "Pollinations (openai-fast)",
    url: "https://text.pollinations.ai/openai",
    model: "openai-fast",
  },
  {
    name: "Pollinations",
    url: "https://text.pollinations.ai/openai",
    model: "openai",
  },
];

const AI_REQUEST_TIMEOUT_MS = 8000;
const AI_MAX_OUTPUT_TOKENS = 2048;

/**
 * Run one request against one endpoint.
 * @param {object} endpoint
 * @param {Array<{role: string, content: string}>} messages
 * @param {AbortSignal} signal aborted by the chain when a competitor wins
 * @returns {Promise<string>} the assistant message content
 */
async function aiCallEndpoint(endpoint, messages, signal) {
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(endpoint.headers || {}) },
    body: JSON.stringify({
      model: endpoint.model,
      messages,
      // No temperature: several free backends reject non-default values.
      // No reasoning_effort either: it hangs some community gateways.
      max_tokens: AI_MAX_OUTPUT_TOKENS,
    }),
    signal,
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
}

/** Strip the wrapping markdown fences some models add around plain answers. */
function aiCleanOutput(text) {
  let out = text.trim();
  const fence = out.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fence) out = fence[1].trim();
  return out;
}

/**
 * Complete a chat: race the two fast endpoints, backstop with the third.
 * A chain that fails FAST (throttle/4xx class, not timeouts) is retried
 * once after a short pause — the anonymous endpoints occasionally reject a
 * first burst and accept the immediate retry.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<string>}
 * @throws {Error} with one line per endpoint when every endpoint failed
 */
async function aiComplete(messages) {
  const started = Date.now();
  try {
    return await aiCompleteOnce(messages);
  } catch (err) {
    const fastFailure = Date.now() - started < 2500;
    if (!fastFailure) throw err;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return aiCompleteOnce(messages);
  }
}

function aiCompleteOnce(messages) {
  const FAST_LANES = 2; // endpoints raced in parallel at t=0
  const controllers = [];
  const started = new Set();
  const failed = new Set();
  const errors = [];
  let settled = false;

  return new Promise((resolve, reject) => {
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      for (const controller of controllers) {
        if (!controller.signal.aborted) controller.abort();
      }
      fn(arg);
    };

    const run = (index) => {
      if (settled || index >= AI_ENDPOINTS.length || started.has(index)) return;
      started.add(index);
      const endpoint = AI_ENDPOINTS[index];

      const controller = new AbortController();
      controllers.push(controller);
      const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
      timer.unref?.();

      aiCallEndpoint(endpoint, messages, controller.signal).then(
        (content) => finish(resolve, content),
        (err) => {
          clearTimeout(timer);
          if (settled) return;
          failed.add(index);
          errors.push(`${endpoint.name}: ${err.message || err}`);
          // Backstop: only once every fast lane has failed.
          let fastAllFailed = true;
          for (let i = 0; i < FAST_LANES; i++) fastAllFailed = fastAllFailed && failed.has(i);
          if (fastAllFailed) run(AI_ENDPOINTS.length - 1);
          if (started.size === AI_ENDPOINTS.length && failed.size === AI_ENDPOINTS.length) {
            finish(reject, new Error(`All AI endpoints failed (${errors.join(" · ")})`));
          }
        }
      );
    };

    for (let i = 0; i < FAST_LANES; i++) run(i);
  });
}

globalThis.MagicTrickAI = { aiComplete };

// Node (unit tests) loads this file via require().
if (typeof module !== "undefined" && module.exports) {
  module.exports = { AI_ENDPOINTS, aiCallEndpoint, aiCleanOutput, aiComplete };
}
