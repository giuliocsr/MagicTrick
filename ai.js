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
    // The steadiest anonymous lane: handles spaced requests indefinitely.
    name: "Pollinations (openai-fast)",
    url: "https://text.pollinations.ai/openai",
    model: "openai-fast",
    cooldownMs: 4000,
  },
  {
    // Per-IP rolling quota; when it runs out the server says for how long.
    name: "LLM7 (Mistral Nemo)",
    url: "https://api.llm7.io/v1/chat/completions",
    // LLM7 expects an Authorization header even for anonymous access.
    headers: { Authorization: "Bearer unused" },
    model: "mistral-Nemo-Instruct-2407",
    cooldownMs: 10000,
  },
  {
    // Last resort: the simple GET text API (flaky, occasionally 500s).
    name: "Pollinations (simple)",
    kind: "simple-get",
    url: "https://text.pollinations.ai/",
    model: "openai-fast",
    cooldownMs: 4000,
  },
];

// LLM7 answers real-size drafts in 10-15 s — the old 8 s timeout aborted it
// mid-answer, which is why big drafts "failed" while tiny ones worked.
const AI_REQUEST_TIMEOUT_MS = 20000;
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
  if (endpoint.kind === "simple-get") {
    return aiCallSimpleGet(endpoint, messages, signal);
  }
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
    throw await httpError(response);
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

/** The plain GET text API: whole conversation flattened into one prompt. */
async function aiCallSimpleGet(endpoint, messages, signal) {
  const prompt = messages
    .map((m) => (m.role === "system" ? `INSTRUCTIONS:\n${m.content}` : m.content))
    .join("\n\n---\n\n");
  const url = endpoint.url + encodeURIComponent(prompt) + `?model=${encodeURIComponent(endpoint.model)}`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw await httpError(response);
  }
  const text = (await response.text()).trim();
  if (!text) throw new Error("empty completion");
  // Some error bodies come back as JSON with status 200 — reject them.
  if (text.startsWith("{") && /"error"/i.test(text.slice(0, 120))) {
    throw new Error("error body");
  }
  return aiCleanOutput(text);
}

/** HTTP error with the server's own retry hint, when it gives one. */
async function httpError(response) {
  let hint = "";
  try {
    const body = await response.text();
    const match = body.match(/[Rr]etry after (\d+) seconds/);
    if (match) hint = ` retry-after=${match[1]}`;
  } catch {
    // body unreadable — status alone is enough
  }
  return new Error(`HTTP ${response.status}${hint}`);
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
    const message = String(err.message || err);
    logLane("chain", "failed", elapsed, message);
    // Auto-retry only when something might recover by itself (network blip,
    // 5xx, timeout). When every lane answered 429 the provider is throttling
    // us — retrying immediately just burns quota. The ONE exception: a short
    // server-given retry-after (≤ 30 s) is worth waiting out inside the run.
    const allThrottled = /HTTP 429/.test(message) &&
      !/(timeout|NetworkError|fetch failed|HTTP 5)/i.test(message.replace(/HTTP 429[^·]*·/g, ""));
    if (allThrottled) {
      const hints = [...message.matchAll(/retry-after=(\d+)/g)].map((m) => Number(m[1]));
      const waitS = hints.length ? Math.min(30, Math.max(1, Math.min(...hints))) : 0;
      if (waitS > 0 && elapsed < 8000) {
        logLane("chain", "throttle-wait", waitS * 1000, `waiting ${waitS}s`);
        await new Promise((resolve) => setTimeout(resolve, waitS * 1000));
        return aiCompleteOnce(messages);
      }
      throw new Error(
        "Free AI quota is throttled right now — wait a minute and click again. " +
          `(detail: ${message.slice(0, 160)})`
      );
    }
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
          const errorMessage = String(err.message || "");
          if (/HTTP 429/.test(errorMessage)) {
            // Honour the server's own retry hint when present ("retry-after=N").
            const hint = errorMessage.match(/retry-after=(\d+)/);
            const cooldownMs = hint
              ? Math.min(360000, Math.max(5000, Number(hint[1]) * 1000))
              : endpoint.cooldownMs || 6000;
            laneCooldowns.set(endpoint.name, Date.now() + cooldownMs);
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
