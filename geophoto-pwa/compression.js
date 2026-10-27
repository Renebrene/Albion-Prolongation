/**
 * compression.js — сжатие фото через Canvas с сохранением EXIF.
 *
 * Canvas при перерисовке теряет EXIF, поэтому исходный блок EXIF
 * сериализуется заранее (ExifReader) и вставляется обратно через piexif.insert().
 */
class PhotoCompressor {
    static LEVELS = {
        original: { quality: 1.0, maxWidth: null, label: 'Оригинал (без сжатия)' },
        high: { quality: 0.85, maxWidth: 2048, label: 'Высокое (85%, до 2048 px)' },
        medium: { quality: 0.70, maxWidth: 1600, label: 'Среднее (70%, до 1600 px)' },
        low: { quality: 0.50, maxWidth: 1024, label: 'Низкое (50%, до 1024 px)' }
    };

    static STORAGE_KEY = 'compressionLevel';

    /** Текущий уровень сжатия из настроек. */
    static getLevel() {
        const stored = localStorage.getItem(PhotoCompressor.STORAGE_KEY);
        return PhotoCompressor.LEVELS[stored] ? stored : 'high';
    }

    static setLevel(level) {
        if (!PhotoCompressor.LEVELS[level]) {
            throw new Error(`PhotoCompressor: неизвестный уровень "${level}"`);
        }
        localStorage.setItem(PhotoCompressor.STORAGE_KEY, level);
    }

    static getLevelConfig(level = PhotoCompressor.getLevel()) {
        return PhotoCompressor.LEVELS[level] || PhotoCompressor.LEVELS.high;
    }

    /**
     * Сжимает изображение.
     * @param {string} originalDataUrl исходный data URL
     * @param {string|null} exifBinary бинарный EXIF из ExifReader
     * @param {string} [level] уровень сжатия
     * @returns {Promise<string>} сжатый data URL (с EXIF, если он был)
     */
    static async compress(originalDataUrl, exifBinary = null, level = PhotoCompressor.getLevel()) {
        if (typeof originalDataUrl !== 'string' || !originalDataUrl.startsWith('data:image/')) {
            throw new Error('PhotoCompressor: некорректный data URL');
        }

        const config = PhotoCompressor.LEVELS[level] || PhotoCompressor.LEVELS.high;

        // Оригинал — не трогаем пиксели и EXIF. Но контракт API требует JPEG,
        // поэтому HEIC/PNG всё равно перекодируем (на уровне high).
        const isJpeg = originalDataUrl.startsWith('data:image/jpeg');
        const effectiveConfig = (config.quality === 1.0 && !config.maxWidth && !isJpeg)
            ? PhotoCompressor.LEVELS.high
            : config;

        if (effectiveConfig.quality === 1.0 && !effectiveConfig.maxWidth) {
            return originalDataUrl;
        }

        const compressed = await PhotoCompressor._resizeAndEncode(originalDataUrl, effectiveConfig);

        if (!exifBinary) return compressed;

        try {
            if (typeof piexif !== 'undefined' && typeof piexif.insert === 'function') {
                return piexif.insert(exifBinary, compressed);
            }
            console.warn('PhotoCompressor: piexif недоступен, EXIF не сохранён');
        } catch (err) {
            // Потеря EXIF не должна ломать съёмку — фото всё равно сохраняем.
            console.warn('PhotoCompressor: не удалось вставить EXIF', err);
        }

        return compressed;
    }

    static _loadImage(dataUrl) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('PhotoCompressor: не удалось загрузить изображение'));
            image.src = dataUrl;
        });
    }

    /** JPEG dataURL через canvas.toBlob — меньше блокирует поток, чем toDataURL. */
    static canvasToJpeg(canvas, quality) {
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (!blob) {
                    reject(new Error('PhotoCompressor: не удалось получить JPEG'));
                    return;
                }
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(reader.error || new Error('PhotoCompressor: ошибка чтения JPEG'));
                reader.readAsDataURL(blob);
            }, 'image/jpeg', quality);
        });
    }

    static async _resizeAndEncode(dataUrl, config) {
        const image = await PhotoCompressor._loadImage(dataUrl);
        let width = image.naturalWidth || image.width;
        let height = image.naturalHeight || image.height;
        if (!width || !height) {
            throw new Error('PhotoCompressor: не удалось определить размер изображения');
        }

        if (config.maxWidth && width > config.maxWidth) {
            height = Math.round((height * config.maxWidth) / width);
            width = config.maxWidth;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('PhotoCompressor: Canvas 2D недоступен');
        ctx.drawImage(image, 0, 0, width, height);

        return PhotoCompressor.canvasToJpeg(canvas, config.quality);
    }

    /** Миниатюра для галереи: список рисуется без полноразмерных dataURL. */
    static async createThumbnail(dataUrl, maxSize = 240, quality = 0.7) {
        const image = await PhotoCompressor._loadImage(dataUrl);
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (!width || !height) throw new Error('PhotoCompressor: некорректное изображение');

        const scale = Math.min(1, maxSize / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('PhotoCompressor: Canvas 2D недоступен');
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

        return PhotoCompressor.canvasToJpeg(canvas, quality);
    }

    /** Записывает GPS в EXIF готового JPEG — для кадров из live-предпросмотра. */
    static attachGpsExif(dataUrl, gps) {
        if (!gps || typeof piexif === 'undefined') return dataUrl;
        try {
            const toDms = (value) => {
                const absolute = Math.abs(value);
                const degrees = Math.floor(absolute);
                const minutesFloat = (absolute - degrees) * 60;
                const minutes = Math.floor(minutesFloat);
                const seconds = (minutesFloat - minutes) * 60;
                return [[degrees, 1], [minutes, 1], [Math.round(seconds * 10000), 10000]];
            };

            const exifObject = { '0th': {}, 'Exif': {}, 'GPS': {} };
            exifObject.GPS[piexif.GPSIFD.GPSLatitudeRef] = gps.lat >= 0 ? 'N' : 'S';
            exifObject.GPS[piexif.GPSIFD.GPSLatitude] = toDms(gps.lat);
            exifObject.GPS[piexif.GPSIFD.GPSLongitudeRef] = gps.lon >= 0 ? 'E' : 'W';
            exifObject.GPS[piexif.GPSIFD.GPSLongitude] = toDms(gps.lon);

            const binary = piexif.dump(exifObject);
            return piexif.insert(binary, dataUrl);
        } catch (err) {
            console.warn('PhotoCompressor: не удалось записать GPS в EXIF', err);
            return dataUrl;
        }
    }

    /** Грубая оценка размера после сжатия — только для подсказки в UI. */
    static estimateSize(originalBytes) {
        const config = PhotoCompressor.getLevelConfig();
        if (config.quality === 1.0 && !config.maxWidth) return originalBytes;
        return Math.round(originalBytes * config.quality * 0.6);
    }

    /** Размер base64-данных в байтах (без учёта заголовка data URL). */
    static dataUrlBytes(dataUrl) {
        if (typeof dataUrl !== 'string') return 0;
        const base64 = dataUrl.split(',')[1] || '';
        const padding = (base64.match(/=+$/) || [''])[0].length;
        return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
    }
}

if (typeof window !== 'undefined') {
    window.PhotoCompressor = PhotoCompressor;
}
