import { describe, expect, test } from 'vitest';
import { cleanResponse, splitIntoBubbles } from './client.js';

describe('cleanResponse', () => {
  test('strips fenced code blocks and common markdown markers', () => {
    const input = [
      '## Title',
      '',
      '- **Bullet**: do the thing',
      '',
      '```js',
      'console.log("nope")',
      '```',
      '',
      'Done.',
    ].join('\n');

    const out = cleanResponse(input);
    expect(out).not.toContain('```');
    expect(out).toContain('Title');
    expect(out).toContain('Bullet: do the thing');
    expect(out).toContain('Done.');
  });
});

describe('splitIntoBubbles', () => {
  test('keeps bubble count under maxBubbles by merging overflow', () => {
    const text = ['a', 'b', 'c', 'd', 'e'].join('\n\n');
    const bubbles = splitIntoBubbles(text, { maxBubbles: 4 });

    expect(bubbles).toHaveLength(4);
    expect(bubbles[0]).toBe('a');
    expect(bubbles[1]).toBe('b');
    expect(bubbles[2]).toBe('c');
    expect(bubbles[3]).toContain('d');
    expect(bubbles[3]).toContain('e');
  });

  test('never returns empty bubbles', () => {
    const bubbles = splitIntoBubbles('\n\n  \nhello\n\n', { maxBubbles: 4 });
    expect(bubbles).toEqual(['hello']);
  });
});

