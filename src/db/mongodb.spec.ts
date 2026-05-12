import { describe, expect, test } from 'vitest';
import { resolveDbName } from './mongodb.js';

describe('resolveDbName', () => {
  test('prefers explicit db name env var', () => {
    expect(resolveDbName('mongodb://localhost:27017/prepcall', 'mydb')).toBe('mydb');
  });

  test('extracts db name from URI path', () => {
    expect(resolveDbName('mongodb://localhost:27017/prepcall?authSource=admin')).toBe('prepcall');
  });

  test('falls back to default when URI has no db name', () => {
    expect(resolveDbName('mongodb://localhost:27017')).toBe('prepcall');
    expect(resolveDbName('mongodb://localhost:27017/')).toBe('prepcall');
  });
});

