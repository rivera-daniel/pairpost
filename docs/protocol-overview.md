# Pairpost protocol overview

Status: design preview. This describes the intended behaviour. The implementation is being built and the details below can still change. Nothing here has had an outside security review.

## Goals

- Let people, and their agents, collaborate without giving anyone a way to run something on their machine.
- Work without a blockchain, a central registry, an account server or a default relay.
- Make "who can talk to me" a decision each person makes, and make unsolicited contact impossible rather than filtered.

## Addresses

An address is an encoded public key with a checksum. It is derived from a key pair the user creates locally, so it needs no registry to look up and nothing to register.

- Format: the text `pp1` followed by a bech32m string that carries a version byte, a signing public key (Ed25519) and a key-agreement public key (X25519). A typo is detected by the checksum, so a mistyped address fails instead of reaching someone else.
- Short fingerprint: a short digest of the address, written in groups of four characters, for reading aloud or comparing in person.
- Display name: optional, chosen and published by the owner. Other people see it as untrusted text. What you trust is the nickname you give a contact yourself, together with the fingerprint.
- Agents: an agent can act for its owner with a separate, scoped and expiring key that the owner certifies. An agent address cannot be added as a contact on its own.

## Mutual add

Two people can exchange messages only after both have added the other's address. Only a person can add a contact. An agent may suggest an address, and the suggestion waits for the person.

1. One person adds the other's address, checks the fingerprint and gives the contact a nickname. The first side is now pending. The other person cannot tell.
2. Pending lasts up to 30 days.
3. The other person adds the first person's address on their side, whenever they choose.
4. The two apps run the handshake automatically. It succeeds only if each side already holds the other's public key.
5. Both sides show the contact as active and can compare a safety number out of band.

Until both additions exist, nothing from the other side is read, answered or acknowledged. Removing a contact destroys the session keys. By default the other side is not told, and the remover can choose to tell them.

## The handshake, in plain words

The handshake is a key exchange in which both parties prove they hold the private key that belongs to the address the other side added, and agree on fresh session keys. Each party must already know the other's static public key before it starts, which is why a stranger cannot begin one. After it completes, messages use a ratcheting scheme: keys change with every message, so recorded traffic cannot be decrypted later if a key leaks, and the session recovers after a compromise once both sides have exchanged messages.

The design uses Noise KK for the handshake and a double ratchet for the session, built on Ed25519, X25519, HKDF-SHA256, ChaCha20-Poly1305 and SHA-256 from the standard library of the host runtime.

## Transport

Messages travel through a small mailbox relay that each recipient chooses. Every instance connects out to relays over HTTPS, so nothing needs an open inbound port and the scheme works behind NAT.

- Mailbox names are derived from a shared secret that only the two contacts can compute, are different for each direction, and change every week. A relay cannot link them to addresses.
- Mailboxes that nobody polls get small caps and expire. Mailboxes that are polled get larger caps and a shorter expiry.
- The project does not host a relay or a directory and there is no default relay. You run your own or use one that a contact told you about.

## What a message can be

The protocol has a short, closed list of message kinds. Every one of them ends as an append to the recipient's local, read-only inbox record.

| Kind | Meaning |
|---|---|
| text | An inert message for the human |
| question | A question that can only be answered from items the human has chosen to share with that contact |
| answer | The reply to a question |
| share offer | An offer of read-only items. In the first version, inline text only |
| task proposal | A proposal that does nothing until the human accepts it |
| housekeeping | Acknowledgements, profile updates, certificate announcements and revocations, key rotation, closing a session |

There is no kind that means run, call, fetch, write, subscribe or open, and the data format has no field that could carry one. Unknown kinds and unknown fields are rejected. Adding a kind is a protocol version change, never a setting.

Messages are plain UTF-8 text with strict size limits. There is no HTML, no Markdown, no embedded media and, in the first version, no attachments. Links arrive as inert text with the destination host shown, and nothing fetches or previews them.

## How inbound content is handled

1. The component that holds the keys decrypts and verifies a message. It reads only a fixed binary header and never parses the message body.
2. A separate, locked-down reader process (no network, empty environment, no secrets, read-only filesystem) parses the body into a typed record. The parent re-validates the output and discards anything that does not fit.
3. By default the agent sees metadata only, such as "2 new messages from a contact: 1 text, 1 task proposal". The human reads content in their own interface.
4. A person can release a message, or all messages from a contact, to their agent. From then on the session is tainted: writes, exports, sends and anything that reaches the outside need the human's approval for as long as the session lasts, and the label follows the content into notes and tasks that came from it.

## Outbound

- No tool can send. A tool can only prepare a draft.
- The draft goes through secret redaction, then waits as an approval card that shows the exact text, the recipient and its fingerprint.
- Approval produces a single-use token bound to a hash of those exact bytes and to the recipient. If a byte changes, the token fails.
- One code path is allowed to post to a relay. It checks the token, the emergency stop, daily limits and the taint state, writes a ledger entry first, then sends.
- Disclosure is default-deny. Only text the human approved and items the human marked as shareable for that contact can leave. The ledger shows what each contact has received.
- Standing approval can be enabled per contact for text and chosen share scopes only. It is time limited, rate limited and void while a session is tainted.

## The external package

For agent hosts without a built-in implementation, the same component is packaged as a small daemon plus a skill. The daemon holds the keys and speaks the protocol. It exposes four tools over a local stdio interface. None can send, run or change anything, and the only thing a tool writes is a draft that waits for the human: list contacts, read inbox, draft message and handshake status. The skill text in `skill/SKILL.md` tells the model the rules. A conformance suite checks that the tool list is exactly those four tools, that no tool interprets a parameter as a path, a URL, a command or a key, and that drafting never causes a post to a relay.

The draft tool takes a contact and plain text. It has no share item parameter, so in this package a reply to a question is ordinary text for the human to review. It is not an answer limited to shared items. Sharing items and constrained answers are done in a host that implements them.

### Limits on the four tools

- `read_inbox`: `limit` is an integer from 1 to 50, default 20. A value that is outside that range or not an integer is rejected. It is never clamped.
- `draft_message`: `text` is at most 8192 bytes of UTF-8, counted on the exact bytes that would be sent, after any redaction. Longer text is rejected and never truncated. A multibyte character counts as all its bytes.
- Inbound message text: the reference reader in the conformance suite refuses text over 4096 bytes of UTF-8.
- The daemon enforces these limits. The skill states them so the model can stay inside them. Conformance cases for the boundaries are planned and not written yet.

Where the host has no approval interface, approval happens on a channel the model cannot drive, such as a prompt on a terminal the human opens.

## Limits

- Nothing described here has been released. The daemon does not exist yet.
- The cryptographic construction is assembled from standard primitives and has not had an outside review. It must not be relied on for anything sensitive until it has.
- Against an agent that has an unrestricted shell under the same operating system user, local files are not a boundary. The protections are passphrase-wrapped keys, approval on a channel the model cannot reach, scoped and revocable agent keys, and releasing content only on a human's decision. Running the daemon as a separate user or in a container strengthens this.
- A relay learns network addresses, timing and message sizes, and with weekly pseudonyms it can build a graph of which network addresses exchange traffic. It does not learn identities, content or message kinds. Running your own relay removes this.
- A hostile relay can drop, delay, duplicate or reorder messages. It cannot forge or read them. Drops show up as gaps.
- Anyone who knows your public address can compute a mailbox name for their own pair with you and post junk to a relay. The name needs their private key and your public key, so you cannot compute it until you add them, and you never poll it. The junk is stored until it expires and is never read by you. Caps, proof of work and access tokens bound this.
- Lost keys: with a recovery phrase you can announce a replacement address, signed by a recovery key you committed to in advance. With neither, you start over with a new address and each contact adds it again.
- Strangers cannot message you. This is deliberate. It also means no cold outreach, no discovery by address alone and no public support inbox.
- Adding a contact is an opt-in with a real risk, much like giving an agent file system access. Mutual add limits who can send. It does not make their text trustworthy, and the package cannot control the agent's other tools after a message is released.
- Detecting prompt injection by pattern matching is a signal, not a control. The controls are structural: no verbs that act, typed data, no content for the agent by default, and approval for risky actions.
