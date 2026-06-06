import {
  extractMessageContent,
  normalizeMessageContent,
  proto,
  type WAMessage,
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
  | "edited"
  | "album"
  | "system"
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
  if (content.protocolMessage?.editedMessage) {
    return extractText(content.protocolMessage.editedMessage);
  }

  return null;
}

export function extractMessageType(
  content: WAMessageContent | undefined
): MessageType {
  if (!content) return "unknown";

  if (content.reactionMessage) return "reaction";
  if (content.protocolMessage?.editedMessage) return "edited";
  if (content.albumMessage) return "album";
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

export function extractDocumentFileName(
  content: WAMessageContent | undefined
): string | null {
  if (!content) return null;
  const doc =
    content.documentMessage ||
    content.documentWithCaptionMessage?.message?.documentMessage;
  return doc?.fileName || null;
}

export interface AudioMeta {
  seconds: number | null;
  ptt: boolean;
}

export function extractAudioMeta(
  content: WAMessageContent | undefined
): AudioMeta | null {
  const audio = content?.audioMessage;
  if (!audio) return null;
  return {
    seconds: typeof audio.seconds === "number" ? audio.seconds : null,
    ptt: !!audio.ptt,
  };
}

export function extractAlbumLabel(
  content: WAMessageContent | undefined
): string {
  const album = content?.albumMessage;
  if (!album) return "[album]";
  const imgs = Number(album.expectedImageCount || 0);
  const vids = Number(album.expectedVideoCount || 0);
  const total = imgs + vids;
  return total > 0 ? `[album: ${total} item${total === 1 ? "" : "s"}]` : "[album]";
}

// Reverse map of the protobuf stub-type enum (number -> NAME), built once.
const STUB_NAME_BY_VALUE: Record<number, string> = Object.fromEntries(
  Object.entries(proto.WebMessageInfo.StubType).map(([name, value]) => [value, name])
);

// Friendly phrasing for the system events worth surfacing; anything else falls
// back to a humanised form of the enum name.
const STUB_PHRASES: Record<string, string> = {
  GROUP_CREATE: "group created",
  GROUP_CHANGE_SUBJECT: "group renamed",
  GROUP_CHANGE_DESCRIPTION: "group description changed",
  GROUP_CHANGE_ICON: "group icon changed",
  GROUP_PARTICIPANT_ADD: "participant added",
  GROUP_PARTICIPANT_INVITE: "participant invited",
  GROUP_PARTICIPANT_LEAVE: "participant left",
  GROUP_PARTICIPANT_REMOVE: "participant removed",
  GROUP_PARTICIPANT_PROMOTE: "participant promoted to admin",
  GROUP_PARTICIPANT_DEMOTE: "participant demoted",
  GROUP_PARTICIPANT_CHANGE_NUMBER: "participant changed number",
  GROUP_PARTICIPANT_LINKED_GROUP_JOIN: "joined via linked group",
  E2E_IDENTITY_CHANGED: "security code changed",
  E2E_ENCRYPTED: "messages are end-to-end encrypted",
  CIPHERTEXT: "waiting for this message",
  CALL_MISSED_VOICE: "missed voice call",
  CALL_MISSED_VIDEO: "missed video call",
};

function humanizeStub(name: string): string {
  return name.toLowerCase().replace(/_/g, " ");
}

// Resolve the messageStubType (stored as either the enum name or its number)
// into a human-readable event label. Returns null when there is no stub event.
export function extractSystemEvent(msg: WAMessage): string | null {
  const raw = msg.messageStubType;
  if (raw === null || raw === undefined) return null;

  let name: string | null = null;
  if (typeof raw === "string") {
    name = raw;
  } else if (typeof raw === "number") {
    name = STUB_NAME_BY_VALUE[raw] ?? null;
    if (name === null) return `event ${raw}`;
  }
  if (!name || name === "UNKNOWN") return null;

  return STUB_PHRASES[name] || humanizeStub(name);
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

export interface MediaResumeMetadata {
  directPath: string | null;
  mediaKey: string | null;
  fileSha256: string | null;
  fileEncSha256: string | null;
  fileLength: number | null;
}

function toBase64(val: Uint8Array | null | undefined): string | null {
  if (!val) return null;
  return Buffer.from(val).toString("base64");
}

export function extractMediaResumeMetadata(
  content: WAMessageContent | undefined
): MediaResumeMetadata | null {
  if (!content) return null;

  const mediaMsg =
    content.imageMessage ||
    content.videoMessage ||
    content.audioMessage ||
    content.documentMessage ||
    content.stickerMessage;

  if (!mediaMsg) return null;

  return {
    directPath: mediaMsg.directPath || null,
    mediaKey: toBase64(mediaMsg.mediaKey as Uint8Array | null | undefined),
    fileSha256: toBase64(mediaMsg.fileSha256 as Uint8Array | null | undefined),
    fileEncSha256: toBase64(mediaMsg.fileEncSha256 as Uint8Array | null | undefined),
    fileLength: typeof mediaMsg.fileLength === "number"
      ? mediaMsg.fileLength
      : typeof mediaMsg.fileLength === "object" && mediaMsg.fileLength != null
        ? Number(mediaMsg.fileLength)
        : null,
  };
}
