import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listChats,
  listContacts,
  listMessages,
  getGroupParticipants,
} from "../core/store.js";

export function registerResources(server: McpServer): void {
  // wu://chats
  server.resource("chats", "wu://chats", async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(listChats({ limit: 100 })),
      },
    ],
  }));

  // wu://chats/{jid}/messages
  server.resource(
    "chat-messages",
    "wu://chats/{jid}/messages",
    async (uri, _extra) => {
      // Extract jid from URI path: wu://chats/<jid>/messages
      const uriStr = uri.href;
      const match = uriStr.match(/wu:\/\/chats\/([^/]+)\/messages/);
      const jid = match ? decodeURIComponent(match[1]) : "";
      const url = new URL(uriStr);
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const before = url.searchParams.get("before")
        ? parseInt(url.searchParams.get("before")!, 10)
        : undefined;

      const messages = listMessages({ chatJid: jid, limit, before });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(messages),
          },
        ],
      };
    }
  );

  // wu://contacts
  server.resource("contacts", "wu://contacts", async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(listContacts({ limit: 100 })),
      },
    ],
  }));

  // wu://contacts/{jid}
  server.resource(
    "contact",
    "wu://contacts/{jid}",
    async (uri, _extra) => {
      const uriStr = uri.href;
      const match = uriStr.match(/wu:\/\/contacts\/([^/?]+)/);
      const jid = match ? decodeURIComponent(match[1]) : "";
      const all = listContacts({ limit: 10000 });
      const contact = all.find((c) => c.jid === jid);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(contact || null),
          },
        ],
      };
    }
  );

  // wu://groups
  server.resource("groups", "wu://groups", async (uri) => {
    const allChats = listChats({ limit: 500 });
    const groups = allChats.filter((c) => c.type === "group");
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(groups),
        },
      ],
    };
  });

  // wu://groups/{jid}
  server.resource(
    "group",
    "wu://groups/{jid}",
    async (uri, _extra) => {
      const uriStr = uri.href;
      const match = uriStr.match(/wu:\/\/groups\/([^/?]+)/);
      const jid = match ? decodeURIComponent(match[1]) : "";
      const allChats = listChats({ limit: 10000 });
      const chat = allChats.find((c) => c.jid === jid);
      const participants = getGroupParticipants(jid);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(chat ? { ...chat, participants } : null),
          },
        ],
      };
    }
  );

  // wu://status
  server.resource("status", "wu://status", async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ connected: true, timestamp: Date.now() }),
      },
    ],
  }));
}
