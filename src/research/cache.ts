import { getMongoDb, PrepCacheDoc } from '../db/mongodb.js';
import { createHash } from 'crypto';

export function getResumeHash(resume: string): string {
  return createHash('sha256').update(resume || '').digest('hex');
}

export async function getPrepCache(
  userId: string,
  company: string,
  role: string | null = null
): Promise<PrepCacheDoc | null> {
  const db = await getMongoDb();
  const col = db.collection<PrepCacheDoc>('prep_cache');

  // Try exact match first
  let doc = await col.findOne({ userId, company: company.toLowerCase(), role: role?.toLowerCase() || null });

  // If role was provided but not found, try finding by company only (partial hit)
  if (!doc && role) {
    doc = await col.findOne({ userId, company: company.toLowerCase(), role: null });
  }

  return doc;
}

export async function updatePrepCache(
  userId: string,
  company: string,
  role: string | null,
  resumeHash: string,
  updates: Partial<Omit<PrepCacheDoc, 'userId' | 'company' | 'role' | 'resumeHash'>>
): Promise<void> {
  const db = await getMongoDb();
  const col = db.collection<PrepCacheDoc>('prep_cache');

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  await col.updateOne(
    { userId, company: company.toLowerCase(), role: role?.toLowerCase() || null },
    {
      $set: {
        ...updates,
        resumeHash,
        cachedAt: now,
        expiresAt,
      },
      $setOnInsert: {
        userId,
        company: company.toLowerCase(),
        role: role?.toLowerCase() || null,
      }
    },
    { upsert: true }
  );
}

export async function invalidatePrepCache(userId: string): Promise<void> {
  const db = await getMongoDb();
  await db.collection('prep_cache').deleteMany({ userId });
}
