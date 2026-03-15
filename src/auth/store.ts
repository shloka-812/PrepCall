/**
 * User auth token store.
 * In-memory for local dev — swap to DynamoDB for production.
 */

export interface UserAuth {
  phoneNumber: string;
  chatId?: string;  // Linq chat ID for sending messages back
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  clientSecret?: string;
  codeVerifier?: string;  // Stored during auth flow, cleared after
  createdAt: number;
  updatedAt: number;
}

// In-memory store (swap to DynamoDB later)
const store = new Map<string, UserAuth>();

export function getUserAuth(phoneNumber: string): UserAuth | null {
  return store.get(phoneNumber) || null;
}

export function setUserAuth(phoneNumber: string, auth: UserAuth): void {
  store.set(phoneNumber, auth);
  console.log(`[auth-store] Saved auth for ${phoneNumber}`);
}

export function updateUserTokens(
  phoneNumber: string,
  accessToken: string,
  refreshToken?: string,
  expiresIn?: number,
): void {
  const existing = store.get(phoneNumber);
  if (!existing) return;

  existing.accessToken = accessToken;
  if (refreshToken) existing.refreshToken = refreshToken;
  if (expiresIn) existing.expiresAt = Date.now() + expiresIn * 1000;
  existing.updatedAt = Date.now();
  existing.codeVerifier = undefined; // Clear after use

  store.set(phoneNumber, existing);
  console.log(`[auth-store] Updated tokens for ${phoneNumber}`);
}

export function deleteUserAuth(phoneNumber: string): void {
  store.delete(phoneNumber);
  console.log(`[auth-store] Deleted auth for ${phoneNumber}`);
}

export function isUserAuthed(phoneNumber: string): boolean {
  const auth = store.get(phoneNumber);
  return !!auth?.accessToken;
}

export function listAuthedUsers(): string[] {
  return Array.from(store.keys());
}
