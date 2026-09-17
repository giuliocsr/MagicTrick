/**
 * MagicTrick — contact resolution.
 *
 * Finds the people whose name actually appears in the draft, so that only a
 * handful of "Name <email>" entries ever matter. Two sources, merged (address
 * book entries win over history matches):
 *
 *   1. every address book of every account;
 *   2. the people you actually exchange email with (recent message history) —
 *      not everyone is a saved contact.
 *
 * The classifier in prompts.js works on this same list, and recipients are
 * only ever picked from it — the AI never chooses addresses.
 *
 * Loaded as a background script; Thunderbird APIs only.
 */
"use strict";

/* global globalThis */

const CONTACT_CACHE_MS = 60000;
let contactCache = { when: 0, entries: [] };

/** Parse a "Name <email>" / "email" / "Name (email)" header value. */
function parseMailbox(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let match = raw.match(/^(.*)<([^>]+)>\s*$/);
  if (match) {
    const name = match[1].trim().replace(/^["']|["']$/g, "");
    return { name: name || match[2], email: match[2].toLowerCase() };
  }
  match = raw.match(/^([^()\s]+@[^()\s]+)$/);
  if (match) return { name: match[1], email: match[1].toLowerCase() };
  match = raw.match(/^(.*?)\(([^)]+@[^)]+)\)\s*$/);
  if (match) return { name: match[1].trim() || match[2], email: match[2].toLowerCase() };
  return null;
}

/** @returns {Promise<Array<{name: string, email: string}>>} all address-book contacts */
async function loadAddressBookContacts() {
  const entries = [];
  try {
    const books = await messenger.addressBooks.list(true);
    for (const book of books) {
      const nodes = await messenger.contacts.list(book.id).catch(() => []);
      for (const node of nodes) {
        const p = node.properties || {};
        const email = p.PrimaryEmail;
        if (!email) continue;
        const name = p.DisplayName || p.FirstName || p.LastName || email;
        entries.push({ name: String(name), email: String(email) });
      }
    }
  } catch {
    // No address-book permission or a broken book: history still helps.
  }
  return entries;
}

/**
 * Correspondents from message history (author + recipients). The query API
 * of Thunderbird 155 has no limit parameter, so the result is capped while
 * iterating.
 * @param {number} limit how many messages to use
 */
async function loadHistoryContacts(limit) {
  const map = new Map(); // email → {name, email}
  try {
    const page = await messenger.messages.query({
      includeSubFolders: true,
    });
    for (const message of (page.messages || []).slice(0, limit)) {
      for (const value of [message.author, ...(message.recipients || [])]) {
        const mailbox = parseMailbox(value);
        if (!mailbox) continue;
        if (!map.has(mailbox.email)) {
          map.set(mailbox.email, { name: mailbox.name, email: mailbox.email });
        }
      }
    }
  } catch {
    // No messagesRead permission or empty stores: address books still help.
  }
  return [...map.values()];
}

/** Merged, cached candidate universe (address books first, history as extra). */
async function loadContacts() {
  if (Date.now() - contactCache.when < CONTACT_CACHE_MS) {
    return contactCache.entries;
  }
  const byEmail = new Map();
  for (const entry of await loadAddressBookContacts()) {
    byEmail.set(entry.email.toLowerCase(), entry);
  }
  for (const entry of await loadHistoryContacts(500)) {
    if (!byEmail.has(entry.email.toLowerCase())) {
      byEmail.set(entry.email.toLowerCase(), entry);
    }
  }
  contactCache = { when: Date.now(), entries: [...byEmail.values()] };
  return contactCache.entries;
}

/**
 * People whose name (any distinctive token) appears as a word in the draft.
 * @param {string} draftText
 * @returns {Promise<Array<{name: string, email: string}>>} at most 8 candidates
 */
async function findContactCandidates(draftText) {
  const contacts = await loadContacts();
  const haystack = " " + draftText.toLowerCase().replace(/[^\p{L}\p{N}@.]+/gu, " ").trim() + " ";
  if (haystack.trim() === "") return [];

  const matches = [];
  for (const contact of contacts) {
    const tokens = String(contact.name)
      .split(/\s+/)
      .filter((token) => token.length >= 3);
    if (!tokens.length) continue;
    const hit = tokens.some((token) => haystack.includes(` ${token.toLowerCase()} `));
    if (hit && !matches.some((m) => m.email.toLowerCase() === contact.email.toLowerCase())) {
      matches.push(contact);
    }
    if (matches.length >= 8) break;
  }
  return matches;
}

globalThis.MagicTrickContacts = { findContactCandidates, parseMailbox };

if (typeof module !== "undefined" && module.exports) {
  module.exports = { findContactCandidates, parseMailbox, loadAddressBookContacts, loadHistoryContacts };
}
