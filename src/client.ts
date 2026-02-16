import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Logger } from 'pino';

export interface CelliumMCPClientConfig {
  token: string;
  endpoint: string;
  logger: Logger;
  retryAttempts?: number;
  retryDelay?: number;
}

// Define schemas for MCP requests
const ToolsListSchema = z.object({
  method: z.literal('tools/list'),
  params: z.object({}).optional()
});

const ToolsCallSchema = z.object({
  method: z.literal('tools/call'),
  params: z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional()
  })
});

const ResourcesListSchema = z.object({
  method: z.literal('resources/list'),
  params: z.object({}).optional()
});

const ResourcesReadSchema = z.object({
  method: z.literal('resources/read'),
  params: z.object({
    uri: z.string()
  })
});

const PingSchema = z.object({
  method: z.literal('ping'),
  params: z.object({}).optional()
});

const InitializeSchema = z.object({
  method: z.literal('initialize'),
  params: z.object({
    protocolVersion: z.string(),
    capabilities: z.object({}).passthrough()
  })
});

const InitializedNotificationSchema = z.object({
  method: z.literal('notifications/initialized'),
  params: z.object({}).optional()
});

export class CelliumMCPClient {
  private config: Required<CelliumMCPClientConfig>;
  private localServer: McpServer;
  private isConnected = false;
  private reconnectTimer?: NodeJS.Timeout;
  private keepAliveInterval?: NodeJS.Timeout;

  constructor(config: CelliumMCPClientConfig) {
    this.config = {
      retryAttempts: 3,
      retryDelay: 1000,
      ...config
    };

    // Local server that interfaces with AI assistants via stdio
    this.localServer = new McpServer({
      name: 'cellium-mcp-client',
      version: '1.0.0'
    }, {
      capabilities: {
        tools: {},
        resources: {}
      }
    });

    this.setupServer();
  }

  private setupServer(): void {
    // Handle MCP initialization
    this.localServer.server.setRequestHandler(InitializeSchema, async (_request) => {
      this.config.logger.debug('Received initialize request');
      return {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          resources: {}
        },
        serverInfo: {
          name: 'cellium-mcp-client',
          version: '1.1.2'
        }
      };
    });

    // Override the underlying server's tool request handlers to proxy to remote
    this.localServer.server.setRequestHandler(ToolsListSchema, async () => {
      try {
        this.config.logger.debug('Proxying tools/list to remote server');
        const result = await this.makeHttpRequest('tools/list', {});
        this.config.logger.debug({ result }, 'tools/list result from remote server');
        return result;
      } catch (error) {
        this.config.logger.error({ error }, 'Error proxying tools/list');
        // Return empty tools list instead of throwing to prevent transport closure
        return { tools: [] };
      }
    });

    this.localServer.server.setRequestHandler(ToolsCallSchema, async (request) => {
      try {
        this.config.logger.debug({ toolName: request.params?.name }, 'Proxying tool call to remote server');
        const result = await this.makeHttpRequest('tools/call', request.params);
        return result;
      } catch (error) {
        this.config.logger.error({ error, toolName: request.params?.name }, 'Error proxying tool call');
        // Return error result instead of throwing
        return {
          content: [{
            type: 'text',
            text: `Error calling tool: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    });

    // Handle resources as well
    this.localServer.server.setRequestHandler(ResourcesListSchema, async () => {
      try {
        this.config.logger.debug('Proxying resources/list to remote server');
        const result = await this.makeHttpRequest('resources/list', {});
        return result;
      } catch (error) {
        this.config.logger.error({ error }, 'Error proxying resources/list');
        // Return empty resources list instead of throwing
        return { resources: [] };
      }
    });

    this.localServer.server.setRequestHandler(ResourcesReadSchema, async (request) => {
      try {
        this.config.logger.debug({ uri: request.params?.uri }, 'Proxying resources/read to remote server');
        const result = await this.makeHttpRequest('resources/read', request.params);
        return result;
      } catch (error) {
        this.config.logger.error({ error, uri: request.params?.uri }, 'Error proxying resources/read');
        // Return error result instead of throwing
        return {
          contents: [{
            uri: request.params?.uri || '',
            mimeType: 'text/plain',
            text: `Error reading resource: ${error instanceof Error ? error.message : 'Unknown error'}`
          }]
        };
      }
    });

    // Handle ping
    this.localServer.server.setRequestHandler(PingSchema, async () => {
      try {
        const result = await this.makeHttpRequest('ping', {});
        return result;
      } catch (error) {
        this.config.logger.error({ error }, 'Error proxying ping');
        // Return empty result instead of throwing
        return {};
      }
    });

    // Handle other common MCP methods
    this.localServer.server.setNotificationHandler(InitializedNotificationSchema, async () => {
      this.config.logger.debug('Received initialized notification');
      // No response needed for notifications
    });
  }

  private async makeHttpRequest(method: string, params: any): Promise<any> {
    // If not connected, try to connect first
    if (!this.isConnected) {
      try {
        await this.testConnection();
        this.isConnected = true;
        this.config.logger.info('Connected to remote Cellium server');
      } catch (error) {
        this.config.logger.error({ error }, 'Failed to connect to remote server');
        throw new Error('Cannot connect to remote Cellium server');
      }
    }

    const mcpEndpoint = this.config.endpoint.replace('/sse', '/mcp');
    
    const requestBody = {
      jsonrpc: '2.0',
      id: Math.random().toString(36).substring(2, 15),
      method,
      params
    };

    this.config.logger.debug({ method, endpoint: mcpEndpoint }, 'Making HTTP request to remote server');

    try {
      const response = await fetch(mcpEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const jsonResponse = await response.json() as any;
      
      if (jsonResponse.error) {
        throw new Error(`Remote server error: ${jsonResponse.error.message}`);
      }

      return jsonResponse.result;
      
    } catch (error) {
      this.config.logger.error({ error, method }, 'HTTP request to remote server failed');
      this.isConnected = false; // Mark as disconnected on error
      throw error;
    }
  }

  async connect(): Promise<void> {
    try {
      this.config.logger.info({ endpoint: this.config.endpoint }, 'Starting Cellium MCP Server');

      // Set up the stdio transport for local MCP server immediately
      const stdioTransport = new StdioServerTransport();
      await this.localServer.connect(stdioTransport);
      
      this.config.logger.info('MCP Server connected and ready');

      // Keep the process alive with a minimal interval
      // This ensures the process doesn't exit when stdin closes
      this.keepAliveInterval = setInterval(() => {
        // Do nothing - just keep the event loop alive
      }, 30000); // Check every 30 seconds

      this.config.logger.debug('Keep-alive interval started for persistent MCP communication');

      // Test connection to remote server in background, but don't block startup
      this.testConnectionInBackground();

    } catch (error) {
      this.config.logger.error({ error }, 'Failed to start MCP server');
      throw error;
    }
  }

  private async testConnectionInBackground(): Promise<void> {
    try {
      await this.testConnection();
      this.isConnected = true;
      this.config.logger.info('Connected to remote Cellium server');
      
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
    } catch (error) {
      this.config.logger.warn({ error }, 'Failed to connect to remote server, will retry on first request');
      this.isConnected = false;
    }
  }

  async serve(): Promise<void> {
    // The MCP server is already connected via stdio in connect()
    // Keep the process alive indefinitely for persistent MCP communication
    // This ensures compatibility with MCP clients like Copilot that expect long-running servers
    this.config.logger.debug('Server is now serving and will stay alive for persistent MCP communication');
    
    // Return a promise that never resolves to keep the process alive
    // The process will only exit via SIGINT/SIGTERM signals
    return new Promise<void>(() => {
      // Never resolve - keep process alive for MCP communication
      // Process will be terminated gracefully via signal handlers
    });
  }

  private async testConnection(): Promise<void> {
    const mcpEndpoint = this.config.endpoint.replace('/sse', '/mcp');
    
    const response = await fetch(mcpEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'test-connection',
        method: 'ping',
        params: {}
      })
    });

    if (!response.ok) {
      throw new Error(`Connection test failed: HTTP ${response.status}`);
    }

    const result = await response.json() as any;
    if (result.error) {
      throw new Error(`Connection test failed: ${result.error.message}`);
    }

    this.config.logger.debug('Connection test successful');
  }





  async disconnect(): Promise<void> {
    this.config.logger.info('Disconnecting from Cellium MCP Server');
    
    this.isConnected = false;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = undefined;
    }

    await this.localServer.close();
    this.config.logger.info('Disconnected successfully');
  }
}