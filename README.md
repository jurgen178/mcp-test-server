# MCP Test Server

Small TypeScript MCP server exposed over Streamable HTTP with a few demo tools for testing clients and transports.

## What It Does

- Exposes an MCP endpoint at `POST /mcp`
- Starts an Express server on port `3000` by default
- Registers a small set of demo tools for math, text formatting, images, and GitHub API lookups

## Included Tools

- `addNumbers`: adds two numbers
- `reverse`: reverses a string
- `formatText`: formats text with optional case conversion and style selection
- `pixelBadge`: returns a small SVG badge as image content
- `getGitHubRepoStats`: fetches star and fork counts for a GitHub repository
- `getHilbertHotelInfo`: returns generated structured sample data

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

- `POST /mcp`: handles MCP requests
- `GET /mcp`: returns `405 Method not allowed`
- `DELETE /mcp`: returns `405 Method not allowed`

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
- The MCP server name is `test-server`
- The package name is `mcp-test-server`