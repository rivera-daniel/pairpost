<img src="../../site/assets/mascot.svg" alt="Pairpost" width="48">

# Install the Pairpost skill in Codex

```
STATUS: DESIGN PREVIEW. THE CONTACTS DAEMON IS NOT RELEASED YET.
```

Read this first:

- You can install the skill text today. Without the daemon it does nothing useful: the skill tells the model to report that Pairpost is not installed and to stop.
- The daemon does not exist yet. The command name `pairpost` and its `mcp` and `approve` subcommands in this guide are proposed, and registering the server today fails because there is no such program.
- The tool names and parameters come from `daemon/tools.json`, the contract the daemon and its conformance suite must match. `node scripts/check-skill.mjs` fails if the skill text and that contract disagree. Both may still change before release.
- Nothing here has had an outside security review.

## What you install

| Part | What it does | Where it goes |
|---|---|---|
| Skill folder `pairpost/` | `SKILL.md` tells the model what the four tools do and the rules it must follow | Your Codex skills directory |
| Contacts daemon | Holds the keys, speaks the protocol, holds drafts, runs the approval prompt | Registered as a local MCP server over stdio |

The skill text is guidance for the model. The read-only guarantees are designed to be enforced by the daemon and checked by its conformance suite, not by the wording of the skill.

## 1. Get the skill folder

From a release, download `pairpost-skill-<version>.zip` and its `.sha256` file into the same directory, then verify and unpack:

```
sha256sum -c pairpost-skill-<version>.zip.sha256
unzip pairpost-skill-<version>.zip
```

From this repository, build the same archive yourself (Node 22 or newer):

```
node scripts/package-skill.mjs
cd dist && sha256sum -c pairpost-skill-*.zip.sha256
```

The packaging script runs the skill checks first and refuses to build if they fail. It writes `dist/pairpost/` (the folder to install), the zip and the checksum file. The zip is reproducible, so the same sources give the same checksum.

## 2. Put the skill where Codex finds it

Codex reads user skills from `$CODEX_HOME/skills`. When `CODEX_HOME` is not set, that is `~/.codex/skills`. The folder name must stay `pairpost`, the same as the `name` in the frontmatter.

```
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -r dist/pairpost "${CODEX_HOME:-$HOME/.codex}/skills/"
```

Start a new Codex session. Codex lists the skill by its `name` and `description` and reads the full `SKILL.md` when the skill applies. The frontmatter passes the same rules as the skill validator that ships with Codex: allowed keys only, a hyphen-case name of at most 64 characters, and a description of at most 1024 characters without angle brackets.

## 3. Register the daemon as an MCP server

The daemon is a local stdio MCP server named `pairpost`. The proposed command is `pairpost mcp`.

```
codex mcp add pairpost -- pairpost mcp
codex mcp list
```

This writes an entry to `~/.codex/config.toml` (under `$CODEX_HOME` when set). Edit it to allow exactly the four tools, so that any other tool the server might offer is never shown to the model:

```toml
[mcp_servers.pairpost]
command = "pairpost"
args = ["mcp"]
enabled_tools = ["list_contacts", "read_inbox", "draft_message", "handshake_status"]
```

If any other tool name appears under this server, do not use it, and report it as a fault.

## 4. How approvals work without a host inbox

Inside a host that implements Pairpost, drafts and released messages go through the host's inbox. Without one there is no inbox, so the daemon brings its own approval interface. There are two separate prompts, and only the second one sends anything.

The flow below is the planned design. It cannot be exercised today because the daemon is not released.

1. The Codex approval prompt. Depending on your approval settings, Codex may ask before it calls an MCP tool or runs a command. Approving a `draft_message` call only creates a draft that is held in the daemon. It does not send. All four tools are read-only or draft-only.

2. The daemon's approval prompt. To send a draft, release a received message to the model, add or remove a contact, or change a grant, you run the daemon's approval command yourself, in a terminal you open outside Codex. The proposed command is `pairpost approve`. It is designed to show the exact text of each draft, ask for your identity passphrase once per session, and bind each approval to a hash of the exact bytes, so a draft changed after you saw it fails to send. A refused draft is discarded. Nothing is sent until you approve it there.

By design the model sees metadata only. It gets a message's content only after you release that message in the approval prompt.

Known limit: Codex can run shell commands as your operating system user. Whether those commands can answer the daemon's approval prompt has not been verified for Codex yet. The passphrase and an approval channel the model cannot drive are the intended defence. As an extra mitigation, keep an approval policy that asks before commands run, such as `approval_policy = "on-request"` or `"untrusted"`, and refuse any command that calls `pairpost`. Do not use `approval_policy = "never"` together with `sandbox_mode = "danger-full-access"` while the daemon is installed. These settings are mitigations, not a security boundary.

## Remove

```
codex mcp remove pairpost
rm -r "${CODEX_HOME:-$HOME/.codex}/skills/pairpost"
```
