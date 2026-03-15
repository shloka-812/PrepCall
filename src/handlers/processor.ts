/**
 * Lambda #2: Processor
 *
 * Triggered by SQS FIFO. Handles the heavy lifting:
 *   - Connect to user's Granola MCP
 *   - Call Claude with Granola tools
 *   - Send response via Linq
 *
 * 60s timeout, 512MB memory.
 */
import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { chat } from '../claude/client.js';
import { sendMessage, sendReaction, getChat, startTyping } from '../linq/client.js';
import { getItem, putItem } from '../db/dynamodb.js';

// BASE_URL comes from the SQS message payload (set by Receiver)
// to avoid circular CloudFormation dependency

function cleanResponse(text: string): string {
  return text
    .replace(/\n\s*-\s*/g, ' - ')
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    .replace(/  +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface MessagePayload {
  chatId: string;
  from: string;
  text: string;
  messageId: string;
  service?: string;
  images?: Array<{ url: string; mimeType: string }>;
  audio?: Array<{ url: string; mimeType: string }>;
  incomingEffect?: { type: string; name: string } | null;
  incomingReplyTo?: { message_id: string } | null;
  baseUrl: string;
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const payload: MessagePayload = JSON.parse(record.body);
      const { chatId, from, text, messageId, service, incomingReplyTo, baseUrl } = payload;

      console.log(`[processor] Processing message from ${from}: "${text.substring(0, 50)}"`);

      // Application-level dedup (5min TTL)
      const dedupKey = `DEDUP#${messageId}`;
      const existing = await getItem(dedupKey, 'DEDUP');
      if (existing) {
        console.log(`[processor] Duplicate message ${messageId}, skipping`);
        continue;
      }
      await putItem(dedupKey, 'DEDUP', { messageId }, 300);

      // Keep typing indicator alive
      await startTyping(chatId).catch(() => {});

      // Get chat info
      const chatInfo = await getChat(chatId);
      const isGroupChat = chatInfo.handles.length > 2;
      const participantNames = chatInfo.handles.map(h => h.handle);

      // Call Claude with Granola tools
      const { text: responseText, reaction } = await chat(chatId, text, {
        isGroupChat,
        participantNames,
        chatName: chatInfo.display_name,
        senderHandle: from,
        service: service as 'iMessage' | 'SMS' | 'RCS' | undefined,
        baseUrl,
      });

      // Send reaction
      if (reaction) {
        await sendReaction(messageId, reaction);
      }

      // Send text response
      if (responseText) {
        const messages = responseText.split('---').map(m => cleanResponse(m)).filter(m => m.length > 0);
        const replyTo = incomingReplyTo ? { message_id: messageId } : undefined;

        // Cap at 4 messages
        const toSend = messages.slice(0, 4);

        for (let i = 0; i < toSend.length; i++) {
          const messageReplyTo = (i === 0) ? replyTo : undefined;
          await sendMessage(chatId, toSend[i], undefined, messageReplyTo);

          if (i < toSend.length - 1) {
            const delay = 400 + Math.random() * 400;
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }

      console.log(`[processor] Done processing ${from}`);
    } catch (error) {
      console.error(`[processor] Failed:`, error);
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}
