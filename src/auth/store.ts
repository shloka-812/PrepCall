/**
 * User auth store — DynamoDB-backed with AES-256-GCM encryption.
 *
 * DynamoDB key scheme:
 *   PK: USER#<phone>  SK: GRANOLA_TOKENS   — encrypted OAuth tokens
 *   PK: USER#<phone>  SK: PROFILE          — chatId, timestamps
 *   PK: USER#<phone>  SK: JUST_ONBOARDED   — one-shot flag (10min TTL)
 *   PK: USER#<phone>  SK: PENDING_AUTH     — PKCE verifier during OAuth (10min TTL)
 *
 * Falls back to in-memory store if DynamoDB is unavailable (local dev).
 */
import { getItem, putItem, deleteItem } from '../db/dynamodb.js';
import { encrypt, decrypt } from './encryption.js';

// ── Types ────────────────────────────────────────────────────────────

export interface GranolaTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface UserProfile {
  phoneNumber: string;
  chatId?: string;
  createdAt: number;
  lastActive: number;
}

export interface PendingAuth {
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  chatId?: string;
}

// ── In-memory fallback (for local dev without DynamoDB) ──────────────

const memStore = new Map<string, { tokens?: GranolaTokens; profile?: UserProfile; pending?: PendingAuth }>();
let useDynamo = true;

async function tryDynamo<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  if (!useDynamo) return fallback;
  try {
    return await fn();
  } catch (error: unknown) {
    const code = (error as { name?: string }).name;
    if (code === 'ResourceNotFoundException' || code === 'UnrecognizedClientException') {
      console.warn('[auth-store] DynamoDB unavailable — using in-memory store (dev mode)');
      useDynamo = false;
    } else {
      console.error('[auth-store] DynamoDB error:', error);
    }
    return fallback;
  }
}

// ── User Profile ─────────────────────────────────────────────────────

export async function getUserProfile(phone: string): Promise<UserProfile | null> {
  return tryDynamo(async () => {
    const item = await getItem<UserProfile & { PK: string; SK: string }>(
      `USER#${phone}`, 'PROFILE',
    );
    return item ? { phoneNumber: item.phoneNumber, chatId: item.chatId, createdAt: item.createdAt, lastActive: item.lastActive } : null;
  }, memStore.get(phone)?.profile || null);
}

export async function setUserProfile(phone: string, profile: Partial<UserProfile>): Promise<void> {
  const now = Date.now();
  const existing = await getUserProfile(phone);

  const full: UserProfile = {
    phoneNumber: phone,
    chatId: profile.chatId || existing?.chatId,
    createdAt: existing?.createdAt || now,
    lastActive: now,
  };

  await tryDynamo(async () => {
    await putItem(`USER#${phone}`, 'PROFILE', full as unknown as Record<string, unknown>);
  }, undefined);

  // In-memory fallback
  const mem = memStore.get(phone) || {};
  mem.profile = full;
  memStore.set(phone, mem);
}

// ── Granola OAuth Tokens (encrypted at rest) ─────────────────────────

export async function getGranolaTokens(phone: string): Promise<GranolaTokens | null> {
  return tryDynamo(async () => {
    const item = await getItem<{ encrypted: string }>(
      `USER#${phone}`, 'GRANOLA_TOKENS',
    );
    if (!item?.encrypted) return null;
    return decrypt(item.encrypted) as GranolaTokens;
  }, memStore.get(phone)?.tokens || null);
}

export async function setGranolaTokens(phone: string, tokens: GranolaTokens): Promise<void> {
  const encrypted = encrypt(tokens);

  await tryDynamo(async () => {
    await putItem(`USER#${phone}`, 'GRANOLA_TOKENS', { encrypted });
  }, undefined);

  // In-memory fallback
  const mem = memStore.get(phone) || {};
  mem.tokens = tokens;
  memStore.set(phone, mem);

  console.log(`[auth-store] Tokens saved for ${phone} (encrypted)`);
}

export async function clearGranolaTokens(phone: string): Promise<void> {
  await tryDynamo(async () => {
    await deleteItem(`USER#${phone}`, 'GRANOLA_TOKENS');
  }, undefined);

  const mem = memStore.get(phone);
  if (mem) { mem.tokens = undefined; }

  console.log(`[auth-store] Tokens cleared for ${phone}`);
}

// ── Auth State Check ─────────────────────────────────────────────────

export async function isUserAuthed(phone: string): Promise<boolean> {
  const tokens = await getGranolaTokens(phone);
  return !!tokens?.accessToken;
}

// ── Pending Auth (PKCE verifier, stored during OAuth flow) ───────────

export async function setPendingAuth(phone: string, pending: PendingAuth): Promise<void> {
  await tryDynamo(async () => {
    await putItem(`USER#${phone}`, 'PENDING_AUTH', pending as unknown as Record<string, unknown>, 600); // 10min TTL
  }, undefined);

  const mem = memStore.get(phone) || {};
  mem.pending = pending;
  memStore.set(phone, mem);
}

export async function getPendingAuth(phone: string): Promise<PendingAuth | null> {
  return tryDynamo(async () => {
    const item = await getItem<PendingAuth & { PK: string; SK: string }>(
      `USER#${phone}`, 'PENDING_AUTH',
    );
    return item ? { codeVerifier: item.codeVerifier, clientId: item.clientId, clientSecret: item.clientSecret, chatId: item.chatId } : null;
  }, memStore.get(phone)?.pending || null);
}

export async function clearPendingAuth(phone: string): Promise<void> {
  await tryDynamo(async () => {
    await deleteItem(`USER#${phone}`, 'PENDING_AUTH');
  }, undefined);

  const mem = memStore.get(phone);
  if (mem) { mem.pending = undefined; }
}

// ── Just Onboarded (one-shot flag) ───────────────────────────────────

export async function setJustOnboarded(phone: string): Promise<void> {
  await tryDynamo(async () => {
    await putItem(`USER#${phone}`, 'JUST_ONBOARDED', { onboarded: true }, 600); // 10min TTL
  }, undefined);
}

export async function consumeJustOnboarded(phone: string): Promise<boolean> {
  return tryDynamo(async () => {
    const item = await getItem<{ onboarded: boolean }>(`USER#${phone}`, 'JUST_ONBOARDED');
    if (item?.onboarded) {
      await deleteItem(`USER#${phone}`, 'JUST_ONBOARDED');
      return true;
    }
    return false;
  }, false);
}
