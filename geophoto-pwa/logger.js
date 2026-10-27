/**
 * logger.js — локальный лог приложения.
 *
 * Записи хранятся в IndexedDB (store 'logs'), максимум 500 штук.
 * Отправляются на сервер только при синхронизации базы (PairingManager.syncLocations).
 */
class Logger {
    static MAX_LOCAL_LOGS = 500;
    static APP_VERSION = '1.2.4';

    /**
     * @param {GeoPhotoDB} db
     */
    constructor(db) {
        this.db = db;
        this._trimming = false;
    }

    async log(level, message, context = {}) {
        const normalizedLevel = ['info', 'warn', 'error'].includes(level) ? level : 'info';

        const entry = {
            id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            level: normalizedLevel,
            message: String(message),
            context: Logger._safeContext(context),
            deviceName: localStorage.getItem('deviceName') || 'unknown',
            appVersion: Logger.APP_VERSION
        };

        try {
            await this.db.putLog(entry);
            // Не ждём очистку: запись уже сохранена, а обрезка не критична для вызывающего кода.
            this._trim().catch((err) => console.warn('Logger: ошибка очистки старых записей', err));
        } catch (err) {
            // Логирование не должно ронять основную операцию.
            console.error('Logger: не удалось записать лог', err);
        }

        return entry;
    }

    info(message, context) {
        return this.log('info', message, context);
    }

    warn(message, context) {
        return this.log('warn', message, context);
    }

    error(message, context) {
        return this.log('error', message, context);
    }

    async getAll() {
        return this.db.getAllLogs();
    }

    async count() {
        return this.db.countLogs();
    }

    async clear() {
        return this.db.clearLogs();
    }

    async _trim() {
        if (this._trimming) return;
        this._trimming = true;

        try {
            const all = await this.db.getAllLogs(); // от старых к новым
            const overflow = all.length - Logger.MAX_LOCAL_LOGS;
            if (overflow <= 0) return;

            const idsToDelete = all.slice(0, overflow).map((entry) => entry.id);
            await this.db.deleteLogs(idsToDelete);
        } finally {
            this._trimming = false;
        }
    }

    /** Контекст должен быть сериализуемым — обрезаем всё, что может сломать JSON. */
    static _safeContext(context) {
        if (!context || typeof context !== 'object') return {};
        try {
            const json = JSON.stringify(context);
            if (json.length > 8000) return { truncated: true, preview: json.slice(0, 8000) };
            return JSON.parse(json);
        } catch (err) {
            return { unserializable: String(err) };
        }
    }
}

if (typeof window !== 'undefined') {
    window.Logger = Logger;
}
