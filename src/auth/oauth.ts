/**
 * Granola OAuth 2.0 with Dynamic Client Registration + PKCE.
 */
import crypto from 'node:crypto';
import { getPendingAuth, setPendingAuth, clearPendingAuth, setGranolaTokens, setJustOnboarded, setUserProfile } from './store.js';

const AUTH_SERVER = 'https://mcp-auth.granola.ai';
const MCP_RESOURCE = 'https://mcp.granola.ai/mcp';

// HMAC key for signing state tokens — derived from CREDENTIAL_ENCRYPTION_KEY or random
const STATE_HMAC_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY
  ? crypto.createHash('sha256').update(`state-signing:${process.env.CREDENTIAL_ENCRYPTION_KEY}`).digest()
  : crypto.randomBytes(32);

/**
 * Sign a phone number into a tamper-proof state token.
 * Format: "base64url(phone).base64url(hmac)"
 */
export function signState(phoneNumber: string): string {
  const payload = Buffer.from(phoneNumber).toString('base64url');
  const sig = crypto.createHmac('sha256', STATE_HMAC_KEY).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verify and extract phone number from a signed state token.
 * Returns null if the signature is invalid (tampered).
 */
export function verifyState(state: string): string | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;

  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', STATE_HMAC_KEY).update(payload).digest('base64url');

  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    console.error('[oauth] State signature mismatch — possible tampering');
    return null;
  }

  return Buffer.from(payload, 'base64url').toString('utf8');
}

let registeredClient: { clientId: string; clientSecret?: string } | null = null;

/**
 * Get the callback URL for OAuth.
 */
export function getCallbackUrl(baseUrl: string): string {
  const port = process.env.PORT || 3000;
  if (process.env.NODE_ENV === 'production') {
    return `${baseUrl}/auth/callback`;
  }
  return `http://localhost:${port}/auth/callback`;
}

/**
 * Register a dynamic client with Granola's OAuth server (DCR).
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

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Generate the Granola OAuth URL for a user and store the PKCE verifier.
 */
export async function generateAuthUrl(phoneNumber: string, baseUrl: string, chatId?: string): Promise<string> {
  const callbackUrl = getCallbackUrl(baseUrl);
  const client = await ensureClientRegistered(callbackUrl);
  const pkce = generatePKCE();

  // Store PKCE verifier + client info (with TTL)
  await setPendingAuth(phoneNumber, {
    codeVerifier: pkce.verifier,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    chatId,
  });

  // Store user profile with chatId
  if (chatId) {
    await setUserProfile(phoneNumber, { chatId });
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: callbackUrl,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: signState(phoneNumber),
    scope: 'openid email profile offline_access',
    resource: MCP_RESOURCE,
  });

  const url = `${AUTH_SERVER}/oauth2/authorize?${params.toString()}`;
  console.log(`[oauth] Auth URL generated for ${phoneNumber}`);
  return url;
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeCodeForTokens(
  code: string,
  phoneNumber: string,
  baseUrl: string,
): Promise<{ success: boolean; error?: string }> {
  const callbackUrl = getCallbackUrl(baseUrl);
  const pending = await getPendingAuth(phoneNumber);

  if (!pending) {
    return { success: false, error: 'No pending auth for this phone number' };
  }

  if (!pending.codeVerifier) {
    return { success: false, error: 'No PKCE verifier found — auth may have expired' };
  }

  const client = await ensureClientRegistered(callbackUrl);

  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl,
    client_id: client.clientId,
    code_verifier: pending.codeVerifier,
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
  };

  // Store tokens encrypted
  await setGranolaTokens(phoneNumber, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
  });

  // Clean up pending auth
  await clearPendingAuth(phoneNumber);

  // Set just-onboarded flag (for welcome flow)
  await setJustOnboarded(phoneNumber);

  console.log(`[oauth] Tokens received for ${phoneNumber} (expires in ${tokens.expires_in}s)`);
  return { success: true };
}

/**
 * Refresh an expired access token.
 */
export async function refreshAccessToken(phoneNumber: string, baseUrl: string, currentRefreshToken: string): Promise<boolean> {
  const callbackUrl = getCallbackUrl(baseUrl);
  const client = await ensureClientRegistered(callbackUrl);

  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: currentRefreshToken,
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

  await setGranolaTokens(phoneNumber, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
  });

  console.log(`[oauth] Token refreshed for ${phoneNumber}`);
  return true;
}
