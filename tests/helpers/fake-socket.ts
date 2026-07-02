import { EventEmitter } from "node:events";
import type { WASocket } from "@whiskeysockets/baileys";

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export interface FakeSocket {
  sock: WASocket;
  ev: EventEmitter;
  calls: RecordedCall[];
  emitUpsert: (messages: unknown[], type?: string) => void;
  emitUpdate: (updates: unknown[]) => void;
  emitReaction: (reactions: unknown[]) => void;
}

// Minimal stand-in for a Baileys WASocket. `ev` is a real EventEmitter so
// listener.ts's `sock.ev.on("messages.upsert", handler)` wiring works
// unmodified. Every socket method the code under test calls is recorded in
// `calls` so tests can assert exact call shape without a real connection.
export function makeFakeSocket(): FakeSocket {
  const ev = new EventEmitter();
  const calls: RecordedCall[] = [];

  const record =
    (method: string, result: unknown = { key: { id: "fake-msg-id", fromMe: true }, messageTimestamp: 1700000000 }) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return result;
    };

  const sock = {
    ev,
    sendMessage: record("sendMessage"),
    sendPresenceUpdate: record("sendPresenceUpdate", undefined),
    updateMediaMessage: record("updateMediaMessage"),
    requestPairingCode: record("requestPairingCode", "ABCD-1234"),
    end: record("end", undefined),
  };

  return {
    sock: sock as unknown as WASocket,
    ev,
    calls,
    emitUpsert: (messages: unknown[], type = "notify") =>
      ev.emit("messages.upsert", { messages, type }),
    emitUpdate: (updates: unknown[]) => ev.emit("messages.update", updates),
    emitReaction: (reactions: unknown[]) => ev.emit("messages.reaction", reactions),
  };
}
