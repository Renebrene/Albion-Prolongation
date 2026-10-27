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

    static _resizeAndEncode(dataUrl, config) {
        return new Promise((resolve, reject) => {
            const image = new Image();

            image.onload = () => {
                try {
                    let width = image.naturalWidth || image.width;
                    let height = image.naturalHeight || image.height;
                    if (!width || !height) {
                        reject(new Error('PhotoCompressor: не удалось определить размер изображения'));
                        return;
                    }

                    if (config.maxWidth && width > config.maxWidth) {
                        height = Math.round((height * config.maxWidth) / width);
                        width = config.maxWidth;
                    }

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        reject(new Error('PhotoCompressor: Canvas 2D недоступен'));
                        return;
                    }
                    ctx.drawImage(image, 0, 0, width, height);

                    resolve(canvas.toDataURL('image/jpeg', config.quality));
                } catch (err) {
                    reject(err);
                }
            };

            image.onerror = () => reject(new Error('PhotoCompressor: не удалось загрузить изображение'));
            image.src = dataUrl;
        });
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
