import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolResult, GetPromptResult, isInitializeRequest, PrimitiveSchemaDefinition, ReadResourceResult, ResourceLink } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const MCP_PORT = Number(process.env.PORT) || 3000;

// Create a MCP server
const getServer = () => {
  const server = new McpServer({
    name: 'test-server',
    version: '1.0.0'
  });

  // Register a tool that adds two numbers
  server.registerTool(
    'addNumbers',
    {
      title: 'Addition Tool',  // Display name for UI
      description: 'Adds two numbers and returns the result',
      inputSchema: {
        a: z.number().describe('First number'),
        b: z.number().describe('Second number'),
      },
    },
    async ({ a, b }): Promise<CallToolResult> => {
      const sum = a + b;
      return {
        content: [
          {
            type: 'text',
            text: `The sum of ${a} and ${b} is ${sum}.`,
          },
        ],
      };
    }
  );

  // Register a tool that reverses a string
  server.registerTool(
    'reverse',
    {
      title: 'Reverse String',
      description: 'Reverses the provided string',
      inputSchema: {
        text: z.string().describe('The string to reverse'),
      },
    },
    async ({ text }): Promise<CallToolResult> => {
      const reversed = text.split('').reverse().join('');

      return {
        content: [
          {
            type: 'text',
            text: reversed,
          },
        ],
      };
    }
  );

  server.registerTool(
    'formatText',
    {
      title: 'Format Text',
      description: 'Formats text with uppercase and a selected style',
      inputSchema: {
        text: z.string().describe('The text to format'),
        uppercase: z.boolean().optional().describe('True for uppercase, false for lowercase, unset to keep the original text'),
        style: z.enum(['plain', 'brackets', 'stars']).describe('The formatting style'),
      },
    },
    async ({ text, uppercase, style }): Promise<CallToolResult> => {
      let baseText = text;

      if (uppercase === true) {
        baseText = text.toUpperCase();
      } else if (uppercase === false) {
        baseText = text.toLowerCase();
      }

      let formattedText = baseText;

      switch (style) {
        case 'brackets':
          formattedText = `[${baseText}]`;
          break;
        case 'stars':
          formattedText = `*** ${baseText} ***`;
          break;
        default:
          formattedText = baseText;
          break;
      }

      return {
        content: [
          {
            type: 'text',
            text: formattedText,
          },
        ],
      };
    }
  );

  server.registerTool(
    'pixelBadge',
    {
      title: 'Pixel Badge',
      description: 'Returns a small test badge as text and image content',
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80" viewBox="0 0 240 80">',
        '<rect width="240" height="80" rx="14" fill="#1f2937"/>',
        '<rect x="8" y="8" width="224" height="64" rx="10" fill="#0ea5e9"/>',
        '<circle cx="42" cy="40" r="16" fill="#f59e0b"/>',
        '<text x="72" y="34" font-family="Arial, sans-serif" font-size="14" fill="#082f49">MCP TEST</text>',
        '<text x="72" y="54" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#ffffff">PIXEL BADGE</text>',
        '</svg>'
      ].join('');

      const imageData = Buffer.from(svg, 'utf8').toString('base64');

      return {
        content: [
          {
            type: 'text',
            text: 'Pixel Badge generated successfully.',
          },
          {
            type: 'image',
            data: imageData,
            mimeType: 'image/svg+xml',
          },
        ],
      };
    }
  );

  // Register a tool that fetches GitHub repository stats
  server.registerTool(
    'getGitHubRepoStats',
    {
      title: 'GitHub Repo Stats',
      description: 'Fetches star and fork count from a GitHub repository',
      inputSchema: {
        owner: z.string().describe('GitHub username or organization'),
        repo: z.string().describe('Repository name'),
      },
    },
    async ({ owner, repo }): Promise<CallToolResult> => {
      const url = `https://api.github.com/repos/${owner}/${repo}`;
      const response = await fetch(url);

      if (!response.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Failed to fetch repo stats: ${response.statusText}`,
            },
          ],
        };
      }

      const data = await response.json();

      return {
        content: [
          {
            type: 'text',
            text: `📊 ${owner}/${repo} has ⭐ ${data.stargazers_count} stars and 🍴 ${data.forks_count} forks.`,
          },
        ],
      };
    }
  );

    // Register a tool that returns Hilbert Hotel details
  server.registerTool(
    'getHilbertHotelInfo',
    {
      title: 'Hilbert Hotel Info',
      description: 'Get information about the Hilbert Hotel in Math Town',
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const structuredContent = {
        hotelName: 'Hilbert Hotel',
        address: {
          street: '1 Infinity Loop',
          city: 'Math Town',
          postalCode: `MT-${Math.floor(1000 + Math.random() * 9000)}`,
          country: 'Numberland',
        },
        building: {
          floors: Math.floor(50 + Math.random() * 151),
          occupiedRooms: Math.floor(1000 + Math.random() * 9000),
          elevatorCount: Math.floor(2 + Math.random() * 8),
        },
        metadata: {
          requestId: `hilbert-${Math.floor(100000 + Math.random() * 900000)}`,
          generatedAt: new Date().toISOString(),
        },
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(structuredContent, null, 2),
          },
        ],
        structuredContent,
      };
    }
  );

  return server;
};


// Start server with HTTP transport
async function startHttpServer() {
  console.log('🚀 Starting MCP server with HTTP transport...');
  
  const app = express();

  const cors = require('cors')
  app.use(cors()); // enabling CORS for any unknown origin

  app.use(express.json());

  app.post("/mcp", async (req: Request, res: Response) => {
    console.log("Received MCP request:", req.body);
    try {
      const server = getServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      res.on('close', () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", async (req: Request, res: Response) => {
    console.log("Received GET MCP request");
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      })
    );
  });

  app.delete("/mcp", async (req: Request, res: Response) => {
    console.log("Received DELETE MCP request");
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      })
    );
  });

  const httpServer = app.listen(MCP_PORT);

  await new Promise<void>((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });

  console.log(`✅ MCP Streamable HTTP Server listening on port ${MCP_PORT}`);

  // Handle server shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down HTTP server...');
    httpServer.close(() => process.exit(0));
  });
}

// Main function to start the server
async function main() {
    await startHttpServer();
}

// Start the server
main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
