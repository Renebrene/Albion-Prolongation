'use strict';

const { describe, it, expect } = require('bun:test');
const tokens = require('../simple-token');

describe('simple-token', () => {
    it('нормализует регистр, пробелы и NFC', () => {
        expect(tokens.normalizeToken('  ПРИМЕРТК ')).toBe('примертк');
        expect(tokens.normalizeToken(null)).toBe('');
    });

    it('принимает ровно 8 кириллических букв', () => {
        expect(tokens.isSimpleToken('примертк')).toBe(true);
        expect(tokens.isSimpleToken('ПРИМЕРТК')).toBe(true);
        expect(tokens.isSimpleToken('пролонг')).toBe(false);
        expect(tokens.isSimpleToken('примертк1')).toBe(false);
        expect(tokens.isSimpleToken('abcdefgh')).toBe(false);
    });

    it('генерирует валидный токен', () => {
        for (let index = 0; index < 20; index += 1) {
            const token = tokens.generateToken();
            expect(token).toHaveLength(8);
            expect(tokens.isSimpleToken(token)).toBe(true);
        }
    });

    it('декодирует percent-encoding', () => {
        expect(tokens.decodeToken(encodeURIComponent('ПРИМЕРТК'))).toBe('примертк');
        expect(tokens.decodeToken('%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80%D1%82%D0%BA'))
            .toBe('примертк');
    });

    it('восстанавливает UTF-8, прочитанный как latin-1', () => {
        const mojibake = Buffer.from('ПРИМЕРТК', 'utf8').toString('latin1');
        expect(tokens.decodeToken(mojibake)).toBe('примертк');
    });

    it('не портит обычный кириллический токен', () => {
        expect(tokens.decodeToken('примертк')).toBe('примертк');
        expect(tokens.decodeToken('ПРИМЕРТК')).toBe('примертк');
    });
});
