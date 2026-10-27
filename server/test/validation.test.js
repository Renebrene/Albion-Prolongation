'use strict';

const { describe, it, expect } = require('bun:test');
const validation = require('../validation');

describe('isValidToken', () => {
    it('принимает 64 hex-символа', () => {
        expect(validation.isValidToken('a'.repeat(64))).toBe(true);
        expect(validation.isValidToken('0123456789abcdef'.repeat(4))).toBe(true);
    });

    it('отклоняет неверные токены', () => {
        expect(validation.isValidToken('a'.repeat(63))).toBe(false);
        expect(validation.isValidToken('g'.repeat(64))).toBe(false);
        expect(validation.isValidToken(null)).toBe(false);
        expect(validation.isValidToken('')).toBe(false);
    });
});

describe('isValidPhotoId', () => {
    it('принимает безопасные идентификаторы', () => {
        expect(validation.isValidPhotoId('photo_1730000000000')).toBe(true);
        expect(validation.isValidPhotoId('abc-123_X')).toBe(true);
    });

    it('не пропускает path traversal и пробелы', () => {
        expect(validation.isValidPhotoId('../../etc/passwd')).toBe(false);
        expect(validation.isValidPhotoId('photo 1')).toBe(false);
        expect(validation.isValidPhotoId('')).toBe(false);
    });
});

describe('parseImageDataUrl', () => {
    it('разбирает допустимый data URL', () => {
        const result = validation.parseImageDataUrl('data:image/jpeg;base64,AAAA');
        expect(result).toEqual({ mime: 'image/jpeg', base64: 'AAAA' });
    });

    it('нормализует jpg в mime', () => {
        expect(validation.parseImageDataUrl('data:image/jpg;base64,AAAA').mime).toBe('image/jpeg');
    });

    it('отклоняет посторонние данные', () => {
        expect(validation.parseImageDataUrl('data:text/plain;base64,AAAA')).toBeNull();
        expect(validation.parseImageDataUrl('data:image/svg+xml;base64,AAAA')).toBeNull();
        expect(validation.parseImageDataUrl('data:image/png;base64,AAAA')).toBeNull();
        expect(validation.parseImageDataUrl('data:image/heic;base64,AAAA')).toBeNull();
        expect(validation.parseImageDataUrl(null)).toBeNull();
    });
});

describe('checksumOfBase64', () => {
    it('считает SHA-256 от base64-строки', () => {
        expect(validation.checksumOfBase64('AAAA'))
            .toBe('63c1dd951ffedf6f7fd968ad4efa39b8ed584f162f46e715114ee184f8de9201');
        expect(validation.checksumOfBase64('test'))
            .toBe('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
    });

    it('детерминирован', () => {
        expect(validation.checksumOfBase64('test')).toBe(validation.checksumOfBase64('test'));
        expect(validation.checksumOfBase64('test')).toHaveLength(64);
    });
});

describe('constantTimeEqual', () => {
    it('сравнивает строки', () => {
        expect(validation.constantTimeEqual('secret', 'secret')).toBe(true);
        expect(validation.constantTimeEqual('secret', 'secreT')).toBe(false);
        expect(validation.constantTimeEqual('short', 'longer')).toBe(false);
        expect(validation.constantTimeEqual(null, 'x')).toBe(false);
    });
});

describe('normalizeLogEntry', () => {
    const now = 1_700_000_000_000;

    it('нормализует корректную запись', () => {
        const entry = validation.normalizeLogEntry({
            id: 'log_1',
            timestamp: now - 1000,
            level: 'warn',
            message: 'Проверка',
            context: { photoId: 'photo_1' }
        }, now);

        expect(entry).toEqual({
            logId: 'log_1',
            timestamp: now - 1000,
            level: 'warn',
            message: 'Проверка',
            context: '{"photoId":"photo_1"}'
        });
    });

    it('подставляет уровень info и текущее время', () => {
        const entry = validation.normalizeLogEntry({ id: 'log_2', message: 'ok' }, now);
        expect(entry.level).toBe('info');
        expect(entry.timestamp).toBe(now);
    });

    it('ограничивает время из будущего', () => {
        const entry = validation.normalizeLogEntry({ id: 'log_3', message: 'ok', timestamp: now + 10 ** 9 }, now);
        expect(entry.timestamp).toBe(now + 60 * 1000);
    });

    it('отклоняет мусор', () => {
        expect(validation.normalizeLogEntry(null, now)).toBeNull();
        expect(validation.normalizeLogEntry({ message: 'без id' }, now)).toBeNull();
        expect(validation.normalizeLogEntry({ id: 'log_4' }, now)).toBeNull();
    });

    it('обрезает слишком длинное сообщение', () => {
        const entry = validation.normalizeLogEntry({ id: 'log_5', message: 'x'.repeat(5000) }, now);
        expect(entry.message.length).toBe(2000);
    });
});

describe('normalizeGps', () => {
    it('принимает корректные координаты', () => {
        expect(validation.normalizeGps({ lat: '55.75', lon: '37.62' })).toEqual({ lat: 55.75, lon: 37.62 });
    });

    it('отклоняет координаты вне диапазона', () => {
        expect(validation.normalizeGps({ lat: 100, lon: 0 })).toBeNull();
        expect(validation.normalizeGps({ lat: 0, lon: 200 })).toBeNull();
        expect(validation.normalizeGps({ lat: 'x', lon: 0 })).toBeNull();
        expect(validation.normalizeGps(null)).toBeNull();
    });
});

describe('normalizeAddress', () => {
    it('обрезает пробелы и длину', () => {
        expect(validation.normalizeAddress('  Москва  ')).toBe('Москва');
        expect(validation.normalizeAddress('x'.repeat(1000))).toHaveLength(500);
        expect(validation.normalizeAddress(42)).toBe('');
    });
});

describe('normalizeLocationInput', () => {
    it('принимает корректную локацию', () => {
        expect(validation.normalizeLocationInput({ name: ' Красная площадь ', lat: '55.7539', lon: '37.6208' }))
            .toEqual({ name: 'Красная площадь', lat: 55.7539, lon: 37.6208 });
    });

    it('отклоняет пустое имя и неверные координаты', () => {
        expect(validation.normalizeLocationInput({ name: '   ', lat: 0, lon: 0 })).toBeNull();
        expect(validation.normalizeLocationInput({ name: 'Точка', lat: 91, lon: 0 })).toBeNull();
        expect(validation.normalizeLocationInput({ name: 'Точка', lat: 0, lon: 181 })).toBeNull();
        expect(validation.normalizeLocationInput({ name: 'x'.repeat(201), lat: 0, lon: 0 })).toBeNull();
        expect(validation.normalizeLocationInput(null)).toBeNull();
    });
});

describe('clampInt', () => {
    it('ограничивает диапазон', () => {
        expect(validation.clampInt('10', 1, 100, 50)).toBe(10);
        expect(validation.clampInt('0', 1, 100, 50)).toBe(1);
        expect(validation.clampInt('1000', 1, 100, 50)).toBe(100);
        expect(validation.clampInt('abc', 1, 100, 50)).toBe(50);
    });
});
