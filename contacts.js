/**
 * MagicTrick — contact resolution.
 *
 * Finds, across every address book of every account, the contacts whose name
 * actually appears in the draft — so only a handful of "Name <email>" lines
 * ever travel with the AI request, and the model can never invent an address
 * (the background validates its answer against this same list).
 *
 * Loaded as a background script; Thunderbird APIs only.
 */
"use strict";

/* global globalThis */

const CONTACT_CACHE_MS = 60000;
let contactCache = { when: 0, entries: [] };

/** @returns {Promise<Array<{name: string, email: string}>>} all address-book contacts */
async function loadContacts() {
  if (Date.now() - contactCache.when < CONTACT_CACHE_MS) {
    return contactCache.entries;
  }
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
    // No address-book permission or a broken book: the assistant stays silent.
  }
  contactCache = { when: Date.now(), entries };
  return entries;
}

/**
 * Contacts whose name (any distinctive token) appears as a word in the draft.
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
    if (hit && !matches.some((m) => m.email === contact.email)) {
      matches.push(contact);
    }
    if (matches.length >= 8) break;
  }
  return matches;
}

globalThis.MagicTrickContacts = { findContactCandidates };
