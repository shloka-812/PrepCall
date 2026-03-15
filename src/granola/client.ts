/**
 * Per-user Granola MCP Client.
 * Each authenticated user gets their own MCP connection using their encrypted OAuth tokens.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Anthropic from '@anthropic-ai/sdk';
import { getGranolaTokens, setGranolaTokens } from '../auth/store.js';
import { refreshAccessToken } from '../auth/oauth.js';

const GRANOLA_MCP_URL = process.env.GRANOLA_MCP_URL || 'https://mcp.granola.ai/mcp';

const userClients = new Map<string, { client: Client; tools: Anthropic.Tool[]; connectedAt: number }>();
const MAX_CONNECTION_AGE_MS = 30 * 60 * 1000;

async function getUserMCPClient(
  phoneNumber: string,
  baseUrl: string,
): Promise<{ client: Client; tools: Anthropic.Tool[] } | null> {
  const tokens = await getGranolaTokens(phoneNumber);
  if (!tokens?.accessToken) return null;

  const cached = userClients.get(phoneNumber);
  if (cached && Date.now() - cached.connectedAt < MAX_CONNECTION_AGE_MS) {
    return { client: cached.client, tools: cached.tools };
  }

  if (cached) {
    try { await cached.client.close(); } catch {}
    userClients.delete(phoneNumber);
  }

  try {
    console.log(`[granola] Connecting MCP for ${phoneNumber}...`);

    const client = new Client({ name: 'granola-agent', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(GRANOLA_MCP_URL),
      { requestInit: { headers: { Authorization: `Bearer ${tokens.accessToken}` } } },
    );

    await client.connect(transport);

    const toolsResult = await client.listTools();
    const tools: Anthropic.Tool[] = toolsResult.tools.map((tool) => ({
      name: `granola_${tool.name}`,
      description: tool.description || `Granola MCP tool: ${tool.name}`,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));

    console.log(`[granola] Connected for ${phoneNumber}: ${tools.length} tools`);
    userClients.set(phoneNumber, { client, tools, connectedAt: Date.now() });
    return { client, tools };
  } catch (error: unknown) {
    const statusCode = (error as { code?: number })?.code;
    const message = error instanceof Error ? error.message : String(error);

    if (statusCode === 401 || message.includes('Unauthorized')) {
      console.log(`[granola] Token expired for ${phoneNumber}, refreshing...`);
      if (tokens.refreshToken) {
        const refreshed = await refreshAccessToken(phoneNumber, baseUrl, tokens.refreshToken);
        if (refreshed) return getUserMCPClient(phoneNumber, baseUrl);
      }
    }

    console.error(`[granola] MCP connection failed for ${phoneNumber}:`, error);
    return null;
  }
}

export async function getGranolaToolsForUser(
  phoneNumber: string,
  baseUrl: string,
): Promise<Anthropic.Tool[]> {
  const result = await getUserMCPClient(phoneNumber, baseUrl);
  return result?.tools || [];
}

export async function callGranolaToolForUser(
  phoneNumber: string,
  baseUrl: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<string> {
  const result = await getUserMCPClient(phoneNumber, baseUrl);
  if (!result) return 'Error: Not connected to Granola. Please link your account first.';

  const mcpToolName = toolName.replace(/^granola_/, '');

  try {
    console.log(`[granola] ${phoneNumber} calling ${mcpToolName}:`, JSON.stringify(toolInput).substring(0, 200));
    const callResult = await result.client.callTool({ name: mcpToolName, arguments: toolInput });
    const textParts = (callResult.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text' && c.text).map((c) => c.text!);
    const output = textParts.join('\n');
    console.log(`[granola] ${mcpToolName} returned ${output.length} chars`);
    return output || 'No results found.';
  } catch (error) {
    console.error(`[granola] ${mcpToolName} failed for ${phoneNumber}:`, error);
    return `Error querying Granola: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export function isGranolaTool(toolName: string): boolean {
  return toolName.startsWith('granola_');
}

export async function disconnectUser(phoneNumber: string): Promise<void> {
  const cached = userClients.get(phoneNumber);
  if (cached) {
    try { await cached.client.close(); } catch {}
    userClients.delete(phoneNumber);
  }
}
