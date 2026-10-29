'use strict';

/**
 * server.js — Express API GeoPhoto.
 *
 * Публичные маршруты:      POST /api/pair
 * Защищённые (X-Device-Token): POST /api/locations, POST /api/upload, GET /api/status
 * Админские (X-Admin-Secret):  /admin/tokens, /admin/logs, /admin/devices, /admin/stats
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { initDb } = require('./db');
const {
    LOG_LEVELS,
    MAX_LOGS_PER_SYNC,
    isValidPhotoId,
    parseImageDataUrl,
    checksumOfBase64,
    constantTimeEqual,
    normalizeLogEntry,
    normalizeGps,
    normalizeAddress,
    normalizeLocationInput,
    clampInt
} = require('./validation');
const {
    isSimpleToken,
    generateToken: generateSimpleToken,
    decodeToken
} = require('./simple-token');
const { StorageClient, StorageError, loadConfig } = require('./storage');
const { XlsxSync, XlsxSyncError } = require('./xlsx-sync');

// ------------------------------------------------------------------ конфиг

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'geophoto.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const MAX_PHOTO_BYTES = Number(process.env.MAX_PHOTO_BYTES) || 15 * 1024 * 1024;
const SERVE_CLIENT = process.env.SERVE_CLIENT !== 'false';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

if (!ADMIN_SECRET) {
    console.warn('[GeoPhoto] ADMIN_SECRET не задан — админ-панель недоступна.');
    console.warn('[GeoPhoto] Задайте переменную окружения ADMIN_SECRET и перезапустите сервер.');
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = initDb(DB_PATH);

const integrationConfig = loadConfig();
const storage = new StorageClient(integrationConfig);

if (storage.verifyEnabled) {
    console.log(`[GeoPhoto] Файлохранилище: ${integrationConfig.baseUrl}`);
} else {
    console.log('[GeoPhoto] Файлохранилище не настроено — локальный режим токенов.');
}
if (storage.verifyEnabled && !storage.dbEnabled) {
    console.warn('[GeoPhoto] Папка «база данных» не настроена: XLSX-синхронизация отключена.');
}

// ---------------------------------------------------- обмен базой локаций

function settingGet(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
}

function settingSet(key, value) {
    db.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, String(value), Date.now());
}

const xlsxSync = new XlsxSync({
    storage,
    db,
    config: integrationConfig,
    settings: { get: settingGet, set: settingSet }
});

let xlsxRefreshInProgress = false;

/** Принудительная или плановая проверка XLSX в файлохранилище. */
async function runXlsxRefresh(options = {}) {
    if (!storage.dbEnabled) {
        throw new XlsxSyncError('STORAGE_DB_DISABLED', 'Папка «база данных» не настроена');
    }
    if (xlsxRefreshInProgress) {
        throw new XlsxSyncError('SYNC_IN_PROGRESS', 'Синхронизация уже выполняется');
    }

    xlsxRefreshInProgress = true;
    try {
        return await xlsxSync.refresh({
            force: Boolean(options.force),
            throttle: !options.force
        });
    } finally {
        xlsxRefreshInProgress = false;
    }
}

/** Проверка XLSX без фатальной ошибки: при сбое работаем по кэшу. */
async function maybeRefreshLocations() {
    if (!storage.dbEnabled) return null;
    try {
        return await runXlsxRefresh({});
    } catch (err) {
        console.warn('[GeoPhoto] Проверка XLSX не удалась:', err.message);
        return null;
    }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

app.use(cors({ origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map((item) => item.trim()) }));
app.use(express.json({ limit: '30mb' }));

// ----------------------------------------------------------- rate limiting

/**
 * Простой in-memory rate limiter без внешних зависимостей.
 */
function createRateLimiter({ windowMs = 60_000, max = 120 } = {}) {
    const hits = new Map();

    const cleanup = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) {
            if (entry.reset <= now) hits.delete(key);
        }
    }, windowMs);
    if (typeof cleanup.unref === 'function') cleanup.unref();

    return (req, res, next) => {
        const key = req.ip || 'unknown';
        const now = Date.now();
        let entry = hits.get(key);

        if (!entry || entry.reset <= now) {
            entry = { count: 0, reset: now + windowMs };
            hits.set(key, entry);
        }

        entry.count += 1;
        res.setHeader('X-RateLimit-Limit', String(max));
        res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));

        if (entry.count > max) {
            res.setHeader('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
            return res.status(429).json({ error: 'TOO_MANY_REQUESTS' });
        }

        return next();
    };
}

const apiLimiter = createRateLimiter({ max: 120 });
const uploadLimiter = createRateLimiter({ max: 30 });
const adminLimiter = createRateLimiter({ max: 120 });
const pairLimiter = createRateLimiter({ max: 20 });

// -------------------------------------------------------------- middleware

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** Приводит ISO-дату из файлохранилища к timestamp (или null). */
function parseStorageExpiry(value) {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Перепроверяет токен в файлохранилище и обновляет локальную запись устройства.
 * Бросает StorageError при отказе или недоступности хранилища.
 */
async function refreshDeviceFromStorage(device, token) {
    const info = await storage.verifyToken(token, { force: true });
    const expiresAt = parseStorageExpiry(info.expiresAt);
    const effectiveExpiry = expiresAt || (Date.now() + TEN_YEARS_MS);

    db.prepare(`
        UPDATE device_tokens
        SET folder_id = ?, storage_name = ?, expires_at = ?, checked_at = ?, revoked = 0
        WHERE token = ?
    `).run(info.folderId || null, info.name || null, effectiveExpiry, Date.now(), token);

    return Object.assign({}, device, {
        folder_id: info.folderId || null,
        storage_name: info.name || null,
        expires_at: effectiveExpiry,
        checked_at: Date.now(),
        revoked: 0
    });
}

async function requireDeviceToken(req, res, next) {
    try {
        const token = decodeToken(req.get('X-Device-Token'));

        if (!isSimpleToken(token)) {
            return res.status(401).json({ error: 'TOKEN_INVALID' });
        }

        let device = db.prepare('SELECT * FROM device_tokens WHERE token = ?').get(token);
        if (!device) return res.status(401).json({ error: 'TOKEN_INVALID' });

        if (storage.verifyEnabled) {
            const ttlMs = integrationConfig.verifyTtlSeconds * 1000;
            if (!device.checked_at || Date.now() - device.checked_at >= ttlMs) {
                try {
                    device = await refreshDeviceFromStorage(device, token);
                } catch (err) {
                    if (err instanceof StorageError && err.status === 401) {
                        db.prepare('DELETE FROM device_tokens WHERE token = ?').run(token);
                        return res.status(401).json({ error: 'TOKEN_INVALID' });
                    }
                    if (err instanceof StorageError && err.status === 403) {
                        db.prepare(
                            'UPDATE device_tokens SET revoked = 1, checked_at = ? WHERE token = ?'
                        ).run(Date.now(), token);
                        return res.status(403).json({ error: 'TOKEN_REVOKED' });
                    }
                    // Хранилище недоступно: работаем по кэшу, пока токен не истёк.
                    console.warn('[GeoPhoto] Не удалось перепроверить токен:', err.message);
                }
            }
        }

        if (device.revoked) return res.status(403).json({ error: 'TOKEN_REVOKED' });
        if (device.expires_at && device.expires_at <= Date.now()) {
            return res.status(403).json({ error: 'TOKEN_EXPIRED' });
        }

        db.prepare('UPDATE device_tokens SET last_seen = ? WHERE token = ?').run(Date.now(), token);

        req.device = device;
        req.deviceToken = token;
        return next();
    } catch (err) {
        return next(err);
    }
}

function requireAdmin(req, res, next) {
    if (!ADMIN_SECRET) return res.status(503).json({ error: 'ADMIN_NOT_CONFIGURED' });

    const provided = req.get('X-Admin-Secret')
        || (typeof req.query.secret === 'string' ? req.query.secret : '');

    if (!provided || !constantTimeEqual(provided, ADMIN_SECRET)) {
        return res.status(401).json({ error: 'ADMIN_UNAUTHORIZED' });
    }

    return next();
}

// -------------------------------------------------------------- публичные API

app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: Date.now() });
});

/**
 * POST /api/pair
 * Body: { token, deviceName }
 */
app.post('/api/pair', pairLimiter, async (req, res, next) => {
    try {
        const body = req.body || {};
        const token = decodeToken(body.token);
        const deviceName = typeof body.deviceName === 'string' ? body.deviceName.trim() : '';

        if (!isSimpleToken(token)) {
            return res.status(401).json({ error: 'TOKEN_INVALID' });
        }
        if (!deviceName || deviceName.length > 100) {
            return res.status(400).json({ error: 'INVALID_DEVICE_NAME' });
        }

        const now = Date.now();
        let expiresAt = now + 365 * 24 * 60 * 60 * 1000;
        let folderId = null;
        let storageName = null;

        if (storage.verifyEnabled) {
            let info;
            try {
                info = await storage.verifyToken(token, { force: true });
            } catch (err) {
                if (err instanceof StorageError && err.status === 401) {
                    return res.status(401).json({ error: 'TOKEN_INVALID' });
                }
                if (err instanceof StorageError && err.status === 403) {
                    return res.status(403).json({ error: 'TOKEN_FORBIDDEN' });
                }
                if (err instanceof StorageError && err.status === 0) {
                    return res.status(503).json({ error: 'STORAGE_UNAVAILABLE' });
                }
                throw err;
            }

            if (!info.folderId) {
                return res.status(403).json({ error: 'FOLDER_NOT_BOUND' });
            }
            if (!info.scopes.includes('upload') && !info.scopes.includes('*')) {
                return res.status(403).json({ error: 'UPLOAD_NOT_ALLOWED' });
            }

            folderId = info.folderId;
            storageName = info.name || null;

            const parsedExpiry = parseStorageExpiry(info.expiresAt);
            if (info.expiresAt && parsedExpiry === null) {
                return res.status(502).json({ error: 'STORAGE_ERROR' });
            }
            if (parsedExpiry && parsedExpiry <= now) {
                return res.status(403).json({ error: 'TOKEN_EXPIRED' });
            }
            expiresAt = parsedExpiry || (now + TEN_YEARS_MS);
        } else {
            const device = db.prepare('SELECT * FROM device_tokens WHERE token = ?').get(token);
            if (!device) return res.status(401).json({ error: 'TOKEN_INVALID' });
            if (device.revoked) return res.status(403).json({ error: 'TOKEN_REVOKED' });
            if (device.expires_at <= Date.now()) {
                return res.status(403).json({ error: 'TOKEN_EXPIRED' });
            }
            expiresAt = device.expires_at;
            folderId = device.folder_id || null;
            storageName = device.storage_name || null;
        }

        db.prepare(`
            INSERT INTO device_tokens
                (token, device_name, created_at, expires_at, revoked, last_seen, comment,
                 folder_id, storage_name, checked_at)
            VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?, ?)
            ON CONFLICT(token) DO UPDATE SET
                device_name = excluded.device_name,
                expires_at = excluded.expires_at,
                revoked = 0,
                last_seen = excluded.last_seen,
                folder_id = excluded.folder_id,
                storage_name = excluded.storage_name,
                checked_at = excluded.checked_at
        `).run(token, deviceName, now, expiresAt, now, folderId, storageName, now);

        return res.json({
            success: true,
            deviceName,
            expiresAt,
            brigade: storageName,
            folderId
        });
    } catch (err) {
        return next(err);
    }
});

// ------------------------------------------------------------ защищённые API

/**
 * POST /api/locations?since=<timestamp>
 * Body: { logs: [...] }
 * Отдаёт локации, обновлённые после since, и принимает накопленные логи.
 */
app.post('/api/locations', apiLimiter, requireDeviceToken, async (req, res, next) => {
    try {
        // Кнопка «Синхронизировать» передаёт refresh=1 — проверяем файл сразу,
        // фоновая/стартовая синхронизация использует троттлинг.
        if (storage.dbEnabled) {
            if (req.query.refresh === '1') {
                try {
                    await runXlsxRefresh({ force: true });
                } catch (err) {
                    console.warn('[GeoPhoto] Не удалось обновить XLSX:', err.message);
                }
            } else {
                await maybeRefreshLocations();
            }
        }

        return handleLocationsSync(req, res);
    } catch (err) {
        return next(err);
    }
});

function handleLocationsSync(req, res) {
    const rawSince = req.query.since;
    const since = rawSince === undefined ? 0 : Number(rawSince);

    if (!Number.isFinite(since) || since < 0) {
        return res.status(400).json({ error: 'INVALID_SINCE' });
    }

    const rawLogs = req.body ? req.body.logs : undefined;
    if (rawLogs !== undefined && !Array.isArray(rawLogs)) {
        return res.status(400).json({ error: 'INVALID_LOGS' });
    }
    if (Array.isArray(rawLogs) && rawLogs.length > MAX_LOGS_PER_SYNC) {
        return res.status(400).json({ error: 'TOO_MANY_LOGS' });
    }

    const now = Date.now();
    const entries = (rawLogs || [])
        .map((entry) => normalizeLogEntry(entry, now))
        .filter(Boolean);

    if (entries.length > 0) {
        const insertLog = db.prepare(`
            INSERT OR IGNORE INTO logs
                (device_token, device_name, log_id, timestamp, level, message, context, received_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMany = db.transaction((items) => {
            for (const item of items) {
                insertLog.run(
                    req.device.token,
                    req.device.device_name,
                    item.logId,
                    item.timestamp,
                    item.level,
                    item.message,
                    item.context,
                    now
                );
            }
        });

        insertMany(entries);
    }

    // Если ревизия SQL не изменилась, список не передаём: устройство
    // продолжает работать с локальной копией в IndexedDB.
    const revision = settingGet('locations_revision') || null;
    const clientRevision = typeof req.query.clientRevision === 'string'
        ? req.query.clientRevision
        : '';
    const shouldSend = !revision || !clientRevision || clientRevision !== revision;

    const locations = shouldSend
        ? db.prepare(`
            SELECT id, name, city, address, side, format, lat, lon,
                   updated_at AS updatedAt
            FROM locations
            ORDER BY id
        `).all()
        : null;

    const totalLogs = Array.isArray(rawLogs) ? rawLogs.length : 0;

    return res.json({
        locations,
        changed: shouldSend,
        revision,
        serverTime: now,
        logsAccepted: entries.length === totalLogs
    });
}

/** Безопасное имя файла для файлохранилища: «Наименование (1).jpg». */
function sanitizePhotoFilename(name, fallbackId) {
    const base = String(name || '')
        .replace(/\.(jpe?g|png|webp)$/i, '')
        .replace(/[^\wа-яёА-ЯЁ\s\-.,()№]+/gi, ' ')
        .replace(/^\.+/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    return `${base || fallbackId}.jpg`;
}

/**
 * POST /api/upload
 * Body: { id, name, city, address, gps, image, checksum }
 */
app.post('/api/upload', uploadLimiter, requireDeviceToken, async (req, res, next) => {
    try {
        const body = req.body || {};

    if (!isValidPhotoId(body.id)) {
        return res.status(400).json({ error: 'INVALID_PHOTO_ID' });
    }

    const parsedImage = parseImageDataUrl(body.image);
    if (!parsedImage) {
        return res.status(400).json({ error: 'INVALID_IMAGE' });
    }

    const buffer = Buffer.from(parsedImage.base64, 'base64');
    if (buffer.length === 0) {
        return res.status(400).json({ error: 'INVALID_IMAGE' });
    }
    if (buffer.length > MAX_PHOTO_BYTES) {
        return res.status(413).json({ error: 'PHOTO_TOO_LARGE' });
    }

    const expectedChecksum = checksumOfBase64(parsedImage.base64);
    if (!constantTimeEqual(String(body.checksum || '').toLowerCase(), expectedChecksum)) {
        return res.status(400).json({ error: 'CHECKSUM_MISMATCH' });
    }

    const existing = db.prepare(`
        SELECT device_token, name, base_name, storage_file_id, storage_url
        FROM photos WHERE id = ?
    `).get(body.id);
    if (existing && existing.device_token !== req.device.token) {
        return res.status(409).json({ error: 'PHOTO_ID_TAKEN' });
    }

    const gps = normalizeGps(body.gps);
    const city = normalizeAddress(body.city);
    const address = normalizeAddress(body.address);
    const requestedName = normalizeAddress(body.name);
    const fallbackName = [city, address].filter(Boolean).join(', ') || `Фото ${body.id}`;
    const baseName = requestedName || fallbackName;

    // Имя фото — колонка «Наименование» из базы. Если на один объект
    // приходится несколько фото, добавляем итерацию: «Название (1)», «(2)», ...
    let assignedName;
    let storedBaseName;
    if (existing && existing.name) {
        assignedName = existing.name;
        storedBaseName = existing.base_name || baseName;
    } else {
        storedBaseName = baseName;
        const count = db.prepare(`
            SELECT COUNT(*) AS count
            FROM photos
            WHERE device_token = ? AND (base_name = ? OR name = ?)
        `).get(req.device.token, storedBaseName, storedBaseName).count;
        assignedName = `${storedBaseName} (${count + 1})`;
    }

    const storageFilename = sanitizePhotoFilename(assignedName, body.id);
    const now = Date.now();

    const filePath = path.join(UPLOAD_DIR, `${body.id}.jpg`);
    try {
        fs.writeFileSync(filePath, buffer);
    } catch (err) {
        console.error('[GeoPhoto] Не удалось сохранить файл', err);
        return res.status(500).json({ error: 'STORAGE_ERROR' });
    }

        let storageFileId = null;
        let storageUrl = null;

        if (storage.verifyEnabled) {
            if (!req.device.folder_id) {
                return res.status(403).json({ error: 'FOLDER_NOT_BOUND' });
            }

            // Повторная отправка того же фото не должна создавать копию в Albion.
            if (existing && existing.storage_file_id) {
                storageFileId = existing.storage_file_id;
                storageUrl = existing.storage_url || null;
            } else try {
                const uploaded = await storage.uploadToFolder(req.deviceToken, req.device.folder_id, {
                    buffer,
                    filename: storageFilename,
                    displayName: assignedName,
                    contentType: 'image/jpeg'
                });
                storageFileId = uploaded && uploaded.file_id ? uploaded.file_id : null;
                storageUrl = uploaded && uploaded.url ? uploaded.url : null;
            } catch (err) {
                console.error('[GeoPhoto] Ошибка загрузки в файлохранилище:', err.message);
                if (err instanceof StorageError) {
                    if (err.status === 401) return res.status(401).json({ error: 'TOKEN_INVALID' });
                    if (err.status === 403) return res.status(403).json({ error: 'STORAGE_FORBIDDEN' });
                    if (err.status === 413) return res.status(413).json({ error: 'PHOTO_TOO_LARGE' });
                    if (err.status === 0) return res.status(503).json({ error: 'STORAGE_UNAVAILABLE' });
                }
                return res.status(502).json({ error: 'STORAGE_UPLOAD_FAILED' });
            }
        }

        db.prepare(`
            INSERT INTO photos
                (id, device_token, name, base_name, city, address, lat, lon,
                 checksum, received_at, storage_file_id, storage_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                base_name = excluded.base_name,
                city = excluded.city,
                address = excluded.address,
                lat = excluded.lat,
                lon = excluded.lon,
                checksum = excluded.checksum,
                received_at = excluded.received_at,
                storage_file_id = excluded.storage_file_id,
                storage_url = excluded.storage_url
        `).run(
            body.id,
            req.device.token,
            assignedName,
            storedBaseName,
            city,
            address,
            gps ? gps.lat : null,
            gps ? gps.lon : null,
            expectedChecksum,
            now,
            storageFileId,
            storageUrl
        );

        return res.json({
            success: true,
            id: body.id,
            name: assignedName,
            checksum: expectedChecksum,
            size: buffer.length,
            storage: storageFileId ? { fileId: storageFileId, url: storageUrl } : null
        });
    } catch (err) {
        return next(err);
    }
});

app.get('/api/status', apiLimiter, requireDeviceToken, (req, res) => {
    res.json({
        deviceName: req.device.device_name,
        brigade: req.device.storage_name || null,
        expiresAt: req.device.expires_at,
        locationsRevision: settingGet('locations_revision') || null,
        serverTime: Date.now()
    });
});

// ---------------------------------------------------------------- админ API

/**
 * GET /admin/tokens
 */
app.get('/admin/tokens', adminLimiter, requireAdmin, (req, res) => {
    const tokens = db.prepare(`
        SELECT token, device_name AS deviceName, created_at AS createdAt,
               expires_at AS expiresAt, revoked, last_seen AS lastSeen, comment,
               folder_id AS folderId, storage_name AS storageName
        FROM device_tokens
        ORDER BY created_at DESC
    `).all().map((row) => Object.assign({}, row, { revoked: Boolean(row.revoked) }));

    res.json({ tokens, managedByStorage: storage.verifyEnabled });
});

/**
 * POST /admin/tokens
 * Body: { deviceName, ttlDays, comment }
 */
app.post('/admin/tokens', adminLimiter, requireAdmin, (req, res) => {
    if (storage.verifyEnabled) {
        return res.status(409).json({ error: 'TOKENS_MANAGED_BY_STORAGE' });
    }

    const body = req.body || {};
    const deviceName = typeof body.deviceName === 'string' ? body.deviceName.trim() : '';
    if (!deviceName || deviceName.length > 100) {
        return res.status(400).json({ error: 'INVALID_DEVICE_NAME' });
    }

    const ttlDays = clampInt(body.ttlDays, 1, 3650, 365);
    const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : null;
    const token = generateSimpleToken();
    const now = Date.now();
    const expiresAt = now + ttlDays * 24 * 60 * 60 * 1000;

    db.prepare(`
        INSERT INTO device_tokens
            (token, device_name, created_at, expires_at, revoked, comment, folder_id, storage_name, checked_at)
        VALUES (?, ?, ?, ?, 0, ?, NULL, NULL, NULL)
    `).run(token, deviceName, now, expiresAt, comment);

    return res.status(201).json({ token, deviceName, createdAt: now, expiresAt, comment });
});

app.post('/admin/tokens/:token/revoke', adminLimiter, requireAdmin, (req, res) => {
    const result = db.prepare('UPDATE device_tokens SET revoked = 1 WHERE token = ?').run(req.params.token);
    if (result.changes === 0) return res.status(404).json({ error: 'TOKEN_NOT_FOUND' });
    return res.json({ success: true });
});

app.post('/admin/tokens/:token/activate', adminLimiter, requireAdmin, (req, res) => {
    const result = db.prepare('UPDATE device_tokens SET revoked = 0 WHERE token = ?').run(req.params.token);
    if (result.changes === 0) return res.status(404).json({ error: 'TOKEN_NOT_FOUND' });
    return res.json({ success: true });
});

app.delete('/admin/tokens/:token', adminLimiter, requireAdmin, (req, res) => {
    const result = db.prepare('DELETE FROM device_tokens WHERE token = ?').run(req.params.token);
    if (result.changes === 0) return res.status(404).json({ error: 'TOKEN_NOT_FOUND' });
    return res.json({ success: true });
});

/**
 * GET /admin/logs?device=&level=&limit=&offset=
 */
app.get('/admin/logs', adminLimiter, requireAdmin, (req, res) => {
    const conditions = [];
    const params = [];

    if (typeof req.query.device === 'string' && req.query.device) {
        conditions.push('device_token = ?');
        params.push(req.query.device);
    }

    if (typeof req.query.level === 'string' && req.query.level) {
        if (!LOG_LEVELS.includes(req.query.level)) {
            return res.status(400).json({ error: 'INVALID_LEVEL' });
        }
        conditions.push('level = ?');
        params.push(req.query.level);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = clampInt(req.query.limit, 1, 1000, 100);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);

    const logs = db.prepare(`
        SELECT id, device_token AS deviceToken, device_name AS deviceName, log_id AS logId,
               timestamp, level, message, context, received_at AS receivedAt
        FROM logs
        ${where}
        ORDER BY timestamp DESC, id DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const total = db.prepare(`SELECT COUNT(*) AS count FROM logs ${where}`).get(...params).count;

    res.json({ logs, total, limit, offset });
});

/**
 * DELETE /admin/logs?olderThanDays=30
 */
app.delete('/admin/logs', adminLimiter, requireAdmin, (req, res) => {
    const days = clampInt(req.query.olderThanDays, 1, 3650, 30);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = db.prepare('DELETE FROM logs WHERE received_at < ?').run(cutoff);
    res.json({ success: true, deleted: result.changes });
});

/**
 * GET /admin/devices
 */
app.get('/admin/devices', adminLimiter, requireAdmin, (req, res) => {
    const devices = db.prepare(`
        SELECT t.token, t.device_name AS deviceName, t.created_at AS createdAt,
               t.expires_at AS expiresAt, t.revoked, t.last_seen AS lastSeen,
               (SELECT COUNT(*) FROM photos p WHERE p.device_token = t.token) AS photos,
               (SELECT COUNT(*) FROM logs l WHERE l.device_token = t.token) AS logs
        FROM device_tokens t
        ORDER BY COALESCE(t.last_seen, 0) DESC
    `).all().map((row) => Object.assign({}, row, { revoked: Boolean(row.revoked) }));

    res.json({ devices });
});

/**
 * GET /admin/stats
 */
app.get('/admin/stats', adminLimiter, requireAdmin, (req, res) => {
    const now = Date.now();

    res.json({
        activeTokens: db.prepare(
            'SELECT COUNT(*) AS count FROM device_tokens WHERE revoked = 0 AND expires_at > ?'
        ).get(now).count,
        totalTokens: db.prepare('SELECT COUNT(*) AS count FROM device_tokens').get().count,
        totalPhotos: db.prepare('SELECT COUNT(*) AS count FROM photos').get().count,
        totalLocations: db.prepare('SELECT COUNT(*) AS count FROM locations').get().count,
        totalLogs: db.prepare('SELECT COUNT(*) AS count FROM logs').get().count,
        storageEnabled: storage.verifyEnabled,
        storageDbEnabled: storage.dbEnabled,
        serverTime: now
    });
});

/**
 * GET /admin/storage/status — состояние интеграции с файлохранилищем.
 */
app.get('/admin/storage/status', adminLimiter, requireAdmin, (req, res) => {
    const source = xlsxSync.getStatus();
    res.json(Object.assign({}, source, {
        enabled: storage.verifyEnabled,
        dbEnabled: storage.dbEnabled,
        source: 'xlsx',
        baseUrl: integrationConfig.baseUrl || null,
        dbFolderId: integrationConfig.dbFolderId || null,
        locationsFolderId: integrationConfig.dbFolderId || null,
        locationsFile: integrationConfig.locationsFile || null,
        cacheDir: integrationConfig.cacheDir,
        xlsxCheckSeconds: integrationConfig.xlsxCheckSeconds,
        dbSyncMinutes: integrationConfig.dbSyncMinutes,
        // Алиасы для совместимости со старой админ-панелью.
        lastPull: source.lastSync,
        lastPush: 0
    }));
});

/**
 * POST /admin/storage/sync — принудительно проверить XLSX и обновить локации.
 */
app.post('/admin/storage/sync', adminLimiter, requireAdmin, async (req, res, next) => {
    try {
        if (!storage.dbEnabled) {
            return res.status(409).json({ error: 'STORAGE_DB_DISABLED' });
        }

        const result = await runXlsxRefresh({ force: true });
        return res.json({ success: true, source: 'xlsx', result });
    } catch (err) {
        if (err instanceof StorageError || err instanceof XlsxSyncError) {
            const status = err.code === 'SYNC_IN_PROGRESS' ? 409 : 502;
            return res.status(status).json({ error: err.code, message: err.message });
        }
        return next(err);
    }
});

/**
 * База локаций: управление из админ-панели.
 * GET /admin/locations
 */
app.get('/admin/locations', adminLimiter, requireAdmin, (req, res) => {
    const limit = clampInt(req.query.limit, 1, 5000, 500);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);

    const locations = db.prepare(`
        SELECT id, name, city, address, side, lat, lon,
               updated_at AS updatedAt
        FROM locations
        ORDER BY name COLLATE NOCASE
        LIMIT ? OFFSET ?
    `).all(limit, offset);

    const total = db.prepare('SELECT COUNT(*) AS count FROM locations').get().count;

    res.json({ locations, total, limit, offset });
});

/**
 * POST /admin/locations
 * Body: { name, lat, lon }
 */
app.post('/admin/locations', adminLimiter, requireAdmin, (req, res) => {
    if (storage.dbEnabled) {
        return res.status(409).json({ error: 'LOCATIONS_MANAGED_BY_XLSX' });
    }
    const input = normalizeLocationInput(req.body);
    if (!input) return res.status(400).json({ error: 'INVALID_LOCATION' });

    const now = Date.now();
    const result = db.prepare(`
        INSERT INTO locations (name, lat, lon, updated_at)
        VALUES (?, ?, ?, ?)
    `).run(input.name, input.lat, input.lon, now);

    return res.status(201).json({
        id: Number(result.lastInsertRowid),
        name: input.name,
        lat: input.lat,
        lon: input.lon,
        updatedAt: now
    });
});

/**
 * PUT /admin/locations/:id
 */
app.put('/admin/locations/:id', adminLimiter, requireAdmin, (req, res) => {
    if (storage.dbEnabled) {
        return res.status(409).json({ error: 'LOCATIONS_MANAGED_BY_XLSX' });
    }
    const id = clampInt(req.params.id, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!id) return res.status(400).json({ error: 'INVALID_LOCATION_ID' });

    const input = normalizeLocationInput(req.body);
    if (!input) return res.status(400).json({ error: 'INVALID_LOCATION' });

    const now = Date.now();
    const result = db.prepare(`
        UPDATE locations SET name = ?, lat = ?, lon = ?, updated_at = ? WHERE id = ?
    `).run(input.name, input.lat, input.lon, now, id);

    if (result.changes === 0) return res.status(404).json({ error: 'LOCATION_NOT_FOUND' });

    return res.json({ id, name: input.name, lat: input.lat, lon: input.lon, updatedAt: now });
});

/**
 * DELETE /admin/locations/:id
 */
app.delete('/admin/locations/:id', adminLimiter, requireAdmin, (req, res) => {
    if (storage.dbEnabled) {
        return res.status(409).json({ error: 'LOCATIONS_MANAGED_BY_XLSX' });
    }
    const id = clampInt(req.params.id, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!id) return res.status(400).json({ error: 'INVALID_LOCATION_ID' });

    const result = db.prepare('DELETE FROM locations WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'LOCATION_NOT_FOUND' });

    return res.json({ success: true });
});

// ------------------------------------------------------------ статика и 404

app.use('/admin', express.static(path.join(__dirname, 'admin')));

if (SERVE_CLIENT) {
    const clientDir = path.join(__dirname, '..', 'geophoto-pwa');
    if (fs.existsSync(clientDir)) {
        app.use('/', express.static(clientDir));
    }
}

app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

// ------------------------------------------------------------- обработчик ошибок

app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
    }

    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'INVALID_JSON' });
    }

    console.error('[GeoPhoto] Ошибка запроса', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
});

// ------------------------------------------------------------------- запуск

let server = null;

if (require.main === module) {
    server = app.listen(PORT, () => {
        console.log(`[GeoPhoto] Сервер запущен: http://localhost:${PORT}`);
        console.log(`[GeoPhoto] Админ-панель:   http://localhost:${PORT}/admin/`);
        if (SERVE_CLIENT) console.log(`[GeoPhoto] PWA-клиент:     http://localhost:${PORT}/`);
        if (!ADMIN_SECRET) console.warn('[GeoPhoto] ВНИМАНИЕ: ADMIN_SECRET не задан.');
    });

    if (storage.dbEnabled) {
        const initial = setTimeout(() => {
            runXlsxRefresh({ force: true })
                .then((result) => {
                    if (result.changed) {
                        console.log(`[GeoPhoto] XLSX загружен: ${result.updated} локаций (${result.file})`);
                    } else if (result.fileChanged) {
                        console.log(`[GeoPhoto] XLSX проверен, данные не изменились (${result.file})`);
                    } else {
                        console.log(`[GeoPhoto] XLSX без изменений (${result.file || 'файл не найден'})`);
                    }
                })
                .catch((err) => {
                    console.warn('[GeoPhoto] Не удалось загрузить XLSX:', err.message);
                });
        }, 1500);
        if (typeof initial.unref === 'function') initial.unref();

        const periodic = setInterval(() => {
            runXlsxRefresh({})
                .then((result) => {
                    if (result && result.changed) {
                        console.log(`[GeoPhoto] XLSX обновлён: ${result.updated} локаций (${result.file})`);
                    }
                })
                .catch((err) => {
                    console.warn('[GeoPhoto] Периодическая проверка XLSX не удалась:', err.message);
                });
        }, integrationConfig.dbSyncMinutes * 60 * 1000);
        if (typeof periodic.unref === 'function') periodic.unref();
    }

    const shutdown = () => {
        console.log('[GeoPhoto] Остановка сервера…');
        server.close(() => {
            try { db.close(); } catch (err) { /* база уже закрыта */ }
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 5000).unref();
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

module.exports = { app, db, storage, integrationConfig };
