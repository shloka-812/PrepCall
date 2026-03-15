/**
 * Granola OAuth 2.0 with Dynamic Client Registration + PKCE
 *
 * Flow:
 * 1. Register dynamic client with Granola's DCR endpoint
 * 2. Generate PKCE challenge
 * 3. Build auth URL with state=phoneNumber
 * 4. User clicks link in iMessage, logs in via browser
 * 5. Callback hits /auth/callback with code + state
 * 6. Exchange code for tokens
 * 7. Store tokens for user
 */
import crypto from 'node:crypto';
import { getUserAuth, setUserAuth, updateUserTokens, type UserAuth } from './store.js';

const AUTH_SERVER = 'https://mcp-auth.granola.ai';
const MCP_RESOURCE = 'https://mcp.granola.ai/mcp';

// Cached DCR client (shared across users since Granola allows it)
let registeredClient: { clientId: string; clientSecret?: string } | null = null;

/**
 * Get the callback URL for OAuth.
 * For local dev, always use localhost (browser is on the same machine).
 * For production (Lambda), use the public API Gateway URL.
 */
export function getCallbackUrl(baseUrl: string): string {
  const port = process.env.PORT || 3000;
  if (process.env.NODE_ENV === 'production') {
    return `${baseUrl}/auth/callback`;
  }
  // Local dev: browser redirect goes to localhost directly (avoids ngrok SSL issues)
  return `http://localhost:${port}/auth/callback`;
}

/**
 * Register a dynamic client with Granola's OAuth server (DCR).
 * Only needs to happen once — we reuse the client for all users.
 */
async function ensureClientRegistered(callbackUrl: string): Promise<{ clientId: string; clientSecret?: string }> {
  if (registeredClient) return registeredClient;

  console.log('[oauth] Registering dynamic client with Granola...');

  const response = await fetch(`${AUTH_SERVER}/oauth2/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Granola Meeting Agent (Linq Blue)',
      redirect_uris: [callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'openid email profile offline_access',
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DCR failed: ${response.status} ${err}`);
  }

  const data = await response.json() as { client_id: string; client_secret?: string };
  registeredClient = { clientId: data.client_id, clientSecret: data.client_secret };

  console.log(`[oauth] Client registered: ${registeredClient.clientId}`);
  return registeredClient;
}

/**
 * Generate PKCE code_verifier and code_challenge.
 */
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Generate the Granola OAuth URL for a user and store the PKCE verifier.
 */
export async function generateAuthUrl(phoneNumber: string, baseUrl: string): Promise<string> {
  const callbackUrl = getCallbackUrl(baseUrl);
  const client = await ensureClientRegistered(callbackUrl);
  const pkce = generatePKCE();

  // Store the PKCE verifier so we can use it during token exchange
  const now = Date.now();
  const existing = getUserAuth(phoneNumber);
  if (existing) {
    existing.codeVerifier = pkce.verifier;
    existing.updatedAt = now;
    setUserAuth(phoneNumber, existing);
  } else {
    setUserAuth(phoneNumber, {
      phoneNumber,
      accessToken: '',
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      codeVerifier: pkce.verifier,
      createdAt: now,
      updatedAt: now,
    });
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: callbackUrl,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: phoneNumber,
    scope: 'openid email profile offline_access',
    resource: MCP_RESOURCE,
  });

  const url = `${AUTH_SERVER}/oauth2/authorize?${params.toString()}`;
  console.log(`[oauth] Auth URL generated for ${phoneNumber}`);
  return url;
}

/**
 * Exchange authorization code for tokens.
 * Called from the /auth/callback route.
 */
export async function exchangeCodeForTokens(
  code: string,
  phoneNumber: string,
  baseUrl: string,
): Promise<{ success: boolean; error?: string }> {
  const callbackUrl = getCallbackUrl(baseUrl);
  const userAuth = getUserAuth(phoneNumber);

  if (!userAuth) {
    return { success: false, error: 'No pending auth for this phone number' };
  }

  if (!userAuth.codeVerifier) {
    return { success: false, error: 'No PKCE verifier found — auth may have expired' };
  }

  const client = await ensureClientRegistered(callbackUrl);

  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl,
    client_id: client.clientId,
    code_verifier: userAuth.codeVerifier,
  };

  if (client.clientSecret) {
    body.client_secret = client.clientSecret;
  }

  console.log(`[oauth] Exchanging code for tokens (user: ${phoneNumber})...`);

  const response = await fetch(`${AUTH_SERVER}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`[oauth] Token exchange failed: ${response.status} ${err}`);
    return { success: false, error: `Token exchange failed: ${response.status}` };
  }

  const tokens = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type: string;
  };

  updateUserTokens(
    phoneNumber,
    tokens.access_token,
    tokens.refresh_token,
    tokens.expires_in,
  );

  console.log(`[oauth] Tokens received for ${phoneNumber} (expires in ${tokens.expires_in}s)`);
  return { success: true };
}

/**
 * Refresh an expired access token using the refresh token.
 */
export async function refreshAccessToken(phoneNumber: string, baseUrl: string): Promise<boolean> {
  const userAuth = getUserAuth(phoneNumber);
  if (!userAuth?.refreshToken) {
    console.log(`[oauth] No refresh token for ${phoneNumber}`);
    return false;
  }

  const callbackUrl = getCallbackUrl(baseUrl);
  const client = await ensureClientRegistered(callbackUrl);

  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: userAuth.refreshToken,
    client_id: client.clientId,
  };

  if (client.clientSecret) {
    body.client_secret = client.clientSecret;
  }

  console.log(`[oauth] Refreshing token for ${phoneNumber}...`);

  const response = await fetch(`${AUTH_SERVER}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });

  if (!response.ok) {
    console.error(`[oauth] Token refresh failed: ${response.status}`);
    return false;
  }

  const tokens = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  updateUserTokens(
    phoneNumber,
    tokens.access_token,
    tokens.refresh_token,
    tokens.expires_in,
  );

  console.log(`[oauth] Token refreshed for ${phoneNumber}`);
  return true;
}
