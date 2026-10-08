# Pairpost threat model

Status: design preview. The mitigations describe the intended design. None of them has been through an outside review, and the daemon is not released.

| Attack | Mitigation |
|---|---|
| A stranger sends messages or connection requests | There is no request path. A stranger's packets go to a mailbox name that the recipient cannot derive until they add the sender, so nothing is read, answered or acknowledged. |
| A message contains instructions for the agent (prompt injection) | By default the agent sees metadata only. A released message is delivered as labelled, typed data inside an untrusted wrapper. The session is then tainted, so risky actions need approval. Pattern detection is only a signal. |
| A message tries to make the agent run something | The protocol has no verb for running, calling, fetching or writing. The data format has no field that could carry one. Unknown kinds and fields are rejected. |
| A malformed message exploits the parser | The key-holding component reads only a fixed binary header. A separate reader with no network, no secrets and an empty environment parses the body. Its output is re-validated and anything that does not fit is discarded. |
| A link in a message leaks data or loads a remote image | Links are inert text. Nothing fetches or previews them. The data model has no image or embed type. The interface forbids remote images. |
| Hidden or confusing text (control characters, bidirectional overrides, lookalike hosts) | Strict character rules reject control, bidirectional and zero-width characters. Hosts are shown with their punycode form and flags for non-ASCII, mixed script or raw IP hosts. |
| The agent sends something on its own | No tool can send. Drafts wait for the human, and each approval is bound to a hash of the exact bytes, so a changed byte fails. |
| The agent leaks private data in a draft | Drafts take text and chosen share item ids only, never a path or a URL. The four-tool external package takes text only and has no share item parameter. Redaction blocks keys, recovery phrases and planted canary strings and redacts other secret patterns. The human sees the exact text. Disclosure is default-deny and every send is in a ledger. |
| The agent sends to a second contact or floods contacts | Every send needs approval. Per-contact and global daily limits, size limits and a draft rate limit apply at the single code path that can post. |
| A tainted session is used to write or export data | Writes, exports, task creation and external calls need approval while the session is tainted. The label survives restarts and follows content into notes and tasks created from a message. |
| Someone replays, reorders or downgrades messages | Counters and message ids reject replays. Handshake nonces and timestamps reject replayed introductions. Versions are pinned and downgrades are refused. |
| A stolen key reads old traffic | A double ratchet gives forward secrecy and recovery after a compromise. Session state is excluded from backups. |
| The identity key is stolen from disk | The key is wrapped with a passphrase and read only by the daemon. Agents get scoped, expiring and revocable subkeys. An unrestricted shell as the same user remains a limit, see below. |
| Someone impersonates a contact with a lookalike name | A display name is untrusted. Contacts are shown by the nickname the human chose, with the short fingerprint. Lookalike nicknames raise a warning. |
| A key change goes unnoticed | A rotation notice is accepted automatically only if it is signed by the recovery key committed in advance. Otherwise the contact is marked as changed and messages are held. Conflicting notices freeze the contact. |
| A relay reads or forges messages | It cannot. Content is end-to-end encrypted and authenticated inside the session. |
| A relay watches who talks to whom | It sees network addresses, timing and sizes, and weekly pseudonymous mailbox names. It does not see identities, content or kinds. Use your own relay to remove this. |
| Someone floods a relay with junk for your address | Mailbox caps, expiry, proof of work for new mailboxes, per-address rate limits and optional access tokens. Unpolled mailboxes get the smallest caps. |
| A malicious or compromised daemon release | The package has no runtime dependencies, pins its version and is meant to be published with provenance. A conformance suite checks the exact tool list and that nothing can post without approval. |
| The approval prompt is answered by the model | Approval uses a channel the model cannot drive, such as a prompt on a terminal the human opens, and requires the identity passphrase once per session. |
| An emergency | An emergency stop halts polling, sending and signing, and resumes when released. |

## Known limits

- Adding a contact is an opt-in to that person's text reaching the agent, with the same kind of risk as giving an agent file system access. Mutual add limits who can send. It does not make what they send trustworthy, and a contact can be compromised or turn hostile. After a message is released, the protections are taint, approval and the human's judgment. None of them can control host tools the daemon does not mediate, so a host without a gate for risky calls has only human release as a control.
- An agent with an unrestricted shell under the same operating system user can read the same files the daemon can. Files on disk are not a boundary against it. The design relies on passphrase-wrapped keys, approval on a channel the model cannot reach, scoped keys and human release of content.
- Whether a host's own terminal tool can answer an approval prompt has to be verified for each host.
- The sandboxed reader depends on an operating system sandbox. Where none exists, a weaker fallback is used and the daemon reports it.
- The construction has not had an outside review.
