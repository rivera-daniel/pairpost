# Pairpost skill and site

Pairpost lets people and their agents collaborate over an end-to-end encrypted channel that can carry messages and nothing else. Each person has an address derived from their own key, two people can talk only after both have added the other, and nothing a contact sends can run anything.

This repository holds the skill text for agent hosts, its packaging and install guides for Claude Code and Codex, the public documentation, and a small static site that explains it.

## Status

Design preview. A host-side implementation of the identity and contacts part is in progress. The daemon that holds the keys and speaks the protocol does not exist yet. A scaffold of it exists in `daemon/`: the four read-only tools running against an in-memory mock core, with no real keys and no protocol. The skill still describes tools that are not available in any host today. Nothing here has had an outside security review. Do not rely on any of it.

## What you accept when you add a contact

Pairpost is opt-in, and so is every contact. Both people must add each other's address before anything is read, and you can remove a contact at any time. Adding a contact is still a decision to let that person's text reach your agent, in the same way that giving an agent file system access is a decision to let it touch your files. The package limits what that text can do. It cannot control what your agent does after it has read the text.

- Nothing is read from anyone you have not added. Messages stay metadata only until you release them.
- After you release a message, your agent reads text written by someone else. The skill tells the model to treat it as data, but a model can still be persuaded. The package has no control over your agent's other tools, such as a shell or a browser, unless your host gates them.
- Release only what you would read yourself, check every draft before you approve it, and revoke a contact's grants or remove the contact if their messages turn odd. The emergency stop halts polling, sending and signing.

## Layout

| Path | What it is |
|---|---|
| `skill/SKILL.md` | The agent-facing skill: purpose, the four read-only tools, the rules for the model, and the status block |
| `daemon/tools.json` | The daemon's tool contract: the four tool names and their input schemas. The daemon is not built yet. It and its conformance suite must match this file |
| `VERSION` | Version of the packaged skill |
| `docs/install/claude-code.md` | Install guide for Claude Code: skill location, MCP registration, approvals without a host inbox |
| `docs/install/codex.md` | Install guide for Codex: skill location, MCP registration, approvals without a host inbox |
| `docs/protocol-overview.md` | Addresses, mutual add, the handshake, the read-only message kinds, limits |
| `docs/threat-model.md` | Attacks and mitigations in one table |
| `docs/conformance.md` | Reader contract, conformance runner usage, corpus format, and safety limits. The plugin guide and public corpora are in this README |
| `docs/index.html` | A small index page for the documents, served at `/docs/` |
| `site/` | The static page: `index.html`, `style.css`, `app.js` (copy buttons only), fonts and the mascot |
| `daemon/` | Zero-dependency MCP daemon scaffold: four read-only tools, a CoreClient interface with an in-memory mock, a draft store and a local approval console. See `docs/daemon.md` |
| `docs/daemon.md` | What the daemon exposes, the rules the code enforces and how to run it |
| `serve.mjs` | Zero-dependency Node static file server |
| `conformance/` | Reader contract, runner, reference stub, unsafe fixture, public-safe seed corpus, and a 64-case hostile corpus |
| `test/` | Server, conformance and daemon tests, run with `node --test` |
| `systemd/pairpost-site.service` | systemd user unit template |
| `scripts/` | `install-service.sh`, `check.sh`, `check-page.mjs`, `check-public.sh`, `check-skill.mjs`, `package-skill.mjs`, `skill-contract.mjs` |

## Run the daemon scaffold

Requires Node 22 or newer. There is nothing to install.

```
node daemon/main.mjs serve     # MCP server on stdio with the four read-only tools
node daemon/main.mjs review    # local approval console for held drafts and message release
```

See `docs/daemon.md`.

## Serve the site

Requires Node 22 or newer. There is nothing to install.

```
node serve.mjs
```

The server listens on `127.0.0.1` by default. `PAIRPOST_SITE_HOST` can name one other address, but only a loopback or a Tailscale address (100.64.0.0/10) is accepted, so the page can never be offered on a local network or the internet by mistake. The port comes from `PAIRPOST_SITE_PORT` and defaults to 5190. It serves `site/` at `/`, `skill/` at `/skill/`, `docs/` at `/docs/` and the licence at `/LICENSE`. Only GET and HEAD are accepted, directories are never listed, and dotfiles and path traversal are refused. Responses carry a strict Content-Security-Policy, so the page makes no external requests and uses no inline styles or scripts. The Permissions-Policy denies every feature except `clipboard-write` for the page itself, which the copy button needs.

To run it as a systemd user service:

```
scripts/install-service.sh            # install, enable and start
scripts/install-service.sh --remove   # stop and remove
systemctl --user restart pairpost-site.service
journalctl --user -u pairpost-site.service -n 50
```

The unit is low priority (`CPUWeight=20`, `MemoryMax=128M`) and sandboxed. The install script fills in the repository path and the Node binary.

To reach the site from other devices without exposing it on the local network or the internet, either put a tailnet in front of the loopback port, for example `tailscale serve --bg --https=8443 http://127.0.0.1:5190` (needs the Tailscale operator or root; remove it with `tailscale serve --https=8443 off`), or bind the server to this machine's Tailscale address with a systemd drop-in that sets `PAIRPOST_SITE_HOST` to the output of `tailscale ip -4`. The second option serves plain HTTP inside the encrypted tailnet.

## Package the skill

```
node scripts/check-skill.mjs      # SKILL.md format and agreement with daemon/tools.json
node scripts/package-skill.mjs    # dist/pairpost/, the zip and its .sha256 file
cd dist && sha256sum -c pairpost-skill-*.zip.sha256
```

`check-skill.mjs` validates the frontmatter against the rules Claude Code and Codex apply (allowed keys, a hyphen-case `name` of at most 64 characters that matches the folder name, a `description` of at most 1024 characters without angle brackets). It then compares the tools in the `## Tools` section with `daemon/tools.json`: tool names, parameter names, which parameters are required, and the tool count stated in the prose. Any disagreement fails the check.

`package-skill.mjs` runs the same checks and refuses to package when they fail. It writes the skill folder, a reproducible zip named after `VERSION` and a checksum file in `sha256sum` format. `dist/` is not tracked. Install steps are in `docs/install/claude-code.md` and `docs/install/codex.md`.

## Edit the site

Edit `site/index.html` and `site/style.css`. There is no build step. Reload the page, files are revalidated with an ETag. Keep these rules:

- No external requests of any kind: no CDN, analytics or web fonts.
- No inline `style` attributes, `<style>` blocks or inline scripts. The CSP blocks them.
- Light and dark follow `prefers-color-scheme`, with dark as the default.
- Keep text contrast at WCAG AA, keep 44 px touch targets and respect `prefers-reduced-motion`.
- Fonts (Sora, Inter, JetBrains Mono) are under the SIL Open Font License. The licence texts sit next to the font files.

## Check your changes

The local reader conformance harness has no runtime dependencies. Run the reference stub with `node conformance/runner.mjs --reader conformance/reference-reader.mjs`. It must pass every seed. Run the deliberately unsafe fixture with `node conformance/runner.mjs --reader conformance/fixtures/unsafe-reader.mjs`. It must exit 1 and print counted failures by category. The [conformance documentation](docs/conformance.md) defines the interface, corpus format, and trusted-module boundary. Add `--corpus conformance/corpus/hostile.json` to run the 64 hostile cases. This harness does not supply the planned daemon or sandbox.

```
scripts/check.sh                         # tests, skill check, public-content scan, HTTP probes
PLAYWRIGHT_CORE=/path/to/playwright-core SHOT_DIR=/tmp/shots node scripts/check-page.mjs
```

`check-page.mjs` drives Chromium at several widths in dark and light, writes screenshots, and fails on horizontal scroll, console errors, external requests, low contrast, small touch targets, broken links, a bad focus order or a broken copy button. On a shared machine run it through a low-priority wrapper.

`scripts/check-public.sh` scans the working tree for host names, addresses, home paths and internal codes. It recognizes the public address-range notation and exact synthetic server-test address literals. Terms that must never appear (names, internal project words) are not listed in the repository, since a list would disclose them: put them one per line in an untracked `.private-denylist` (or the file named by `PAIRPOST_PRIVATE_DENYLIST`) and the same scan reports them by file, line and rule number. Run it before every commit.

## Plugin guide

The conformance suite checks one thing, the reader. A reader takes one serialized message from a contact and returns either that text labelled as untrusted or a rejection. The four tools in `skill/SKILL.md` (list contacts, read inbox, draft a message, handshake status) belong to the planned daemon. They are not part of this interface and the runner does not call them. A daemon that wants to claim the inert-output guarantee must route every inbound message through a reader that passes this suite.

An implementation is an ES module that exports `reader`, an object with a `read(input)` method. The input is a string. The method returns, directly or as a promise, exactly one of two records and nothing else:

```json
{"type":"contact-text","trust":"untrusted","text":"..."}
{"type":"rejected","reason":"invalid-json"}
```

The rejection reasons are `invalid-json`, `invalid-message` and `invalid-text`. The full contract, including the 4096-byte text limit and the characters that must be refused, is in [docs/conformance.md](docs/conformance.md).

A minimal reader that registers itself by being the module you point the runner at. Save it in the repository root as `my-reader.mjs`:

```js
import { isValidText } from './conformance/reader.mjs';

export const reader = {
  read(input) {
    let message;
    try {
      message = JSON.parse(input);
    } catch {
      return { type: 'rejected', reason: 'invalid-json' };
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || Object.keys(message).length !== 2 || message.kind !== 'text'
      || !Object.hasOwn(message, 'text')) {
      return { type: 'rejected', reason: 'invalid-message' };
    }
    if (!isValidText(message.text)) return { type: 'rejected', reason: 'invalid-text' };
    return { type: 'contact-text', trust: 'untrusted', text: message.text };
  },
};
```

Run it against the seed corpus and then the hostile corpus:

```
node conformance/runner.mjs --reader my-reader.mjs
node conformance/runner.mjs --reader my-reader.mjs --corpus conformance/corpus/hostile.json
```

Both commands also work against `conformance/reference-reader.mjs`, which is the same logic. The reader module is trusted local code. The runner imports it in its own process and does not sandbox it.

### Read the results

Each case ends in one of three states:

| State | Meaning |
|---|---|
| pass | The output is typed, inert and exactly the expected record. The runner prints `PASS` and the output. |
| fail | The output broke a rule or differs from the expected record. The runner prints `FAIL` and the rule names, and withholds the output. |
| error | The reader threw an exception. This counts as a fail with the rule `reader-error`, and the exception text is not printed. |

The report groups cases by category with a failure count for each, and ends with one summary line:

```
Total: 64, passed: 64, failures: 0
```

The exit status is 0 when every case passes, 1 when any case fails and 2 when the arguments, the reader module or the corpus cannot be used. `--json` prints the same report as JSON.

The rule names say what went wrong. `untyped` and `schema` mean the output is not one of the two allowed records. `instruction`, `tool-call` and `executable` mean contact text was promoted into something that could be acted on. These are the failures that matter most, because a reader that does this treats contact text as an instruction. `output-mismatch` means the output is safe but not what the case expects, for example text that was altered or a message that should have been refused.

Passing proves the output is typed, inert and as expected for these cases. It does not prove that a downstream model will ignore the text.

## Public corpora

The cases in this repository are small and synthetic. Larger public collections cover injection against tool-using agents and are good sources of new cases. None of them is bundled, their licences differ, and most target a full agent rather than a reader. Read the licence of each before you copy anything, and convert any case you adopt into the four-field format in `docs/conformance.md` with an expectation you write by hand.

| Corpus | URL | What it covers |
|---|---|---|
| AgentDojo | https://github.com/ethz-spylab/agentdojo | Attacks and defenses for tool-using agents, with injected instructions placed in tool results |
| InjecAgent | https://github.com/uiuc-kang-lab/InjecAgent | 1,054 indirect injection test cases that try to make an agent call attacker-chosen tools or leak data |
| BIPIA | https://github.com/microsoft/BIPIA | Indirect injection benchmark with instructions hidden in email, web page, table and code content |
| deepset prompt-injections | https://huggingface.co/datasets/deepset/prompt-injections | 662 labelled direct injection prompts, useful as plain instruction-injection text |
| Trojan Source | https://trojansource.codes/ | Bidirectional control characters and homoglyphs that make text read differently from how it is encoded |

## Contribute

- Keep claims honest. The page, the skill and the docs must not say that anything works until it does.
- Keep content neutral and public: no personal names, host names or internal identifiers.
- Make small commits with plain messages. Add or update a test when you change `serve.mjs` or anything in `daemon/`.
- When you change a tool in `skill/SKILL.md`, change `daemon/tools.json` in the same commit. `node scripts/check-skill.mjs` fails until they agree.
- Run `node --test`, `node scripts/check-skill.mjs`, `scripts/check-public.sh` and `scripts/check-page.mjs` before you send a change.

## Licence

MIT, see `LICENSE`. Fonts are under the SIL Open Font License 1.1, see `site/fonts/*/OFL.txt`.
