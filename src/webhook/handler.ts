import { Request, Response } from 'express';
import {
  WebhookEvent,
  isMessageReceivedEvent,
  extractEventFields,
  extractTextContent,
  extractImageUrls,
  extractAudioUrls,
  ExtractedMedia,
  MessageEffect,
  ReplyTo,
} from './types.js';

export type MessageService = 'iMessage' | 'SMS' | 'RCS';

export interface MessageHandler {
  (chatId: string, from: string, text: string, messageId: string, images: ExtractedMedia[], audio: ExtractedMedia[], incomingEffect?: MessageEffect, incomingReplyTo?: ReplyTo, service?: MessageService): Promise<void>;
}

export function createWebhookHandler(onMessage: MessageHandler) {
  const botNumbers = process.env.LINQ_AGENT_BOT_NUMBERS?.split(',').map(p => p.trim()).filter(Boolean) || [];
  const ignoredSenders = process.env.IGNORED_SENDERS?.split(',').map(p => p.trim()).filter(Boolean) || [];
  const allowedSenders = process.env.ALLOWED_SENDERS?.split(',').map(p => p.trim()).filter(Boolean) || [];

  return async (req: Request, res: Response) => {
    const event = req.body as WebhookEvent;

    const pstTime = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
    console.log(`[webhook] ${pstTime} PST | ${event.event_type} (${event.event_id})`);

    // Acknowledge receipt immediately
    res.status(200).json({ received: true });

    if (isMessageReceivedEvent(event)) {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[webhook] Full payload:`, JSON.stringify(event, null, 2));
      }

      const { chatId, from, recipientPhone, isFromMe, messageId, parts, effect, replyTo, service } = extractEventFields(event.data);

      // Only process messages sent to this bot's phone numbers
      if (botNumbers.length > 0 && !botNumbers.includes(recipientPhone)) {
        console.log(`[webhook] Skipping message to ${recipientPhone} (not this bot's number)`);
        return;
      }

      // Skip messages from ourselves
      if (isFromMe) {
        console.log(`[webhook] Skipping own message`);
        return;
      }

      // If ALLOWED_SENDERS is set, only respond to those numbers
      if (allowedSenders.length > 0 && !allowedSenders.includes(from)) {
        console.log(`[webhook] Skipping ${from} (not in allowed senders)`);
        return;
      }

      // Skip messages from ignored senders
      if (ignoredSenders.includes(from)) {
        console.log(`[webhook] Skipping ${from} (ignored sender)`);
        return;
      }

      const text = extractTextContent(parts);
      const images = extractImageUrls(parts);
      const audio = extractAudioUrls(parts);

      if (!text.trim() && images.length === 0 && audio.length === 0) {
        console.log(`[webhook] Skipping empty message`);
        return;
      }

      const effectInfo = effect ? ` [effect: ${effect.type}/${effect.name}]` : '';
      const replyInfo = replyTo ? ` [reply to: ${replyTo.message_id.slice(0, 8)}...]` : '';
      const mediaInfo = [
        images.length > 0 ? `${images.length} image(s)` : '',
        audio.length > 0 ? `${audio.length} audio` : '',
      ].filter(Boolean).join(', ');
      console.log(`[webhook] Message from ${from}: "${text.substring(0, 50)}..."${mediaInfo ? ` [${mediaInfo}]` : ''}${effectInfo}${replyInfo}`);

      try {
        await onMessage(chatId, from, text, messageId, images, audio, effect, replyTo, service);
      } catch (error) {
        console.error(`[webhook] Error handling message:`, error);
      }
    }
  };
}
