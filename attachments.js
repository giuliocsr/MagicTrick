/**
 * MagicTrick — attachment rules.
 *
 * WebExtensions cannot scan the disk, so files are REGISTERED once through the
 * MagicTrick options page and stored (as blobs, in the extension's IndexedDB).
 * A rule fires when one of its keyword phrases appears in the draft text —
 * e.g. "reference letters" → always attach reference-letters.pdf.
 *
 * Shared by the background page and the options page.
 */
"use strict";

/* global globalThis, indexedDB, crypto */

const MT_DB_NAME = "magictrick";
const MT_STORE = "attachmentRules";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(MT_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const store = db.transaction(MT_STORE, mode).objectStore(MT_STORE);
    const request = fn(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Register a file under a set of keyword phrases.
 * @param {string[]} keywords phrases that trigger the attachment
 * @param {File} file chosen through an <input type="file">
 * @returns {Promise<object>} the stored rule (without the blob)
 */
async function addAttachmentRule(keywords, file) {
  const db = await openDb();
  const rule = {
    id: crypto.randomUUID(),
    keywords: keywords.map((k) => k.trim()).filter(Boolean),
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    addedAt: Date.now(),
    blob: file,
  };
  await tx(db, "readwrite", (store) => store.put(rule));
  db.close();
  const { blob, ...meta } = rule;
  return meta;
}

/** @returns {Promise<Array<object>>} all rules, without blobs */
async function listAttachmentRules() {
  const db = await openDb();
  const rules = await tx(db, "readonly", (store) => store.getAll());
  db.close();
  return rules.map(({ blob, ...meta }) => meta);
}

/** @param {string} id */
async function deleteAttachmentRule(id) {
  const db = await openDb();
  await tx(db, "readwrite", (store) => store.delete(id));
  db.close();
}

/**
 * Rules whose keywords appear in the draft, hydrated into real File objects
 * ready for messenger.compose.addAttachment().
 * @param {string} draftText
 * @returns {Promise<Array<{name: string, file: File}>>}
 */
async function matchedAttachments(draftText) {
  const db = await openDb();
  const rules = await tx(db, "readonly", (store) => store.getAll());
  db.close();

  const haystack = draftText.toLowerCase();
  const out = [];
  for (const rule of rules) {
    const hit = (rule.keywords || []).some((keyword) => haystack.includes(keyword.toLowerCase()));
    if (!hit) continue;
    out.push({
      name: rule.name,
      file: new File([rule.blob], rule.name, { type: rule.type }),
    });
  }
  return out;
}

const MagicTrickAttachments = { addAttachmentRule, listAttachmentRules, deleteAttachmentRule, matchedAttachments };

if (typeof globalThis !== "undefined") {
  globalThis.MagicTrickAttachments = MagicTrickAttachments;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = MagicTrickAttachments;
}
