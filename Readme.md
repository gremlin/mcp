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

### Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GREMLIN_API_KEY` | Yes | — | Your Gremlin API key. The server exits immediately if this is missing. |
| `GREMLIN_SERVICE_URL` | No | `https://api.gremlin.com/v1` | Base URL for the Gremlin API, including the version prefix. Override to target a staging or self-hosted environment. |

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

### Direct API Access

#### `search_gremlin_api`
Searches the Gremlin OpenAPI spec for endpoints, returning method, path, parameters, and request body schema for each match.
- **Parameters:** `query` (required), `method` (optional, enum: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`), `tag` (optional, partial/case-insensitive match), `limit` (optional, default: 10, max: 50)

#### `execute_gremlin_api`
Executes an arbitrary Gremlin API endpoint. Endpoints requiring a `*_RUN` privilege prompt for interactive confirmation unless bypassed; can trigger real chaos experiments.
- **Parameters:** `method` (required, enum: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`), `path` (required, OpenAPI template syntax, leading slash optional), `pathParams` (optional), `queryParams` (optional), `body` (optional), `confirmExecution` (optional, bypasses the confirmation prompt)

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

### Publishing

```bash
make publish
```

## Support

For issues or questions, please [create a support ticket](https://support-site.gremlin.com/support/tickets/new) or contact support.
