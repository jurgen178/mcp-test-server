# MCP Test Server

Small TypeScript MCP server exposed over Streamable HTTP with a few demo tools for testing clients and transports.

## What It Does

- Exposes an MCP endpoint at `POST /mcp`
- Supports stateful MCP sessions with `mcp-session-id`
- Supports `GET /mcp` as SSE stream for server-initiated notifications
- Starts an Express server on port `3000` by default
- Registers a small set of demo tools for math, text formatting, images, and GitHub API lookups
- Registers notification and event demos for progress, live resource updates, and dynamic catalog changes
- Exposes demo resource and demo prompt in addition to the tools

## Included Tools

- `addNumbers`: adds two numbers
- `reverse`: reverses a string
- `formatText`: formats text with optional case conversion and style selection
- `pixelBadge`: returns a small SVG badge as image content
- `getGitHubRepoStats`: fetches star and fork counts for a GitHub repository
- `getHilbertHotelInfo`: returns generated structured sample data
- `runProgressDemo`: emits `notifications/progress` during a long-running tool call
- `pushLiveUpdate`: updates a live resource and emits resource/logging notifications
- `startEventBurst`: emits timed server-side events after the tool already returned
- `toggleDynamicCatalog`: enables or disables demo tool/prompt/resource entries to trigger `list_changed` notifications

## Included Resources

- `resorcerer`: returns a compact markdown overview of the server capabilities
- `live-status`: returns a JSON snapshot used for `notifications/resources/updated` testing
- `dynamic-note`: optional test resource toggled via `toggleDynamicCatalog`

## Included Prompts

- `promptsmith`: creates a reusable prompt brief from `goal`, `audience`, and `tone`
- `ticket-summary`: creates a structured summary for a support ticket
- `dynamic-event-brief`: optional prompt toggled via `toggleDynamicCatalog`

## Tool Screenshots

### addNumbers

![addNumbers screenshot](https://github.com/jurgen178/mcp-test-server/blob/main/doc/addnumbers.png?raw=true)

### reverse

![reverse screenshot](https://github.com/jurgen178/mcp-test-server/blob/main/doc/reverse.png?raw=true)

### formatText

![formatText screenshot](https://github.com/jurgen178/mcp-test-server/blob/main/doc/formattext.png?raw=true)

### pixelBadge

![pixelBadge screenshot](https://github.com/jurgen178/mcp-test-server/blob/main/doc/pixelbadge.png?raw=true)

### getGitHubRepoStats

![getGitHubRepoStats screenshot](https://github.com/jurgen178/mcp-test-server/blob/main/doc/github.png?raw=true)

### getHilbertHotelInfo

![getHilbertHotelInfo screenshot](https://github.com/jurgen178/mcp-test-server/blob/main/doc/hilbert.png?raw=true)

## Requirements

- Node.js 18 or newer
- npm

## Install

```bash
npm install
```

## Run

```bash
npm start
```

The server listens on:

```text
http://localhost:3000/mcp
```

![Console output screenshot](https://github.com/jurgen178/mcp-test-server/blob/main/doc/cmd.png?raw=true)


Additional deployment:

```text
https://bitfabrik.io/mcp
```

To use a different port:

```bash
PORT=4000 npm start
```

On Windows PowerShell:

```powershell
$env:PORT=4000
npm start
```

## Type Check

```bash
npm run build
```

Note: the `build` script currently runs TypeScript with `--noEmit`, so it performs type-checking rather than producing output files.

## MCP Endpoint

- `POST /mcp`: handles initialization and session-bound MCP requests
- `GET /mcp`: opens the SSE stream for an existing MCP session
- `DELETE /mcp`: terminates an existing MCP session

## Testing Notifications

Recommended test flow for clients that support Streamable HTTP with SSE:

1. Initialize with `POST /mcp` and capture the returned `mcp-session-id` header.
2. Open `GET /mcp` with the same `mcp-session-id` header to keep the notification stream open.
3. Call `runProgressDemo` with a `progressToken` to test `notifications/progress`.
4. Call `pushLiveUpdate` or `startEventBurst` to test `notifications/message` and `notifications/resources/updated`.
5. Call `toggleDynamicCatalog` to test `notifications/resources/list_changed`, `notifications/prompts/list_changed`, and `notifications/tools/list_changed`.

Notes:

- `startEventBurst` is useful for out-of-band events because the notifications continue after the tool call response has already been returned.
- `live-status` is the resource that changes when event notifications are emitted.

## Example Request

Example JSON-RPC style request body for calling a tool depends on the MCP client you use, but the server endpoint is:

```text
POST http://localhost:3000/mcp
Content-Type: application/json
```

Additional deployment endpoint:

```text
POST https://bitfabrik.io/mcp
Content-Type: application/json
```

If you are connecting from an MCP client, configure it to use the Streamable HTTP transport against either URL.

## Project Structure

```text
.
├── doc/
│   ├── addnumbers.png
│   ├── cmd.png
│   ├── formattext.png
│   ├── github.png
│   ├── hilbert.png
│   ├── pixelbadge.png
│   └── reverse.png
├── src/
│   └── server.ts
├── package.json
├── tsconfig.json
└── README.md
```

## Notes

- CORS is enabled for any origin
- The MCP server name is `mcp-test-server`
