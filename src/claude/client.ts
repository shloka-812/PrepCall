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

export async function chat(chatId: string, userMessage: string, chatContext: ChatContext): Promise<ChatResponse> {
  void chatId;
  void userMessage;
  void chatContext;

  // Phase 1 cleanup removes Granola-specific tooling. Gemini integration lands in Phase 2.
  return {
    text: 'prepcall is booting. try /help for now.',
    reaction: null,
  };
}
