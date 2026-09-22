# Gremlin MCP Server

A Model Context Protocol (MCP) server for interacting with Gremlin's reliability management APIs.

## Overview

This MCP server provides access to Gremlin's reliability testing and management capabilities, including:
- Service reliability management and monitoring
- Service dependency tracking
- Reliability experiments and testing
- Reliability reporting
- Usage and pricing reports
- Client (agent) and attack summaries
- Reliability test execution and queued run inspection
- Direct access to the Gremlin API

## Installation

### Prerequisites
- Node.js 18 or higher
- A valid [Gremlin API key](https://app.gremlin.com/settings/api-keys)

### Two deployments

There are two entrypoints, with different authentication models, and they are deliberately separate
programs rather than two modes of one:

| | `src/main.ts` (`build/main.mjs`) | `src/http.ts` (`build/http.mjs`) |
| --- | --- | --- |
| Transport | stdio | Streamable HTTP |
| Runs | Locally, next to your client | Hosted, Gremlin-operated |
| Users | One | Many, concurrently |
| Credential | A static API key from the environment | Each user's own OAuth 2.0 access token |

This is the deployment customers run themselves, and the one Private Edition uses. It is
unaffected by the hosted server: the hosted path never falls back to a process-wide credential,
because nothing below `apiKeyCredentialFromEnvironment` knows `GREMLIN_API_KEY` exists.

### Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GREMLIN_API_KEY` | stdio only | — | Your Gremlin API key. The server exits immediately if this is missing. Not read by the hosted server. |
| `GREMLIN_SERVICE_URL` | No | `https://api.gremlin.com/v1` | Base URL for the Gremlin API, including the version prefix. Override to target a staging or self-hosted environment. |
| `GREMLIN_MCP_RESOURCE_URL` | HTTP only | — | This server's own public origin — `https://mcp.gremlin.com` in production, host-only with no path. Its RFC 8707 resource identifier, compared as an exact string, so it must match the `resource` a client sends and what the authorization server audiences tokens for. No default: a wrong guess surfaces as an authentication failure with no obvious cause, so the server refuses to start without it. |
| `GREMLIN_AUTHORIZATION_SERVER` | No | `https://api.gremlin.com` | The authorization server that issues tokens for this resource. |
| `PORT` | No | `8080` | HTTP listen port. |
| `GREMLIN_MCP_MAX_SESSIONS` | No | `2000` | Ceiling on concurrent sessions; new ones get `503` beyond it. |
| `GREMLIN_MCP_ALLOWED_ORIGINS` | No | *(none)* | Comma-separated browser origins permitted to call `/mcp`. Requests with no `Origin` are allowed — the legitimate caller is a server, not a browser — and any present value must be listed. Only needed for local development against a browser-based MCP client. |
| `GREMLIN_MCP_MAX_NEW_SESSIONS_PER_MINUTE` | No | `20` | Per-source cap on session creation; excess gets `429`. Reusing a session is not counted. Source is the rightmost globally-routable `X-Forwarded-For` hop, so a private load-balancer hop does not collapse every caller into one bucket. |

### Why the resource identifier is the MCP server, not the API

`GREMLIN_MCP_RESOURCE_URL` is this server's own origin, and the access tokens Claude obtains are
audienced for it. Conceptually that is a little off: the credential authorizes *this server* to
reach `api.gremlin.com` on the user's behalf, and the API is what actually validates the token and
applies the user's RBAC. By that reading the audience "should" be `https://api.gremlin.com`.

It is not, for a concrete reason: Anthropic's connector requirements state that *the protected
resource metadata document's `resource` field must match your MCP server URL exactly as the user
enters it in Claude*. Declaring the API there would fail directory review, and Claude sends back
whatever that field says regardless.

The consequence is that `api.gremlin.com` must accept tokens audienced for `mcp.gremlin.com`, so
its allow list (`GREMLIN_OAUTH_RESOURCES` on the service side) contains both hosts and the audience
check cannot distinguish between them. That was accepted deliberately rather than overlooked:

- The attack audience binding exists to stop — a token minted for resource A being replayed at
  resource B — yields no privilege gain here, because the API applies the authorizing user's own
  RBAC either way. An attacker holding the token can call the API directly instead, for the same
  access.
- The upstream path is closed separately: we support no Dynamic Client Registration, and
  `redirect_uri` is an exact-match allow list, so a third-party resource cannot obtain a token from
  our authorization server in the first place.

**Revisit this if the topology changes.** Specifically: a second protected resource (another
connector, a partner-operated MCP server), or this server leaving the API team's operational
control. At that point the audience field stops being cosmetic, and the fix is RFC 8693 token
exchange at this boundary — this server would validate its own `aud=mcp` token and exchange it for
an `aud=api` one rather than forwarding. That needs an introspection endpoint or shared token-store
access, plus a client credential for this server, which is why it was not worth paying up front.

### Hosted server endpoints

| Path | Auth | Purpose |
| --- | --- | --- |
| `/.well-known/oauth-protected-resource` | None | RFC 9728 metadata. Public by definition — it is how a client discovers where to authenticate, so requiring a token to read it would be circular. |
| `/mcp` | `Authorization: Bearer <access token>` | The MCP endpoint. A request with no token gets `401` plus a `WWW-Authenticate` header naming the metadata document; that exchange is the entry point to the whole OAuth flow. |
| `/healthz` | None | Liveness, plus the live session count. |

Each authenticated session gets its own `McpServer` and its own `GremlinApi`. That is a
requirement, not an optimisation: the API client's response cache is keyed on URL alone, so a
shared instance would answer one user's request with another user's teams, services and reports
for the full cache TTL, and every response would look valid.

Sessions are additionally bound to the SHA-256 fingerprint of the credential that opened them, so
attaching to a session requires presenting that same token — a leaked session id alone will not do.

Two bounds sit in front of session creation, because a session is allocated on the first request
rather than on demand: `GREMLIN_MCP_MAX_SESSIONS` (default 2000) caps how many can exist, and
`GREMLIN_MCP_MAX_NEW_SESSIONS_PER_MINUTE` (default 20) caps how fast one source can open them.
Reusing an established session is not counted against the second. A bearer that is not one of our
`gremlin_oat_` access tokens is refused before anything is allocated — notably including an
internal Gremlin session token, which the API would otherwise accept under the same Bearer
scheme.

### Claude Desktop

Go to Claude Settings > Developer and add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gremlin": {
      "command": "npx",
      "args": ["-y", "@gremlin/mcp-server"],
      "env": {
        "GREMLIN_API_KEY": "your_gremlin_api_key_here"
      }
    }
  }
}
```

### VS Code / Cursor

> Requires [VS Code 1.99](https://code.visualstudio.com/updates/v1_99) or higher (MCP support was added in the March 2025 release). See also: [Cursor MCP docs](https://cursor.com/docs/mcp).

Open your MCP Settings:
 - Cursor: `Cmd+Shift+P` → search "Cursor Settings" → Tools & Integrations → Add Custom MCP
 - VSCode: `Cmd+Shift+P` → type "MCP: Open User Configuration"

Or directly edit them:
 - Cursor (Mac/Linux): `~/.cursor/mcp.json`
 - Cursor (Win): `%USERPROFILE%\.cursor\mcp.json`
 - VSCode (Mac): `~/Library/Application Support/Code/User/mcp.json`
 - VSCode (Win): `%APPDATA%\Code\User\mcp.json`
 - VSCode (Linux): `~/.config/Code/User/mcp.json`

Add the following to your MCP settings:

```json
{
  "servers": {
    "gremlin": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@gremlin/mcp-server"],
      "env": {
        "GREMLIN_API_KEY": "${input:gremlin-api-key}"
      }
    }
  },
  "inputs": [
    {
      "type": "promptString",
      "id": "gremlin-api-key",
      "description": "Gremlin API Key",
      "password": true
    }
  ]
}
```


## Available Tools

### Teams

#### `list_teams`
Lists all teams you have access to. Nearly every other tool requires a `teamId`, and this is how to find one.

### Service Management

#### `list_services`
Lists all available reliability management (RM) services with their descriptions, scores, and targeting information.

#### `get_service_dependencies`
Retrieves dependencies for a specific service.
- **Parameters:** `teamId` (required), `serviceId` (required)

#### `get_service_status_checks`
Gets status checks configured for a service.
- **Parameters:** `teamId` (required), `serviceId` (required)

#### `list_service_risks`
Lists identified risks associated with a service.
- **Parameters:** `teamId` (required), `serviceId` (required)

### Reliability Reports & Analytics

#### `get_reliability_report`
Generates a reliability report for a service on a specific date.
- **Parameters:** `teamId` (required), `serviceId` (required), `date` (optional, defaults to today, format: YYYY-MM-DD)

#### `get_reliability_experiments`
Retrieves recent reliability experiments for a service.
- **Parameters:** `teamId` (required), `serviceId` (required), `dependencyId` (optional), `testId` (optional), `limit` (optional, default: 100), `includeScenarioRun` (optional, default: false, full step-by-step scenario run graph data)

### Usage & Billing

#### `get_pricing_report`
Fetches the pricing usage report for the company over a specified date range. Returns usage broken down by tracking period including active agents, targetable applications, and unique targets by type.
- **Parameters:** `startDate` (required, yyyy-mm-dd), `endDate` (required, yyyy-mm-dd), `trackingPeriod` (optional: `Daily`, `Weekly`, or `Monthly`, defaults to the company's configured period)

#### `get_client_summary`
Loads the client (agent) summary for a team over a specified time period. Shows agent activity and status.
- **Parameters:** `teamId` (required), `start` (required, yyyy-mm-dd), `end` (required, yyyy-mm-dd), `period` (required: `MONTHS`, `WEEKS`, or `DAYS`)

#### `get_attack_summary`
Loads the attack summary for a team over a specified time period. Shows attack activity and results.
- **Parameters:** `teamId` (required), `start` (required, yyyy-mm-dd), `end` (required, yyyy-mm-dd), `period` (required: `MONTHS`, `WEEKS`, or `DAYS`)

### Testing & Experiments

#### `run_reliability_test`
Triggers a reliability test run for a service. Requires the `SERVICES_RUN` privilege. Returns HTTP 400 if a test is already running or scheduled for the service.
- **Parameters:** `teamId` (required), `serviceId` (required), `reliabilityTestId` (required), `dependencyId` (optional), `failureFlagName` (optional), `includeScenarioRun` (optional, default: false)

#### `get_pending_test_runs`
Retrieves pending or queued test runs for a service, ordered by expected trigger time. Useful for diagnosing a 400 from `run_reliability_test`.
- **Parameters:** `teamId` (required), `serviceId` (required)

#### `get_recent_reliability_tests`
Gets recent reliability tests for a team.
- **Parameters:** `teamId` (required), `pageSize` (optional, default: 5), `pageToken` (optional)

#### `get_current_test_suite`
Retrieves the current test suite for a team or all teams.
- **Parameters:** `teamId` (optional)

### Container Targeting

#### `get_container`
Fetches a single container by its ID — a quick point lookup, not a search. Returns `id`, `clientId`, `name`, and `labels`.
- **Parameters:** `teamId` (required), `containerId` (required)

#### `match_containers`
Previews which containers a targeting selector would match, using the same matching logic a real Service's targeting strategy uses. Returns `matchedContainers` (each with `id`, `clientId`, `name`, `labels`) plus `totalContainerCount` (the full team container count, so you can report e.g. "12 of 340 matched").
- **Parameters:** `teamId` (required), and exactly one of `isAll` (boolean), `ids` (list of container IDs), or `multiSelectLabels` (map of label key → list of acceptable values; keys are combined with AND, values within a key with OR)

#### `list_container_label_keys`
Lists the distinct label keys observed across all of the team's containers (keys only — no values or counts). Use this to discover valid keys before building a `multiSelectLabels` selector for `match_containers`.
- **Parameters:** `teamId` (required)

### Direct API Access

#### `search_gremlin_api`
Searches the Gremlin OpenAPI spec for endpoints, returning method, path, parameters, and request body schema for each match.
- **Parameters:** `query` (required), `method` (optional, enum: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`), `tag` (optional, partial/case-insensitive match), `limit` (optional, default: 10, max: 50)

The API tools are split by HTTP safety class rather than taking a `method` parameter. A single tool
spanning `GET` and `DELETE` cannot carry an honest `readOnlyHint`/`destructiveHint`, and those
annotations are what decide whether Claude confirms a call. All four share one implementation, so
path templating, the `*_RUN` privilege prompt, and error handling behave identically whichever you
call.

#### `read_gremlin_api`
Reads any Gremlin API endpoint with a `GET`. The only API tool marked `readOnlyHint`, so it runs
without per-call confirmation — it earns that by fixing the method rather than accepting one.
- **Parameters:** `path` (required, OpenAPI template syntax, leading slash optional), `pathParams` (optional), `queryParams` (optional)

#### `create_gremlin_api`
Sends a `POST`, to create a resource or start a run. Marked `destructiveHint` despite creating
rather than destroying: in Gremlin a `POST` is how a chaos experiment starts, so the call adds a
record and takes down a production dependency. Claude prompting each time is correct.
- **Parameters:** `path` (required), `pathParams` (optional), `queryParams` (optional), `body` (optional), `confirmExecution` (optional, bypasses the `*_RUN` prompt)

#### `update_gremlin_api`
Modifies an existing resource with `PUT` (replace) or `PATCH` (partial).
- **Parameters:** `path` (required), `method` (required, enum: `PUT`, `PATCH`), `pathParams` (optional), `queryParams` (optional), `body` (optional), `confirmExecution` (optional)

#### `delete_gremlin_api`
Deletes a resource, or halts a running experiment.
- **Parameters:** `path` (required), `pathParams` (optional), `queryParams` (optional), `confirmExecution` (optional)

## Usage Notes

- All date parameters should use YYYY-MM-DD format
- Team and service IDs are required for most service-specific operations
- Optional parameters have sensible defaults where applicable
- Team IDs can be discovered with `list_teams`
- Operations that trigger tests require the corresponding `*_RUN` privilege

## Example Queries

1. **List all services:**
> "What reliability management services are available?"

2. **Identify Critical Dependency for Coverage:**
> "I'm trying to find which are my most critical dependencies. Can you pull all my RM services, identify shared dependencies, ignoring ignored dependencies, create a list of them and then use the policy reports to understand what my coverage currently is for these dependencies. Finally; I want you to create a quick page with some graphics to help me understand the state of the world"

3. **Identify gaps in Scheduling:**
> "I think my schedule for tests is misconfigured for my RM services. I think this because I'm seeing a lot of expired policy evaluations in my RM Reports. It takes about 6 weeks to expire a policy evaluation and I should be testing every week. Now given my scheduling window it's possible that I'm not running every test every week, but across 6 weeks it seems less likely. Now, it's expected that for policy evaluations on a dependency which is marked as a SPOF it's expected for the policy evaluation to get to EXPIRED state. So can you go check all my RM services and figure out how many policy evaluations (excluding those on ignored or SPOF dependencies) are expired as a percentage of total? I'd like to see that on a per service basis"

## Troubleshooting

### Authentication Errors
Ensure your `GREMLIN_API_KEY` is valid and has the necessary permissions. The server will exit immediately with an error message if the key is missing.

### Server Not Starting
Check your MCP client's logs for error output from the server process. For Claude Desktop:
```
less ~/Library/Logs/Claude/mcp-server-gremlin.log
```

### Node.js Version
If you have multiple Node.js versions on your PATH, you may need to specify it explicitly:

```json
{
  "mcpServers": {
    "gremlin": {
      "command": "npx",
      "args": ["-y", "@gremlin/mcp-server"],
      "env": {
        "GREMLIN_API_KEY": "your_gremlin_api_key_here",
        "PATH": "/path/to/node/bin:/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

## Development

### Setup

```bash
git clone git@github.com:gremlin/mcp.git gremlin-mcp
cd gremlin-mcp
make
```

### Testing

Tests run against the live Gremlin API. Create a `.env` file with your key:

```
GREMLIN_API_KEY=your_gremlin_api_key_here
```

Then run:

```bash
env $(cat .env | xargs) make test
```

**Note:** Running tests requires Node.js 20.19+ or 22.12+ (vitest 4.x dependency).

### Inspector

```bash
make inspector
```

### Version Bumps

```bash
make bump VERSION=patch   # or minor / major
```

Updates the version everywhere it's hardcoded (`package.json`, `package-lock.json`, `src/main.ts`, `src/client/gremlin.ts`). A pre-push hook blocks pushes with real changes but no version bump — for hotfixes/merge-backs where that doesn't apply, bypass it with `SKIP_VERSION_CHECK=1 git push`.

### Publishing

```bash
make publish
```

## Support

For issues or questions, please [create a support ticket](https://support-site.gremlin.com/support/tickets/new) or contact support.
