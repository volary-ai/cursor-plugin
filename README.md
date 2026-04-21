# Volary Cursor Plugin

A Cursor plugin that connects your Cursor sessions to Volary:

- **On session start** — fetches your agent's root memory index from Volary and injects it into the model context, so the agent knows what reflections are available to recall.
- **On session end** — posts the completed transcript to Volary so the reflector can extract new reflections from it.
- **MCP tools** — exposes Volary's per-agent memory tools to the agent.

## Requirements

- Cursor 2.5+
- Node.js 18+ on your PATH
- A Volary account with an organisation, agent, and access token

## Installation

### Local install

Clone this repository into Cursor's local plugin folder:

```bash
mkdir -p ~/.cursor/plugins/local
git clone git@github.com:volary-ai/cursor-plugin.git ~/.cursor/plugins/local/volary
```

Then start (or restart) Cursor.


## Configuration

All three integrations (session-start hook, stop hook, and MCP proxy) share the same config loader. Values resolve in this order (first non-empty wins per field):

1. Environment variables: `VOLARY_ORG_ID`, `VOLARY_AGENT_ID`, `VOLARY_TOKEN`
2. Project config at `<workspace>/.cursor/volary.json`
3. User config at `~/.cursor/volary.json`

### Recommended setup

Configure the user config like so:

```bash
# ~/.cursor/volary.json
{
  "org_id": "your-org-id",
  "agent_id": "your-agent-id",
  "token": "eyJh..."
}
```

## Verifying it works

Start a new Cursor session in a configured project. You should see a memory index appear in the agent's initial context (expand the system message to inspect). The `volary` MCP server should show up green in Cursor's MCP panel with four tools listed. After finishing the session, check your agent's reflections page in the Volary UI - new reflections should appear shortly after the session ends.

If something goes wrong, both the hooks and the MCP proxy log to stderr. Hook errors surface in Cursor's output panel; MCP proxy errors surface in Cursor's MCP server panel. A common one is `missing config: token` when no configuration has been provided.
