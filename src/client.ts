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
  debugMode?: boolean;
}

interface TransportState {
  connected: boolean;
  lastActivity: number;
  requestCount: number;
  errorCount: number;
}

interface RequestTiming {
  start: number;
  method: string;
  id: string;
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
  private transport?: StdioServerTransport;
  private isConnected = false;
  private reconnectTimer?: NodeJS.Timeout;
  private keepAliveInterval?: NodeJS.Timeout;
  private transportState: TransportState = {
    connected: false,
    lastActivity: 0,
    requestCount: 0,
    errorCount: 0
  };
  private activeRequests: Map<string, RequestTiming> = new Map();
  private mcpProtocolVersion = '2024-11-05';

  constructor(config: CelliumMCPClientConfig) {
    this.config = {
      retryAttempts: 3,
      retryDelay: 1000,
      debugMode: false,
      ...config
    };

    this.logDebug('Initializing CelliumMCPClient', {
      endpoint: this.config.endpoint,
      debugMode: this.config.debugMode
    });

    // Local server that interfaces with AI assistants via stdio
    this.localServer = new McpServer({
      name: 'cellium-mcp-client',
      version: '1.1.3'
    }, {
      capabilities: {
        tools: {},
        resources: {}
      }
    });

    this.setupServer();
    this.setupTransportMonitoring();
  }

  private logDebug(message: string, data?: any): void {
    if (this.config.debugMode) {
      this.config.logger.debug({
        timestamp: new Date().toISOString(),
        transportState: this.transportState,
        activeRequests: Array.from(this.activeRequests.entries()),
        ...data
      }, `[CELLIUM-MCP-DEBUG] ${message}`);
    }
  }

  private logRequest(method: string, id: string, params?: any): void {
    this.transportState.requestCount++;
    this.transportState.lastActivity = Date.now();
    
    const timing: RequestTiming = {
      start: Date.now(),
      method,
      id
    };
    this.activeRequests.set(id, timing);

    this.config.logger.info({
      requestId: id,
      method,
      params,
      requestCount: this.transportState.requestCount,
      activeRequestCount: this.activeRequests.size
    }, `[MCP-REQUEST] Received ${method}`);

    this.logDebug(`Request received: ${method}`, { id, params });
  }

  private logResponse(method: string, id: string, success: boolean, result?: any, error?: any): void {
    const timing = this.activeRequests.get(id);
    const duration = timing ? Date.now() - timing.start : 0;
    
    this.activeRequests.delete(id);
    this.transportState.lastActivity = Date.now();
    
    if (!success) {
      this.transportState.errorCount++;
    }

    this.config.logger.info({
      requestId: id,
      method,
      success,
      duration,
      result: success ? result : undefined,
      error: !success ? error : undefined,
      activeRequestCount: this.activeRequests.size,
      totalErrors: this.transportState.errorCount
    }, `[MCP-RESPONSE] Completed ${method} in ${duration}ms`);

    this.logDebug(`Response sent: ${method}`, {
      id,
      success,
      duration,
      result: success ? result : undefined,
      error: !success ? error : undefined
    });
  }

  private setupTransportMonitoring(): void {
    // Monitor transport health every 10 seconds
    setInterval(() => {
      const now = Date.now();
      const timeSinceLastActivity = now - this.transportState.lastActivity;
      
      this.logDebug('Transport health check', {
        timeSinceLastActivity,
        activeRequestsCount: this.activeRequests.size,
        errorRate: this.transportState.errorCount / Math.max(this.transportState.requestCount, 1)
      });

      // Log warning if no activity for 2 minutes
      if (timeSinceLastActivity > 120000 && this.transportState.requestCount > 0) {
        this.config.logger.warn({
          timeSinceLastActivity,
          lastActivity: new Date(this.transportState.lastActivity).toISOString()
        }, 'Transport appears idle for extended period');
      }

      // Log active requests that are taking too long (>30s)
      for (const [id, timing] of this.activeRequests.entries()) {
        const requestDuration = now - timing.start;
        if (requestDuration > 30000) {
          this.config.logger.warn({
            requestId: id,
            method: timing.method,
            duration: requestDuration
          }, 'Long-running request detected');
        }
      }
    }, 10000);
  }
  private setupServer(): void {
    this.logDebug('Setting up MCP server handlers');

    // Add error boundary wrapper for all handlers
    const withErrorBoundary = <T>(
      handler: (request: T) => Promise<any>,
      methodName: string
    ) => {
      return async (request: T) => {
        const requestId = Math.random().toString(36).substring(2, 15);
        
        try {
          this.logRequest(methodName, requestId, request);
          const result = await handler(request);
          this.logResponse(methodName, requestId, true, result);
          return result;
        } catch (error) {
          this.logResponse(methodName, requestId, false, undefined, error);
          
          // Log the full error for debugging
          this.config.logger.error({
            error: error instanceof Error ? {
              name: error.name,
              message: error.message,
              stack: error.stack
            } : error,
            methodName,
            requestId,
            request
          }, `Error in ${methodName} handler`);
          
          // Don't re-throw - return safe fallback instead to prevent transport closure
          return this.getSafeErrorResponse(methodName, error);
        }
      };
    };

    // Handle MCP initialization with protocol version checking
    this.localServer.server.setRequestHandler(InitializeSchema, withErrorBoundary(async (request) => {
      this.logDebug('Processing initialize request', request);
      
      const clientProtocolVersion = request.params?.protocolVersion;
      if (clientProtocolVersion && clientProtocolVersion !== this.mcpProtocolVersion) {
        this.config.logger.warn({
          clientVersion: clientProtocolVersion,
          serverVersion: this.mcpProtocolVersion
        }, 'Protocol version mismatch detected');
      }

      const initResponse = {
        protocolVersion: this.mcpProtocolVersion,
        capabilities: {
          tools: {},
          resources: {}
        },
        serverInfo: {
          name: 'cellium-mcp-client',
          version: '1.1.3'
        }
      };

      this.transportState.connected = true;
      this.transportState.lastActivity = Date.now();
      
      this.logDebug('Initialize response prepared', initResponse);
      return initResponse;
    }, 'initialize'));

    // Override the underlying server's tool request handlers to proxy to remote
    this.localServer.server.setRequestHandler(ToolsListSchema, withErrorBoundary(async (request) => {
      this.logDebug('Processing tools/list request', request);
      
      // Add artificial delay to test timing issues
      if (this.config.debugMode) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      const result = await this.makeHttpRequest('tools/list', {});
      this.logDebug('tools/list completed successfully', { toolCount: result.tools?.length || 0 });
      return result;
    }, 'tools/list'));

    this.localServer.server.setRequestHandler(ToolsCallSchema, withErrorBoundary(async (request) => {
      this.logDebug('Processing tools/call request', {
        toolName: request.params?.name,
        hasArguments: !!request.params?.arguments
      });
      
      const result = await this.makeHttpRequest('tools/call', request.params);
      this.logDebug('tools/call completed successfully', {
        toolName: request.params?.name,
        resultType: typeof result
      });
      return result;
    }, 'tools/call'));

    // Handle resources as well
    this.localServer.server.setRequestHandler(ResourcesListSchema, withErrorBoundary(async (request) => {
      this.logDebug('Processing resources/list request', request);
      const result = await this.makeHttpRequest('resources/list', {});
      this.logDebug('resources/list completed successfully', { resourceCount: result.resources?.length || 0 });
      return result;
    }, 'resources/list'));

    this.localServer.server.setRequestHandler(ResourcesReadSchema, withErrorBoundary(async (request) => {
      this.logDebug('Processing resources/read request', { uri: request.params?.uri });
      const result = await this.makeHttpRequest('resources/read', request.params);
      this.logDebug('resources/read completed successfully', { uri: request.params?.uri });
      return result;
    }, 'resources/read'));

    // Handle ping
    this.localServer.server.setRequestHandler(PingSchema, withErrorBoundary(async (request) => {
      this.logDebug('Processing ping request', request);
      const result = await this.makeHttpRequest('ping', {});
      this.logDebug('ping completed successfully');
      return result;
    }, 'ping'));

    // Handle other common MCP methods
    this.localServer.server.setNotificationHandler(InitializedNotificationSchema, async (notification) => {
      const notificationId = Math.random().toString(36).substring(2, 15);
      this.logRequest('notifications/initialized', notificationId, notification);
      this.logDebug('Received initialized notification', notification);
      
      this.transportState.connected = true;
      this.transportState.lastActivity = Date.now();
      
      this.logResponse('notifications/initialized', notificationId, true);
      // No response needed for notifications
    });

    this.logDebug('MCP server handlers setup completed');
  }

  private getSafeErrorResponse(methodName: string, error: unknown): any {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    switch (methodName) {
      case 'tools/list':
        return { tools: [] };
      case 'resources/list':
        return { resources: [] };
      case 'tools/call':
        return {
          content: [{
            type: 'text',
            text: `Error calling tool: ${errorMessage}`
          }],
          isError: true
        };
      case 'resources/read':
        return {
          contents: [{
            uri: '',
            mimeType: 'text/plain',
            text: `Error reading resource: ${errorMessage}`
          }]
        };
      case 'ping':
        return {};
      default:
        return { error: errorMessage };
    }
  }

  private async makeHttpRequest(method: string, params: any): Promise<any> {
    const requestId = Math.random().toString(36).substring(2, 15);
    const startTime = Date.now();
    
    this.logDebug(`Starting HTTP request for ${method}`, {
      requestId,
      params,
      isConnected: this.isConnected,
      endpoint: this.config.endpoint
    });

    // If not connected, try to connect first
    if (!this.isConnected) {
      try {
        this.logDebug('Not connected, attempting connection test');
        await this.testConnection();
        this.isConnected = true;
        this.config.logger.info('Connected to remote Cellium server');
      } catch (error) {
        this.config.logger.error({
          error: error instanceof Error ? {
            name: error.name,
            message: error.message,
            stack: error.stack
          } : error
        }, 'Failed to connect to remote server');
        throw new Error('Cannot connect to remote Cellium server');
      }
    }

    const mcpEndpoint = this.config.endpoint.replace('/sse', '/mcp');
    
    const requestBody = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params
    };

    this.logDebug(`Making HTTP request to ${mcpEndpoint}`, {
      requestId,
      method,
      bodySize: JSON.stringify(requestBody).length
    });

    let response: Response;
    let responseText: string;
    
    try {
      response = await fetch(mcpEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'cellium-mcp-client/1.1.3'
        },
        body: JSON.stringify(requestBody)
      });

      responseText = await response.text();
      const duration = Date.now() - startTime;
      
      this.logDebug('HTTP response received', {
        requestId,
        method,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        responseSize: responseText.length,
        duration
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      let jsonResponse: any;
      try {
        jsonResponse = JSON.parse(responseText);
      } catch (parseError) {
        this.config.logger.error({
          requestId,
          method,
          responseText: responseText.substring(0, 500),
          parseError: parseError instanceof Error ? parseError.message : parseError
        }, 'Failed to parse JSON response');
        throw new Error('Invalid JSON response from server');
      }
      
      this.logDebug('HTTP response parsed', {
        requestId,
        method,
        hasResult: !!jsonResponse.result,
        hasError: !!jsonResponse.error,
        jsonrpcId: jsonResponse.id
      });
      
      if (jsonResponse.error) {
        this.config.logger.error({
          requestId,
          method,
          serverError: jsonResponse.error
        }, 'Remote server returned error');
        throw new Error(`Remote server error: ${jsonResponse.error.message}`);
      }

      return jsonResponse.result;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      this.config.logger.error({
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack
        } : error,
        requestId,
        method,
        duration,
        endpoint: mcpEndpoint
      }, 'HTTP request to remote server failed');
      
      this.isConnected = false; // Mark as disconnected on error
      throw error;
    }
  }

  async connect(): Promise<void> {
    try {
      this.config.logger.info({
        endpoint: this.config.endpoint,
        debugMode: this.config.debugMode,
        protocolVersion: this.mcpProtocolVersion
      }, 'Starting Cellium MCP Server');

      this.logDebug('Initializing stdio transport');

      // Set up the stdio transport for local MCP server immediately
      this.transport = new StdioServerTransport();
      
      // Add transport event monitoring
      this.setupTransportEventListeners(this.transport);
      
      await this.localServer.connect(this.transport);
      
      this.transportState.connected = true;
      this.transportState.lastActivity = Date.now();
      
      this.config.logger.info('MCP Server connected and ready');
      this.logDebug('Transport connected successfully', {
        transportType: 'stdio',
        serverName: 'cellium-mcp-client',
        serverVersion: '1.1.3'
      });

      // Keep the process alive with a minimal interval
      // This ensures the process doesn't exit when stdin closes
      this.keepAliveInterval = setInterval(() => {
        this.logDebug('Keep-alive tick', {
          uptime: Date.now() - this.transportState.lastActivity,
          activeRequests: this.activeRequests.size
        });
      }, 30000); // Check every 30 seconds

      this.config.logger.debug('Keep-alive interval started for persistent MCP communication');

      // Test connection to remote server in background, but don't block startup
      this.testConnectionInBackground();

    } catch (error) {
      this.config.logger.error({
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack
        } : error
      }, 'Failed to start MCP server');
      
      this.transportState.connected = false;
      throw error;
    }
  }

  private setupTransportEventListeners(transport: StdioServerTransport): void {
    this.logDebug('Setting up transport event listeners');
    
    // Monitor transport events if available
    try {
      // Try to access transport events (may not be available in all SDK versions)
      const transportAny = transport as any;
      
      if (transportAny.on && typeof transportAny.on === 'function') {
        transportAny.on('close', () => {
          this.config.logger.warn('Transport close event detected');
          this.transportState.connected = false;
        });
        
        transportAny.on('error', (error: Error) => {
          this.config.logger.error({ error }, 'Transport error event');
          this.transportState.errorCount++;
        });
        
        transportAny.on('connect', () => {
          this.config.logger.info('Transport connect event');
          this.transportState.connected = true;
        });
        
        this.logDebug('Transport event listeners attached');
      } else {
        this.logDebug('Transport does not support event listeners');
      }
    } catch (error) {
      this.logDebug('Could not attach transport event listeners', { error });
    }
  }

  private async testConnectionInBackground(): Promise<void> {
    try {
      this.logDebug('Testing connection to remote server in background');
      await this.testConnection();
      this.isConnected = true;
      this.config.logger.info('Connected to remote Cellium server');
      
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
    } catch (error) {
      this.config.logger.warn({
        error: error instanceof Error ? error.message : error
      }, 'Failed to connect to remote server, will retry on first request');
      this.isConnected = false;
    }
  }

  async serve(): Promise<void> {
    // The MCP server is already connected via stdio in connect()
    // Keep the process alive indefinitely for persistent MCP communication
    // This ensures compatibility with MCP clients like Copilot that expect long-running servers
    this.config.logger.debug({
      transportConnected: this.transportState.connected,
      serverName: 'cellium-mcp-client'
    }, 'Server is now serving and will stay alive for persistent MCP communication');
    
    this.logDebug('Entering serve mode - process will stay alive');
    
    // Set up graceful shutdown handlers
    process.on('SIGINT', async () => {
      this.config.logger.info('Received SIGINT, shutting down gracefully...');
      await this.disconnect();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      this.config.logger.info('Received SIGTERM, shutting down gracefully...');
      await this.disconnect();
      process.exit(0);
    });
    
    // Return a promise that never resolves to keep the process alive
    // The process will only exit via SIGINT/SIGTERM signals
    return new Promise<void>(() => {
      // Never resolve - keep process alive for MCP communication
      // Process will be terminated gracefully via signal handlers
    });
  }

  private async testConnection(): Promise<void> {
    const startTime = Date.now();
    const mcpEndpoint = this.config.endpoint.replace('/sse', '/mcp');
    
    this.logDebug('Testing connection', {
      endpoint: mcpEndpoint,
      hasToken: !!this.config.token
    });
    
    const response = await fetch(mcpEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'cellium-mcp-client/1.1.3'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'connection-test',
        method: 'ping',
        params: {}
      })
    });

    const duration = Date.now() - startTime;
    
    this.logDebug('Connection test response', {
      status: response.status,
      statusText: response.statusText,
      duration
    });

    if (!response.ok) {
      throw new Error(`Connection test failed: HTTP ${response.status}`);
    }

    const result = await response.json() as any;
    if (result.error) {
      throw new Error(`Connection test failed: ${result.error.message}`);
    }

    this.config.logger.debug({ duration }, 'Connection test successful');
  }





  async disconnect(): Promise<void> {
    this.config.logger.info('Disconnecting from Cellium MCP Server');
    
    this.logDebug('Starting disconnect process', {
      activeRequestCount: this.activeRequests.size,
      transportConnected: this.transportState.connected
    });
    
    this.isConnected = false;
    this.transportState.connected = false;
    
    // Cancel any active requests
    if (this.activeRequests.size > 0) {
      this.config.logger.warn({
        activeRequestCount: this.activeRequests.size
      }, 'Cancelling active requests during disconnect');
      
      for (const [id, timing] of this.activeRequests.entries()) {
        this.logResponse(timing.method, id, false, undefined, 'Cancelled due to disconnect');
      }
      this.activeRequests.clear();
    }
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = undefined;
    }

    try {
      await this.localServer.close();
      this.logDebug('Local MCP server closed successfully');
    } catch (error) {
      this.config.logger.error({
        error: error instanceof Error ? error.message : error
      }, 'Error closing local MCP server');
    }
    
    this.config.logger.info({
      totalRequests: this.transportState.requestCount,
      totalErrors: this.transportState.errorCount,
      uptime: Date.now() - this.transportState.lastActivity
    }, 'Disconnected successfully');
  }
}