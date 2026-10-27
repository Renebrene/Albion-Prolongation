'use strict';

/**
 * validation.js — чистые функции валидации и нормализации входных данных.
 * Вынесены отдельно, чтобы их можно было покрыть unit-тестами без запуска сервера.
 */

const crypto = require('crypto');

const TOKEN_RE = /^[a-f0-9]{64}$/i;
const PHOTO_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
// Контракт API: клиент всегда отправляет JPEG (Canvas перекодирует HEIC/PNG).
const DATA_URL_RE = /^data:image\/(jpeg|jpg);base64,([A-Za-z0-9+/]+={0,2})$/;

const LOG_LEVELS = ['info', 'warn', 'error'];
const MAX_LOG_MESSAGE_LENGTH = 2000;
const MAX_LOG_CONTEXT_LENGTH = 8000;
const MAX_ADDRESS_LENGTH = 500;
const MAX_LOGS_PER_SYNC = 500;

function isValidToken(value) {
    return typeof value === 'string' && TOKEN_RE.test(value);
}

function isValidPhotoId(value) {
    return typeof value === 'string' && PHOTO_ID_RE.test(value);
}

/**
 * Разбирает data URL изображения.
 * @returns {{ mime: string, base64: string }|null}
 */
function parseImageDataUrl(value) {
    if (typeof value !== 'string') return null;
    const match = DATA_URL_RE.exec(value);
    if (!match) return null;

    let base64 = match[2];
    // Убираем padding для декодирования и снова добавляем при необходимости — Buffer справляется сам.
    if (!base64 || base64.length % 4 === 1) return null;

    return {
        mime: `image/${match[1] === 'jpg' ? 'jpeg' : match[1]}`,
        base64
    };
}

/** SHA-256 от base64-строки (именно её отправляет клиент). */
function checksumOfBase64(base64) {
    return crypto.createHash('sha256').update(base64, 'utf8').digest('hex');
}

/** Сравнение строк без утечки времени. */
function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    if (bufferA.length !== bufferB.length) return false;
    return crypto.timingSafeEqual(bufferA, bufferB);
}

/** Безопасный JSON.stringify с ограничением длины. */
function safeJson(value, maxLength = MAX_LOG_CONTEXT_LENGTH) {
    try {
        const json = JSON.stringify(value);
        if (typeof json !== 'string') return '{}';
        return json.length > maxLength ? JSON.stringify({ truncated: true, preview: json.slice(0, maxLength) }) : json;
    } catch (err) {
        return JSON.stringify({ unserializable: String(err && err.message ? err.message : err) });
    }
}

/**
 * Приводит запись лога с клиента к виду для вставки в БД.
 * @returns {{logId: string, timestamp: number, level: string, message: string, context: string}|null}
 */
function normalizeLogEntry(entry, now = Date.now()) {
    if (!entry || typeof entry !== 'object') return null;

    const logId = typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 200
        ? entry.id
        : null;
    if (!logId) return null;

    const message = typeof entry.message === 'string' ? entry.message.slice(0, MAX_LOG_MESSAGE_LENGTH) : '';
    if (!message) return null;

    const parsedTimestamp = Number(entry.timestamp);
    const timestamp = Number.isFinite(parsedTimestamp) && parsedTimestamp > 0
        ? Math.min(parsedTimestamp, now + 60 * 1000)
        : now;

    return {
        logId,
        timestamp,
        level: LOG_LEVELS.includes(entry.level) ? entry.level : 'info',
        message,
        context: safeJson(entry.context || {})
    };
}

function normalizeGps(gps) {
    if (!gps || typeof gps !== 'object') return null;
    const lat = Number(gps.lat);
    const lon = Number(gps.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
}

function normalizeAddress(address) {
    return typeof address === 'string' ? address.trim().slice(0, MAX_ADDRESS_LENGTH) : '';
}

/**
 * Проверяет тело запроса на создание/обновление локации.
 * @returns {{name: string, lat: number, lon: number}|null}
 */
function normalizeLocationInput(body) {
    if (!body || typeof body !== 'object') return null;

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 200) return null;

    const lat = Number(body.lat);
    const lon = Number(body.lon);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null;

    return { name, lat, lon };
}

/** Ограниченное целое из query-параметра. */
function clampInt(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

module.exports = {
    TOKEN_RE,
    PHOTO_ID_RE,
    LOG_LEVELS,
    MAX_LOGS_PER_SYNC,
    MAX_ADDRESS_LENGTH,
    isValidToken,
    isValidPhotoId,
    parseImageDataUrl,
    checksumOfBase64,
    constantTimeEqual,
    safeJson,
    normalizeLogEntry,
    normalizeGps,
    normalizeAddress,
    normalizeLocationInput,
    clampInt
};
