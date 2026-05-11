// In-memory state.
//
// Phase 1 cleanup removes AWS/DynamoDB. MongoDB persistence will be introduced in Phase 2.
const CONVERSATION_TTL_SECONDS = 60 * 60;
const MAX_MESSAGES_PER_CHAT = 20;

type EpochSeconds = number;

interface ConversationRecord {
  messages: StoredMessage[];
  lastActive: EpochSeconds;
  ttl: EpochSeconds;
}

const conversations = new Map<string, ConversationRecord>();
const userProfiles = new Map<string, UserProfile>();

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  handle?: string; // Who sent this message (for user messages in group chats)
}

function nowSeconds(): EpochSeconds {
  return Math.floor(Date.now() / 1000);
}

function pruneConversationIfExpired(chatId: string, now = nowSeconds()) {
  const record = conversations.get(chatId);
  if (!record) return;
  if (record.ttl <= now) {
    conversations.delete(chatId);
  }
}

export async function getConversation(chatId: string): Promise<StoredMessage[]> {
  pruneConversationIfExpired(chatId);
  return conversations.get(chatId)?.messages ?? [];
}

export async function addMessage(chatId: string, role: 'user' | 'assistant', content: string, handle?: string): Promise<void> {
  const now = nowSeconds();
  pruneConversationIfExpired(chatId, now);

  const existing = conversations.get(chatId);
  const messages = existing?.messages ?? [];

  const newMessage: StoredMessage = handle ? { role, content, handle } : { role, content };
  messages.push(newMessage);

  conversations.set(chatId, {
    messages: messages.slice(-MAX_MESSAGES_PER_CHAT),
    lastActive: now,
    ttl: now + CONVERSATION_TTL_SECONDS,
  });
}

export async function clearConversation(chatId: string): Promise<void> {
  conversations.delete(chatId);
}

export async function clearAllConversations(): Promise<void> {
  conversations.clear();
}

// ============================================================================
// User Profiles - persistent facts about people (no TTL, kept forever)
// ============================================================================

export interface UserProfile {
  handle: string;
  name: string | null;
  facts: string[];
  firstSeen: number;
  lastSeen: number;
}

export async function getUserProfile(handle: string): Promise<UserProfile | null> {
  return userProfiles.get(handle) ?? null;
}

export async function updateUserProfile(
  handle: string,
  updates: { name?: string; facts?: string[] }
): Promise<void> {
  const existing = await getUserProfile(handle);
  const now = nowSeconds();

  const profile: UserProfile = {
    handle,
    name: updates.name ?? existing?.name ?? null,
    facts: updates.facts ?? existing?.facts ?? [],
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
  };

  userProfiles.set(handle, profile);
}

export async function addUserFact(handle: string, fact: string): Promise<boolean> {
  try {
    const existing = await getUserProfile(handle);
    const facts = existing?.facts ?? [];

    // Don't add duplicate facts
    if (!facts.includes(fact)) {
      facts.push(fact);
      await updateUserProfile(handle, { facts });
      console.log(`[conversation] Added fact for ${handle}: "${fact}"`);
      return true;
    }
    console.log(`[conversation] Fact for ${handle} already exists, skipping: "${fact}"`);
    return false;
  } catch (error) {
    console.error('[conversation] Error adding user fact:', error);
    return false;
  }
}

export async function setUserName(handle: string, name: string): Promise<boolean> {
  try {
    const existing = await getUserProfile(handle);
    // Skip if name is already the same
    if (existing?.name === name) {
      console.log(`[conversation] Name for ${handle} already "${name}", skipping`);
      return false;
    }
    await updateUserProfile(handle, { name });
    console.log(`[conversation] Set name for ${handle}: "${name}"`);
    return true;
  } catch (error) {
    console.error('[conversation] Error setting user name:', error);
    return false;
  }
}

export async function clearUserProfile(handle: string): Promise<boolean> {
  userProfiles.delete(handle);
  return true;
}
