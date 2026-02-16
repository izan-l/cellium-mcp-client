# @cellium/mcp-client

A Model Context Protocol (MCP) server that proxies requests to remote Cellium processor servers.

## Features

- **HTTP Proxy**: Proxies MCP requests to remote Cellium servers via HTTP
- **Authentication**: Token-based authentication with format `user:username:hash`
- **Robust Connection Management**: Automatic reconnection with configurable retry logic
- **MCP Protocol Compliance**: Uses official `@modelcontextprotocol/sdk`
- **CLI Interface**: Ready-to-use command-line interface
- **TypeScript Support**: Full TypeScript types and definitions

## Installation

```bash
npm install -g @cellium/mcp-client
```

Or use directly with npx:

```bash
npx @cellium/mcp-client
```

## Usage

### Command Line Interface

```bash
# Using environment variable for token
export CELLIUM_MCP_TOKEN="user:your-username:your-hash"
cellium-mcp-client

# Using command line option
cellium-mcp-client --token "user:your-username:your-hash"

# With custom endpoint and verbose logging
cellium-mcp-client \
  --token "user:your-username:your-hash" \
  --endpoint "https://mcp.cellium.dev/mcp" \
  --verbose \
  --retry-attempts 5 \
  --retry-delay 2000
```

### Configuration with Cody/Other MCP Clients

Add to your MCP client configuration:

```toml
[mcp_servers.cellium]
command = "npx"
args = ["-y", "@cellium/mcp-client"]
env = { CELLIUM_MCP_TOKEN = "user:your-username:your-hash" }
enabled = true
```

### Programmatic Usage

```typescript
import { CelliumMCPClient } from '@cellium/mcp-client';
import pino from 'pino';

const logger = pino();

const client = new CelliumMCPClient({
  token: 'user:your-username:your-hash',
  endpoint: 'https://mcp.cellium.dev/mcp',
  logger,
  retryAttempts: 3,
  retryDelay: 1000
});

await client.connect();

// The client will now proxy MCP requests to the remote server
// Handle shutdown gracefully
process.on('SIGINT', async () => {
  await client.disconnect();
  process.exit(0);
});
```

## Configuration Options

| Option | Environment Variable | Description | Default |
|--------|---------------------|-------------|---------|
| `--token` | `CELLIUM_MCP_TOKEN` | Authentication token (required) | - |
| `--endpoint` | - | Server endpoint URL | `https://mcp.cellium.dev/mcp` |
| `--verbose` | - | Enable verbose logging | `false` |
| `--retry-attempts` | - | Number of retry attempts | `3` |
| `--retry-delay` | - | Delay between retries (ms) | `1000` |

## Authentication Token Format

The authentication token must follow the format: `user:username:hash`

Where:
- `user`: Literal string "user"
- `username`: Your Cellium username
- `hash`: Authentication hash provided by Cellium

Example: `user:john-doe:a1b2c3d4e5f6...`

## Architecture

```
┌─────────────────┐   stdio    ┌─────────────────┐   HTTPS    ┌─────────────────┐
│                 │◄──────────►│                 │◄──────────►│                 │
│  Code Editor /  │    MCP     │ cellium-mcp-    │    HTTP    │ Cellium Server  │
│  AI Assistant   │  Protocol  │ client (Proxy)  │   Requests │   (Remote)      │
│   (Cody, etc.)  │            │                 │            │                 │
└─────────────────┘            └─────────────────┘            └─────────────────┘
```

The client acts as an **MCP server proxy** between local MCP clients (like Cody) and the remote Cellium processor server, handling:
- **MCP Protocol**: Full stdio-based MCP server implementation
- **Authentication**: Token-based authentication with remote server
- **Request Proxying**: Converts MCP requests to HTTP requests to remote server
- **Error Handling**: Graceful handling of connection failures
- **Connection Management**: Automatic retry and reconnection logic

## Development

```bash
# Clone and install dependencies
git clone <repo-url>
cd cellium-mcp-client
npm install

# Build
npm run build

# Run in development mode
npm run dev

# Test locally
./dist/cli.js --help
```

## Troubleshooting

### Connection Issues

1. **Invalid token format**: Ensure your token follows the `user:username:hash` format
2. **Network connectivity**: Check if `https://mcp.cellium.dev/mcp` is accessible
3. **Authentication failed**: Verify your token is valid and not expired

### Verbose Logging

Use `--verbose` flag to enable detailed logging for debugging:

```bash
cellium-mcp-client --verbose --token "your-token"
```

### Common Error Messages

- `Authentication token required`: Set `CELLIUM_MCP_TOKEN` or use `--token`
- `Invalid token format`: Check token follows `user:username:hash` pattern  
- `Not connected to remote server`: Connection to SSE endpoint failed
- `Request timeout`: Remote server didn't respond within 30 seconds

## License

MIT

## Support

For issues and questions, please open an issue on the GitHub repository.

