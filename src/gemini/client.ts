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

const SYSTEM_INSTRUCTION =
  'You are PrepCall, a pocket interview coach via SMS. Be blunt, tactical, and extremely concise. ' +
  'Plain text only — no markdown, no asterisks, no headers. ' +
  'Separate each distinct point with a blank line (they become separate text bubbles). ' +
  'Use short, bite-sized bullets or key-value pairs. Cut all fluff.';

export function cleanResponse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
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

async function generateWithSystem(
  userPrompt: string,
  opts?: GeminiGenerateOptions
): Promise<string[]> {
  const { GEMINI_API_KEY } = getGeminiEnv();
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const modelName = opts?.model ?? 'gemini-flash-latest';
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: SYSTEM_INSTRUCTION,
  });
  const result = await model.generateContent(userPrompt);
  const raw = result.response.text();
  const cleaned = cleanResponse(raw);
  return splitIntoBubbles(cleaned, { maxBubbles: opts?.maxBubbles ?? 4 });
}

export async function generateBubbles(prompt: string, opts?: GeminiGenerateOptions): Promise<string[]> {
  return generateWithSystem(prompt, opts);
}

export async function classifyIntent(text: string): Promise<string | null> {
  const { GEMINI_API_KEY } = getGeminiEnv();
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });

  const prompt = `Map this message to one command or return "none". Return ONLY the command string or "none".

Commands:
/help - user needs help or instructions
/start - greeting or starting
/update resume - refresh resume from Notion
/set jd - user providing a job description
/jd - show stored JD
/brief [company] [role] - full research brief
/company [company] - full company info only
/talking points - interview strategy/positioning
/gaps - weaknesses/gaps
/questions - likely interview questions
/saved - view bookmarked intel
/clear - reset session

Rules:
1. If the user asks a specific question (e.g., "who is the CEO", "what is the latest news", "where is HQ"), return "none".
2. Only return a command if they want the FULL summary/brief for that category.

Message: "${text}"

Intent:`;

  const result = await model.generateContent(prompt);
  const intent = result.response.text().trim().toLowerCase();

  if (intent === 'none') return null;
  // Handle cases where Gemini might return arguments too
  const firstWord = intent.split(/\s+/)[0];
  const normalized = firstWord.startsWith('/') ? intent : `/${intent}`;
  return normalized;
}

export async function generateCompanyInfo(company: string): Promise<{
  dateFounded: string;
  ceo: string;
  location: string;
  peopleSize: string;
  webLink: string;
  currentStage: string;
  totalFunding: string;
  keyInvestors: string;
  news: string[];
}> {
  const prompt =
    `Research ${company} and provide a concise snapshot for an interviewee. ` +
    `Return exactly these fields (if known): ` +
    `dateFounded= [year] ` +
    `CEO= [current CEO name] ` +
    `location= [city, state, country] ` +
    `people-size= [count] employees ` +
    `web-link= [url] ` +
    `Current Stage= [stage] ` +
    `Total Funding= [amount] ` +
    `Key Investors= [top 2-3] ` +
    `News= [1-2 recent headlines] ` +
    `Be extremely concise. No sentences. No fluff.`;

  const { GEMINI_API_KEY } = getGeminiEnv();
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });
  const result = await model.generateContent(prompt);
  const text = result.response.text();

  const getValue = (key: string) => {
    const match = text.match(new RegExp(`${key}\\s*=\\s*(.*)`, 'i'));
    return match ? match[1].trim() : 'Unknown';
  };

  return {
    dateFounded: getValue('dateFounded'),
    ceo: getValue('CEO'),
    location: getValue('location'),
    peopleSize: getValue('people-size'),
    webLink: getValue('web-link'),
    currentStage: getValue('Current Stage'),
    totalFunding: getValue('Total Funding'),
    keyInvestors: getValue('Key Investors'),
    news: getValue('News').split(',').map(s => s.trim()).filter(Boolean),
  };
}

export function companyInfoToBubbles(info: any): string[] {
  return [
    `dateFounded= ${info.dateFounded}\nCEO= ${info.ceo}\nlocation= ${info.location}\npeople-size= ${info.peopleSize}\nweb-link= ${info.webLink}`,
    `Current Stage= ${info.currentStage}\nTotal Funding= ${info.totalFunding}\nKey Investors= ${info.keyInvestors}`,
    `News= ${info.news.join(', ')}`
  ];
}

export async function generateTalkingPoints(resume: string, jd: string): Promise<{
  leadWith: string;
  howToFrame: string;
  gapToAddress: string;
}> {
  const prompt =
    `Resume:\n${resume}\n\nJob Description:\n${jd}\n\n` +
    `Generate interview strategy. Return exactly these three sections: ` +
    `LEAD WITH: [one specific highlight from resume that maps to JD] ` +
    `HOW TO FRAME IT: [tactical advice on positioning experience] ` +
    `GAP TO ADDRESS: [identify one major gap and how to spin/fix it] ` +
    `Be blunt and tactical. No generic advice.`;

  const { GEMINI_API_KEY } = getGeminiEnv();
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });
  const result = await model.generateContent(prompt);
  const text = result.response.text();

  const getValue = (key: string) => {
    const match = text.match(new RegExp(`${key}:\\s*([\\s\\S]*?)(?=\\n[A-Z\\s]+:|$)`, 'i'));
    return match ? match[1].trim() : 'Unknown';
  };

  return {
    leadWith: getValue('LEAD WITH'),
    howToFrame: getValue('HOW TO FRAME IT'),
    gapToAddress: getValue('GAP TO ADDRESS'),
  };
}

export function talkingPointsToBubbles(tp: any): string[] {
  return [
    `LEAD WITH: ${tp.leadWith}`,
    `HOW TO FRAME IT: ${tp.howToFrame}`,
    `GAP TO ADDRESS: ${tp.gapToAddress}`
  ];
}

export async function answerQuestion(
  question: string,
  context: {
    company?: string;
    role?: string | null;
    companyInfo?: any;
    talkingPoints?: any;
    jd?: string;
  }
): Promise<string[]> {
  const ctxStr = [
    context.company ? `Company: ${context.company}` : '',
    context.role ? `Role: ${context.role}` : '',
    context.companyInfo ? `Cached Intel: ${JSON.stringify(context.companyInfo)}` : '',
    context.talkingPoints ? `Strategy: ${JSON.stringify(context.talkingPoints)}` : '',
    context.jd ? `JD: ${context.jd.substring(0, 500)}...` : '',
  ].filter(Boolean).join('\n');

  const prompt = `
    ${ctxStr}

    User asked: "${question}"

    Answer ONLY what they asked for using the cached intel above. If the answer isn't there, use your knowledge.
    Be blunt. One sentence. No extra info. No fluff.
  `;
  return generateWithSystem(prompt, { maxBubbles: 1 });
}

export async function generateInterviewQuestions(jd: string): Promise<string[]> {
  const prompt =
    `Job Description:\n${jd}\n\n` +
    `List the 5-6 most likely interview questions for this role. ` +
    `Include 2-3 behavioral ("tell me about a time...") and 2-3 technical or role-specific. ` +
    `One question per paragraph. No explanations, just the questions.`;
  return generateWithSystem(prompt);
}

export async function generateBrief(company: string, role: string, resume: string, jd: string): Promise<string[]> {
  const info = await generateCompanyInfo(company);
  const infoBubbles = companyInfoToBubbles(info);

  if (resume && jd) {
    const tp = await generateTalkingPoints(resume, jd);
    const tpBubbles = talkingPointsToBubbles(tp);
    const questions = await generateInterviewQuestions(jd);
    return [...infoBubbles, ...tpBubbles, ...questions.slice(0, 3)];
  }

  const genericPrompt = `Company: ${company}${role ? `\nRole: ${role}` : ''}\n\nFull pre-interview brief. Para 1: what to expect in the interview process and culture. Para 2: key things to research before the call. Para 3: 3 likely interview questions for this type of role.`;
  const extraBubbles = await generateWithSystem(genericPrompt, { maxBubbles: 3 });
  return [...infoBubbles, ...extraBubbles];
}
