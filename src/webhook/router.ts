import type { MessageHandler, ReactionHandler } from './handler.js';
import { markAsRead, sendMessage, startTyping, stopTyping, getMessage } from '../linq/client.js';
import type { SendMessageResponse } from '../linq/client.js';
import { refreshResumeForHandle, setJobDescriptionForHandle } from '../notion/service.js';
import { getUserProfile, saveIntel, getSavedIntel, updateSession, getMessageCache, upsertMessageCache } from '../db/mongodb.js';
import {
  classifyIntent,
  generateCompanyInfo,
  generateTalkingPoints,
  generateInterviewQuestions,
  generateBrief,
  companyInfoToBubbles,
  talkingPointsToBubbles,
  answerQuestion,
} from '../gemini/client.js';
import { getPrepCache, updatePrepCache, getResumeHash } from '../research/cache.js';

// In-memory map of recently sent message IDs → content (for reaction saving).
// Capped at 200 entries; old entries pruned on overflow.
const recentMessages = new Map<string, { text: string; handle: string; chatId: string }>();
const RECENT_MSG_CAP = 200;

function trackSent(resp: SendMessageResponse, text: string, handle: string, chatId: string) {
  if (recentMessages.size >= RECENT_MSG_CAP) {
    const firstKey = recentMessages.keys().next().value;
    if (firstKey !== undefined) recentMessages.delete(firstKey);
  }
  recentMessages.set(resp.message.id, { text, handle, chatId });
}

async function sendTracked(
  chatId: string,
  handle: string,
  text: string,
  replyTo?: { message_id: string }
): Promise<void> {
  const resp = await sendMessage(chatId, text, undefined, replyTo);
  trackSent(resp, text, handle, chatId);
  await upsertMessageCache(resp.message.id, chatId, handle, text);
}

// ─── JD Detection ────────────────────────────────────────────────────────────

const JD_KEYWORDS = [
  'responsibilities', 'requirements', 'qualifications', 'you will', 'we are looking',
  'must have', 'nice to have', 'preferred', 'minimum', 'compensation', 'benefits',
  'job description', 'about the role', 'what you\'ll do', 'what you will do',
  'we\'re looking', 'the role', 'ideal candidate',
];

function isLikelyJobDescription(text: string): boolean {
  if (text.length < 300) return false;
  const lower = text.toLowerCase();
  const hits = JD_KEYWORDS.filter(kw => lower.includes(kw));
  return hits.length >= 3;
}

// ─── Command Parsing ──────────────────────────────────────────────────────────

function normalizeCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const first = trimmed.split(/\s+/)[0];
  return first.toLowerCase();
}

function extractArg(text: string, cmd: string): string {
  return text.trim().slice(cmd.length).trim();
}

export function extractJobDescriptionFromSetCommand(text: string): string | null {
  const m = text.trim().match(/^\/set\s+jd\b([\s\S]*)$/i);
  if (!m) return null;
  return (m[1] ?? '').trim();
}

function cleanParsedArg(value: string | undefined): string {
  return (value ?? '')
    .replace(/[“”"']+/g, '')
    .replace(/[.?!]+$/g, '')
    .trim();
}

export function extractBriefArgsFromText(text: string): { company: string; role: string | null } | null {
  const roleMatch = text.match(/\b(?:for\s+role|role)\s+([^,.]+)/i);
  const role = cleanParsedArg(roleMatch?.[1]);

  const companyMatch =
    text.match(/\bcompany\s+([^,.]+?)(?:\s+\b(?:for\s+role|role)\b|$)/i) ??
    text.match(/\bbrief(?:\s+me)?(?:\s+about)?\s+([^,.]+?)(?:\s+\b(?:for\s+role|role)\b|$)/i);

  const company = cleanParsedArg(companyMatch?.[1]);
  if (!company) return null;

  return { company, role: role || null };
}

export function extractCompanyFromText(text: string): string | null {
  const match =
    text.match(/\bcompany\s+([^,.]+)/i) ??
    text.match(/\babout\s+([^,.]+)/i);
  const company = cleanParsedArg(match?.[1]);
  return company || null;
}

// ─── Help Text ────────────────────────────────────────────────────────────────

function getHelpText(): string[] {
  return [
    'PrepCall — your pre-interview research agent.',
    '/brief [company] [role] — full intel: company + strategy + questions\n/company [name] — company snapshot\n/talking points — strategy: lead with + how to frame + gaps\n/questions — likely interview questions',
    '/update resume — re-fetch resume from Notion\n/set jd <text> — save a job description\n/jd — show stored JD\n/saved — view bookmarked intel\n/clear — reset session\n\nOr just paste a JD directly — I\'ll detect it.',
  ];
}

async function getStartText(from: string): Promise<string[]> {
  const profile = await getUserProfile(from);
  const hasResume = !!profile?.resumeText;
  const hasJD = !!profile?.jobDescription;

  if (hasResume && hasJD) {
    // User is fully set up
    return [
      'PrepCall — your pre-interview research agent.',
      'Send /brief [company] [role] to start.',
      '/update resume — re-fetch resume from Notion\n/set jd <text> — save a job description\n/jd — show stored JD\n/saved — view bookmarked intel\n/clear — reset session',
    ];
  }

  if (!hasResume && !hasJD) {
    // First time user
    return [
      'PrepCall — your 30-min-before-a-call lifeline.',
      'First time? Here\'s how it works:\n\n1️⃣ Connect resume: /update resume\n2️⃣ Paste a JD (I\'ll auto-detect it)\n3️⃣ Get intel: /brief [company] [role]',
      'Try: /update resume to start.',
    ];
  }

  if (!hasResume) {
    // Has JD but no resume
    return [
      'PrepCall — almost ready.',
      'You have a JD saved but no resume. Send /update resume to connect it.',
      'Once that\'s done, you can run /brief [company] [role] for full prep.',
    ];
  }

  // Has resume but no JD
  return [
    'PrepCall — almost ready.',
    'You have your resume but no JD saved. Paste a job description (I\'ll auto-detect it) or use /set jd.',
    'Then run /brief [company] [role] to get your intel.',
  ];
}

// ─── Reaction Handler ─────────────────────────────────────────────────────────

export function createReactionHandler(): ReactionHandler {
  return async (chatId, from, messageId, reaction, action) => {
    const reactionLower = (reaction || '').toLowerCase();
    const isLove = reactionLower === 'love' || reaction === '❤️' || reactionLower.includes('love') || reactionLower.includes('heart');
    if (!isLove || action !== 'added') return;

    // 1️⃣ Check in-memory map (fastest, lives for process lifetime)
    let resolvedText: string | null = recentMessages.get(messageId)?.text ?? null;

    // 2️⃣ Fallback: check MongoDB message_cache (survives restarts, 24h TTL)
    if (!resolvedText) {
      console.log(`[router] ❤️ message ${messageId.slice(0, 8)} not in memory — checking DB cache...`);
      const cached = await getMessageCache(messageId).catch(() => null);
      if (cached?.text) resolvedText = cached.text;
    }

    // 3️⃣ Fallback: fetch from Linq API directly
    if (!resolvedText) {
      console.log(`[router] ❤️ message ${messageId.slice(0, 8)} not in DB — fetching from Linq API...`);
      const apiMsg = await getMessage(messageId).catch(() => null);
      if (apiMsg) {
        resolvedText = apiMsg.parts
          .filter(p => p.type === 'text' && p.value)
          .map(p => p.value!)
          .join('\n') || null;
        // Warm the cache for future reactions
        if (resolvedText) {
          await upsertMessageCache(messageId, chatId, from, resolvedText).catch(() => { });
        }
      }
    }

    if (!resolvedText) {
      console.warn(`[router] ❤️ Could not resolve text for message ${messageId.slice(0, 8)} — skipping`);
      return;
    }

    try {
      await saveIntel({
        handle: from,
        chatId,
        messageId,
        text: resolvedText,
        source: 'reaction',
      });
      console.log(`[router] ✅ Saved intel for ${from}: "${resolvedText.substring(0, 60)}..."`);
    } catch (err) {
      console.error('[router] Failed to save intel:', err);
    }
  };
}

// ─── Message Handler ──────────────────────────────────────────────────────────

export function createWebhookMessageHandler(): MessageHandler {
  return async (chatId, from, text, messageId, _images, _audio, _incomingEffect, _incomingReplyTo) => {
    // Cache every incoming message immediately so reactions can resolve it later
    recentMessages.set(messageId, { text, handle: from, chatId });
    if (recentMessages.size > RECENT_MSG_CAP) {
      const firstKey = recentMessages.keys().next().value;
      if (firstKey !== undefined) recentMessages.delete(firstKey);
    }
    upsertMessageCache(messageId, chatId, from, text).catch(err =>
      console.error(`[router] Failed to cache incoming message ${messageId.slice(0, 8)}:`, err)
    );

    await Promise.all([markAsRead(chatId), startTyping(chatId)]);

    const replyTo = { message_id: messageId };

    try {
      // ── Auto-detect JD paste ────────────────────────────────────────────
      if (!text.trim().startsWith('/') && isLikelyJobDescription(text)) {
        console.log(`[router] Auto-detected JD from ${from} (${text.length} chars)`);
        try {
          await setJobDescriptionForHandle(from, text);
          const preview = text.substring(0, 120).replace(/\n+/g, ' ');
          await sendTracked(chatId, from, `JD saved (${text.length.toLocaleString()} chars). "${preview}…"\n\nSend /brief, /talking points, /gaps, or /questions.`, replyTo);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await sendTracked(chatId, from, `Couldn't save JD: ${msg}`, replyTo);
        }
        return;
      }

      // ── Resolve command or answer question ──────────────────────────────
      let cmd = normalizeCommand(text);
      const profile = await getUserProfile(from);
      const company = profile?.currentCompany ?? null;
      const role = profile?.currentRole ?? null;

      if (!cmd) {
        cmd = await classifyIntent(text);
        if (cmd) {
          console.log(`[router] Classified intent for "${text.substring(0, 40)}...": ${cmd}`);
          // If the classified command has arguments (like "/company google"), update the text
          // so the command handlers below can extract them.
          if (cmd.split(/\s+/).length > 1) {
            text = cmd;
            cmd = normalizeCommand(cmd);
          }
        }
      }

      if (cmd === '/brief' && !text.trim().startsWith('/')) {
        const parsed = extractBriefArgsFromText(text);
        if (parsed) {
          text = `/brief ${parsed.company}${parsed.role ? ` ${parsed.role}` : ''}`;
        }
      }

      if (cmd === '/company' && !text.trim().startsWith('/')) {
        const company = extractCompanyFromText(text);
        if (company) {
          text = `/company ${company}`;
        }
      }

      if (!cmd && !text.trim().startsWith('/') && company) {
        // If we have an active session and it's not a command, try answering as a question first
        const cache = await getPrepCache(from, company, role);
        const bubbles = await answerQuestion(text, {
          company,
          role,
          companyInfo: cache?.companyInfo,
          talkingPoints: cache?.talkingPoints,
          jd: profile?.jobDescription,
        });

        // If Gemini actually answered (not just a generic fallback), send it
        if (bubbles.length > 0 && !bubbles[0].toLowerCase().includes('help')) {
          for (const b of bubbles) await sendTracked(chatId, from, b, replyTo);
          return;
        }
      }

      // ── /help or /start ─────────────────────────────────────────────────
      if (cmd === '/help') {
        for (const bubble of getHelpText()) {
          await sendTracked(chatId, from, bubble, replyTo);
        }
        return;
      }

      if (cmd === '/start') {
        const helpBubbles = await getStartText(from);
        for (const bubble of helpBubbles) {
          await sendTracked(chatId, from, bubble, replyTo);
        }
        return;
      }


      // ── /update resume ──────────────────────────────────────────────────
      if (cmd === '/update' || cmd === '/update resume') {
        await sendTracked(chatId, from, 'Fetching resume from Notion…', replyTo);
        try {
          const { resumeText } = await refreshResumeForHandle(from);
          await sendTracked(
            chatId, from,
            resumeText
              ? `Resume updated. ${resumeText.length.toLocaleString()} chars loaded. Ready — paste a JD or send /brief.`
              : 'Resume updated but it looks empty. Check your Notion page.',
            replyTo
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await sendTracked(chatId, from, `Resume fetch failed: ${msg}`, replyTo);
        }
        return;
      }

      // ── /set jd ─────────────────────────────────────────────────────────
      if (cmd === '/set' || cmd === '/set jd') {
        let jd = extractJobDescriptionFromSetCommand(text);
        if (jd === null && cmd === '/set jd') {
          jd = text.replace(/^(here is the jd|set jd|jd is|job description is)[:\s]*/i, '').trim();
        }
        if (jd !== null) {
          if (!jd) {
            await sendTracked(chatId, from, 'Paste the JD after the command: /set jd <text>', replyTo);
            return;
          }
          try {
            await setJobDescriptionForHandle(from, jd);
            await sendTracked(chatId, from, `JD saved (${jd.length.toLocaleString()} chars). Send /brief to get your full prep.`, replyTo);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await sendTracked(chatId, from, `JD save failed: ${msg}`, replyTo);
          }
          return;
        }
      }

      // ── /jd ─────────────────────────────────────────────────────────────
      if (cmd === '/jd') {
        const profile = await getUserProfile(from);
        if (!profile?.jobDescription) {
          await sendTracked(chatId, from, 'No JD stored. Paste one directly or use /set jd <text>.', replyTo);
        } else {
          const preview = profile.jobDescription.length > 500
            ? profile.jobDescription.substring(0, 500) + '…'
            : profile.jobDescription;
          await sendTracked(chatId, from, `Stored JD (${profile.jobDescription.length} chars):\n\n${preview}`, replyTo);
        }
        return;
      }

      // ── /clear ───────────────────────────────────────────────────────────
      if (cmd === '/clear') {
        await updateSession(from, null, null);
        await sendTracked(chatId, from, 'Session cleared. Resume and JD wiped — start fresh.', replyTo);
        return;
      }

      // ── /saved ───────────────────────────────────────────────────────────
      if (cmd === '/saved') {
        const items = await getSavedIntel(from, 5);
        if (items.length === 0) {
          await sendTracked(chatId, from, 'Nothing saved yet. React with ❤️ on any message to bookmark it.', replyTo);
        } else {
          await sendTracked(chatId, from, `Your last ${items.length} saved items:`, replyTo);
          for (const item of items) {
            await sendTracked(chatId, from, item.text, replyTo);
          }
        }
        return;
      }

      // ── /company ─────────────────────────────────────────────────────────
      if (cmd === '/company') {
        const company = extractArg(text, '/company');
        if (!company) {
          await sendTracked(chatId, from, 'Which company? Example: /company Stripe', replyTo);
          return;
        }

        const profile = await getUserProfile(from);
        const resumeHash = getResumeHash(profile?.resumeText || '');
        await updateSession(from, company, profile?.currentRole || null);

        let cache = await getPrepCache(from, company);
        if (!cache?.companyInfo) {
          const info = await generateCompanyInfo(company);
          await updatePrepCache(from, company, null, resumeHash, { companyInfo: info });
          cache = await getPrepCache(from, company);
        }

        const bubbles = companyInfoToBubbles(cache!.companyInfo);
        for (const bubble of bubbles) {
          await sendTracked(chatId, from, bubble, replyTo);
        }
        return;
      }

      // ── /talking points ───────────────────────────────────────────────────
      if (cmd === '/talking points' || cmd === '/talking') {
        if (!company) {
          await sendTracked(chatId, from, 'Which company? Use /brief [company] or /company [company] first.', replyTo);
          return;
        }

        if (!profile?.resumeText || !profile?.jobDescription) {
          await sendTracked(chatId, from, 'Need both your resume and a JD. Run /update resume first, then paste your JD.', replyTo);
          return;
        }

        const resumeHash = getResumeHash(profile.resumeText);
        let cache = await getPrepCache(from, company, role);

        if (!cache?.talkingPoints || cache.resumeHash !== resumeHash) {
          const tp = await generateTalkingPoints(profile.resumeText, profile.jobDescription);
          await updatePrepCache(from, company, role, resumeHash, { talkingPoints: tp });
          cache = await getPrepCache(from, company, role);
        }

        const bubbles = talkingPointsToBubbles(cache!.talkingPoints);
        for (const bubble of bubbles) {
          await sendTracked(chatId, from, bubble, replyTo);
        }
        return;
      }

      // ── /gaps ────────────────────────────────────────────────────────────
      if (cmd === '/gaps') {
        const profile = await getUserProfile(from);
        if (!profile?.resumeText || !profile?.jobDescription) {
          await sendTracked(chatId, from, 'Need both resume and JD. Run /update resume and paste the JD first.', replyTo);
          return;
        }
        const tp = await generateTalkingPoints(profile.resumeText, profile.jobDescription);
        const bubbles = talkingPointsToBubbles(tp);
        for (const bubble of bubbles) {
          await sendTracked(chatId, from, bubble, replyTo);
        }
        return;
      }

      // ── /questions ────────────────────────────────────────────────────────
      if (cmd === '/questions') {
        if (!company) {
          await sendTracked(chatId, from, 'Which company? Use /brief [company] or /company [company] first.', replyTo);
          return;
        }

        if (!profile?.jobDescription) {
          await sendTracked(chatId, from, 'No JD saved. Paste the job description first.', replyTo);
          return;
        }

        const resumeHash = getResumeHash(profile?.resumeText || '');
        let cache = await getPrepCache(from, company, role);

        if (!cache?.interviewQuestions) {
          const questions = await generateInterviewQuestions(profile.jobDescription);
          await updatePrepCache(from, company, role, resumeHash, { interviewQuestions: questions });
          cache = await getPrepCache(from, company, role);
        }

        for (const bubble of cache!.interviewQuestions!) {
          await sendTracked(chatId, from, bubble, replyTo);
        }
        return;
      }

      // ── /brief ────────────────────────────────────────────────────────────
      if (cmd === '/brief') {
        const arg = extractArg(text, '/brief');
        const parts = arg.split(/\s+/);
        const company = parts[0]?.toLowerCase() ?? '';
        const role = parts.slice(1).join(' ').toLowerCase() || null;

        if (!company) {
          await sendTracked(chatId, from, 'Which company? Example: /brief Stripe Senior SWE', replyTo);
          return;
        }

        const profile = await getUserProfile(from);
        const resume = profile?.resumeText ?? '';
        const jd = profile?.jobDescription ?? '';
        const resumeHash = getResumeHash(resume);

        await updateSession(from, company, role);

        let cache = await getPrepCache(from, company, role);
        let needsUpdate = false;
        const updates: any = {};

        if (!cache?.companyInfo) {
          updates.companyInfo = await generateCompanyInfo(company);
          needsUpdate = true;
        }

        if (resume && jd && (!cache?.talkingPoints || cache.resumeHash !== resumeHash)) {
          updates.talkingPoints = await generateTalkingPoints(resume, jd);
          needsUpdate = true;
        }

        if (jd && !cache?.interviewQuestions) {
          updates.interviewQuestions = await generateInterviewQuestions(jd);
          needsUpdate = true;
        }

        if (needsUpdate) {
          await updatePrepCache(from, company, role, resumeHash, updates);
          cache = await getPrepCache(from, company, role);
        }

        // Keep typing indicator alive
        await startTyping(chatId).catch(() => { });

        // Send bubbles
        const infoBubbles = companyInfoToBubbles(cache!.companyInfo);
        for (const b of infoBubbles) await sendTracked(chatId, from, b, replyTo);

        if (cache?.talkingPoints) {
          const tpBubbles = talkingPointsToBubbles(cache.talkingPoints);
          for (const b of tpBubbles) await sendTracked(chatId, from, b, replyTo);
        }

        if (cache?.interviewQuestions) {
          for (const b of cache.interviewQuestions.slice(0, 3)) await sendTracked(chatId, from, b, replyTo);
        }

        if (!resume || !jd) {
          await sendTracked(
            chatId, from,
            `For personalized strategy, add your resume (/update resume) and JD (paste it).`,
            replyTo
          );
        }
        return;
      }

      // ── Fallback ─────────────────────────────────────────────────────────
      await sendTracked(chatId, from, 'Send /help to see what I can do.', replyTo);
    } finally {
      await stopTyping(chatId);
    }
  };
}
