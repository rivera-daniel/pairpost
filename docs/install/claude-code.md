<img src="../../site/assets/mascot.svg" alt="Pairpost" width="48">

# Install the Pairpost skill in Claude Code

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
| Skill folder `pairpost/` | `SKILL.md` tells the model what the four tools do and the rules it must follow | Your Claude Code skills directory |
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

## 2. Put the skill where Claude Code finds it

The folder name must stay `pairpost`, the same as the `name` in the frontmatter.

| Scope | Path |
|---|---|
| Every project for your user | `~/.claude/skills/pairpost/SKILL.md` |
| One project, shared with its repository | `.claude/skills/pairpost/SKILL.md` in the project root |

```
mkdir -p ~/.claude/skills
cp -r dist/pairpost ~/.claude/skills/
```

Start a new Claude Code session. Claude Code reads the `name` and `description` at startup and loads the rest of `SKILL.md` when the skill applies.

## 3. Register the daemon as an MCP server

The daemon is a local stdio MCP server named `pairpost`. The proposed command is `pairpost mcp`.

```
claude mcp add --scope user pairpost -- pairpost mcp
claude mcp list
```

Use `--scope project` instead to write the entry to `.mcp.json` in the project root, so the project's collaborators get the same entry:

```json
{
  "mcpServers": {
    "pairpost": {
      "command": "pairpost",
      "args": ["mcp"]
    }
  }
}
```

Inside a session, `/mcp` shows whether the server is connected. Claude Code names its tools `mcp__pairpost__<tool>`:

- `mcp__pairpost__list_contacts`
- `mcp__pairpost__read_inbox`
- `mcp__pairpost__draft_message`
- `mcp__pairpost__handshake_status`

If any other tool name appears under this server, do not use it, and report it as a fault.

## 4. How approvals work without a host inbox

Inside a host that implements Pairpost, drafts and released messages go through the host's inbox. Without one there is no inbox, so the daemon brings its own approval interface. There are two separate prompts, and only the second one sends anything.

The flow below is the planned design. It cannot be exercised today because the daemon is not released.

1. The Claude Code permission prompt. When the model calls a tool, Claude Code may ask you to allow it. Allowing `draft_message` only creates a draft that is held in the daemon. It does not send. All four tools are read-only or draft-only, so you can allow them in `.claude/settings.json` to avoid repeated prompts:

   ```json
   {
     "permissions": {
       "allow": [
         "mcp__pairpost__list_contacts",
         "mcp__pairpost__read_inbox",
         "mcp__pairpost__draft_message",
         "mcp__pairpost__handshake_status"
       ]
     }
   }
   ```

2. The daemon's approval prompt. To send a draft, release a received message to the model, add or remove a contact, or change a grant, you run the daemon's approval command yourself, in a terminal you open outside Claude Code. The proposed command is `pairpost approve`. It is designed to show the exact text of each draft, ask for your identity passphrase once per session, and bind each approval to a hash of the exact bytes, so a draft changed after you saw it fails to send. A refused draft is discarded. Nothing is sent until you approve it there.

By design the model sees metadata only. It gets a message's content only after you release that message in the approval prompt.

Known limit: Claude Code has a shell tool that runs as your operating system user. Whether that shell can answer the daemon's approval prompt has not been verified for Claude Code yet. The passphrase and an approval channel the model cannot drive are the intended defence. As an extra mitigation, you can deny the agent's shell access to the daemon's command line in `.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["Bash(pairpost:*)"]
  }
}
```

This rule is a mitigation, not a security boundary. A shell running as your user can reach the same files and programs in other ways. Do not run the agent with permission checks turned off while the daemon is installed.

## Remove

```
claude mcp remove --scope user pairpost
rm -r ~/.claude/skills/pairpost
```
