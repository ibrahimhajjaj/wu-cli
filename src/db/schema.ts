export const SCHEMA_VERSION = 1;

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
CREATE INDEX IF NOT EXISTS idx_msg_body ON messages(body) WHERE body IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender_jid, timestamp);
CREATE INDEX IF NOT EXISTS idx_msg_type ON messages(type);

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
`;
