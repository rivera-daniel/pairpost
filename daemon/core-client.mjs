// The CoreClient interface: everything the daemon needs from the protocol core.
//
// The daemon never touches keys, sessions or the network itself. It asks a CoreClient, which
// the real protocol core implements later. Until then daemon/mock-core.mjs provides an
// in-memory implementation with the same contract.
//
// Contract, for every implementation:
//   - Results carry no key material of any kind. The daemon also projects every result onto a
//     fixed set of fields, so extra fields are dropped, but a core must not return them.
//   - Only mutually added contacts exist. A message from anyone else is never stored or listed.
//   - readMessage returns content only for a message the human has released.
//   - releaseMessage is a human action. Only the local approval console calls it. No tool does.
//   - There is no method that transmits anything. Adding one is a change to this file and to the
//     conformance test that guards it.

/**
 * @typedef {'pending' | 'active' | 'expired' | 'closed'} ContactState
 *
 * @typedef {object} ContactSummary
 * @property {string} id            Opaque contact id.
 * @property {string} petname       The nickname the human chose.
 * @property {string} fingerprint   Short fingerprint of the contact's address.
 * @property {ContactState} state
 * @property {{ readReleased: boolean }} grants   What the human allows for this contact.
 *
 * @typedef {'text' | 'question' | 'answer' | 'share_offer' | 'task_proposal'} MessageKind
 *
 * @typedef {object} InboxMetadata
 * @property {string} id
 * @property {string} contactId
 * @property {MessageKind} kind
 * @property {number} size          Size of the content in bytes.
 * @property {string} receivedAt    ISO 8601 timestamp.
 * @property {boolean} released     True once the human released the message.
 *
 * @typedef {object} ReleasedMessage
 * @property {Record<string, string>} fields   Labelled text fields. Untrusted data.
 *
 * @typedef {object} HandshakeStatus
 * @property {string} contactId
 * @property {'pending' | 'active' | 'expired'} state
 * @property {string} startedAt     ISO 8601 timestamp.
 * @property {string} [expiresAt]   ISO 8601 timestamp, present while pending.
 *
 * @typedef {object} CoreClient
 * @property {() => Promise<ContactSummary[]>} listContacts
 * @property {(filter?: { contactId?: string }) => Promise<InboxMetadata[]>} listInbox
 *   Metadata only, oldest first.
 * @property {(messageId: string) => Promise<ReleasedMessage | null>} readMessage
 *   Null unless the human released the message.
 * @property {(messageId: string) => Promise<boolean>} releaseMessage
 *   Human console only. False when the message does not exist.
 * @property {(contactId?: string) => Promise<HandshakeStatus[]>} handshakeStatus
 *   One entry per contact, or for the one contact named.
 */

export const CORE_CLIENT_METHODS = Object.freeze([
  'listContacts',
  'listInbox',
  'readMessage',
  'releaseMessage',
  'handshakeStatus',
]);

/** Throw unless `core` implements exactly the CoreClient methods. Returns `core`. */
export function assertCoreClient(core) {
  if (core === null || typeof core !== 'object') throw new TypeError('core must be an object');
  for (const method of CORE_CLIENT_METHODS) {
    if (typeof core[method] !== 'function') throw new TypeError(`core is missing method ${method}`);
  }
  return core;
}
