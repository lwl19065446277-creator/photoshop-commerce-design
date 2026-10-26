import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudioMcp } from './mcp-server.js';
const index = process.argv.indexOf('--workspace');
const workspace = index >= 0 ? resolve(process.argv[index + 1]) : resolve(fileURLToPath(new URL('../../', import.meta.url)));
// stdout is exclusively MCP JSON-RPC. Diagnostics belong on stderr.
await createStudioMcp(workspace).connect(new StdioServerTransport());
