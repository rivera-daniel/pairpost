// Draft store. A draft is text the agent prepared for the human to review. It starts as
// held_for_approval and the human console can mark it approved or refused. Nothing in the
// daemon reads an approved draft and transmits it: handing approved drafts to the protocol
// core is the core's job, through its own human-controlled path.

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const MAX_HELD_DRAFTS = 100;
export const MAX_DRAFT_BYTES = 8192;

/** Thrown when the held-draft cap is reached. Safe to show the model. */
export class DraftCapError extends Error {}

export const DRAFT_STATUS = Object.freeze({
  HELD: 'held_for_approval',
  APPROVED: 'approved',
  REFUSED: 'refused',
});

/**
 * @typedef {object} Draft
 * @property {string} id
 * @property {string} contactId
 * @property {string} text
 * @property {string} status
 * @property {string} createdAt
 * @property {string} [decidedAt]
 */

/**
 * @param {object} [options]
 * @param {string} [options.file]   JSON file that persists drafts so the console can run in
 *                                  another process. Omit for an in-memory store.
 * @param {() => Date} [options.now]
 */
export function createDraftStore({ file, now = () => new Date() } = {}) {
  /** @type {Draft[]} */
  let memory = [];

  function load() {
    if (!file) return memory;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  function save(drafts) {
    if (!file) {
      memory = drafts;
      return;
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(drafts, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  }

  return {
    /** Store a new draft in the held state. */
    create({ contactId, text }) {
      const drafts = load();
      if (drafts.filter((d) => d.status === DRAFT_STATUS.HELD).length >= MAX_HELD_DRAFTS) {
        throw new DraftCapError('too many drafts are waiting for approval');
      }
      const draft = {
        id: `drf_${randomBytes(8).toString('hex')}`,
        contactId,
        text,
        status: DRAFT_STATUS.HELD,
        createdAt: now().toISOString(),
      };
      drafts.push(draft);
      save(drafts);
      return { ...draft };
    },

    /** Drafts, optionally limited to one status. */
    list(status) {
      return load()
        .filter((d) => status === undefined || d.status === status)
        .map((d) => ({ ...d }));
    },

    /** Human decision on a held draft. Returns the updated draft, or null when none is held. */
    decide(id, status) {
      if (status !== DRAFT_STATUS.APPROVED && status !== DRAFT_STATUS.REFUSED) {
        throw new Error(`invalid decision: ${status}`);
      }
      const drafts = load();
      const draft = drafts.find((d) => d.id === id && d.status === DRAFT_STATUS.HELD);
      if (!draft) return null;
      draft.status = status;
      draft.decidedAt = now().toISOString();
      save(drafts);
      return { ...draft };
    },
  };
}
