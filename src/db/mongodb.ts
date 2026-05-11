import { Db, MongoClient } from 'mongodb';
import { z } from 'zod';

const DEFAULT_DB_NAME = 'prepcall';

export function resolveDbName(uri: string, explicitDbName?: string): string {
  const explicit = explicitDbName?.trim();
  if (explicit) return explicit;

  try {
    const url = new URL(uri);
    const path = url.pathname?.replace(/^\//, '').trim();
    if (path) return path;
  } catch {
    // ignore parsing errors, fall back to default
  }

  return DEFAULT_DB_NAME;
}

const envSchema = z.object({
  MONGODB_URI: z.string().min(1, 'MONGODB_URI not configured'),
  MONGODB_DB_NAME: z.string().min(1).optional(),
});

function getMongoEnv() {
  const parsed = envSchema.safeParse({
    MONGODB_URI: process.env.MONGODB_URI,
    MONGODB_DB_NAME: process.env.MONGODB_DB_NAME,
  });
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map(i => i.message).join('; '));
  }
  return parsed.data;
}

let clientSingleton: MongoClient | null = null;
let dbSingleton: Db | null = null;

export async function getMongoClient(): Promise<MongoClient> {
  if (clientSingleton) return clientSingleton;

  const { MONGODB_URI } = getMongoEnv();
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  clientSingleton = client;
  return client;
}

export async function getMongoDb(): Promise<Db> {
  if (dbSingleton) return dbSingleton;
  const { MONGODB_URI, MONGODB_DB_NAME } = getMongoEnv();
  const dbName = resolveDbName(MONGODB_URI, MONGODB_DB_NAME);
  const client = await getMongoClient();
  dbSingleton = client.db(dbName);
  return dbSingleton;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  handle?: string;
}

export interface ConversationDoc {
  chatId: string;
  messages: ConversationMessage[];
  lastActive: Date;
  expiresAt: Date;
}

export interface UserProfileDoc {
  handle: string;
  name: string | null;
  facts: string[];
  firstSeen: Date;
  lastSeen: Date;
  resumeText?: string;
  resumeUpdatedAt?: Date;
  notionPageId?: string;
  jobDescription?: string;
  jdSetAt?: Date;
}

export interface SavedIntelDoc {
  handle: string;
  chatId: string;
  messageId: string;
  text: string;
  savedAt: Date;
  source?: 'reaction' | 'manual';
}

export async function ensureMongoIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection<ConversationDoc>('conversations').createIndexes([
      { key: { chatId: 1 }, name: 'chatId_unique', unique: true },
      { key: { expiresAt: 1 }, name: 'expiresAt_ttl', expireAfterSeconds: 0 },
      { key: { lastActive: -1 }, name: 'lastActive_desc' },
    ]),
    db.collection<UserProfileDoc>('user_profiles').createIndexes([
      { key: { handle: 1 }, name: 'handle_unique', unique: true },
      { key: { lastSeen: -1 }, name: 'lastSeen_desc' },
    ]),
    db.collection<SavedIntelDoc>('saved_intel').createIndexes([
      { key: { handle: 1, savedAt: -1 }, name: 'handle_savedAt' },
      { key: { messageId: 1 }, name: 'messageId_unique', unique: true },
    ]),
  ]);
}

export async function closeMongo(): Promise<void> {
  const client = clientSingleton;
  clientSingleton = null;
  dbSingleton = null;
  if (client) {
    await client.close();
  }
}

