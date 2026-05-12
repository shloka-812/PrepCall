import { Request, Response } from 'express';
import {
  WebhookEvent,
  isMessageReceivedEvent,
  isMessageReactionEvent,
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

export interface ReactionHandler {
  (chatId: string, from: string, messageId: string, reaction: string, action: 'added' | 'removed'): Promise<void>;
}

export function createWebhookHandler(onMessage: MessageHandler, onReaction?: ReactionHandler) {
  const botNumbers = process.env.LINQ_AGENT_BOT_NUMBERS?.split(',').map(p => p.trim()).filter(Boolean) || [];
  const ignoredSenders = process.env.IGNORED_SENDERS?.split(',').map(p => p.trim()).filter(Boolean) || [];
  const allowedSenders = process.env.ALLOWED_SENDERS?.split(',').map(p => p.trim()).filter(Boolean) || [];

  return async (req: Request, res: Response) => {
    const event = req.body as WebhookEvent;

    const pstTime = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
    console.log(`[webhook] ${pstTime} PST | ${event.event_type} (${event.event_id})`);

    res.status(200).json({ received: true });

    if (isMessageReactionEvent(event) && onReaction) {
      const data = event.data as any;
      const chat = data.chat;
      const senderHandle = data.sender_handle || data.handle_info;
      const messageId = data.message_id || data.id;
      
      const reactionValue = typeof data.reaction === 'object' 
        ? (data.reaction.emoji || data.reaction.name || data.reaction.type)
        : (data.reaction || data.emoji || data.custom_emoji || data.customEmoji);
      
      let action = data.action;
      if (!action) {
        if (event.event_type === 'reaction.added' || event.event_type === 'message.reaction') action = 'added';
        else if (event.event_type === 'reaction.removed') action = 'removed';
        else action = 'added';
      }

      const from = senderHandle?.handle || data.from || data.handle;
      const chatId = chat?.id || data.chat_id;

      if (senderHandle?.is_me || data.is_from_me) return;
      
      if (!chatId || !from || !messageId) {
        console.warn(`[webhook] Incomplete reaction data: chat=${chatId}, sender=${from}, msg=${messageId}`);
        console.log(`[webhook] Full payload:`, JSON.stringify(event, null, 2));
        return;
      }

      console.log(`[webhook] Reaction ${reactionValue} ${action} by ${from} on message ${messageId.slice(0, 8)}...`);
      try {
        await onReaction(chatId, from, messageId, reactionValue, action);
      } catch (error) {
        console.error(`[webhook] Error handling reaction:`, error);
      }
      return;
    }

    if (isMessageReceivedEvent(event)) {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[webhook] Full payload:`, JSON.stringify(event, null, 2));
      }

      const { chatId, from, recipientPhone, isFromMe, messageId, parts, effect, replyTo, service } = extractEventFields(event.data);

      if (botNumbers.length > 0 && !botNumbers.includes(recipientPhone)) {
        console.log(`[webhook] Skipping message to ${recipientPhone} (not this bot's number)`);
        return;
      }

      if (isFromMe) {
        console.log(`[webhook] Skipping own message`);
        return;
      }

      if (allowedSenders.length > 0 && !allowedSenders.includes(from)) {
        console.log(`[webhook] Skipping ${from} (not in allowed senders)`);
        return;
      }

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
