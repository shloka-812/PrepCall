// Linq Blue V3 Webhook Types (2026-02-03 payload version)
// Ref: https://apidocs.linqapp.com/webhook-events

export interface WebhookEvent {
  api_version: 'v3';
  webhook_version?: string;
  event_id: string;
  created_at: string;
  trace_id: string;
  partner_id: string;
  event_type: string;
  data: unknown;
}

export interface HandleInfo {
  handle: string;
  id: string;
  is_me: boolean;
  joined_at: string;
  left_at: string | null;
  service: 'iMessage' | 'SMS' | 'RCS';
  status: string;
}

export interface ChatInfo {
  id: string;
  is_group: boolean;
  owner_handle: HandleInfo;
}

export interface MessageReceivedData {
  // New 2026-02-03 payload format
  chat: ChatInfo;
  sender_handle: HandleInfo;
  id: string;
  direction: 'inbound' | 'outbound';
  parts: MessagePart[];
  effect: MessageEffect | null;
  reply_to: ReplyTo | null;
  sent_at: string;
  service: 'iMessage' | 'SMS' | 'RCS';

  // Legacy fields (older webhook versions)
  chat_id?: string;
  from?: string;
  recipient_phone?: string;
  is_from_me?: boolean;
  message?: {
    id: string;
    parts: MessagePart[];
    effect?: MessageEffect;
    reply_to?: ReplyTo;
  };
}

export interface MessageReceivedEvent extends WebhookEvent {
  event_type: 'message.received';
  data: MessageReceivedData;
}

export interface TextPart {
  type: 'text';
  value: string;
  text_decorations?: unknown;
}

export interface MediaPart {
  type: 'media';
  url?: string;
  attachment_id?: string;
  filename?: string;
  mime_type?: string;
  size?: number;
}

export type MessagePart = TextPart | MediaPart;

export interface MessageEffect {
  type: 'screen' | 'bubble';
  name: string;
}

export interface ReplyTo {
  message_id: string;
  part_index?: number;
}

export function isMessageReceivedEvent(event: WebhookEvent): event is MessageReceivedEvent {
  return event.event_type === 'message.received';
}

/**
 * Extract fields from webhook data, handling both new and legacy formats.
 */
export function extractEventFields(data: MessageReceivedData) {
  // New format (2026-02-03)
  if (data.chat && data.sender_handle) {
    return {
      chatId: data.chat.id,
      from: data.sender_handle.handle,
      recipientPhone: data.chat.owner_handle.handle,
      isFromMe: data.sender_handle.is_me,
      messageId: data.id,
      parts: data.parts,
      effect: data.effect ?? undefined,
      replyTo: data.reply_to ?? undefined,
      service: data.service || data.sender_handle.service,
    };
  }

  // Legacy format
  return {
    chatId: data.chat_id!,
    from: data.from!,
    recipientPhone: data.recipient_phone!,
    isFromMe: data.is_from_me!,
    messageId: data.message!.id,
    parts: data.message!.parts,
    effect: data.message?.effect,
    replyTo: data.message?.reply_to,
    service: data.service,
  };
}

export function extractTextContent(parts: MessagePart[]): string {
  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map(part => part.value)
    .join('\n');
}

export interface ExtractedMedia {
  url: string;
  mimeType: string;
}

export function extractImageUrls(parts: MessagePart[]): ExtractedMedia[] {
  return parts
    .filter((part): part is MediaPart =>
      part.type === 'media' &&
      !!part.url &&
      !!part.mime_type &&
      part.mime_type.startsWith('image/')
    )
    .map(part => ({ url: part.url!, mimeType: part.mime_type! }));
}

export function extractAudioUrls(parts: MessagePart[]): ExtractedMedia[] {
  return parts
    .filter((part): part is MediaPart =>
      part.type === 'media' &&
      !!part.url &&
      !!part.mime_type &&
      part.mime_type.startsWith('audio/')
    )
    .map(part => ({ url: part.url!, mimeType: part.mime_type! }));
}
