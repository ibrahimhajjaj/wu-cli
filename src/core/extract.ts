import {
  extractMessageContent,
  normalizeMessageContent,
  type WAMessage,
  type proto,
} from "@whiskeysockets/baileys";

export type MessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "contact"
  | "location"
  | "poll"
  | "reaction"
  | "deleted"
  | "unknown";

type WAMessageContent = proto.IMessage;

export function getMessageContent(
  msg: WAMessage
): WAMessageContent | undefined {
  const normalized = normalizeMessageContent(msg.message);
  return extractMessageContent(normalized) ?? undefined;
}

export function extractText(content: WAMessageContent | undefined): string | null {
  if (!content) return null;

  if (content.conversation) return content.conversation;
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
  if (content.imageMessage?.caption) return content.imageMessage.caption;
  if (content.videoMessage?.caption) return content.videoMessage.caption;
  if (content.documentMessage?.caption) return content.documentMessage.caption;
  if (content.contactMessage) {
    return content.contactMessage.vcard || content.contactMessage.displayName || null;
  }
  if (content.contactsArrayMessage?.contacts) {
    return content.contactsArrayMessage.contacts
      .map((c) => c.vcard || c.displayName)
      .filter(Boolean)
      .join("\n");
  }
  if (content.pollCreationMessage) {
    const poll = content.pollCreationMessage;
    const options = poll.options?.map((o) => o.optionName).join(", ") || "";
    return `Poll: ${poll.name}\nOptions: ${options}`;
  }
  if (content.pollCreationMessageV2) {
    const poll = content.pollCreationMessageV2;
    const options = poll.options?.map((o) => o.optionName).join(", ") || "";
    return `Poll: ${poll.name}\nOptions: ${options}`;
  }
  if (content.pollCreationMessageV3) {
    const poll = content.pollCreationMessageV3;
    const options = poll.options?.map((o) => o.optionName).join(", ") || "";
    return `Poll: ${poll.name}\nOptions: ${options}`;
  }
  if (content.locationMessage) {
    return content.locationMessage.name || content.locationMessage.address || null;
  }
  if (content.liveLocationMessage) {
    return content.liveLocationMessage.caption || null;
  }
  if (content.reactionMessage) {
    return content.reactionMessage.text || null;
  }

  return null;
}

export function extractMessageType(
  content: WAMessageContent | undefined
): MessageType {
  if (!content) return "unknown";

  if (content.reactionMessage) return "reaction";
  if (content.conversation || content.extendedTextMessage) return "text";
  if (content.imageMessage) return "image";
  if (content.videoMessage) return "video";
  if (content.audioMessage) return "audio";
  if (content.documentMessage || content.documentWithCaptionMessage) return "document";
  if (content.stickerMessage) return "sticker";
  if (content.contactMessage || content.contactsArrayMessage) return "contact";
  if (content.locationMessage || content.liveLocationMessage) return "location";
  if (
    content.pollCreationMessage ||
    content.pollCreationMessageV2 ||
    content.pollCreationMessageV3 ||
    content.pollUpdateMessage
  )
    return "poll";
  if (content.protocolMessage?.type === 0) return "deleted"; // REVOKE

  return "unknown";
}

export function extractQuotedId(
  content: WAMessageContent | undefined
): string | null {
  if (!content) return null;

  const contextInfo =
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.audioMessage?.contextInfo ||
    content.documentMessage?.contextInfo ||
    content.stickerMessage?.contextInfo;

  return contextInfo?.stanzaId || null;
}

export interface LocationData {
  lat: number;
  lon: number;
  name: string | null;
}

export function extractLocationData(
  content: WAMessageContent | undefined
): LocationData | null {
  if (!content) return null;

  const loc = content.locationMessage || content.liveLocationMessage;
  if (!loc || loc.degreesLatitude == null || loc.degreesLongitude == null) return null;

  return {
    lat: loc.degreesLatitude,
    lon: loc.degreesLongitude,
    name:
      (content.locationMessage as { name?: string })?.name ||
      (content.locationMessage as { address?: string })?.address ||
      null,
  };
}

export interface MediaInfo {
  mime: string | null;
  size: number | null;
}

export function extractMediaInfo(
  content: WAMessageContent | undefined
): MediaInfo | null {
  if (!content) return null;

  const mediaMsg =
    content.imageMessage ||
    content.videoMessage ||
    content.audioMessage ||
    content.documentMessage ||
    content.stickerMessage;

  if (!mediaMsg) return null;

  return {
    mime: mediaMsg.mimetype || null,
    size: typeof mediaMsg.fileLength === "number"
      ? mediaMsg.fileLength
      : typeof mediaMsg.fileLength === "object" && mediaMsg.fileLength != null
        ? Number(mediaMsg.fileLength)
        : null,
  };
}
