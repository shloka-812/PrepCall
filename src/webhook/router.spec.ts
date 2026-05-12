import { describe, expect, test } from 'vitest';
import { extractJobDescriptionFromSetCommand } from './router.js';

describe('extractJobDescriptionFromSetCommand', () => {
  test('returns null if not a /set jd command', () => {
    expect(extractJobDescriptionFromSetCommand('/help')).toBeNull();
    expect(extractJobDescriptionFromSetCommand('hello')).toBeNull();
    expect(extractJobDescriptionFromSetCommand('/set something else')).toBeNull();
  });

  test('returns empty string when command has no body', () => {
    expect(extractJobDescriptionFromSetCommand('/set jd')).toBe('');
    expect(extractJobDescriptionFromSetCommand('/set jd   ')).toBe('');
  });

  test('extracts job description after /set jd', () => {
    expect(extractJobDescriptionFromSetCommand('/set jd Responsibilities: build things')).toBe(
      'Responsibilities: build things'
    );
  });
});

