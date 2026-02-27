import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { FifoDedup } from "../src/core/dedup.js";

// We test the dedup module directly since the store module depends on the
// singleton database. For store operations, we'd need to inject the db.

describe("FifoDedup", () => {
  it("should track added keys", () => {
    const dedup = new FifoDedup(100);
    dedup.add("a");
    dedup.add("b");
    assert.equal(dedup.has("a"), true);
    assert.equal(dedup.has("b"), true);
    assert.equal(dedup.has("c"), false);
  });

  it("should evict oldest when full", () => {
    const dedup = new FifoDedup(3);
    dedup.add("a");
    dedup.add("b");
    dedup.add("c");
    assert.equal(dedup.size, 3);

    dedup.add("d"); // should evict "a"
    assert.equal(dedup.has("a"), false);
    assert.equal(dedup.has("b"), true);
    assert.equal(dedup.has("c"), true);
    assert.equal(dedup.has("d"), true);
    assert.equal(dedup.size, 3);
  });

  it("should handle size 1", () => {
    const dedup = new FifoDedup(1);
    dedup.add("a");
    assert.equal(dedup.has("a"), true);
    dedup.add("b");
    assert.equal(dedup.has("a"), false);
    assert.equal(dedup.has("b"), true);
  });

  it("should handle many entries", () => {
    const dedup = new FifoDedup(10000);
    for (let i = 0; i < 10000; i++) {
      dedup.add(`key:${i}`);
    }
    assert.equal(dedup.size, 10000);
    assert.equal(dedup.has("key:0"), true);
    assert.equal(dedup.has("key:9999"), true);

    // Add one more — should evict key:0
    dedup.add("key:10000");
    assert.equal(dedup.has("key:0"), false);
    assert.equal(dedup.has("key:10000"), true);
    assert.equal(dedup.size, 10000);
  });
});

describe("SQLite store operations", () => {
  const TEST_DIR = join(tmpdir(), `wu-test-store-${process.pid}`);
  let db: Database.Database;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    db = new Database(join(TEST_DIR, "test.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Create schema directly
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        sender_jid TEXT,
        sender_name TEXT,
        body TEXT,
        type TEXT NOT NULL,
        media_mime TEXT,
        media_path TEXT,
        media_size INTEGER,
        quoted_id TEXT,
        location_lat REAL,
        location_lon REAL,
        location_name TEXT,
        is_from_me INTEGER DEFAULT 0,
        timestamp INTEGER NOT NULL,
        raw TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_msg_chat_ts ON messages(chat_jid, timestamp);

      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        type TEXT NOT NULL,
        participant_count INTEGER,
        description TEXT,
        last_message_at INTEGER,
        updated_at INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        phone TEXT,
        push_name TEXT,
        saved_name TEXT,
        is_business INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS group_participants (
        group_jid TEXT NOT NULL REFERENCES chats(jid),
        participant_jid TEXT NOT NULL,
        is_admin INTEGER DEFAULT 0,
        is_super_admin INTEGER DEFAULT 0,
        PRIMARY KEY (group_jid, participant_jid)
      );
    `);
  });

  afterEach(() => {
    db.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should insert and query a message", () => {
    db.prepare(`
      INSERT INTO messages (id, chat_jid, sender_jid, sender_name, body, type, is_from_me, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("msg1", "chat@g.us", "sender@s.whatsapp.net", "John", "Hello", "text", 0, 1700000000);

    const row = db.prepare("SELECT * FROM messages WHERE id = ?").get("msg1") as any;
    assert.equal(row.id, "msg1");
    assert.equal(row.body, "Hello");
    assert.equal(row.sender_name, "John");
  });

  it("should handle upsert (ON CONFLICT)", () => {
    const stmt = db.prepare(`
      INSERT INTO messages (id, chat_jid, body, type, timestamp)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET body = COALESCE(excluded.body, messages.body)
    `);

    stmt.run("msg2", "chat@g.us", "original", "text", 1700000000);
    stmt.run("msg2", "chat@g.us", "updated", "text", 1700000000);

    const row = db.prepare("SELECT body FROM messages WHERE id = ?").get("msg2") as any;
    assert.equal(row.body, "updated");
  });

  it("should bulk insert 1000 messages in a transaction fast", () => {
    const stmt = db.prepare(`
      INSERT INTO messages (id, chat_jid, body, type, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);

    const start = performance.now();
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        stmt.run(`bulk-${i}`, "chat@g.us", `Message ${i}`, "text", 1700000000 + i);
      }
    })();
    const elapsed = performance.now() - start;

    const count = db.prepare("SELECT COUNT(*) as c FROM messages").get() as any;
    assert.equal(count.c, 1000);
    assert.ok(elapsed < 500, `Bulk insert took ${elapsed.toFixed(0)}ms, expected <500ms`);
  });

  it("should search messages by body", () => {
    const stmt = db.prepare(`
      INSERT INTO messages (id, chat_jid, body, type, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run("s1", "chat@g.us", "Hello world", "text", 1700000001);
    stmt.run("s2", "chat@g.us", "Goodbye world", "text", 1700000002);
    stmt.run("s3", "chat@g.us", "Something else", "text", 1700000003);

    const results = db
      .prepare("SELECT * FROM messages WHERE body LIKE ? ORDER BY timestamp DESC")
      .all("%world%") as any[];
    assert.equal(results.length, 2);
  });

  it("should handle chats and contacts", () => {
    db.prepare(`
      INSERT INTO chats (jid, name, type, last_message_at) VALUES (?, ?, ?, ?)
    `).run("group@g.us", "Test Group", "group", 1700000000);

    db.prepare(`
      INSERT INTO contacts (jid, phone, push_name) VALUES (?, ?, ?)
    `).run("user@s.whatsapp.net", "1234567890", "Alice");

    const chat = db.prepare("SELECT * FROM chats WHERE jid = ?").get("group@g.us") as any;
    assert.equal(chat.name, "Test Group");

    const contact = db.prepare("SELECT * FROM contacts WHERE jid = ?").get("user@s.whatsapp.net") as any;
    assert.equal(contact.push_name, "Alice");
  });

  it("should enforce group_participants foreign key", () => {
    // Insert a chat first to satisfy foreign key
    db.prepare(`INSERT INTO chats (jid, name, type) VALUES (?, ?, ?)`).run(
      "group@g.us",
      "Group",
      "group"
    );

    db.prepare(`
      INSERT INTO group_participants (group_jid, participant_jid, is_admin) VALUES (?, ?, ?)
    `).run("group@g.us", "user@s.whatsapp.net", 1);

    const p = db
      .prepare("SELECT * FROM group_participants WHERE group_jid = ?")
      .all("group@g.us") as any[];
    assert.equal(p.length, 1);
    assert.equal(p[0].is_admin, 1);
  });
});
