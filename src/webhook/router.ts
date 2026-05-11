import type { MessageHandler } from './handler.js';
import { markAsRead, sendMessage, startTyping, stopTyping } from '../linq/client.js';
import { refreshResumeForHandle, setJobDescriptionForHandle } from '../notion/service.js';
import { getUserProfile } from '../db/mongodb.js';
import { classifyIntent } from '../gemini/client.js';

function normalizeCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const first = trimmed.split(/\s+/)[0];
  return first.toLowerCase();
}

function getHelpText(): string[] {
  return [
    'PrepCall is ready.',
    'Commands:',
    '/update resume - refresh from Notion',
    '/set jd <text> - save job description',
    '/jd - show stored job description',
    'You can also just ask in plain English, e.g., "what is the jd stored?" or "update my resume".',
  ];
}

export function extractJobDescriptionFromSetCommand(text: string): string | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/set\s+jd\b([\s\S]*)$/i);
  if (!m) return null;
  const rest = (m[1] ?? '').trim();
  return rest || '';
}

export function createWebhookMessageHandler(): MessageHandler {
  return async (chatId, from, text, messageId, _images, _audio, _incomingEffect, incomingReplyTo) => {
    // Mark as read + start typing in parallel.
    await Promise.all([markAsRead(chatId), startTyping(chatId)]);

    let cmd = normalizeCommand(text);
    if (!cmd) {
      // Fallback to LLM intent classification for natural language
      cmd = await classifyIntent(text);
      console.log(`[router] Classified intent for "${text.substring(0, 20)}...": ${cmd}`);
    }

    // Thread replies back to the incoming message.
    // If the incoming message itself was a reply, Linq may also provide reply metadata (incomingReplyTo),
    // but we still respond to the message we just received.
    void incomingReplyTo;
    const replyTo = { message_id: messageId };

    try {
      if (cmd === '/help' || cmd === '/start') {
        for (const bubble of getHelpText()) {
          await sendMessage(chatId, bubble, undefined, replyTo);
        }
        return;
      }

      if (cmd === '/update' || cmd === '/update resume') {
        if (text.trim().toLowerCase().startsWith('/update resume') || cmd === '/update resume') {
          await sendMessage(chatId, 'Updating your resume from Notion…', undefined, replyTo);
          try {
            const { resumeText } = await refreshResumeForHandle(from);
            await sendMessage(
              chatId,
              resumeText ? `Resume updated. Parsed ~${resumeText.length.toLocaleString()} chars. Do you want to paste the Job Desc?` : 'Resume updated, but it looks empty.',
              undefined,
              replyTo
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await sendMessage(
              chatId,
              `Resume fetch failed: ${msg}`,
              undefined,
              replyTo
            );
          }
          return;
        }
      }

      if (cmd === '/set' || cmd === '/set jd') {
        let jd = extractJobDescriptionFromSetCommand(text);
        
        // If LLM classified it as /set jd but it wasn't a slash command, 
        // the whole text might be the JD (e.g. "here is the jd: ...")
        if (jd === null && cmd === '/set jd') {
          jd = text.replace(/^(here is the jd|set jd|jd is|job description is)[:\s]*/i, '').trim();
        }

        if (jd !== null) {
          if (!jd) {
            await sendMessage(chatId, 'Paste the JD after the command: /set jd <job description>', undefined, replyTo);
            return;
          }
          try {
            await setJobDescriptionForHandle(from, jd);
            await sendMessage(chatId, `JD saved. (${jd.length.toLocaleString()} chars)`, undefined, replyTo);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await sendMessage(chatId, `JD save failed: ${msg}`, undefined, replyTo);
          }
          return;
        }
      }

      if (cmd === '/jd') {
        const profile = await getUserProfile(from);
        if (!profile?.jobDescription) {
          await sendMessage(chatId, 'No JD stored yet. Use /set jd <text> to add one.', undefined, replyTo);
        } else {
          // Truncate if too long for a single bubble, or just send it
          const displayJd = profile.jobDescription.length > 500 
            ? profile.jobDescription.substring(0, 500) + '...' 
            : profile.jobDescription;
          await sendMessage(chatId, `Stored JD (${profile.jobDescription.length} chars):\n\n${displayJd}`, undefined, replyTo);
        }
        return;
      }

      // Phase 3 placeholders for classified intents
      const phase3Commands = ['/brief', '/company', '/talking points', '/gaps', '/questions', '/saved', '/clear'];
      if (phase3Commands.includes(cmd!)) {
        await sendMessage(chatId, `The ${cmd} command is coming in Phase 3! Stay tuned.`, undefined, replyTo);
        return;
      }

      await sendMessage(
        chatId,
        'prepcall is online. send /help to see whats available.',
        undefined,
        replyTo,
      );
    } finally {
      await stopTyping(chatId);
    }
  };
}

