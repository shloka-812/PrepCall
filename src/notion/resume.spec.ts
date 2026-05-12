import { describe, expect, test } from 'vitest';
import { blocksToPlainText } from './resume.js';

describe('blocksToPlainText', () => {
  test('converts common Notion blocks into readable plain text', () => {
    const blocks = [
      {
        type: 'heading_1',
        heading_1: { rich_text: [{ plain_text: 'Shloka Pandya' }] },
      },
      {
        type: 'paragraph',
        paragraph: { rich_text: [{ plain_text: 'Software engineer.' }] },
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ plain_text: 'Built X' }] },
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ plain_text: 'Shipped Y' }] },
      },
    ] as const;

    const text = blocksToPlainText(blocks);
    expect(text).toContain('Shloka Pandya');
    expect(text).toContain('Software engineer.');
    expect(text).toContain('- Built X');
    expect(text).toContain('- Shipped Y');
  });
});

