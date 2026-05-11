import type { MessageHandler } from './handler.js';
import { markAsRead, sendMessage, startTyping } from '../linq/client.js';

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
    'more commands will land in phase 3',
  ];
}

export function createWebhookMessageHandler(): MessageHandler {
  return async (chatId, from, text, messageId, _images, _audio, _incomingEffect, incomingReplyTo) => {
    // Mark as read + start typing in parallel.
    await Promise.all([markAsRead(chatId), startTyping(chatId)]);

    const cmd = normalizeCommand(text);

    const replyTo = incomingReplyTo ? { message_id: messageId } : undefined;

    if (cmd === '/help' || cmd === '/start') {
      for (const bubble of getHelpText()) {
        await sendMessage(chatId, bubble, undefined, replyTo);
      }
      return;
    }

    await sendMessage(
      chatId,
      'prepcall is online. send /help to see whats available.',
      undefined,
      replyTo,
    );
  };
}

