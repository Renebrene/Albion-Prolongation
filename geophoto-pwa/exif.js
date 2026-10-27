/**
 * exif.js — чтение GPS и бинарных EXIF-данных из выбранного фото.
 *
 * Использует piexif.js (lib/piexif.js). Библиотека умеет работать
 * с data URL, поэтому файл сначала читается через FileReader.
 */
class ExifReader {
    /**
     * Читает файл и извлекает GPS-координаты + сериализованный EXIF.
     *
     * @param {File|Blob} file
     * @returns {Promise<{gps: {lat: number, lon: number}|null, exifBinary: string|null}>}
     */
    static async readFromFile(file) {
        if (!file) throw new Error('ExifReader: файл не передан');
        if (typeof piexif === 'undefined') {
            console.warn('ExifReader: piexif не загружен, EXIF недоступен');
            return { gps: null, exifBinary: null };
        }

        const dataUrl = await ExifReader._readAsDataURL(file);

        let exifObject;
        try {
            exifObject = piexif.load(dataUrl);
        } catch (err) {
            // У фото может не быть EXIF (например, после мессенджера) — это нормально.
            console.warn('ExifReader: не удалось прочитать EXIF', err);
            return { gps: null, exifBinary: null };
        }

        if (!exifObject || typeof exifObject !== 'object') {
            return { gps: null, exifBinary: null };
        }

        const gps = ExifReader._parseGps(exifObject.GPS || {});

        let exifBinary = null;
        try {
            exifBinary = piexif.dump(exifObject);
        } catch (err) {
            console.warn('ExifReader: не удалось сериализовать EXIF', err);
        }

        return { gps, exifBinary };
    }

    static _readAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл'));
            reader.readAsDataURL(file);
        });
    }

    /**
     * GPS-теги в EXIF хранятся как рациональные числа: [[градусы, 1], [минуты, 1], [секунды, 1000]].
     * @param {Array} dms
     * @param {string} ref 'N'|'S'|'E'|'W'
     * @returns {number|null}
     */
    static _dmsToDecimal(dms, ref) {
        if (!Array.isArray(dms) || dms.length < 3) return null;

        const toNumber = (value) => {
            if (Array.isArray(value) && value.length >= 2) {
                const numerator = Number(value[0]);
                const denominator = Number(value[1]);
                if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
                    return NaN;
                }
                return numerator / denominator;
            }
            return Number(value);
        };

        const degrees = toNumber(dms[0]);
        const minutes = toNumber(dms[1]);
        const seconds = toNumber(dms[2]);

        if (![degrees, minutes, seconds].every(Number.isFinite)) return null;

        let decimal = Math.abs(degrees) + minutes / 60 + seconds / 3600;
        if (ref === 'S' || ref === 'W') decimal = -decimal;
        return decimal;
    }

    /** @returns {{lat: number, lon: number}|null} */
    static _parseGps(gps) {
        try {
            const lat = ExifReader._dmsToDecimal(
                gps[piexif.GPSIFD.GPSLatitude],
                gps[piexif.GPSIFD.GPSLatitudeRef]
            );
            const lon = ExifReader._dmsToDecimal(
                gps[piexif.GPSIFD.GPSLongitude],
                gps[piexif.GPSIFD.GPSLongitudeRef]
            );

            if (lat === null || lon === null) return null;
            if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
            // 0,0 — почти всегда означает «координаты отсутствуют».
            if (lat === 0 && lon === 0) return null;

            return {
                lat: Number(lat.toFixed(7)),
                lon: Number(lon.toFixed(7))
            };
        } catch (err) {
            console.warn('ExifReader: ошибка разбора GPS', err);
            return null;
        }
    }
}

if (typeof window !== 'undefined') {
    window.ExifReader = ExifReader;
}
