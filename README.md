# newrelic-lite-logs-mcp

Read-only New Relic Logs MCP server for VS Code.

This project helps users debug issues with AI by fetching New Relic logs through MCP without requiring a premium New Relic MCP plan.

## Why this project

- Read-only access to logs through NRQL.
- VS Code MCP compatible.
- API key auth by default, cookie fallback for emergencies.
- Built-in redaction and query guardrails.

## Tooling included

| Tool | Description |
|---|---|
| `search_logs` | Run any read-only NRQL query against your log tables |
| `dry_run_query` | Validate and normalize a NRQL query without executing it |
| `build_memory_bank` | **Run once.** Discovers infra/log tables/schemas, accepts clarifications, and writes a repo-local memory bank file |

## Requirements

- Node.js 20+
- npm
- New Relic User API key
- New Relic account id

## Quick start

1. Install dependencies.

```bash
npm install
```

2. Build.

```bash
npm run build
```

3. Run tests.

```bash
npm test
```

## VS Code setup (no clone/build)

This is the primary usage model.

1. Set local environment variables.

```bash
export NEW_RELIC_DEFAULT_AUTH_MODE=api_key_only
export NEW_RELIC_ACCOUNT_ID=1867676
export NEW_RELIC_API_KEY="YOUR_REAL_NEW_RELIC_USER_API_KEY"
export NEW_RELIC_COOKIE=""
```

2. Add this block to VS Code mcp.json.

```json
{
  "servers": {
    "newrelic-lite-logs-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:BetterWorks/newrelic-lite-logs-mcp"],
      "env": {
        "NEW_RELIC_DEFAULT_AUTH_MODE": "api_key_only",
        "NEW_RELIC_ACCOUNT_ID": "${env:NEW_RELIC_ACCOUNT_ID}",
        "NEW_RELIC_API_KEY": "${env:NEW_RELIC_API_KEY}",
        "NEW_RELIC_COOKIE": "${env:NEW_RELIC_COOKIE}",
        "NEW_RELIC_VERBOSE_LOGS": "0",
        "NR_MEMORY_BANK_PATH": "${workspaceFolder}/.newrelic/memory-bank.json"
      }
    }
  },
  "inputs": [
  {
   "id": "newrelic-account-id",
   "type": "promptString",
   "description": "New Relic Account ID — get from https://one.newrelic.com/ → Account settings → API keys",
   "password": true,
   "default": "${env:NEW_RELIC_ACCOUNT_ID}"
  },
  {
   "id": "newrelic-api-key",
   "type": "promptString",
   "description": "New Relic API key — get from https://one.newrelic.com/ → Account settings → API keys",
   "password": true,
   "default": "${env:NEW_RELIC_API_KEY}"
  },
  {
   "id": "newrelic-cookie",
   "type": "promptString",
   "description": "New Relic cookie — get from browser's network tab when logged in to New Relic",
   "password": true,
   "default": "${env:NEW_RELIC_COOKIE}"
  }
 ]
}
```

3. Restart VS Code.
4. Open MCP server list/dropdown.
5. Start/select newrelic-lite-logs-mcp.
6. **First time only:** ask the AI to call `build_memory_bank`. It should ask clarifying questions first (service mapping, environments, pod/container naming), then write `.newrelic/memory-bank.json`.
7. Ask the AI to call `search_logs` (optionally `dry_run_query` first).

## VS Code setup for local development

Project-level config is available in .vscode/mcp.json and runs dist/index.js from the workspace.

## Memory bank

The memory bank solves a common problem: your infra may push logs into custom event types (`Log_produs`, `Log_prodeu`, `Log_internal`, …) with custom field names (`container_name`, `region`, …) that the AI has no way of knowing about ahead of time.

**How it works:**

1. Call `build_memory_bank` once (or whenever your infra changes). It runs:
   - `SHOW EVENT TYPES` → finds all log-like tables
   - `keyset()` per table → all field names
   - `FACET` queries → sample values for custom fields
2. Results are written to a local JSON file (default: `./.newrelic/memory-bank.json`).
3. The MCP server automatically reads this local file for routing/validation, so query tools can use the correct table names and fields without an extra call.

The memory bank also stores concise user clarifications such as local repo names, environment names, and service-to-pod/container mappings.
Keep this file machine-readable and deterministic so AI can consume it with minimal context overhead.

**Customising the file location:**

Set `NR_MEMORY_BANK_PATH` to any absolute path:

```bash
export NR_MEMORY_BANK_PATH="/path/to/your/nr-context.json"
```

Or pass it in the VS Code `mcp.json` `env` block (shown in the example above).

**Re-run after infra changes** — new log tables, new custom fields, or renamed containers will not be visible until you run `build_memory_bank` again.

## Authentication modes

Default mode:

- NEW_RELIC_DEFAULT_AUTH_MODE=api_key_only
- NEW_RELIC_API_KEY=...

Emergency fallback:

- NEW_RELIC_DEFAULT_AUTH_MODE=cookie
- NEW_RELIC_COOKIE=...

Cookie mode should only be used as fallback because session cookies are short-lived.

## Safety and limits

- Read-only query enforcement.
- At least one time boundary required (since/until or inline NRQL SINCE/UNTIL).
- Max rows per request: 5000.
- Sensitive data redaction in outputs.

## Scripts

- npm run build
- npm run dev
- npm run start
- npm run test
- npm run test:coverage
- npm run typecheck

## CI

GitHub Actions workflow runs:

- typecheck
- build
- test with coverage

Coverage artifacts are uploaded in each run.

## Release notes

Choose one update mode:

- Always latest code (auto-updates from default branch):
  - `github:BetterWorks/newrelic-lite-logs-mcp`
- Pinned stable version (manual upgrade when you change the tag):
  - `github:BetterWorks/newrelic-lite-logs-mcp#v1.0.1`

Important:

- GitHub source installs do not have a built-in "always newest release tag" mode.
- If you want strict release tags, update the tag in `mcp.json` when a new release is published.

## Security checklist

- Never commit real API keys or cookies.
- Rotate credentials immediately if exposed.
- Keep secrets in local environment variables only.

## Troubleshooting

401 authentication required:

- verify NEW_RELIC_API_KEY is valid and active
- verify key has NerdGraph query access
- verify VS Code process can read your env vars

Server not visible in MCP list:

- validate mcp.json syntax
- restart VS Code

No logs returned:

- use larger time windows
- validate account id
- verify data exists in New Relic for that period

## Project structure

- src/index.ts
- src/newrelic.ts
- src/security.ts
- tests/security.test.ts
- .vscode/mcp.json
- .github/workflows/ci.yml

## License

ISC
