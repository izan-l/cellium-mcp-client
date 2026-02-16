# Changelog

## [1.0.0] - 2024-02-16

### Added
- Initial release of @cellium/mcp-client
- MCP client for connecting to remote Cellium processor server
- CLI interface with token-based authentication
- HTTP proxy mode using existing /mcp endpoint
- Connection retry logic with configurable attempts and delays
- Comprehensive error handling and logging
- Support for tools and resources proxying
- TypeScript support with full type definitions

### Features
- **Authentication**: Token-based auth with format validation (`user:username:hash`)
- **Transport**: HTTP-based communication with Cellium server `/mcp` endpoint
- **MCP Protocol**: Full compliance with Model Context Protocol using official SDK
- **CLI Interface**: Command-line tool with configurable options
- **Error Handling**: Robust connection management with retry logic
- **Logging**: Structured logging with pino, configurable verbosity

### Configuration
- Environment variable support: `CELLIUM_MCP_TOKEN`
- Configurable endpoint (default: `https://mcp.cellium.dev/sse`)
- Retry attempts and delay configuration
- Verbose logging option

### Compatibility
- Node.js >= 18.0.0
- Compatible with MCP client tools like Cody
- Works with npx for easy installation