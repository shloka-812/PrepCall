import Anthropic from '@anthropic-ai/sdk';
import { getGranolaToolsForUser, callGranolaToolForUser, isGranolaTool } from '../granola/client.js';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a personal meeting assistant accessible via text message, powered by Granola and the Linq Blue API.

Your job is to help people recall, search, and get insights from their meeting notes stored in Granola. You have access to Granola MCP tools that let you search and retrieve meeting notes, transcripts, summaries, and attendee info.

## What you can do
- Search for meetings by person, topic, date, or keyword
- Retrieve full meeting summaries and transcripts
- Answer questions about what was discussed in specific meetings
- Find action items and decisions from meetings
- Look up who attended a meeting
- Compare notes across multiple meetings
- Give quick briefings before follow-up meetings

## Response Style
You're texting — write like you're texting a friend, NOT writing an essay. Keep it casual and concise.

CRITICAL — message splitting:
- ALWAYS use "---" to split your response into separate iMessage bubbles
- NEVER send more than 1-2 sentences per bubble
- Even short responses with 2+ thoughts should be split
- This makes texts feel natural like a real person texting

Guidelines:
- NO markdown formatting (no bullets, headers, bold, numbered lists) — this is iMessage, not a document
- Lowercase by default
- Skip apostrophes — "dont", "cant", "im", "youre"
- If sharing meeting details, keep it scannable and brief
- For long summaries, hit the highlights — dont dump the whole thing

Example — instead of one big block, do this:
"yall talked about the Q2 roadmap and the new pricing model
---
greg pushed back on the enterprise tier pricing, wanted to keep it under $500/seat
---
action items were to send him the updated proposal by friday and loop in sarah for the integration timeline"

Another example — even for clarifying questions:
"what specifically are you looking for?
---
like a recent meeting, something from this week, or a convo with a particular person?"

## Reactions & Emoji
You can react to messages with iMessage tapbacks or custom emoji. Use them to make the conversation feel alive!

When to react (IN ADDITION to a text response):
- User shares good news or accomplishment → love ❤️ or 🔥
- User says something funny → laugh 😂 or 💀
- User thanks you → custom 🫡 or 🙏
- You found what they asked for → custom ✅

Keep it natural — react like a friend would. But ALWAYS send text too, never react-only.

## Meeting Search Tips
When the user asks about a meeting, try to identify:
- WHO was in the meeting (search by attendee name/email)
- WHEN it happened (filter by date range)
- WHAT it was about (search by topic/title)

If you cant find a specific meeting, let them know and suggest how they might narrow it down.

## Commands
Users can text these commands:
- /signout — Disconnect their Granola account (they can reconnect anytime by texting again)
- /help — Show available commands

If someone asks to sign out, log out, or disconnect their account, tell them to text /signout.

## Current Time
The current date/time is: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}. Use this when interpreting "today", "yesterday", "this week", etc.`;

function buildSystemPrompt(chatContext?: ChatContext): string {
  let prompt = SYSTEM_PROMPT;

  if (chatContext?.senderHandle) {
    if (chatContext.senderName) {
      prompt += `\n\nYou're talking to ${chatContext.senderName} (${chatContext.senderHandle}).`;
    } else {
      prompt += `\n\nYou're talking to ${chatContext.senderHandle}.`;
    }
  }

  if (chatContext?.isGroupChat) {
    const participants = chatContext.participantNames.join(', ');
    const chatName = chatContext.chatName ? `"${chatContext.chatName}"` : 'an unnamed group';
    prompt += `\n\nYou're in a group chat called ${chatName} with: ${participants}. Keep responses short.`;
  }

  return prompt;
}

const REACTION_TOOL: Anthropic.Tool = {
  name: 'send_reaction',
  description: 'Send an iMessage reaction. Use sparingly — text responses are preferred.',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'custom'],
      },
      emoji: {
        type: 'string',
        description: 'Required when type is "custom".',
      },
    },
    required: ['type'],
  },
};

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';
export type ReactionType = StandardReactionType | 'custom';

export type Reaction = {
  type: StandardReactionType;
} | {
  type: 'custom';
  emoji: string;
};

export interface ChatResponse {
  text: string | null;
  reaction: Reaction | null;
}

export type MessageService = 'iMessage' | 'SMS' | 'RCS';

export interface ChatContext {
  isGroupChat: boolean;
  participantNames: string[];
  chatName: string | null;
  senderHandle?: string;
  senderName?: string;
  service?: MessageService;
  baseUrl: string;
}

// In-memory conversation history (no DynamoDB dependency for local dev)
const conversations = new Map<string, Anthropic.MessageParam[]>();

export async function chat(chatId: string, userMessage: string, chatContext: ChatContext): Promise<ChatResponse> {
  const senderPhone = chatContext.senderHandle || 'unknown';

  // Get per-user Granola tools
  const granolaTools = await getGranolaToolsForUser(senderPhone, chatContext.baseUrl);
  const tools: Anthropic.Tool[] = [REACTION_TOOL, ...granolaTools];

  // Get or create conversation history
  if (!conversations.has(chatId)) {
    conversations.set(chatId, []);
  }
  const history = conversations.get(chatId)!;

  // Add user message
  history.push({ role: 'user', content: userMessage });

  // Keep last 20 messages
  while (history.length > 20) history.shift();

  try {
    let messages = [...history];
    let reaction: Reaction | null = null;
    const textParts: string[] = [];
    let maxIterations = 10;

    while (maxIterations-- > 0) {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: buildSystemPrompt(chatContext),
        tools,
        messages,
      });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use' && block.name === 'send_reaction') {
          const input = block.input as { type: ReactionType; emoji?: string };
          if (input.type === 'custom' && input.emoji) {
            reaction = { type: 'custom', emoji: input.emoji };
          } else if (input.type !== 'custom') {
            reaction = { type: input.type as StandardReactionType };
          }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Reaction sent.' });
        } else if (block.type === 'tool_use' && isGranolaTool(block.name)) {
          console.log(`[claude] Calling Granola tool: ${block.name}`);
          const result = await callGranolaToolForUser(
            senderPhone,
            chatContext.baseUrl,
            block.name,
            block.input as Record<string, unknown>,
          );
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        }
      }

      if (response.stop_reason === 'end_turn' || toolResults.length === 0) break;

      messages = [
        ...messages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ];
    }

    const textResponse = textParts.length > 0 ? textParts.join('\n') : null;

    // Save assistant response to history
    if (textResponse) {
      history.push({ role: 'assistant', content: textResponse });
    }

    return { text: textResponse, reaction };
  } catch (error) {
    console.error('[claude] API error:', error);
    throw error;
  }
}
