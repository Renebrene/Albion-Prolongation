'use strict';

/**
 * xlsx-sync.js — синхронизация базы локаций из XLSX-файла файлохранилища.
 *
 * Сценарий:
 *   1. получаем список файлов папки «база данных»;
 *   2. выбираем самый свежий XLSX (или файл, указанный в locationsFile);
 *   3. если file_id/mtime/size не изменились — ничего не делаем;
 *   4. скачиваем файл в кэш сервера;
 *   5. парсим парсером Локатора (vendor/xls_import.py) через Python;
 *   6. заменяем таблицу locations и сохраняем ревизию для клиентов.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SPREADSHEET_RE = /\.(xlsx|xlsm|xls|ods)$/i;
const MAX_POINTS = 20000;
const PARSE_TIMEOUT_MS = 120000;

class XlsxSyncError extends Error {
    constructor(code, message) {
        super(message || code);
        this.name = 'XlsxSyncError';
        this.code = code;
    }
}

/**
 * Самый свежий XLSX по дате изменения.
 * Если задан locationsFile, рассматриваются только файлы с тем же базовым
 * именем (включая суффиксы _1, _2, которые добавляет файлохранилище).
 */
function pickSpreadsheet(files, preferredName) {
    if (!Array.isArray(files)) return null;

    let candidates = files.filter((file) => SPREADSHEET_RE.test(String(file && file.name)));
    if (candidates.length === 0) return null;

    if (preferredName) {
        const dot = preferredName.lastIndexOf('.');
        const base = dot > 0 ? preferredName.slice(0, dot) : preferredName;
        const extension = dot > 0 ? preferredName.slice(dot) : '';
        const matching = candidates.filter((file) => {
            const name = String(file.name);
            return name === preferredName
                || name.startsWith(`${base}_`)
                || (extension && name.startsWith(base) && name.endsWith(extension));
        });
        if (matching.length > 0) candidates = matching;
    }

    return candidates.sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0))[0];
}

/** Стабильная ревизия содержимого: клиент сравнивает её с локальной. */
function computeRevision(points) {
    const normalized = points
        .map((point) => [
            point.name, point.city || '', point.address || '', point.side || '',
            point.format || '', point.lat, point.lon
        ])
        .sort((a, b) => {
            const left = JSON.stringify(a);
            const right = JSON.stringify(b);
            return left < right ? -1 : left > right ? 1 : 0;
        });

    return crypto
        .createHash('sha256')
        .update(JSON.stringify(normalized))
        .digest('hex')
        .slice(0, 32);
}

/** Запускает Python-парсер Локатора и возвращает точки. */
function parseWorkbook(filePath) {
    return new Promise((resolve, reject) => {
        const python = process.env.PYTHON_BIN || 'python3';
        const script = path.join(__dirname, 'xlsx_parse.py');
        const child = spawn(python, [script, filePath], {
            cwd: __dirname,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGKILL'); } catch (err) { /* уже завершён */ }
            reject(new XlsxSyncError('XLSX_PARSE_TIMEOUT', 'Парсер XLSX не уложился в 120 секунд'));
        }, PARSE_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();

        child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new XlsxSyncError('XLSX_PARSER_UNAVAILABLE', `Не удалось запустить парсер XLSX: ${err.message}`));
        });

        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            if (code !== 0) {
                let message = stderr.trim();
                try {
                    const payload = JSON.parse(message);
                    if (payload && payload.error) message = payload.error;
                } catch (err) { /* не JSON */ }
                reject(new XlsxSyncError('XLSX_PARSE_FAILED', message || `Парсер завершился с кодом ${code}`));
                return;
            }

            try {
                const data = JSON.parse(stdout);
                const points = Array.isArray(data.points) ? data.points : [];
                resolve(points);
            } catch (err) {
                reject(new XlsxSyncError('XLSX_PARSE_FAILED', 'Парсер вернул некорректный JSON'));
            }
        });
    });
}

class XlsxSync {
    /**
     * @param {object} options
     * @param {import('./storage').StorageClient} options.storage
     * @param {import('better-sqlite3').Database} options.db
     * @param {{get: Function, set: Function}} options.settings
     * @param {object} options.config
     */
    constructor({ storage, db, settings, config }) {
        this.storage = storage;
        this.db = db;
        this.settings = settings;
        this.config = config;
        this._running = false;
    }

    get enabled() {
        return Boolean(this.storage && this.storage.dbEnabled);
    }

    getStatus() {
        const count = this.db.prepare('SELECT COUNT(*) AS count FROM locations').get().count;
        return {
            enabled: this.enabled,
            fileName: this.settings.get('xlsx_name') || null,
            fileMtime: Number(this.settings.get('xlsx_mtime')) || 0,
            lastCheck: Number(this.settings.get('xlsx_last_check')) || 0,
            lastSync: Number(this.settings.get('xlsx_last_sync')) || 0,
            revision: this.settings.get('locations_revision') || null,
            cachePath: this.settings.get('xlsx_cache_path') || null,
            lastError: this.settings.get('xlsx_last_error') || '',
            locations: count
        };
    }

    /**
     * @param {{force?: boolean, throttle?: boolean}} [options]
     *   force    — игнорировать кэш проверок и всегда смотреть файл;
     *   throttle — не проверять файл чаще, чем xlsxCheckSeconds.
     */
    async refresh(options = {}) {
        if (!this.enabled) {
            throw new XlsxSyncError('STORAGE_DB_DISABLED', 'Папка «база данных» не настроена');
        }
        if (this._running) {
            throw new XlsxSyncError('SYNC_IN_PROGRESS', 'Синхронизация уже выполняется');
        }

        const now = Date.now();
        const lastCheck = Number(this.settings.get('xlsx_last_check')) || 0;
        const throttleMs = this.config.xlsxCheckSeconds * 1000;

        if (options.throttle && !options.force && now - lastCheck < throttleMs) {
            return {
                changed: false,
                fileChanged: false,
                updated: 0,
                skipped: true,
                revision: this.settings.get('locations_revision') || null
            };
        }

        this._running = true;
        try {
            const listing = await this.storage.listDbFiles();
            const file = pickSpreadsheet((listing && listing.files) || [], this.config.locationsFile);

            if (!file) {
                this.settings.set('xlsx_last_check', now);
                return {
                    changed: false,
                    fileChanged: false,
                    updated: 0,
                    reason: 'no_file',
                    revision: this.settings.get('locations_revision') || null
                };
            }

            const sameFile = this.settings.get('xlsx_file_id') === file.file_id
                && Number(this.settings.get('xlsx_mtime')) === Number(file.mtime)
                && Number(this.settings.get('xlsx_size')) === Number(file.size);
            const previousError = this.settings.get('xlsx_last_error') || '';

            // Тот же файл и прошлый разбор был успешным — при фоновой проверке
            // скачивать нечего. force (кнопка/старт) перечитывает файл заново,
            // чтобы подхватить изменения парсера и восстановиться после ошибки.
            if (sameFile && !options.force && !previousError) {
                this.settings.set('xlsx_last_check', now);
                return {
                    changed: false,
                    fileChanged: false,
                    updated: 0,
                    file: file.name,
                    revision: this.settings.get('locations_revision') || null
                };
            }

            const buffer = await this.storage.downloadDbFile(file.file_id);
            const cachePath = this._writeCache(file, buffer);
            const points = await parseWorkbook(cachePath);
            const rows = this._normalizePoints(points);

            if (rows.length === 0) {
                throw new XlsxSyncError(
                    'XLSX_NO_ROWS',
                    'В XLSX не найдены строки с наименованием и координатами'
                );
            }

            const previousRevision = this.settings.get('locations_revision') || null;
            const revision = computeRevision(rows);
            const dataChanged = revision !== previousRevision;

            this._replaceLocations(rows, file);

            this.settings.set('xlsx_file_id', file.file_id);
            this.settings.set('xlsx_mtime', String(Number(file.mtime) || 0));
            this.settings.set('xlsx_size', String(Number(file.size) || 0));
            this.settings.set('xlsx_name', file.name || '');
            this.settings.set('xlsx_cache_path', cachePath);
            this.settings.set('xlsx_last_sync', Date.now());
            this.settings.set('xlsx_last_check', Date.now());
            this.settings.set('locations_revision', revision);
            this.settings.set('xlsx_last_error', '');

            return {
                changed: dataChanged,
                fileChanged: true,
                updated: rows.length,
                skipped: points.length - rows.length,
                file: file.name,
                revision,
                cachePath,
                mtime: file.mtime
            };
        } catch (err) {
            this.settings.set('xlsx_last_error', err.message);
            this.settings.set('xlsx_last_check', Date.now());
            throw err;
        } finally {
            this._running = false;
        }
    }

    _writeCache(file, buffer) {
        const directory = path.join(this.config.cacheDir, 'xlsx');
        fs.mkdirSync(directory, { recursive: true });

        const safeName = String(file.name || 'locations.xlsx')
            .replace(/[^\w.\-а-яё]+/gi, '_')
            .slice(0, 120) || 'locations.xlsx';
        const target = path.join(directory, safeName);
        const temporary = `${target}.part`;

        fs.writeFileSync(temporary, buffer);
        fs.renameSync(temporary, target);

        // В кэше храним только последнюю версию.
        for (const entry of fs.readdirSync(directory)) {
            if (entry === safeName) continue;
            if (!SPREADSHEET_RE.test(entry)) continue;
            try { fs.unlinkSync(path.join(directory, entry)); } catch (err) { /* занят */ }
        }

        return target;
    }

    _normalizePoints(points) {
        const seen = new Set();
        const rows = [];

        for (const point of points) {
            // name — колонка «Наименование»; если её нет, собираем подпись.
            const name = String((point && (point.name || point.display_name)) || '')
                .trim()
                .slice(0, 500);
            const city = String((point && point.city) || '').trim().slice(0, 200);
            const address = String((point && point.address) || '').trim().slice(0, 500);
            const side = String((point && point.side) || '').trim().slice(0, 20);
            // Формат нужен, чтобы свернуть поверхности в стороны по правилу
            // «Сайта»: у щита и экрана A1/A2 — разные стороны.
            const format = String((point && point.format) || '').trim().slice(0, 120);
            const lat = Number(point && point.lat);
            const lon = Number(point && point.lon);

            if (!name && !city && !address) continue;
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;

            const displayName = name || [city, address].filter(Boolean).join(', ')
                || `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
            const key = [
                displayName.toLowerCase(),
                city.toLowerCase(),
                address.toLowerCase(),
                side.toLowerCase(),
                format.toLowerCase(),
                lat.toFixed(6),
                lon.toFixed(6)
            ].join('|');
            if (seen.has(key)) continue;
            seen.add(key);

            rows.push({ name: displayName, city, address, side, format, lat, lon });
            if (rows.length >= MAX_POINTS) break;
        }

        return rows;
    }

    _replaceLocations(rows, file) {
        const updatedAt = Number(file && file.mtime) > 0
            ? Math.round(Number(file.mtime) * 1000)
            : Date.now();

        const replace = this.db.transaction((items) => {
            this.db.prepare('DELETE FROM locations').run();
            const insert = this.db.prepare(`
                INSERT INTO locations (name, city, address, side, format, lat, lon, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const item of items) {
                insert.run(
                    item.name, item.city, item.address, item.side, item.format,
                    item.lat, item.lon, updatedAt
                );
            }
        });

        replace(rows);
    }
}

module.exports = {
    XlsxSync,
    XlsxSyncError,
    pickSpreadsheet,
    computeRevision,
    parseWorkbook
};
