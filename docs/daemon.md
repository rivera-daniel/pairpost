# Pairpost daemon

Status: design preview. This is a scaffold. It runs against an in-memory mock of the protocol core, so it holds no real keys, speaks no protocol and talks to no one. Nothing here has had an outside security review.

## What it is

A zero-dependency Node 22 MCP server over stdio. It exposes exactly four tools and nothing else.

| Tool | Does | Cannot do |
|---|---|---|
| `list_contacts` | Lists contacts: id, petname, fingerprint, state, grants | Add, remove or change a contact |
| `read_inbox` | Lists inbox items as metadata. An item carries its message only after the human released it | Release a message, return keys or raw bytes |
| `draft_message` | Stores a draft for an active contact and returns its id with status `held_for_approval` | Send, edit or approve a draft |
| `handshake_status` | Reports `pending`, `active` or `expired` for each contact | Start or complete a handshake |

The server declares the tools capability only. It has no resources, prompts, sampling or logging. It refuses to start if the tool registry is not exactly these four, and every argument is validated against a closed schema that rejects unknown properties.

## Safety rules the code enforces

- Results are built by projecting core data onto fixed fields. A field the core returns beyond the documented ones never reaches the model, so a core that leaks a key by mistake still cannot put it into a result.
- Released message content is returned as labelled text fields, capped at 16 KiB each and marked `untrusted: true`. It is data, never an instruction.
- Unknown senders are never read. The core only stores messages from contacts that are active, meaning both sides added each other.
- There is no send path. The source has no network, process or shell module, no dynamic import and no send, deliver or publish call. An approved draft is a status in the local draft store. Handing it to the protocol core is the core's job, through its own human path.
- `releaseMessage` is on the CoreClient interface for the human console only. The tools never call it.
- Tool errors show the model a short fixed message. Internal errors are reduced to `internal error`.
- The draft store is a JSON file with mode 0600 and holds at most 100 drafts waiting for approval.

The conformance tests in `test/daemon.test.mjs` check each rule: the exact tool list, metadata-only inbox, key material absent from every result, source scans for send primitives and for network, process and file system modules, and zero dependencies.

## Run it

```
node daemon/main.mjs serve     # MCP server on stdio (default)
node daemon/main.mjs review    # local approval console
```

Register `node /path/to/daemon/main.mjs serve` as a stdio MCP server in the host. Drafts persist in `PAIRPOST_STATE_DIR`, default `~/.local/state/pairpost`, so the console runs in a separate terminal from the host.

The console reads from the human's terminal. It shows each held draft with its exact text and asks to approve, refuse or skip, then lists messages not yet released and asks to release or skip. Terminal control characters in drafts are replaced before display. With the mock core, message release only affects the console's own process, since the mock keeps no state on disk. The real core persists releases.

## CoreClient

`daemon/core-client.mjs` documents the interface the protocol core implements. It has five methods:

| Method | Purpose |
|---|---|
| `listContacts()` | Contacts with state and grants |
| `listInbox({ contactId })` | Message metadata, oldest first |
| `readMessage(id)` | Labelled fields, or `null` unless the human released the message |
| `releaseMessage(id)` | Human console only |
| `handshakeStatus(contactId)` | One status per contact |

No method transmits anything. `daemon/mock-core.mjs` implements it in memory, keeps stand-in key material in private state for the tests and drops messages from senders that are not active contacts. To drop the real core in, implement the five methods and return it from `createCore` in `daemon/main.mjs`. `assertCoreClient` checks the shape at startup.
