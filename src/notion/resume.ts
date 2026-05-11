import { Client } from '@notionhq/client';
import { z } from 'zod';

type RichText = { plain_text?: string };

type NotionBlock = {
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
};

function richTextToText(richText: unknown): string {
  if (!Array.isArray(richText)) return '';
  return (richText as RichText[])
    .map(rt => rt?.plain_text ?? '')
    .join('')
    .trim();
}

export function blocksToPlainText(blocks: readonly NotionBlock[]): string {
  const lines: string[] = [];

  for (const block of blocks) {
    const type = block.type;
    const payload = block[type] as { rich_text?: unknown } | undefined;

    const text = richTextToText(payload?.rich_text);
    if (!text) continue;

    switch (type) {
      case 'heading_1':
      case 'heading_2':
      case 'heading_3':
        lines.push(text);
        break;
      case 'paragraph':
        lines.push(text);
        break;
      case 'bulleted_list_item':
        lines.push(`- ${text}`);
        break;
      case 'numbered_list_item':
        lines.push(`1. ${text}`);
        break;
      case 'to_do':
        lines.push(`- [ ] ${text}`);
        break;
      case 'quote':
        lines.push(text);
        break;
      default:
        lines.push(text);
        break;
    }
  }

  return lines.join('\n').trim();
}

const envSchema = z.object({
  NOTION_TOKEN: z.string().min(1, 'NOTION_TOKEN not configured'),
  NOTION_PAGE_ID: z.string().min(1).optional(),
  NOTION_RESUME_PAGE_ID: z.string().min(1).optional(), // backward-compatible fallback
});

function getEnv() {
  const parsed = envSchema.safeParse({
    NOTION_TOKEN: process.env.NOTION_TOKEN,
    NOTION_PAGE_ID: process.env.NOTION_PAGE_ID,
    NOTION_RESUME_PAGE_ID: process.env.NOTION_RESUME_PAGE_ID,
  });
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map(i => i.message).join('; '));
  }

  const pageId = parsed.data.NOTION_PAGE_ID?.trim() || parsed.data.NOTION_RESUME_PAGE_ID?.trim();
  if (!pageId) {
    throw new Error('NOTION_PAGE_ID not configured');
  }

  return { NOTION_TOKEN: parsed.data.NOTION_TOKEN, NOTION_PAGE_ID: pageId };
}

async function listAllChildBlocks(client: Client, blockId: string): Promise<NotionBlock[]> {
  const results: NotionBlock[] = [];
  let cursor: string | undefined = undefined;

  // Notion pagination loop
  while (true) {
    const resp = await client.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });

    const blocks = resp.results as unknown as NotionBlock[];
    results.push(...blocks);

    if (!resp.has_more) break;
    cursor = resp.next_cursor ?? undefined;
    if (!cursor) break;
  }

  return results;
}

export async function fetchResumeBlocksFromEnv(): Promise<NotionBlock[]> {
  const { NOTION_TOKEN, NOTION_PAGE_ID } = getEnv();
  const client = new Client({ auth: NOTION_TOKEN });

  // Treat the resume page as a block container and fetch its children.
  return await listAllChildBlocks(client, NOTION_PAGE_ID);
}

export async function fetchResumeTextFromEnv(): Promise<string> {
  const blocks = await fetchResumeBlocksFromEnv();
  return blocksToPlainText(blocks);
}

