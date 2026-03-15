/**
 * Quick one-shot test — query Granola via CLI using local tokens.
 * Usage: npm run test:granola -- "what meetings did I have this week?"
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformation, OAuthTokens, OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const anthropic = new Anthropic();
const GRANOLA_MCP_URL = process.env.GRANOLA_MCP_URL || 'https://mcp.granola.ai/mcp';
const TOKENS_FILE = join(process.cwd(), '.granola-tokens.json');

class LocalTokenProvider implements OAuthClientProvider {
  private stored: { tokens?: OAuthTokens; clientInfo?: OAuthClientInformation };
  constructor() { this.stored = existsSync(TOKENS_FILE) ? JSON.parse(readFileSync(TOKENS_FILE, 'utf-8')) : {}; }
  get redirectUrl() { return 'http://localhost:8090/callback'; }
  get clientMetadata(): OAuthClientMetadata { return { client_name: 'Granola Agent Test', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_post' }; }
  clientInformation() { return this.stored.clientInfo; }
  saveClientInformation(info: OAuthClientInformation) { this.stored.clientInfo = info; }
  tokens() { return this.stored.tokens; }
  saveTokens(tokens: OAuthTokens) { this.stored.tokens = tokens; writeFileSync(TOKENS_FILE, JSON.stringify(this.stored, null, 2)); }
  redirectToAuthorization() { console.error('Tokens expired. Run: npm run auth'); }
  saveCodeVerifier() {}
  codeVerifier() { return ''; }
}

async function main() {
  const query = process.argv[2] || 'list my recent meetings';

  if (!existsSync(TOKENS_FILE)) {
    console.error('\nNo tokens found. Run: npm run auth\n');
    process.exit(1);
  }

  console.log(`\n--- Connecting to Granola MCP ---\n`);
  const mcpClient = new Client({ name: 'granola-agent-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(GRANOLA_MCP_URL), { authProvider: new LocalTokenProvider() });
  await mcpClient.connect(transport);

  const toolsResult = await mcpClient.listTools();
  const tools: Anthropic.Tool[] = toolsResult.tools.map(t => ({
    name: `granola_${t.name}`,
    description: t.description || t.name,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
  console.log(`Connected! ${tools.length} tools.\n--- Query: "${query}" ---\n`);

  let messages: Anthropic.MessageParam[] = [{ role: 'user', content: query }];
  let iterations = 0;

  while (iterations++ < 10) {
    const response = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: 'You are a meeting assistant. Use Granola tools to answer. Be concise.', tools, messages });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === 'text') console.log(`Claude: ${block.text}`);
      else if (block.type === 'tool_use' && block.name.startsWith('granola_')) {
        const mcpName = block.name.replace('granola_', '');
        console.log(`\n[Tool] ${mcpName}(${JSON.stringify(block.input)})`);
        const result = await mcpClient.callTool({ name: mcpName, arguments: block.input as Record<string, unknown> });
        const text = (result.content as Array<{ type: string; text?: string }>).filter(c => c.type === 'text').map(c => c.text!).join('\n');
        console.log(`[Result] ${text.substring(0, 300)}${text.length > 300 ? '...' : ''}\n`);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: text || 'No results.' });
      }
    }

    if (response.stop_reason === 'end_turn' || toolResults.length === 0) break;
    messages = [...messages, { role: 'assistant', content: response.content }, { role: 'user', content: toolResults }];
  }
  console.log('\n--- Done ---\n');
}

main().catch(console.error);
