import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';

const envSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY not configured'),
});

function getGeminiEnv() {
  const parsed = envSchema.safeParse({ GEMINI_API_KEY: process.env.GEMINI_API_KEY });
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map(i => i.message).join('; '));
  }
  return parsed.data;
}

export function cleanResponse(text: string): string {
  return text
    // Remove fenced code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Remove markdown headings
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bold/italics markers
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    // Remove inline code ticks
    .replace(/`([^`]+)`/g, '$1')
    // Normalize whitespace
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function splitIntoBubbles(
  text: string,
  opts?: { maxBubbles?: number }
): string[] {
  const maxBubbles = opts?.maxBubbles ?? 4;

  const parts = text
    .split(/\n\s*\n+/g)
    .map(p => p.trim())
    .filter(Boolean);

  if (parts.length === 0) return [];
  if (parts.length <= maxBubbles) return parts;

  const head = parts.slice(0, maxBubbles - 1);
  const tail = parts.slice(maxBubbles - 1).join('\n\n');
  return [...head, tail].filter(Boolean);
}

export interface GeminiGenerateOptions {
  model?: string;
  maxBubbles?: number;
}

export async function generateBubbles(prompt: string, opts?: GeminiGenerateOptions): Promise<string[]> {
  const { GEMINI_API_KEY } = getGeminiEnv();
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

  const modelName = opts?.model ?? 'gemini-1.5-flash';
  const model = genAI.getGenerativeModel({ model: modelName });
  const result = await model.generateContent(prompt);

  const raw = result.response.text();
  const cleaned = cleanResponse(raw);
  return splitIntoBubbles(cleaned, { maxBubbles: opts?.maxBubbles ?? 4 });
}

