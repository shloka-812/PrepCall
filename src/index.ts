import 'dotenv/config';
import express from 'express';
import { createWebhookHandler } from './webhook/handler.js';
import { sendMessage, markAsRead, startTyping, sendReaction, getChat } from './linq/client.js';
import { chat } from './claude/client.js';
import { isUserAuthed, getUserProfile, setUserProfile } from './auth/store.js';
import { generateAuthUrl } from './auth/oauth.js';
import { createAuthRoutes } from './auth/routes.js';

// Clean up LLM response formatting for iMessage
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

const app = express();
const PORT = process.env.PORT || 3000;

// The public base URL (set by ngrok or API Gateway)
let publicBaseUrl = process.env.BASE_URL || '';

app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes (/auth/callback, /auth/status/:phone)
const authRoutes = createAuthRoutes(
  () => publicBaseUrl,
  // When a user completes auth, send them a welcome message with confetti
  async (phoneNumber: string) => {
    console.log(`[main] User ${phoneNumber} just authenticated!`);

    const profile = await getUserProfile(phoneNumber);
    if (profile?.chatId) {
      try {
        await startTyping(profile.chatId);
        await new Promise(r => setTimeout(r, 500));
        await sendMessage(
          profile.chatId,
          "youre all connected! your granola account is linked and ready to go",
          { type: 'screen', name: 'confetti' },
        );
        await new Promise(r => setTimeout(r, 600));
        await sendMessage(
          profile.chatId,
          "just text me anytime to ask about your meetings — summaries, action items, transcripts, whatever you need",
        );
        console.log(`[main] Welcome message sent to ${phoneNumber}`);
      } catch (error) {
        console.error(`[main] Failed to send welcome message:`, error);
      }
    }
  },
);
app.use(authRoutes);

// Webhook endpoint for Linq Blue
app.post(
  '/webhook',
  createWebhookHandler(async (chatId, from, text, messageId, images, audio, incomingEffect, incomingReplyTo, service) => {
    const start = Date.now();
    console.log(`[main] Message from ${from}: "${text}"`);

    // Mark as read + start typing in parallel
    await Promise.all([markAsRead(chatId), startTyping(chatId)]);

    // Check if user has linked their Granola account
    if (!(await isUserAuthed(from))) {
      console.log(`[main] User ${from} not authed — sending auth link`);

      // Store chatId so we can message them after auth completes
      await setUserProfile(from, { chatId });

      const authUrl = await generateAuthUrl(from, publicBaseUrl, chatId);

      await sendMessage(chatId, 'hey! i need to connect to your granola account to access your meeting notes');
      await new Promise(r => setTimeout(r, 500));
      await sendMessage(chatId, `tap here to link your account:\n${authUrl}`);
      await new Promise(r => setTimeout(r, 500));
      await sendMessage(chatId, 'once youre connected, just text me any question about your meetings');

      console.log(`[timing] auth flow: ${Date.now() - start}ms`);
      return;
    }

    // User is authed — get chat info and process with Claude
    const chatInfo = await getChat(chatId);
    const isGroupChat = chatInfo.handles.length > 2;
    const participantNames = chatInfo.handles.map(h => h.handle);

    const { text: responseText, reaction } = await chat(chatId, text, {
      isGroupChat,
      participantNames,
      chatName: chatInfo.display_name,
      senderHandle: from,
      service,
      baseUrl: publicBaseUrl,
    });
    console.log(`[timing] claude: ${Date.now() - start}ms`);

    // Send reaction
    if (reaction) {
      await sendReaction(messageId, reaction);
    }

    // Send text response
    if (responseText) {
      const messages = responseText.split('---').map(m => cleanResponse(m)).filter(m => m.length > 0);
      const replyTo = incomingReplyTo ? { message_id: messageId } : undefined;

      for (let i = 0; i < messages.length; i++) {
        const messageReplyTo = (i === 0) ? replyTo : undefined;
        await sendMessage(chatId, messages[i], undefined, messageReplyTo);

        if (i < messages.length - 1) {
          const delay = 400 + Math.random() * 400;
          await new Promise(r => setTimeout(r, delay));
        }
      }
      console.log(`[timing] sent ${messages.length} msg(s): ${Date.now() - start}ms`);
    }

    console.log(`[main] Done processing ${from}`);
  })
);

// Auto-detect ngrok URL for local dev
async function detectNgrokUrl(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch('http://localhost:4040/api/tunnels', { signal: controller.signal });
    clearTimeout(timeout);
    const data = await resp.json() as { tunnels: Array<{ public_url: string }> };
    const tunnel = data.tunnels.find(t => t.public_url.startsWith('https://'));
    return tunnel?.public_url || null;
  } catch {
    return null;
  }
}

async function main() {
  // Detect public URL
  if (!publicBaseUrl) {
    detectNgrokUrl().then(url => {
      if (url) {
        publicBaseUrl = url;
        console.log(`[main] Detected ngrok URL: ${publicBaseUrl}`);
      }
    }).catch(() => {});
    publicBaseUrl = `http://localhost:${PORT}`;
  }

  app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║         Granola Meeting Agent (Linq Blue)             ║
╠═══════════════════════════════════════════════════════╣
║  Server: http://localhost:${PORT}                       ║
║  Public: ${publicBaseUrl.padEnd(42)}║
╚═══════════════════════════════════════════════════════╝
    `);
  });
}

main().catch(console.error);
