import { randomUUID } from 'crypto';
import express, { Request, Response } from 'express';
import { McpServer, RegisteredPrompt, RegisteredResource, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolResult, GetPromptResult, ReadResourceResult, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const MCP_PORT = Number(process.env.PORT) || 3000;
const LIVE_RESOURCE_URI = 'resource://mcp-test-server/live-status';
const DYNAMIC_RESOURCE_URI = 'resource://mcp-test-server/dynamic-note';

type SessionContext = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  dynamicResource: RegisteredResource;
  dynamicPrompt: RegisteredPrompt;
  dynamicTool: RegisteredTool;
  eventTimer?: NodeJS.Timeout;
};

const sessions = new Map<string, SessionContext>();

const liveState = {
  version: 0,
  message: 'Server started',
  source: 'bootstrap',
  updatedAt: new Date().toISOString(),
};

const getHeaderValue = (value: string | string[] | undefined): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const updateLiveState = (message: string, source: string) => {
  liveState.version += 1;
  liveState.message = message;
  liveState.source = source;
  liveState.updatedAt = new Date().toISOString();
};

const stopEventTimer = (context: SessionContext) => {
  if (context.eventTimer) {
    clearInterval(context.eventTimer);
    context.eventTimer = undefined;
  }
};

const setEnabledState = (
  registeredItem: RegisteredResource | RegisteredPrompt | RegisteredTool,
  enabled: boolean
) => {
  if (enabled) {
    registeredItem.enable();
    return 'enabled';
  }

  registeredItem.disable();
  return 'disabled';
};

const emitLiveUpdate = async (message: string, source: string, sessionIds?: string[]) => {
  updateLiveState(message, source);

  const targetSessionIds = sessionIds ?? Array.from(sessions.keys());

  await Promise.all(targetSessionIds.map(async (sessionId) => {
    const context = sessions.get(sessionId);

    if (!context || !context.server.isConnected()) {
      return;
    }

    try {
      await context.server.sendLoggingMessage(
        {
          level: 'info',
          logger: 'mcp-test-server',
          data: {
            event: 'live-update',
            message,
            source,
            version: liveState.version,
            updatedAt: liveState.updatedAt,
          },
        },
        sessionId
      );

      await context.server.server.sendResourceUpdated({
        uri: LIVE_RESOURCE_URI,
      });
    } catch (error) {
      console.error(`Failed to send live update for session ${sessionId}:`, error);
    }
  }));
};

const startEventBurst = (sessionId: string, ticks: number, delayMs: number) => {
  const context = sessions.get(sessionId);

  if (!context) {
    return false;
  }

  stopEventTimer(context);

  let currentTick = 0;

  context.eventTimer = setInterval(() => {
    const activeContext = sessions.get(sessionId);

    if (!activeContext) {
      return;
    }

    currentTick += 1;
    void emitLiveUpdate(
      `Event burst tick ${currentTick}/${ticks}`,
      'event-burst',
      [sessionId]
    );

    if (currentTick >= ticks) {
      stopEventTimer(activeContext);
    }
  }, delayMs);

  return true;
};

// Create a MCP server
const getServer = () => {
  const server = new McpServer({
    name: 'mcp-test-server',
    version: '1.0.0'
  }, {
    capabilities: {
      logging: {},
      resources: {
        subscribe: true,
      },
    },
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

  server.registerTool(
    'runProgressDemo',
    {
      title: 'Run Progress Demo',
      description: 'Counts through several steps and emits notifications/progress updates when requested by the client',
      inputSchema: {
        steps: z.number().int().min(1).max(20).default(5).describe('How many progress steps to emit'),
        delayMs: z.number().int().min(50).max(2000).default(250).describe('Delay between progress notifications in milliseconds'),
      },
    },
    async ({ steps, delayMs }, extra): Promise<CallToolResult> => {
      for (let index = 1; index <= steps; index += 1) {
        if (extra.signal.aborted) {
          return {
            content: [
              {
                type: 'text',
                text: `Progress demo cancelled at step ${index}.`,
              },
            ],
            isError: true,
          };
        }

        if (extra._meta?.progressToken !== undefined) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken: extra._meta.progressToken,
              progress: index,
              total: steps,
              message: `Progress step ${index}/${steps}`,
            },
          });
        }

        await sleep(delayMs);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Progress demo finished with ${steps} steps and ${delayMs}ms delay.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'pushLiveUpdate',
    {
      title: 'Push Live Update',
      description: 'Updates the live demo resource and emits notifications/resources/updated plus a logging message',
      inputSchema: {
        message: z.string().min(1).max(200).describe('Message written into the live resource'),
        broadcast: z.boolean().default(false).describe('True to send the update to all sessions, false for the current session only'),
      },
    },
    async ({ message, broadcast }, extra): Promise<CallToolResult> => {
      const targetSessionIds = broadcast || !extra.sessionId ? undefined : [extra.sessionId];
      await emitLiveUpdate(message, 'pushLiveUpdate', targetSessionIds);

      return {
        content: [
          {
            type: 'text',
            text: broadcast
              ? `Live update broadcast to ${sessions.size} session(s).`
              : `Live update sent for session ${extra.sessionId ?? 'n/a'}.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'startEventBurst',
    {
      title: 'Start Event Burst',
      description: 'Starts a short timer that emits live resource update notifications after the tool has already returned',
      inputSchema: {
        ticks: z.number().int().min(1).max(20).default(5).describe('Number of timed notifications to emit'),
        delayMs: z.number().int().min(100).max(5000).default(1000).describe('Delay between emitted events in milliseconds'),
      },
    },
    async ({ ticks, delayMs }, extra): Promise<CallToolResult> => {
      if (!extra.sessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'No session ID is bound to this request. Initialize a stateful session first.',
            },
          ],
          isError: true,
        };
      }

      const started = startEventBurst(extra.sessionId, ticks, delayMs);

      if (!started) {
        return {
          content: [
            {
              type: 'text',
              text: `Session ${extra.sessionId} is no longer active.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Event burst started for session ${extra.sessionId}. Keep the GET /mcp SSE stream open to receive ${ticks} events.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'toggleDynamicCatalog',
    {
      title: 'Toggle Dynamic Catalog',
      description: 'Enables or disables demo resource, prompt, and tool entries so clients can observe list_changed notifications',
      inputSchema: {
        resource: z.boolean().optional().describe('Enable or disable the dynamic demo resource'),
        prompt: z.boolean().optional().describe('Enable or disable the dynamic demo prompt'),
        tool: z.boolean().optional().describe('Enable or disable the dynamic demo tool'),
      },
    },
    async ({ resource, prompt, tool }, extra): Promise<CallToolResult> => {
      if (!extra.sessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'No session ID is bound to this request. Initialize a stateful session first.',
            },
          ],
          isError: true,
        };
      }

      const context = sessions.get(extra.sessionId);

      if (!context) {
        return {
          content: [
            {
              type: 'text',
              text: `Session ${extra.sessionId} is no longer active.`,
            },
          ],
          isError: true,
        };
      }

      const changes: string[] = [];

      if (typeof resource === 'boolean') {
        changes.push(`resource=${setEnabledState(context.dynamicResource, resource)}`);
      }

      if (typeof prompt === 'boolean') {
        changes.push(`prompt=${setEnabledState(context.dynamicPrompt, prompt)}`);
      }

      if (typeof tool === 'boolean') {
        changes.push(`tool=${setEnabledState(context.dynamicTool, tool)}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: changes.length > 0
              ? `Dynamic catalog updated for session ${extra.sessionId}: ${changes.join(', ')}`
              : 'No catalog flags changed. Provide at least one of resource, prompt, or tool.',
          },
        ],
      };
    }
  );

  const RESORCERER_URI = 'resource://mcp-test-server/resorcerer';
  const dynamicResource = server.registerResource(
    'dynamic-note',
    DYNAMIC_RESOURCE_URI,
    {
      title: 'Dynamic Note',
      description: 'Only visible when enabled via toggleDynamicCatalog',
      mimeType: 'text/markdown',
    },
    async (): Promise<ReadResourceResult> => {
      const resourceText = [
        '# Dynamic Note',
        '',
        'This resource exists to test notifications/resources/list_changed.',
        '',
        `Version: ${liveState.version}`,
        `Updated At: ${liveState.updatedAt}`,
      ].join('\n');

      return {
        contents: [
          {
            uri: DYNAMIC_RESOURCE_URI,
            mimeType: 'text/markdown',
            text: resourceText,
          },
        ],
      };
    }
  );

  dynamicResource.disable();

  server.registerResource(
    'live-status',
    LIVE_RESOURCE_URI,
    {
      title: 'Live Status',
      description: 'Live-updating demo resource for notifications/resources/updated tests',
      mimeType: 'application/json',
    },
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [
          {
            uri: LIVE_RESOURCE_URI,
            mimeType: 'application/json',
            text: JSON.stringify({
              ...liveState,
              activeSessions: sessions.size,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    'resorcerer',
    RESORCERER_URI,
    {
      title: 'Resorcerer',
      description: 'Provides a compact overview of the demo server capabilities',
      mimeType: 'text/markdown',
    },
    async (): Promise<ReadResourceResult> => {
      const resourceText = [
        '# Resorcerer',
        '',
        'This resource describes the MCP demo server surface in one place.',
        '',
        '## Tools',
        '- addNumbers',
        '- reverse',
        '- formatText',
        '- pixelBadge',
        '- getGitHubRepoStats',
        '- getHilbertHotelInfo',
        '- runProgressDemo',
        '- pushLiveUpdate',
        '- startEventBurst',
        '- toggleDynamicCatalog',
        '- dynamicEcho (optional)',
        '',
        '## Resources',
        '- resorcerer',
        '- live-status',
        '- dynamic-note (optional)',
        '',
        '## Prompts',
        '- promptsmith',
        '- ticket-summary',
        '- dynamic-event-brief (optional)',
        '',
        `Generated at: ${new Date().toISOString()}`,
      ].join('\n');

      return {
        contents: [
          {
            uri: RESORCERER_URI,
            mimeType: 'text/markdown',
            text: resourceText,
          },
        ],
      };
    }
  );

  const dynamicPrompt = server.registerPrompt(
    'dynamic-event-brief',
    {
      title: 'Dynamic Event Brief',
      description: 'Only visible when enabled via toggleDynamicCatalog',
      argsSchema: {
        topic: z.string().describe('Topic for the dynamic prompt'),
      },
    },
    async ({ topic }): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                'Create a short event brief.',
                `Topic: ${topic}`,
                `Current live version: ${liveState.version}`,
              ].join('\n'),
            },
          },
        ],
      };
    }
  );

  dynamicPrompt.disable();

  server.registerPrompt(
    'promptsmith',
    {
      title: 'Promptsmith',
      description: 'Builds a reusable prompt brief for a task, audience, and tone',
      argsSchema: {
        goal: z.string().describe('The task or outcome the prompt should achieve'),
        audience: z.string().optional().describe('Who the resulting prompt is meant for'),
        tone: completable(
          z.enum(['clear', 'friendly', 'formal', 'concise']).default('clear').describe('Desired tone of the prompt'),
          async (value) => {
            const tones = ['clear', 'friendly', 'formal', 'concise'] as const;
            const prefix = value?.toLowerCase() ?? '';

            return tones.filter((tone) => tone.startsWith(prefix));
          }
        ),
      },
    },
    async ({ goal, audience, tone }): Promise<GetPromptResult> => {
      const selectedAudience = audience ?? 'a technically literate user';
      const selectedTone = tone;

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                'Create a reusable prompt with the following requirements.',
                `Goal: ${goal}`,
                `Audience: ${selectedAudience}`,
                `Tone: ${selectedTone}`,
                'Return the result with three sections: system prompt, user prompt template, and variables.',
                'Keep the wording specific, concise, and ready to reuse.',
              ].join('\n'),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    'ticket-summary',
    {
      title: 'Ticket Summary',
      description: 'Creates a concise summary for a support ticket',
      argsSchema: {
        ticketText: z.string().describe('Original support ticket text'),
        audience: completable(
          z.enum(['developer', 'support', 'customer']).describe('Target audience'),
          async (value) => {
            const audiences = ['developer', 'support', 'customer'] as const;
            const prefix = value?.toLowerCase() ?? '';

            return audiences.filter((audience) => audience.startsWith(prefix));
          }
        ),
        style: completable(
          z.enum(['short', 'detailed']).default('short').describe('Summary style'),
          async (value) => {
            const styles = ['short', 'detailed'] as const;
            const prefix = value?.toLowerCase() ?? '';

            return styles.filter((style) => style.startsWith(prefix));
          }
        ),
      },
    },
    async ({ ticketText, audience, style }): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                'Summarize the following support ticket.',
                `Audience: ${audience}`,
                `Style: ${style}`,
                '',
                'Ticket:',
                ticketText,
                '',
                'Return:',
                '- short summary',
                '- main problem',
                '- next action',
              ].join('\n'),
            },
          },
        ],
      };
    }
  );

  const dynamicTool = server.registerTool(
    'dynamicEcho',
    {
      title: 'Dynamic Echo',
      description: 'Only visible when enabled via toggleDynamicCatalog',
      inputSchema: {
        text: z.string().describe('Text to echo back'),
      },
    },
    async ({ text }): Promise<CallToolResult> => {
      return {
        content: [
          {
            type: 'text',
            text: `Dynamic echo: ${text}`,
          },
        ],
      };
    }
  );

  dynamicTool.disable();

  return {
    server,
    dynamicResource,
    dynamicPrompt,
    dynamicTool,
  };
};


// Start server with HTTP transport
async function startHttpServer() {
  console.log('🚀 Starting MCP server with HTTP transport...');
  
  const app = express();

  const cors = require('cors')
  app.use(cors()); // enabling CORS for any unknown origin

  app.use(express.json());

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = getHeaderValue(req.headers['mcp-session-id']);
    console.log('Received MCP POST request:', req.body);

    try {
      if (sessionId) {
        const context = sessions.get(sessionId);

        if (!context) {
          res.status(404).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: `Session ${sessionId} not found.`,
            },
            id: null,
          });
          return;
        }

        await context.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: initialize must be called before session-bound requests.',
          },
          id: null,
        });
        return;
      }

      const serverContext = getServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initializedSessionId) => {
          sessions.set(initializedSessionId, {
            ...serverContext,
            transport,
          });
          console.log(`Session initialized: ${initializedSessionId}`);
        },
      });

      transport.onclose = () => {
        const closedSessionId = transport.sessionId;

        if (!closedSessionId) {
          return;
        }

        const context = sessions.get(closedSessionId);

        if (!context) {
          return;
        }

        stopEventTimer(context);
        sessions.delete(closedSessionId);
        void context.server.close();
        console.log(`Session closed: ${closedSessionId}`);
      };

      await serverContext.server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = getHeaderValue(req.headers['mcp-session-id']);

    if (!sessionId) {
      res.status(400).send('Missing mcp-session-id header.');
      return;
    }

    const context = sessions.get(sessionId);

    if (!context) {
      res.status(404).send(`Session ${sessionId} not found.`);
      return;
    }

    console.log(`Establishing GET SSE stream for session ${sessionId}`);
    await context.transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = getHeaderValue(req.headers['mcp-session-id']);

    if (!sessionId) {
      res.status(400).send('Missing mcp-session-id header.');
      return;
    }

    const context = sessions.get(sessionId);

    if (!context) {
      res.status(404).send(`Session ${sessionId} not found.`);
      return;
    }

    console.log(`Received DELETE request for session ${sessionId}`);
    await context.transport.handleRequest(req, res);
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
