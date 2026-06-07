export const SCHEMA_VERSION = 5;

// FTS5 over the searchable text columns (external content table). Deletes use
// the 'delete' command with the OLD values — a plain DELETE can't locate the
// indexed terms and leaves the index corrupt (breaks ORDER BY rank).
export const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    body,
    transcript,
    ocr_text,
    content=messages,
    content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, body, transcript, ocr_text)
    VALUES (new.rowid, new.body, new.transcript, new.ocr_text);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, body, transcript, ocr_text)
    VALUES ('delete', old.rowid, old.body, old.transcript, old.ocr_text);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF body, transcript, ocr_text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, body, transcript, ocr_text)
    VALUES ('delete', old.rowid, old.body, old.transcript, old.ocr_text);
    INSERT INTO messages_fts(rowid, body, transcript, ocr_text)
    VALUES (new.rowid, new.body, new.transcript, new.ocr_text);
END;
`;

export const CREATE_TABLES_SQL = `
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
    media_direct_path TEXT,
    media_key TEXT,
    media_file_sha256 TEXT,
    media_file_enc_sha256 TEXT,
    media_file_length INTEGER,
    quoted_id TEXT,
    location_lat REAL,
    location_lon REAL,
    location_name TEXT,
    is_from_me INTEGER DEFAULT 0,
    timestamp INTEGER NOT NULL,
    raw TEXT,
    transcript TEXT,
    ocr_text TEXT,
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_msg_chat_ts ON messages(chat_jid, timestamp);
CREATE INDEX IF NOT EXISTS idx_msg_body ON messages(body) WHERE body IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender_jid, timestamp);
CREATE INDEX IF NOT EXISTS idx_msg_type ON messages(type);

-- FTS5 full-text search (external content, synced via triggers) — see FTS_SQL
${FTS_SQL}

CREATE TABLE IF NOT EXISTS chats (
    jid TEXT PRIMARY KEY,
    name TEXT,
    type TEXT NOT NULL,
    participant_count INTEGER,
    description TEXT,
    last_message_at INTEGER,
    last_seen_at INTEGER,
    is_community INTEGER DEFAULT 0,
    is_community_announce INTEGER DEFAULT 0,
    linked_parent TEXT,
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_chats_linked_parent ON chats(linked_parent) WHERE linked_parent IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chats_type ON chats(type);

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
`;
