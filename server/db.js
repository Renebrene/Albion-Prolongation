'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS device_tokens (
    token       TEXT PRIMARY KEY,
    device_name TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0,
    last_seen   INTEGER,
    comment     TEXT
);

CREATE TABLE IF NOT EXISTS locations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    city       TEXT,
    address    TEXT,
    side       TEXT,
    format     TEXT,
    lat        REAL NOT NULL,
    lon        REAL NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
    id           TEXT PRIMARY KEY,
    device_token TEXT NOT NULL,
    name         TEXT,
    base_name    TEXT,
    city         TEXT,
    address      TEXT,
    lat          REAL,
    lon          REAL,
    checksum     TEXT,
    received_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_token TEXT NOT NULL,
    device_name  TEXT,
    log_id       TEXT NOT NULL,
    timestamp    INTEGER NOT NULL,
    level        TEXT NOT NULL,
    message      TEXT NOT NULL,
    context      TEXT,
    received_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_device   ON photos (device_token);
CREATE INDEX IF NOT EXISTS idx_photos_received ON photos (received_at);
CREATE INDEX IF NOT EXISTS idx_logs_device     ON logs (device_token);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp  ON logs (timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_level      ON logs (level);
CREATE INDEX IF NOT EXISTS idx_locations_updated ON locations (updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_unique ON logs (device_token, log_id);
`;

/** Добавляет колонку, если её ещё нет (простая миграция без версионирования). */
function ensureColumn(db, table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name);
    if (!columns.includes(column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

/**
 * Открывает (при необходимости создаёт) базу и применяет схему.
 * @param {string} [dbPath]
 * @returns {import('better-sqlite3').Database}
 */
function initDb(dbPath = path.join(__dirname, 'geophoto.db')) {
    const db = new Database(dbPath);

    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');

    db.exec(SCHEMA);

    // Миграции для баз, созданных до интеграции с файлохранилищем.
    ensureColumn(db, 'device_tokens', 'folder_id', 'TEXT');
    ensureColumn(db, 'device_tokens', 'storage_name', 'TEXT');
    ensureColumn(db, 'device_tokens', 'checked_at', 'INTEGER');
    ensureColumn(db, 'photos', 'storage_file_id', 'TEXT');
    ensureColumn(db, 'photos', 'storage_url', 'TEXT');
    ensureColumn(db, 'photos', 'name', 'TEXT');
    ensureColumn(db, 'photos', 'base_name', 'TEXT');
    ensureColumn(db, 'photos', 'city', 'TEXT');
    ensureColumn(db, 'locations', 'city', 'TEXT');
    ensureColumn(db, 'locations', 'address', 'TEXT');
    ensureColumn(db, 'locations', 'side', 'TEXT');
    ensureColumn(db, 'locations', 'format', 'TEXT');

    return db;
}

module.exports = { initDb };
