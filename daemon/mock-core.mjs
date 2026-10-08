// In-memory CoreClient for development and tests. It keeps stand-in secrets in its private
// state so tests can prove none of them ever reaches a tool result.

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_LIFETIME_MS = 30 * DAY_MS;

/** Stand-in key material held inside the mock. Tests search tool output for these values. */
export const MOCK_KEY_SENTINELS = Object.freeze({
  signingSeed: 'SENTINEL-signing-seed-5f1c9a',
  sessionKey: 'SENTINEL-session-key-83be27',
  identityKey: 'SENTINEL-identity-key-c40d11',
});

const DEFAULT_CONTACTS = [
  { id: 'c-sam', petname: 'Sam', fingerprint: 'a1b2 c3d4 e5f6', state: 'active', startedAt: '2026-09-01T10:00:00.000Z' },
  { id: 'c-robin', petname: 'Robin', fingerprint: '0f9e 8d7c 6b5a', state: 'pending', startedAt: '2026-09-28T10:00:00.000Z' },
];

const DEFAULT_MESSAGES = [
  { id: 'm-1', contactId: 'c-sam', kind: 'text', receivedAt: '2026-10-01T08:00:00.000Z', fields: { text: 'Hello from the sample contact.' } },
  { id: 'm-2', contactId: 'c-sam', kind: 'question', receivedAt: '2026-10-02T09:30:00.000Z', fields: { question: 'Is the draft ready?' } },
];

/**
 * @param {object} [options]
 * @param {Array<{id: string, petname: string, fingerprint: string, state: string, startedAt: string}>} [options.contacts]
 * @param {Array<{id: string, contactId: string, kind: string, receivedAt: string, fields: Record<string, string>}>} [options.messages]
 * @param {() => Date} [options.now]
 * @returns {import('./core-client.mjs').CoreClient & { receive: (message: object) => boolean }}
 */
export function createMockCore({ contacts = DEFAULT_CONTACTS, messages = DEFAULT_MESSAGES, now = () => new Date() } = {}) {
  const contactById = new Map();
  for (const c of contacts) {
    contactById.set(c.id, { ...c, ...MOCK_KEY_SENTINELS });
  }
  const inbox = [];

  /** Store a message only when its sender is an active contact. Unknown senders are dropped. */
  function receive(message) {
    const sender = contactById.get(message.contactId);
    if (!sender || sender.state !== 'active') return false;
    inbox.push({ ...message, released: false, ...MOCK_KEY_SENTINELS });
    return true;
  }
  for (const m of messages) receive(m);

  const sizeOf = (m) => Buffer.byteLength(JSON.stringify(m.fields), 'utf8');

  function effectiveState(c) {
    if (c.state === 'pending' && now().getTime() > Date.parse(c.startedAt) + PENDING_LIFETIME_MS) return 'expired';
    return c.state;
  }

  return {
    receive,

    async listContacts() {
      return [...contactById.values()].map((c) => ({
        id: c.id,
        petname: c.petname,
        fingerprint: c.fingerprint,
        state: effectiveState(c),
        grants: { readReleased: effectiveState(c) === 'active' },
      }));
    },

    async listInbox({ contactId } = {}) {
      return inbox
        .filter((m) => contactId === undefined || m.contactId === contactId)
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id))
        .map((m) => ({
          id: m.id,
          contactId: m.contactId,
          kind: m.kind,
          size: sizeOf(m),
          receivedAt: m.receivedAt,
          released: m.released,
        }));
    },

    async readMessage(messageId) {
      const m = inbox.find((x) => x.id === messageId);
      if (!m || !m.released) return null;
      return { fields: { ...m.fields } };
    },

    async releaseMessage(messageId) {
      const m = inbox.find((x) => x.id === messageId);
      if (!m) return false;
      m.released = true;
      return true;
    },

    async handshakeStatus(contactId) {
      return [...contactById.values()]
        .filter((c) => contactId === undefined || c.id === contactId)
        .map((c) => {
          const state = effectiveState(c);
          const status = { contactId: c.id, state: state === 'closed' ? 'expired' : state, startedAt: c.startedAt };
          if (state === 'pending') status.expiresAt = new Date(Date.parse(c.startedAt) + PENDING_LIFETIME_MS).toISOString();
          return status;
        });
    },
  };
}
