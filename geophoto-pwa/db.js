/**
 * db.js — обёртка над IndexedDB (GeoPhotoDB).
 *
 * Object stores:
 *   photos    (keyPath: id)      — фото, GPS, адрес, статус
 *   locations (keyPath: id)      — база известных адресов
 *   logs      (keyPath: id)      — локальный лог (пишет Logger)
 *
 * Все методы возвращают Promise. Ошибки IndexedDB пробрасываются наружу,
 * чтобы вызывающий код мог их залогировать и показать пользователю.
 */
class GeoPhotoDB {
    static DB_NAME = 'GeoPhotoDB';
    static DB_VERSION = 1;
    static STORE_PHOTOS = 'photos';
    static STORE_LOCATIONS = 'locations';
    static STORE_LOGS = 'logs';

    constructor() {
        this.db = null;
        this._opening = null;
    }

    /** Открывает (или создаёт) базу. Повторные вызовы возвращают один и тот же объект. */
    async open() {
        if (this.db) return this.db;
        if (this._opening) return this._opening;

        this._opening = new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) {
                reject(new Error('IndexedDB не поддерживается браузером'));
                return;
            }

            const request = indexedDB.open(GeoPhotoDB.DB_NAME, GeoPhotoDB.DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                if (!db.objectStoreNames.contains(GeoPhotoDB.STORE_PHOTOS)) {
                    const photos = db.createObjectStore(GeoPhotoDB.STORE_PHOTOS, { keyPath: 'id' });
                    photos.createIndex('status', 'status', { unique: false });
                    photos.createIndex('timestamp', 'timestamp', { unique: false });
                }

                if (!db.objectStoreNames.contains(GeoPhotoDB.STORE_LOCATIONS)) {
                    db.createObjectStore(GeoPhotoDB.STORE_LOCATIONS, { keyPath: 'id' });
                }

                if (!db.objectStoreNames.contains(GeoPhotoDB.STORE_LOGS)) {
                    const logs = db.createObjectStore(GeoPhotoDB.STORE_LOGS, { keyPath: 'id' });
                    logs.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };

            request.onsuccess = () => {
                this.db = request.result;
                this.db.onversionchange = () => {
                    this.db.close();
                    this.db = null;
                };
                resolve(this.db);
            };

            request.onerror = () => reject(request.error || new Error('Не удалось открыть IndexedDB'));

            request.onblocked = () => reject(new Error('IndexedDB заблокирована другой вкладкой приложения'));
        }).finally(() => {
            this._opening = null;
        });

        return this._opening;
    }

    /**
     * Выполняет операцию в транзакции и дожидается её завершения.
     * @param {string} storeName
     * @param {'readonly'|'readwrite'} mode
     * @param {(store: IDBObjectStore) => any} operation
     */
    async _withStore(storeName, mode, operation) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            let tx;
            try {
                tx = db.transaction(storeName, mode);
            } catch (err) {
                reject(err);
                return;
            }

            let result;
            let resultIsRequest = false;

            tx.oncomplete = () => resolve(resultIsRequest ? result.result : result);
            tx.onerror = () => reject(tx.error || new Error('Ошибка транзакции IndexedDB'));
            tx.onabort = () => reject(tx.error || new Error('Транзакция IndexedDB прервана'));

            try {
                const store = tx.objectStore(storeName);
                result = operation(store);
                resultIsRequest = result instanceof IDBRequest;
                if (resultIsRequest) {
                    result.onerror = () => reject(result.error);
                }
            } catch (err) {
                try { tx.abort(); } catch (_) { /* транзакция уже завершена */ }
                reject(err);
            }
        });
    }

    // ---------------------------------------------------------------- photos

    async putPhoto(photo) {
        if (!photo || !photo.id) throw new Error('putPhoto: у фото отсутствует id');
        await this._withStore(GeoPhotoDB.STORE_PHOTOS, 'readwrite', (store) => store.put(photo));
        return photo;
    }

    async getPhoto(id) {
        return this._withStore(GeoPhotoDB.STORE_PHOTOS, 'readonly', (store) => store.get(id));
    }

    /** Все фото, отсортированные от новых к старым. */
    async getAllPhotos() {
        const photos = await this._withStore(GeoPhotoDB.STORE_PHOTOS, 'readonly', (store) => store.getAll());
        return (photos || []).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    /** Частичное обновление фото. Возвращает обновлённую запись или null. */
    async updatePhoto(id, changes) {
        if (!changes || typeof changes !== 'object') throw new Error('updatePhoto: changes должен быть объектом');
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(GeoPhotoDB.STORE_PHOTOS, 'readwrite');
            const store = tx.objectStore(GeoPhotoDB.STORE_PHOTOS);
            let updated = null;

            const getRequest = store.get(id);
            getRequest.onsuccess = () => {
                const photo = getRequest.result;
                if (!photo) return;
                updated = Object.assign({}, photo, changes, { id });
                store.put(updated);
            };
            getRequest.onerror = () => reject(getRequest.error);

            tx.oncomplete = () => resolve(updated);
            tx.onerror = () => reject(tx.error || new Error('Не удалось обновить фото'));
        });
    }

    async deletePhoto(id) {
        await this._withStore(GeoPhotoDB.STORE_PHOTOS, 'readwrite', (store) => store.delete(id));
    }

    async countPhotosByStatus(status) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(GeoPhotoDB.STORE_PHOTOS, 'readonly');
            const index = tx.objectStore(GeoPhotoDB.STORE_PHOTOS).index('status');
            const request = index.count(status);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // ------------------------------------------------------------- locations

    /** Полностью заменяет локальную базу локаций данными сервера. */
    async replaceLocations(locations) {
        if (!Array.isArray(locations)) throw new Error('replaceLocations: ожидается массив');
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(GeoPhotoDB.STORE_LOCATIONS, 'readwrite');
            const store = tx.objectStore(GeoPhotoDB.STORE_LOCATIONS);
            store.clear();

            for (const location of locations) {
                if (!location || location.id === undefined || location.id === null) continue;
                const lat = Number(location.lat);
                const lon = Number(location.lon);
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
                store.put({
                    id: location.id,
                    name: String(location.name || ''),
                    city: String(location.city || ''),
                    address: String(location.address || ''),
                    side: String(location.side || ''),
                    format: String(location.format || ''),
                    lat,
                    lon,
                    updatedAt: Number(location.updatedAt || location.updated_at || Date.now())
                });
            }

            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error || new Error('Не удалось обновить локации'));
        });
    }

    async getAllLocations() {
        const locations = await this._withStore(GeoPhotoDB.STORE_LOCATIONS, 'readonly', (store) => store.getAll());
        return locations || [];
    }

    async countLocations() {
        return this._withStore(GeoPhotoDB.STORE_LOCATIONS, 'readonly', (store) => store.count());
    }

    /**
     * Ищет ближайшую локацию, расширяя радиус: 10, 20, ... 100 м.
     * Возвращает { location, distance } для первого радиуса, в котором есть совпадение.
     * Если несколько локаций попадают в кольцо — выбирается самая близкая.
     *
     * @param {number} lat
     * @param {number} lon
     * @param {{maxRadius?: number, step?: number}} [options]
     * @returns {Promise<{location: object, distance: number}|null>}
     */
    async findNearestLocation(lat, lon, options = {}) {
        const latitude = Number(lat);
        const longitude = Number(lon);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

        const maxRadius = Number(options.maxRadius) > 0 ? Number(options.maxRadius) : 100;
        const step = Number(options.step) > 0 ? Number(options.step) : 10;
        const locations = await this.getAllLocations();

        const candidates = locations
            .map((location) => ({
                location,
                distance: GeoPhotoDB.haversine(latitude, longitude, location.lat, location.lon)
            }))
            .filter((item) => Number.isFinite(item.distance))
            .sort((a, b) => a.distance - b.distance);

        for (let radius = step; radius <= maxRadius; radius += step) {
            const match = candidates.find((item) => item.distance <= radius);
            if (match) return match;
        }

        return null;
    }

    /** Расстояние между двумя точками в метрах (формула Haversine). */
    static haversine(lat1, lon1, lat2, lon2) {
        const R = 6371000; // радиус Земли, м
        const toRad = (deg) => (deg * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    // ------------------------------------------------------------------ logs

    async putLog(entry) {
        await this._withStore(GeoPhotoDB.STORE_LOGS, 'readwrite', (store) => store.put(entry));
        return entry;
    }

    /** Логи, отсортированные от старых к новым. */
    async getAllLogs() {
        const logs = await this._withStore(GeoPhotoDB.STORE_LOGS, 'readonly', (store) => store.getAll());
        return (logs || []).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    }

    async countLogs() {
        return this._withStore(GeoPhotoDB.STORE_LOGS, 'readonly', (store) => store.count());
    }

    async deleteLogs(ids) {
        if (!Array.isArray(ids) || ids.length === 0) return;
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(GeoPhotoDB.STORE_LOGS, 'readwrite');
            const store = tx.objectStore(GeoPhotoDB.STORE_LOGS);
            for (const id of ids) store.delete(id);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error || new Error('Не удалось удалить логи'));
        });
    }

    async clearLogs() {
        return this._withStore(GeoPhotoDB.STORE_LOGS, 'readwrite', (store) => store.clear());
    }
}

if (typeof window !== 'undefined') {
    window.GeoPhotoDB = GeoPhotoDB;
}
