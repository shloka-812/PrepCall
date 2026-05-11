import type { MessageHandler } from './handler.js';
import { markAsRead, sendMessage, startTyping, stopTyping } from '../linq/client.js';
import { refreshResumeForHandle, setJobDescriptionForHandle } from '../notion/service.js';

function normalizeCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const first = trimmed.split(/\s+/)[0];
  return first.toLowerCase();
}

function getHelpText(): string[] {
  return [
    'prepcall is running locally',
    'try: /help',
    'set JD: /set jd <paste job description>',
    'update resume: /update resume',
    'more commands will land in phase 3',
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

    const cmd = normalizeCommand(text);

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

      if (cmd === '/update' && text.trim().toLowerCase().startsWith('/update resume')) {
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

      if (cmd === '/set') {
        const jd = extractJobDescriptionFromSetCommand(text);
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

