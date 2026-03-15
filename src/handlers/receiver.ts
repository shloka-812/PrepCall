/**
 * Lambda #1: Receiver
 *
 * Handles all HTTP traffic (API Gateway):
 *   - POST /webhook       → validate + enqueue to SQS FIFO
 *   - GET  /auth/callback → OAuth token exchange
 *   - GET  /health        → health check
 *
 * Must respond fast (<10s). Heavy processing goes to Processor via SQS.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { exchangeCodeForTokens, verifyState, getCallbackUrl } from '../auth/oauth.js';
import { isUserAuthed, getUserProfile, setUserProfile, clearGranolaTokens } from '../auth/store.js';
import { generateAuthUrl } from '../auth/oauth.js';
import { sendMessage, markAsRead, startTyping } from '../linq/client.js';
import {
  extractEventFields,
  extractTextContent,
  extractImageUrls,
  extractAudioUrls,
} from '../webhook/types.js';

const sqs = new SQSClient({});
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL!;
const BASE_URL = process.env.BASE_URL!;

// Inline HTML pages (imported from routes in local dev, inlined here for Lambda)
const SUCCESS_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connected</title><link href="https://fonts.googleapis.com/css2?family=Urbanist:wght@700&family=Inter:wght@400;500&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,sans-serif;background:#0a0a0b;color:#f0f0f0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px}.card{text-align:center;max-width:420px}h1{font-family:'Urbanist',sans-serif;font-size:32px;font-weight:700;margin-bottom:12px}p{font-size:15px;color:#8a8a8e;line-height:1.6;margin-bottom:8px}.check{width:64px;height:64px;border-radius:50%;background:#f0f0f0;color:#0a0a0b;display:flex;align-items:center;justify-content:center;margin:0 auto 24px;font-size:28px}.cta{margin-top:32px;display:inline-block;background:#f0f0f0;color:#0a0a0b;font-size:14px;font-weight:600;padding:12px 28px;border-radius:10px;text-decoration:none}.footer{margin-top:48px;font-size:12px;color:#8a8a8e;opacity:.5}</style></head><body><div class="card"><div class="check">&#10003;</div><h1>Connected</h1><p>Your Granola account is linked.</p><p>Head back to iMessage and ask about your meetings.</p><a href="sms:+16504447005" class="cta">Open iMessage</a><div class="footer">Powered by Linq Blue × Granola MCP</div></div></body></html>`;
const ERROR_HTML = (msg: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title><style>body{font-family:system-ui;background:#0a0a0b;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh}h1{font-size:24px;margin-bottom:8px}p{color:#8a8a8e}</style></head><body><div style="text-align:center"><h1>Auth Failed</h1><p>${msg}</p><p>Go back to iMessage and try again.</p></div></body></html>`;

const botNumbers = process.env.LINQ_AGENT_BOT_NUMBERS?.split(',').map(p => p.trim()).filter(Boolean) || [];
const ignoredSenders = process.env.IGNORED_SENDERS?.split(',').map(p => p.trim()).filter(Boolean) || [];
const allowedSenders = process.env.ALLOWED_SENDERS?.split(',').map(p => p.trim()).filter(Boolean) || [];

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  // Health check
  if (method === 'GET' && path === '/health') {
    return { statusCode: 200, body: JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }) };
  }

  // OAuth callback
  if (method === 'GET' && path === '/auth/callback') {
    const params = event.queryStringParameters || {};
    const code = params.code || '';
    const state = params.state || '';
    const error = params.error || '';

    const secHeaders = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
      'Content-Type': 'text/html',
    };

    if (error) return { statusCode: 400, headers: secHeaders, body: ERROR_HTML(error) };
    if (!code || !state) return { statusCode: 400, headers: secHeaders, body: ERROR_HTML('Missing authorization code') };

    const phoneNumber = verifyState(state);
    if (!phoneNumber) return { statusCode: 400, headers: secHeaders, body: ERROR_HTML('Invalid authorization state') };

    const result = await exchangeCodeForTokens(code, phoneNumber, BASE_URL);

    if (result.success) {
      // Send welcome message before returning HTML (Lambda freezes after response)
      const profile = await getUserProfile(phoneNumber);
      if (profile?.chatId) {
        try {
          await startTyping(profile.chatId);
          await sendMessage(profile.chatId, "youre all connected! your granola account is linked and ready to go", { type: 'screen', name: 'confetti' });
          await sendMessage(profile.chatId, "just text me anytime to ask about your meetings — summaries, action items, transcripts, whatever you need");
        } catch (err) {
          console.error('[receiver] Failed to send welcome message:', err);
        }
      }
      return { statusCode: 200, headers: secHeaders, body: SUCCESS_HTML };
    }

    return { statusCode: 400, headers: secHeaders, body: ERROR_HTML(result.error || 'Unknown error') };
  }

  // Linq webhook
  if (method === 'POST' && (path === '/webhook' || path === '/')) {
    const body = JSON.parse(event.body || '{}');
    const eventType = body.event_type;

    console.log(`[receiver] ${eventType} (${body.event_id})`);

    // Only process message.received
    if (eventType !== 'message.received') {
      return { statusCode: 200, body: '{"received":true}' };
    }

    const { chatId, from, recipientPhone, isFromMe, messageId, parts, service } = extractEventFields(body.data);

    // Filters
    if (botNumbers.length > 0 && !botNumbers.includes(recipientPhone)) return { statusCode: 200, body: '{"skipped":"not our number"}' };
    if (isFromMe) return { statusCode: 200, body: '{"skipped":"own message"}' };
    if (allowedSenders.length > 0 && !allowedSenders.includes(from)) return { statusCode: 200, body: '{"skipped":"not allowed"}' };
    if (ignoredSenders.includes(from)) return { statusCode: 200, body: '{"skipped":"ignored"}' };

    const text = extractTextContent(parts);
    const images = extractImageUrls(parts);
    const audio = extractAudioUrls(parts);

    if (!text.trim() && images.length === 0 && audio.length === 0) {
      return { statusCode: 200, body: '{"skipped":"empty"}' };
    }

    console.log(`[receiver] Message from ${from}: "${text.substring(0, 50)}"`);

    // Mark as read + start typing immediately
    await Promise.all([markAsRead(chatId), startTyping(chatId)]);

    // Handle signout — slash commands or natural language
    const cmd = text.toLowerCase().trim();
    const isSignout = cmd === '/signout' || cmd === '/logout' || cmd === '/disconnect'
      || /\b(sign\s*out|log\s*out|disconnect|unlink|remove\s*auth|deauth)\b/.test(cmd);
    if (isSignout && await isUserAuthed(from)) {
      await clearGranolaTokens(from);
      await sendMessage(chatId, "done — your granola account has been disconnected. text me anytime to reconnect");
      console.log(`[receiver] User ${from} signed out`);
      return { statusCode: 200, body: '{"action":"signed_out"}' };
    }

    // If user isn't authed, send auth link directly (no need to enqueue)
    if (!(await isUserAuthed(from))) {
      console.log(`[receiver] User ${from} not authed — sending auth link`);
      await setUserProfile(from, { chatId });
      const authUrl = await generateAuthUrl(from, BASE_URL, chatId);
      await sendMessage(chatId, 'hey! i need to connect to your granola account to access your meeting notes');
      await sendMessage(chatId, `tap here to link your account:\n${authUrl}`);
      await sendMessage(chatId, 'once youre connected, just text me any question about your meetings');
      return { statusCode: 200, body: '{"action":"auth_link_sent"}' };
    }

    // Enqueue to SQS for processing
    await sqs.send(new SendMessageCommand({
      QueueUrl: SQS_QUEUE_URL,
      MessageBody: JSON.stringify({
        chatId, from, text, messageId, service,
        images, audio,
        incomingEffect: body.data.effect,
        incomingReplyTo: body.data.reply_to,
        baseUrl: BASE_URL,
      }),
      MessageGroupId: chatId,
      MessageDeduplicationId: body.event_id,
    }));

    console.log(`[receiver] Enqueued for processing`);
    return { statusCode: 200, body: '{"queued":true}' };
  }

  return { statusCode: 404, body: '{"error":"not found"}' };
}
