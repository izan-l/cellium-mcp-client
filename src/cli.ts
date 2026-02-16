#!/usr/bin/env node

import { CelliumMCPClient } from './client';
import { Command } from 'commander';
import pino from 'pino';

const program = new Command();

program
  .name('cellium-mcp-client')
  .description('MCP client for connecting to remote Cellium processor server')
  .version('1.1.1')
  .option('-t, --token <token>', 'Authentication token (format: user:username:hash)')
  .option('-e, --endpoint <url>', 'Server endpoint URL', 'http://localhost:3000/mcp')
  .option('-v, --verbose', 'Enable verbose logging')
  .option('-r, --retry-attempts <num>', 'Number of retry attempts on connection failure', '3')
  .option('--retry-delay <ms>', 'Delay between retry attempts in milliseconds', '1000')
  .parse(process.argv);

const options = program.opts();

// Configure logging
const logger = pino({
  level: options.verbose ? 'debug' : 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname'
    }
  }
});

async function main() {
  try {
    // Get token from environment or command line
    const token = options.token || process.env.CELLIUM_MCP_TOKEN;
    
    if (!token) {
      logger.error('Authentication token required. Use --token option or CELLIUM_MCP_TOKEN environment variable');
      process.exit(1);
    }

    // Validate token format
    if (!token.match(/^user:[^:]+:[a-f0-9]+$/)) {
      logger.error('Invalid token format. Expected: user:username:hash');
      process.exit(1);
    }

    logger.info('Starting Cellium MCP Client');
    logger.debug({
      endpoint: options.endpoint,
      retryAttempts: parseInt(options.retryAttempts),
      retryDelay: parseInt(options.retryDelay)
    }, 'Configuration');

    const client = new CelliumMCPClient({
      token,
      endpoint: options.endpoint,
      logger,
      retryAttempts: parseInt(options.retryAttempts),
      retryDelay: parseInt(options.retryDelay)
    });

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully');
      await client.disconnect();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully');
      await client.disconnect();
      process.exit(0);
    });

    await client.connect();
    
    // Start the MCP server and keep process alive for stdio communication
    await client.serve();
    
  } catch (error) {
    logger.error({ error }, 'Fatal error');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});