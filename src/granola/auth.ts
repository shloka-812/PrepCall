/**
 * Granola MCP OAuth Authentication
 *
 * Handles the browser-based OAuth flow:
 * 1. Starts a local callback server on port 8090
 * 2. Opens your browser to Granola's auth page
 * 3. Receives the callback with an auth code
 * 4. Exchanges the code for access/refresh tokens
 * 5. Persists tokens to .granola-tokens.json
 *
 * Usage: npx tsx src/granola/auth.ts
 */
import 'dotenv/config';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformation, OAuthTokens, OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';

const GRANOLA_MCP_URL = process.env.GRANOLA_MCP_URL || 'https://mcp.granola.ai/mcp';
const CALLBACK_PORT = 8090;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;
const TOKENS_FILE = join(process.cwd(), '.granola-tokens.json');

interface StoredAuth {
  tokens?: OAuthTokens;
  clientInfo?: OAuthClientInformation;
}

function loadStoredAuth(): StoredAuth {
  if (existsSync(TOKENS_FILE)) {
    try {
      return JSON.parse(readFileSync(TOKENS_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveStoredAuth(auth: StoredAuth): void {
  writeFileSync(TOKENS_FILE, JSON.stringify(auth, null, 2));
}

/**
 * OAuth provider that persists tokens to disk
 */
class GranolaOAuthProvider implements OAuthClientProvider {
  private stored: StoredAuth;
  private _codeVerifier?: string;

  constructor() {
    this.stored = loadStoredAuth();
  }

  get redirectUrl(): string {
    return CALLBACK_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Granola Meeting Agent',
      redirect_uris: [CALLBACK_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    };
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.stored.clientInfo;
  }

  saveClientInformation(info: OAuthClientInformation): void {
    this.stored.clientInfo = info;
    saveStoredAuth(this.stored);
  }

  tokens(): OAuthTokens | undefined {
    return this.stored.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.stored.tokens = tokens;
    saveStoredAuth(this.stored);
    console.log('[auth] Tokens saved to .granola-tokens.json');
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    console.log(`\nOpen this URL in your browser to authorize:\n`);
    console.log(`  ${authorizationUrl.toString()}\n`);

    // Try to open browser automatically
    const { exec } = require('child_process');
    exec(`open "${authorizationUrl.toString()}"`);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this._codeVerifier) throw new Error('No code verifier saved');
    return this._codeVerifier;
  }
}

/**
 * Wait for OAuth callback on local server
 */
function waitForOAuthCallback(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url === '/favicon.ico') {
        res.writeHead(404);
        res.end();
        return;
      }

      const parsedUrl = new URL(req.url || '', 'http://localhost');
      const code = parsedUrl.searchParams.get('code');
      const error = parsedUrl.searchParams.get('error');

      if (code) {
        console.log(`[auth] Authorization code received`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Authorized!</h1><p>You can close this window.</p><script>setTimeout(()=>window.close(),2000)</script></body></html>`);
        resolve(code);
        setTimeout(() => server.close(), 3000);
      } else if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Auth Failed</h1><p>${error}</p></body></html>`);
        reject(new Error(`OAuth failed: ${error}`));
      } else {
        res.writeHead(400);
        res.end('Bad request');
      }
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(`[auth] Callback server listening on http://localhost:${CALLBACK_PORT}`);
    });
  });
}

async function authenticate(): Promise<void> {
  console.log(`[auth] Authenticating with Granola MCP at ${GRANOLA_MCP_URL}...\n`);

  const oauthProvider = new GranolaOAuthProvider();
  const client = new Client({ name: 'granola-agent', version: '1.0.0' });

  const transport = new StreamableHTTPClientTransport(
    new URL(GRANOLA_MCP_URL),
    { authProvider: oauthProvider },
  );

  try {
    await client.connect(transport);
    console.log('[auth] Already authenticated! Connection successful.');

    // List tools to verify
    const tools = await client.listTools();
    console.log(`[auth] ${tools.tools.length} Granola tools available:`);
    for (const tool of tools.tools) {
      console.log(`  - ${tool.name}: ${tool.description?.substring(0, 80)}`);
    }

    await client.close();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      console.log('[auth] OAuth required — opening browser...');

      const callbackPromise = waitForOAuthCallback();
      const authCode = await callbackPromise;

      await transport.finishAuth(authCode);
      console.log('[auth] Auth code exchanged for tokens.');

      // Reconnect with the new tokens
      console.log('[auth] Reconnecting...');
      const client2 = new Client({ name: 'granola-agent', version: '1.0.0' });
      const transport2 = new StreamableHTTPClientTransport(
        new URL(GRANOLA_MCP_URL),
        { authProvider: oauthProvider },
      );
      await client2.connect(transport2);

      const tools = await client2.listTools();
      console.log(`\n[auth] Success! ${tools.tools.length} Granola tools available:`);
      for (const tool of tools.tools) {
        console.log(`  - ${tool.name}: ${tool.description?.substring(0, 80)}`);
      }

      await client2.close();
    } else {
      throw error;
    }
  }

  console.log('\n[auth] Done! Tokens saved to .granola-tokens.json');
  console.log('[auth] You can now run: npx tsx src/test-granola.ts "what meetings did I have?"');
}

// Run if called directly
authenticate().catch(err => {
  console.error('[auth] Failed:', err);
  process.exit(1);
});
