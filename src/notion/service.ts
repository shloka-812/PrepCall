import { fetchResumeTextFromEnv } from './resume.js';
import { ensureMongoIndexes, getMongoDb, UserProfileDoc } from '../db/mongodb.js';
import { invalidatePrepCache } from '../research/cache.js';

function getNotionPageIdFromEnv(): string | null {
  const pageId = process.env.NOTION_PAGE_ID?.trim() || process.env.NOTION_RESUME_PAGE_ID?.trim();
  return pageId || null;
}

async function getUserProfilesCollection() {
  const db = await getMongoDb();
  await ensureMongoIndexes(db);
  return db.collection<UserProfileDoc>('user_profiles');
}

export async function refreshResumeForHandle(handle: string): Promise<{ resumeText: string; updatedAt: Date }> {
  const resumeText = await fetchResumeTextFromEnv();
  const updatedAt = new Date();
  const notionPageId = getNotionPageIdFromEnv();

  const col = await getUserProfilesCollection();

  await col.updateOne(
    { handle },
    {
      $set: { resumeText, resumeUpdatedAt: updatedAt, lastSeen: updatedAt, ...(notionPageId ? { notionPageId } : {}) },
      $setOnInsert: { handle, name: null, facts: [], firstSeen: updatedAt },
    },
    { upsert: true }
  );

  await invalidatePrepCache(handle);

  return { resumeText, updatedAt };
}

export async function setJobDescriptionForHandle(
  handle: string,
  jobDescription: string
): Promise<{ jdSetAt: Date }> {
  const updatedAt = new Date();

  const jd = jobDescription.trim();
  if (!jd) {
    throw new Error('job description is empty');
  }

  const col = await getUserProfilesCollection();

  await col.updateOne(
    { handle },
    {
      $set: { jobDescription: jd, jdSetAt: updatedAt, lastSeen: updatedAt },
      $setOnInsert: { handle, name: null, facts: [], firstSeen: updatedAt },
    },
    { upsert: true }
  );

  return { jdSetAt: updatedAt };
}

