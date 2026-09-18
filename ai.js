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
    cooldownMs: 10000,
  },
  {
    name: "Pollinations (openai-fast)",
    url: "https://text.pollinations.ai/openai",
    model: "openai-fast",
    cooldownMs: 4000,
  },
  {
    name: "Pollinations",
    url: "https://text.pollinations.ai/openai",
    model: "openai",
    cooldownMs: 4000,
  },
];

const AI_REQUEST_TIMEOUT_MS = 8000;
const AI_MAX_OUTPUT_TOKENS = 2048;

/** Throttled lanes sit out briefly instead of burning race slots.
 * LLM7: one anonymous request per ~10 s; Pollinations: burst limits. */
const laneCooldowns = new Map(); // endpoint name → timestamp until
const HEDGE_DELAY_MS = 1500;
/** The lane that won the previous run leads the next one alone — halves the
 * request volume per run and keeps both providers out of their burst limits. */
let lastWinner = null;

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
    const elapsed = Date.now() - started;
    logLane("chain", "failed", elapsed, err.message || err);
    // One retry whenever the chain failed quickly enough that the user is
    // still waiting anyway — the anonymous endpoints' throttles and network
    // blips usually clear within a second.
    if (elapsed >= 12000) throw err;
    await new Promise((resolve) => setTimeout(resolve, 700));
    return aiCompleteOnce(messages);
  }
}

function aiCompleteOnce(messages) {
  const FAST_LANES = 2; // endpoints raced in parallel at t=0
  const BACKSTOP = AI_ENDPOINTS.length - 1;
  const controllers = [];
  const started = new Set();
  const failed = new Set();
  const skipped = new Set(); // fast lanes held back by a throttle cooldown
  const errors = [];
  let settled = false;
  let backstopLaunched = false;

  return new Promise((resolve, reject) => {
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      for (const controller of controllers) {
        if (!controller.signal.aborted) controller.abort();
      }
      fn(arg);
    };

    function maybeAdvance() {
      const fastDone = () => {
        for (let i = 0; i < FAST_LANES; i++) {
          if (!failed.has(i) && !skipped.has(i)) return false;
        }
        return true;
      };
      if (fastDone() && !backstopLaunched) {
        backstopLaunched = true;
        run(BACKSTOP);
      }
      // Reject only when EVERY endpoint is resolved (failed or cooling-skipped)
      // — a hedge lane or backstop that has not run yet must not be cut off.
      let allResolved = true;
      for (let i = 0; i < AI_ENDPOINTS.length; i++) {
        if (!failed.has(i) && !skipped.has(i)) allResolved = false;
      }
      if (allResolved) {
        finish(reject, new Error(`All AI endpoints failed (${errors.join(" · ")})`));
      }
    }

    function run(index) {
      if (settled || index >= AI_ENDPOINTS.length || started.has(index)) return;
      started.add(index);
      const endpoint = AI_ENDPOINTS[index];

      const controller = new AbortController();
      controllers.push(controller);
      const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
      timer.unref?.();

      const laneStarted = Date.now();
      aiCallEndpoint(endpoint, messages, controller.signal).then(
        (content) => {
          lastWinner = endpoint.name;
          logLane(endpoint.name, "ok", Date.now() - laneStarted, "");
          finish(resolve, content);
        },
        (err) => {
          clearTimeout(timer);
          const aborted = controller.signal.aborted;
          logLane(
            endpoint.name,
            aborted ? (settled ? "lost-race" : "timeout") : "fail",
            Date.now() - laneStarted,
            String(err.message || err)
          );
          if (/HTTP 429/.test(String(err.message || ""))) {
            laneCooldowns.set(
              endpoint.name,
              Date.now() + (endpoint.cooldownMs || 6000)
            );
          }
          if (settled) return;
          failed.add(index);
          errors.push(`${endpoint.name}: ${err.message || err}`);
          maybeAdvance();
        }
      );
    }

    // Winner-first: the lane that won the previous run leads alone and the
    // other fast lane joins only as a late hedge. Endpoints currently
    // throttling us sit the round out (unless every fast lane is cooling).
    const cooling = (index) =>
      (laneCooldowns.get(AI_ENDPOINTS[index].name) || 0) > Date.now();

    const winnerIndex = AI_ENDPOINTS.findIndex((e) => e.name === lastWinner);
    if (
      lastWinner &&
      winnerIndex !== -1 &&
      winnerIndex < FAST_LANES &&
      !cooling(winnerIndex)
    ) {
      run(winnerIndex);
      const other = 1 - winnerIndex;
      if (!cooling(other)) {
        setTimeout(() => run(other), HEDGE_DELAY_MS);
      } else {
        skipped.add(other);
        logLane(AI_ENDPOINTS[other].name, "cooldown", 0, "");
      }
    } else {
      let startedFast = 0;
      for (let i = 0; i < FAST_LANES; i++) {
        if (cooling(i)) {
          skipped.add(i);
          logLane(AI_ENDPOINTS[i].name, "cooldown", 0, "");
        } else {
          run(i);
          startedFast++;
        }
      }
      if (startedFast === 0) {
        for (let i = 0; i < FAST_LANES; i++) {
          skipped.delete(i);
          run(i);
        }
      }
    }
    maybeAdvance();
  });
}

globalThis.__mtChainLog = [];

function logLane(endpoint, status, ms, error) {
  try {
    globalThis.__mtChainLog.push({
      at: new Date().toISOString(),
      lane: endpoint,
      status,
      ms,
      error: error.slice(0, 200),
    });
    if (globalThis.__mtChainLog.length > 60) globalThis.__mtChainLog.shift();
    messenger?.storage?.local?.set({ chainLog: globalThis.__mtChainLog.slice(-25) });
  } catch {
    // Node (unit tests) has no messenger.
  }
}

globalThis.MagicTrickAI = {
  aiComplete,
  chainLog: globalThis.__mtChainLog,
};

// Node (unit tests) loads this file via require().
if (typeof module !== "undefined" && module.exports) {
  module.exports = { AI_ENDPOINTS, aiCallEndpoint, aiCleanOutput, aiComplete };
}
