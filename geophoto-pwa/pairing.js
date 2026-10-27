/**
 * pairing.js — сопряжение с сервером и все защищённые API-запросы.
 *
 * Токен устройства выдаётся администратором на сервере и вводится
 * в настройках приложения. Передаётся в заголовке X-Device-Token.
 */

class ApiError extends Error {
    /**
     * @param {string} code машинный код ошибки (TOKEN_INVALID, CHECKSUM_MISMATCH, ...)
     * @param {string} [message]
     * @param {number} [status] HTTP-статус
     */
    constructor(code, message, status = 0) {
        super(message || code);
        this.name = 'ApiError';
        this.code = code;
        this.status = status;
    }
}

class PairingManager {
    static TOKEN_KEY = 'deviceToken';
    static DEVICE_NAME_KEY = 'deviceName';
    static SERVER_URL_KEY = 'serverUrl';
    static LAST_SYNC_KEY = 'lastLocationsSync';
    static AUTOSYNC_KEY = 'autoSyncEnabled';
    static SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
    // Токен бригады: 8 кириллических букв, регистр не важен.
    static TOKEN_PATTERN = /^[а-яё]{8}$/u;

    static normalizeToken(value) {
        return String(value || '').normalize('NFC').trim().toLowerCase();
    }

    /**
     * @param {GeoPhotoDB} db
     * @param {Logger} logger
     */
    constructor(db, logger) {
        this.db = db;
        this.logger = logger;
        this._syncing = false;
    }

    // ------------------------------------------------------------- настройки

    get serverUrl() {
        const stored = localStorage.getItem(PairingManager.SERVER_URL_KEY);
        const base = stored && stored.trim() ? stored.trim() : window.location.origin;
        return base.replace(/\/+$/, '');
    }

    setServerUrl(url) {
        const normalized = String(url || '').trim().replace(/\/+$/, '');
        if (normalized) {
            localStorage.setItem(PairingManager.SERVER_URL_KEY, normalized);
        } else {
            localStorage.removeItem(PairingManager.SERVER_URL_KEY);
        }
    }

    get token() {
        return localStorage.getItem(PairingManager.TOKEN_KEY) || '';
    }

    isPaired() {
        return PairingManager.TOKEN_PATTERN.test(this.token);
    }

    getDeviceName() {
        const stored = localStorage.getItem(PairingManager.DEVICE_NAME_KEY);
        if (stored) return stored;
        const ua = navigator.userAgent || '';
        if (/Android/i.test(ua)) return 'Android device';
        if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS device';
        return 'Browser device';
    }

    setDeviceName(name) {
        const normalized = String(name || '').trim().slice(0, 100);
        if (normalized) localStorage.setItem(PairingManager.DEVICE_NAME_KEY, normalized);
        return normalized;
    }

    getLastSync() {
        const value = Number(localStorage.getItem(PairingManager.LAST_SYNC_KEY));
        return Number.isFinite(value) && value > 0 ? value : 0;
    }

    isAutoSyncEnabled() {
        const stored = localStorage.getItem(PairingManager.AUTOSYNC_KEY);
        // По умолчанию автосинхронизация включена.
        return stored === null ? true : stored === 'true';
    }

    setAutoSyncEnabled(enabled) {
        localStorage.setItem(PairingManager.AUTOSYNC_KEY, enabled ? 'true' : 'false');
    }

    // -------------------------------------------------------------- запросы

    /**
     * Единая точка всех HTTP-запросов к серверу.
     * @param {string} endpoint например '/api/status'
     * @param {RequestInit & {tokenOverride?: string}} [options]
     * @returns {Promise<any>} распарсенный JSON
     * @throws {ApiError}
     */
    async apiRequest(endpoint, options = {}) {
        const { tokenOverride, ...fetchOptions } = options;
        const headers = Object.assign(
            { 'Content-Type': 'application/json' },
            fetchOptions.headers || {}
        );

        const token = tokenOverride || this.token;
        // HTTP-заголовки не допускают кириллицу — передаём percent-encoding UTF-8.
        if (token) headers['X-Device-Token'] = encodeURIComponent(token);

        let response;
        try {
            response = await fetch(this.serverUrl + endpoint, Object.assign({}, fetchOptions, { headers }));
        } catch (err) {
            throw new ApiError('NETWORK_ERROR', 'Нет связи с сервером', 0);
        }

        let data = null;
        const text = await response.text();
        if (text) {
            try {
                data = JSON.parse(text);
            } catch (err) {
                data = null;
            }
        }

        if (!response.ok) {
            const code = (data && (data.error || data.code)) || `HTTP_${response.status}`;
            throw new ApiError(code, (data && data.message) || code, response.status);
        }

        return data;
    }

    /** Первичное сопряжение: проверяет токен на сервере и сохраняет его локально. */
    async pair(token, deviceName) {
        const normalizedToken = PairingManager.normalizeToken(token);
        if (!PairingManager.TOKEN_PATTERN.test(normalizedToken)) {
            throw new ApiError('TOKEN_FORMAT', 'Токен должен состоять из 8 кириллических букв');
        }

        const normalizedName = (String(deviceName || '').trim() || this.getDeviceName()).slice(0, 100);
        const data = await this.apiRequest('/api/pair', {
            method: 'POST',
            tokenOverride: normalizedToken,
            body: JSON.stringify({ token: normalizedToken, deviceName: normalizedName })
        });

        localStorage.setItem(PairingManager.TOKEN_KEY, normalizedToken);
        localStorage.setItem(PairingManager.DEVICE_NAME_KEY, normalizedName);

        if (this.logger) {
            await this.logger.info('Устройство сопряжено с сервером', {
                deviceName: data && data.deviceName ? data.deviceName : normalizedName,
                expiresAt: data && data.expiresAt
            });
        }

        return data;
    }

    /** Отвязка устройства на клиенте. Токен на сервере при этом остаётся активным. */
    async unpair() {
        localStorage.removeItem(PairingManager.TOKEN_KEY);
        localStorage.removeItem(PairingManager.LAST_SYNC_KEY);
        if (this.logger) await this.logger.warn('Устройство отвязано от сервера');
    }

    async checkStatus() {
        return this.apiRequest('/api/status', { method: 'GET' });
    }

    // -------------------------------------------------------- синхронизация

    /**
     * POST /api/locations: отправляет накопленные логи и получает базу локаций.
     * Логи удаляются локально только после успешного приёма сервером.
     *
     * @param {{force?: boolean}} [options] force — попросить сервер сразу
     *        проверить XLSX в файлохранилище (кнопка «Синхронизировать»).
     */
    async syncLocations(options = {}) {
        if (!this.isPaired()) throw new ApiError('NOT_PAIRED', 'Устройство не сопряжено');
        if (this._syncing) throw new ApiError('SYNC_IN_PROGRESS', 'Синхронизация уже выполняется');

        this._syncing = true;
        try {
            const logs = await this.logger.getAll();
            const since = this.getLastSync();
            const clientRevision = localStorage.getItem('locationsRevision') || '';
            const params = new URLSearchParams({
                since: String(since),
                clientRevision
            });
            if (options.force) params.set('refresh', '1');

            const data = await this.apiRequest(`/api/locations?${params.toString()}`, {
                method: 'POST',
                body: JSON.stringify({
                    logs: logs.map((entry) => ({
                        id: entry.id,
                        timestamp: entry.timestamp,
                        level: entry.level,
                        message: entry.message,
                        context: entry.context || {}
                    }))
                })
            });

            let locationsUpdated = 0;
            let locationsChanged = false;
            const revision = data && data.revision ? String(data.revision) : null;

            if (data && Array.isArray(data.locations)) {
                // Сервер может не присылать список, если ревизия не изменилась.
                await this.db.replaceLocations(data.locations);
                locationsUpdated = data.locations.length;
                locationsChanged = true;
                if (revision) localStorage.setItem('locationsRevision', revision);
            } else if (revision) {
                localStorage.setItem('locationsRevision', revision);
            }

            if (data && data.logsAccepted && logs.length > 0) {
                await this.db.deleteLogs(logs.map((entry) => entry.id));
            }

            const serverTime = Number(data && data.serverTime) || Date.now();
            localStorage.setItem(PairingManager.LAST_SYNC_KEY, String(serverTime));

            if (this.logger) {
                await this.logger.info('Синхронизация базы выполнена', {
                    locationsUpdated,
                    locationsChanged,
                    revision,
                    logsSent: logs.length,
                    logsAccepted: Boolean(data && data.logsAccepted)
                });
            }

            return {
                locationsUpdated,
                locationsChanged,
                revision,
                logsSent: logs.length,
                logsAccepted: Boolean(data && data.logsAccepted),
                serverTime
            };
        } finally {
            this._syncing = false;
        }
    }

    /** Автосинхронизация не чаще одного раза в 24 часа. */
    async autoSyncIfDue() {
        if (!this.isPaired() || !this.isAutoSyncEnabled()) return null;
        if (Date.now() - this.getLastSync() < PairingManager.SYNC_INTERVAL_MS) return null;
        try {
            return await this.syncLocations();
        } catch (err) {
            await this.logger.warn('Автосинхронизация не удалась', { code: err.code || null, message: err.message });
            return null;
        }
    }

    // -------------------------------------------------------------- отправка

    /**
     * POST /api/upload. Проверяет целостность по SHA-256 (base64-часть data URL).
     * @param {{id: string, address: string, gps: object|null, dataUrl: string}} photo
     */
    async uploadPhoto(photo) {
        if (!this.isPaired()) throw new ApiError('NOT_PAIRED', 'Устройство не сопряжено');
        if (!photo || !photo.id || !photo.dataUrl) throw new ApiError('PHOTO_INVALID', 'Некорректные данные фото');

        const base64 = String(photo.dataUrl).split(',')[1] || '';
        if (!base64) throw new ApiError('PHOTO_INVALID', 'Фото не содержит base64-данных');

        const checksum = await PairingManager.sha256(base64);

        const data = await this.apiRequest('/api/upload', {
            method: 'POST',
            body: JSON.stringify({
                id: photo.id,
                name: photo.name || '',
                city: photo.city || '',
                address: photo.address || '',
                gps: photo.gps || null,
                image: photo.dataUrl,
                checksum
            })
        });

        if (!data || data.checksum !== checksum) {
            throw new ApiError('CHECKSUM_MISMATCH', 'Сервер вернул другую контрольную сумму');
        }

        return data;
    }

    /** SHA-256 в hex. */
    static async sha256(text) {
        if (!window.crypto || !window.crypto.subtle) {
            throw new ApiError('CRYPTO_UNAVAILABLE', 'Web Crypto API недоступен (нужен HTTPS)');
        }
        const bytes = new TextEncoder().encode(text);
        const digest = await window.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest))
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
    }
}

if (typeof window !== 'undefined') {
    window.ApiError = ApiError;
    window.PairingManager = PairingManager;
}
