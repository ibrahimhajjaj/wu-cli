import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type pino from "pino";
import { DisconnectReason } from "@whiskeysockets/baileys";
import { handleDisconnect } from "../src/core/connection.js";

// handleDisconnect only calls .warn/.error/.info on the logger; a stub is
// enough and keeps the test output clean.
function stubLog(): pino.Logger {
  return { warn: () => {}, error: () => {}, info: () => {} } as unknown as pino.Logger;
}

// Pins the current reconnect/give-up classification for every
// DisconnectReason branch handleDisconnect knows about, plus the unknown-code
// fallback. This is the daemon's core resilience decision table - plan
// 012/013 refactors must keep these outcomes (or update them deliberately).
describe("handleDisconnect", () => {
  it("does not reconnect after loggedOut", () => {
    assert.equal(handleDisconnect(stubLog(), DisconnectReason.loggedOut), false);
  });

  it("reconnects on connectionLost and timedOut", () => {
    assert.equal(handleDisconnect(stubLog(), DisconnectReason.connectionLost), true);
    assert.equal(handleDisconnect(stubLog(), DisconnectReason.timedOut), true);
  });

  it("treats multideviceMismatch as fatal", () => {
    assert.equal(handleDisconnect(stubLog(), DisconnectReason.multideviceMismatch), false);
  });

  it("reconnects on connectionClosed", () => {
    assert.equal(handleDisconnect(stubLog(), DisconnectReason.connectionClosed), true);
  });

  it("connectionReplaced: fatal for a one-shot command, retryable for the daemon", () => {
    assert.equal(
      handleDisconnect(stubLog(), DisconnectReason.connectionReplaced, false),
      false,
      "non-daemon caller must give up so it can't loop forever"
    );
    assert.equal(
      handleDisconnect(stubLog(), DisconnectReason.connectionReplaced, true),
      true,
      "daemon caller must keep retrying"
    );
  });

  it("treats badSession as fatal", () => {
    assert.equal(handleDisconnect(stubLog(), DisconnectReason.badSession), false);
  });

  it("reconnects on unavailableService", () => {
    assert.equal(handleDisconnect(stubLog(), DisconnectReason.unavailableService), true);
  });

  it("reconnects on restartRequired", () => {
    assert.equal(handleDisconnect(stubLog(), DisconnectReason.restartRequired), true);
  });

  it("defaults to reconnect for an unrecognized status code", () => {
    assert.equal(handleDisconnect(stubLog(), 999999), true);
  });
});
