#!/usr/bin/env node

import { CelliumMCPClient } from './client';
import { Command } from 'commander';
import pino from 'pino';

const program = new Command();

program
  .name('cellium-mcp-client')
  .description('MCP client for connecting to remote Cellium processor server')
  .version('1.1.3')
  .option('-t, --token <token>', 'Authentication token (format: user:username:hash)')
  .option('-e, --endpoint <url>', 'Server endpoint URL', 'http://localhost:3000/mcp')
  .option('-v, --verbose', 'Enable verbose logging')
  .option('-d, --debug', 'Enable debug mode with extensive logging')
  .option('-r, --retry-attempts <num>', 'Number of retry attempts on connection failure', '3')
  .option('--retry-delay <ms>', 'Delay between retry attempts in milliseconds', '1000')
  .parse(process.argv);

const options = program.opts();

// Configure logging with different levels based on options
let logLevel = 'info';
if (options.debug) {
  logLevel = 'debug';
} else if (options.verbose) {
  logLevel = 'debug';
}

const logger = pino({
  level: logLevel,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss.l',
      ignore: 'pid,hostname',
      messageFormat: options.debug ? '[{level}] {msg}' : '{msg}',
      destination: process.stderr
    }
  }
});

async function main() {
  try {
    // Get token from environment or command line
    const token = options.token || process.env.CELLIUM_MCP_TOKEN;
    
    if (!token) {
      logger.error('Authentication token required. Use --token option or CELLIUM_MCP_TOKEN environment variable');
      logger.info('Token format should be: user:username:hash');
      process.exit(1);
    }

    // Validate token format
    if (!token.match(/^user:[^:]+:[a-f0-9]+$/)) {
      logger.error('Invalid token format. Expected: user:username:hash');
      logger.info('Example: user:myusername:abc123def456...');
      process.exit(1);
    }

    logger.info({
      version: '1.1.3',
      debugMode: !!options.debug,
      verboseMode: !!options.verbose
    }, 'Starting Cellium MCP Client');
    
    logger.debug({
      endpoint: options.endpoint,
      retryAttempts: parseInt(options.retryAttempts),
      retryDelay: parseInt(options.retryDelay),
      tokenPreview: `${token.split(':')[0]}:${token.split(':')[1]}:${token.split(':')[2]?.substring(0, 8)}...`
    }, 'Configuration loaded');

    const client = new CelliumMCPClient({
      token,
      endpoint: options.endpoint,
      logger,
      retryAttempts: parseInt(options.retryAttempts),
      retryDelay: parseInt(options.retryDelay),
      debugMode: !!options.debug
    });

    // Enhanced error handling for unhandled rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error({
        reason,
        promise
      }, 'Unhandled promise rejection');
    });

    process.on('uncaughtException', (error) => {
      logger.fatal({ error }, 'Uncaught exception');
      process.exit(1);
    });

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully');
      try {
        await client.disconnect();
        process.exit(0);
      } catch (error) {
        logger.error({ error }, 'Error during shutdown');
        process.exit(1);
      }
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully');
      try {
        await client.disconnect();
        process.exit(0);
      } catch (error) {
        logger.error({ error }, 'Error during shutdown');
        process.exit(1);
      }
    });

    logger.debug('Connecting to MCP transport...');
    await client.connect();
    
    logger.info('MCP Client ready - starting server...');
    // Start the MCP server and keep process alive for stdio communication
    await client.serve();
    
  } catch (error) {
    logger.fatal({
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : error
    }, 'Fatal error during startup');
    process.exit(1);
  }
}

main().catch((error) => {
  // Create a minimal stderr logger for critical startup errors
  const stderrLogger = pino({ transport: { target: 'pino-pretty', options: { destination: process.stderr } } });
  stderrLogger.fatal({ error }, 'Unhandled startup error');
  process.exit(1);
});