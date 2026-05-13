import { describe, expect, it, vi, Mock } from 'vitest';
import { updatePrepCache } from './cache.js';
import { getMongoDb } from '../db/mongodb.js';

vi.mock('../db/mongodb.js', () => ({
  getMongoDb: vi.fn(),
}));

describe('updatePrepCache', () => {
  it('upgrades role-null cache entry when role is provided', async () => {
    const existingDoc = {
      _id: 'doc-1',
      userId: 'user-1',
      company: 'apple',
      role: null,
      companyInfo: { ceo: 'Tim Cook' },
      resumeHash: 'old',
      cachedAt: new Date('2025-01-01T00:00:00Z'),
      expiresAt: new Date('2025-01-02T00:00:00Z'),
    };

    const findOne = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingDoc);
    const updateOne = vi.fn().mockResolvedValue({ acknowledged: true });
    const collection = vi.fn().mockReturnValue({ findOne, updateOne });

    (getMongoDb as unknown as Mock).mockResolvedValue({ collection });


    await updatePrepCache('user-1', 'Apple', 'Software Engineer', 'newhash', {
      talkingPoints: { leadWith: 'X', howToFrame: 'Y', gapToAddress: 'Z' },
    });

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: existingDoc._id });
    expect(update.$set.role).toBe('software engineer');
  });
});
