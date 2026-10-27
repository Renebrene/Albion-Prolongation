'use strict';

/**
 * storage.js — клиент файлохранилища albion-files.
 *
 * Использует машинный API `X-API-Key`. Токен передаётся в percent-encoding,
 * чтобы 8 кириллических букв проходили через HTTP-заголовки.
 */

const fs = require('fs');
const path = require('path');
const { normalizeToken } = require('./simple-token');

class StorageError extends Error {
    constructor(code, message, status = 0) {
        super(message || code);
        this.name = 'StorageError';
        this.code = code;
        this.status = status;
    }
}

/** Читает integration.json и переменные окружения (env имеет приоритет). */
function loadConfig() {
    const configPath = process.env.INTEGRATION_CONFIG
        || path.join(__dirname, 'integration.json');

    let fileConfig = {};
    if (fs.existsSync(configPath)) {
        try {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (err) {
            console.warn(`[GeoPhoto] Не удалось прочитать ${configPath}: ${err.message}`);
            fileConfig = {};
        }
    }

    const rawBaseUrl = process.env.STORAGE_BASE_URL || fileConfig.storageBaseUrl || '';
    const dbToken = process.env.STORAGE_DB_TOKEN || fileConfig.dbToken || '';
    const dbFolderId = process.env.STORAGE_DB_FOLDER_ID || fileConfig.dbFolderId || '';
    const verifyTtl = Number(process.env.STORAGE_VERIFY_TTL_SECONDS || fileConfig.verifyTtlSeconds);
    const syncMinutes = Number(
        process.env.STORAGE_DB_SYNC_MINUTES
        || process.env.STORAGE_XLSX_SYNC_MINUTES
        || fileConfig.dbSyncMinutes
        || fileConfig.xlsxSyncMinutes
    );
    const checkSeconds = Number(
        process.env.STORAGE_XLSX_CHECK_SECONDS
        || fileConfig.xlsxCheckSeconds
    );

    return {
        configPath,
        baseUrl: String(rawBaseUrl).trim().replace(/\/+$/, ''),
        dbFolderId: String(dbFolderId).trim(),
        dbToken: String(dbToken).trim(),
        // Новый источник локаций — XLSX в папке «база данных».
        locationsFile: String(
            process.env.STORAGE_LOCATIONS_FILE || fileConfig.locationsFile || ''
        ).trim(),
        cacheDir: path.resolve(
            __dirname,
            process.env.STORAGE_CACHE_DIR || fileConfig.cacheDir || 'cache'
        ),
        xlsxCheckSeconds: Number.isFinite(checkSeconds) && checkSeconds >= 0 ? checkSeconds : 60,
        // dbFileName оставлен для совместимости старых конфигов, больше не используется.
        dbFileName: String(process.env.STORAGE_DB_FILE || fileConfig.dbFileName || 'geophoto.db').trim(),
        verifyTtlSeconds: Number.isFinite(verifyTtl) && verifyTtl >= 0 ? verifyTtl : 60,
        dbSyncMinutes: Number.isFinite(syncMinutes) && syncMinutes > 0 ? syncMinutes : 15
    };
}

class StorageClient {
    constructor(config) {
        this.config = config;
        this.enabled = Boolean(config.baseUrl);
        this.dbEnabled = Boolean(config.baseUrl && config.dbFolderId && config.dbToken);
        this._verifyCache = new Map();
    }

    get verifyEnabled() {
        return this.enabled;
    }

    _headers(token) {
        const headers = {};
        if (token) headers['X-API-Key'] = encodeURIComponent(token);
        return headers;
    }

    async _request(apiPath, options = {}) {
        const { token, headers, ...fetchOptions } = options;
        let response;

        try {
            response = await fetch(this.config.baseUrl + apiPath, Object.assign({}, fetchOptions, {
                headers: Object.assign(this._headers(token), headers || {})
            }));
        } catch (err) {
            throw new StorageError('STORAGE_UNAVAILABLE', 'Файлохранилище недоступно', 0);
        }

        const text = await response.text();
        let data = null;
        if (text) {
            try { data = JSON.parse(text); } catch (err) { data = null; }
        }

        if (!response.ok) {
            const message = (data && data.error) || `HTTP ${response.status}`;
            let code = 'STORAGE_ERROR';
            if (response.status === 401) code = 'STORAGE_TOKEN_INVALID';
            else if (response.status === 403) code = 'STORAGE_FORBIDDEN';
            else if (response.status === 404) code = 'STORAGE_NOT_FOUND';
            else if (response.status === 413) code = 'STORAGE_FILE_TOO_LARGE';
            else if (response.status === 429) code = 'STORAGE_RATE_LIMITED';
            throw new StorageError(code, message, response.status);
        }

        return data;
    }

    invalidateToken(token) {
        this._verifyCache.delete(normalizeToken(token));
    }

    /**
     * Проверяет токен в файлохранилище.
     * @returns {Promise<{name: string, folderId: string, scopes: string[], expiresAt: string|null}>}
     */
    async verifyToken(token, options = {}) {
        if (!this.enabled) {
            throw new StorageError('STORAGE_DISABLED', 'Интеграция с файлохранилищем не настроена');
        }

        const key = normalizeToken(token);
        const cached = this._verifyCache.get(key);
        if (!options.force && cached && cached.until > Date.now()) {
            return cached.value;
        }

        const data = await this._request('/api/v1/integration/verify', { token });

        const value = {
            name: data && data.name ? String(data.name) : '',
            folderId: data && data.folder_id ? String(data.folder_id) : '',
            scopes: data && Array.isArray(data.scopes) ? data.scopes : ['download'],
            expiresAt: data && data.token_expires_at ? String(data.token_expires_at) : null
        };

        this._verifyCache.set(key, {
            value,
            until: Date.now() + this.config.verifyTtlSeconds * 1000
        });

        return value;
    }

    async uploadToFolder(token, folderId, file) {
        if (!file || !Buffer.isBuffer(file.buffer)) {
            throw new StorageError('STORAGE_UPLOAD_FAILED', 'Некорректные данные файла');
        }

        const form = new FormData();
        form.append('file', new Blob([file.buffer], { type: file.contentType || 'application/octet-stream' }), file.filename);
        if (file.displayName) form.append('display_name', file.displayName);
        if (folderId) form.append('folder_id', folderId);

        return this._request('/api/v1/integration/upload', {
            method: 'POST',
            token,
            body: form
        });
    }

    async listFolderFiles(token) {
        return this._request('/api/v1/integration/files', { token });
    }

    async deleteFile(token, fileId) {
        return this._request(`/api/v1/integration/files/${encodeURIComponent(fileId)}`, {
            method: 'DELETE',
            token
        });
    }

    async downloadFile(token, fileId) {
        let response;
        try {
            response = await fetch(
                `${this.config.baseUrl}/api/v1/integration/files/${encodeURIComponent(fileId)}/download`,
                { headers: this._headers(token) }
            );
        } catch (err) {
            throw new StorageError('STORAGE_UNAVAILABLE', 'Файлохранилище недоступно', 0);
        }

        if (!response.ok) {
            let code = 'STORAGE_DOWNLOAD_FAILED';
            if (response.status === 401) code = 'STORAGE_TOKEN_INVALID';
            else if (response.status === 403) code = 'STORAGE_FORBIDDEN';
            else if (response.status === 404) code = 'STORAGE_NOT_FOUND';
            throw new StorageError(code, `Не удалось скачать файл (HTTP ${response.status})`, response.status);
        }

        return Buffer.from(await response.arrayBuffer());
    }

    // ------------------------------------------------------- база данных

    async listDbFiles() {
        if (!this.dbEnabled) {
            throw new StorageError('STORAGE_DB_DISABLED', 'Папка «база данных» не настроена');
        }
        return this.listFolderFiles(this.config.dbToken);
    }

    async downloadDbFile(fileId) {
        if (!this.dbEnabled) {
            throw new StorageError('STORAGE_DB_DISABLED', 'Папка «база данных» не настроена');
        }
        return this.downloadFile(this.config.dbToken, fileId);
    }

    async uploadDbFile(buffer) {
        if (!this.dbEnabled) {
            throw new StorageError('STORAGE_DB_DISABLED', 'Папка «база данных» не настроена');
        }
        return this.uploadToFolder(this.config.dbToken, this.config.dbFolderId, {
            buffer,
            filename: this.config.dbFileName,
            displayName: this.config.dbFileName,
            contentType: 'application/vnd.sqlite3'
        });
    }
}

module.exports = { StorageClient, StorageError, loadConfig };
