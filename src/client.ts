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

export class CelliumMCPClient {
  private config: Required<CelliumMCPClientConfig>;
  private localServer: McpServer;
  private isConnected = false;
  private reconnectTimer?: NodeJS.Timeout;
  private currentRetryCount = 0;

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
    // Register a dynamic tool handler that forwards all tool calls to remote server
    this.localServer.registerTool('cellium-proxy-tool', {
      description: 'Proxy tool for Cellium server - handles all tool calls dynamically'
    }, async (_args) => {
      // This won't actually be called since we override the request handlers directly
      return { content: [{ type: 'text', text: 'Proxy tool' }] };
    });

    // Override the underlying server's tool request handlers to proxy to remote
    this.localServer.server.setRequestHandler(ToolsListSchema, async () => {
      this.config.logger.debug('Proxying tools/list to remote server');
      if (!this.isConnected) {
        throw new Error('Not connected to remote server');
      }
      
      const result = await this.makeHttpRequest('tools/list', {});
      return result;
    });

    this.localServer.server.setRequestHandler(ToolsCallSchema, async (request) => {
      this.config.logger.debug({ toolName: request.params?.name }, 'Proxying tool call to remote server');
      if (!this.isConnected) {
        throw new Error('Not connected to remote server');
      }
      
      const result = await this.makeHttpRequest('tools/call', request.params);
      return result;
    });

    // Handle resources as well
    this.localServer.server.setRequestHandler(ResourcesListSchema, async () => {
      this.config.logger.debug('Proxying resources/list to remote server');
      if (!this.isConnected) {
        throw new Error('Not connected to remote server');
      }
      
      const result = await this.makeHttpRequest('resources/list', {});
      return result;
    });

    this.localServer.server.setRequestHandler(ResourcesReadSchema, async (request) => {
      this.config.logger.debug({ uri: request.params?.uri }, 'Proxying resources/read to remote server');
      if (!this.isConnected) {
        throw new Error('Not connected to remote server');
      }
      
      const result = await this.makeHttpRequest('resources/read', request.params);
      return result;
    });

    // Handle ping
    this.localServer.server.setRequestHandler(PingSchema, async () => {
      if (!this.isConnected) {
        throw new Error('Not connected to remote server');
      }
      const result = await this.makeHttpRequest('ping', {});
      return result;
    });
  }

  private async makeHttpRequest(method: string, params: any): Promise<any> {
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
      throw error;
    }
  }

  async connect(): Promise<void> {
    try {
      this.config.logger.info({ endpoint: this.config.endpoint }, 'Connecting to Cellium MCP Server');

      // Test connection with a ping
      await this.testConnection();
      
      this.isConnected = true;
      this.currentRetryCount = 0;
      
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }

      this.config.logger.info('Connected to remote Cellium server');

      // Set up the stdio transport for local MCP server
      const stdioTransport = new StdioServerTransport();
      await this.localServer.connect(stdioTransport);
      
      this.config.logger.info('MCP Client connected and ready');

    } catch (error) {
      this.config.logger.error({ error }, 'Failed to connect');
      this.isConnected = false;
      this.handleConnectionError();
      throw error;
    }
  }

  async serve(): Promise<void> {
    // The MCP server is already connected via stdio in connect()
    // This method just keeps the process alive indefinitely
    return new Promise(() => {
      // Never resolve - keep process alive for MCP communication
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

  private handleConnectionError(): void {
    if (this.currentRetryCount < this.config.retryAttempts) {
      this.currentRetryCount++;
      this.config.logger.warn(`Connection failed, retrying in ${this.config.retryDelay}ms (attempt ${this.currentRetryCount}/${this.config.retryAttempts})`);
      
      this.reconnectTimer = setTimeout(() => {
        this.reconnect();
      }, this.config.retryDelay);
    } else {
      this.config.logger.error('Max retry attempts reached, giving up');
      process.exit(1);
    }
  }

  private async reconnect(): Promise<void> {
    try {
      await this.connect();
    } catch (error) {
      this.config.logger.error({ error }, 'Reconnection failed');
      this.handleConnectionError();
    }
  }

  async disconnect(): Promise<void> {
    this.config.logger.info('Disconnecting from Cellium MCP Server');
    
    this.isConnected = false;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    await this.localServer.close();
    this.config.logger.info('Disconnected successfully');
  }
}