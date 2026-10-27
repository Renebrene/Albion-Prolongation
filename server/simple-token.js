'use strict';

/**
 * simple-token.js — простые токены устройств: 8 кириллических букв,
 * регистронезависимые. Тот же формат использует albion-files.
 *
 * HTTP-заголовки не допускают не-ASCII, поэтому клиент передаёт токен
 * в percent-encoding UTF-8, а сервер декодирует его здесь.
 */

const crypto = require('crypto');

// Для генерации исключаем редко используемые/похожие буквы; при проверке
// принимаются все буквы а-я и ё.
const SIMPLE_TOKEN_ALPHABET = 'абвгдежзиклмнопрстуфхцчшщэюя';
const SIMPLE_TOKEN_RE = /^[а-яё]{8}$/u;
const SIMPLE_TOKEN_LENGTH = 8;

/** NFC + trim + нижний регистр. */
function normalizeToken(value) {
    if (typeof value !== 'string') return '';
    return value.normalize('NFC').trim().toLowerCase();
}

function isSimpleToken(value) {
    return SIMPLE_TOKEN_RE.test(normalizeToken(value));
}

/** Генерация нового токена (только для локального режима без хранилища). */
function generateToken() {
    let result = '';
    for (let index = 0; index < SIMPLE_TOKEN_LENGTH; index += 1) {
        result += SIMPLE_TOKEN_ALPHABET[crypto.randomInt(0, SIMPLE_TOKEN_ALPHABET.length)];
    }
    return result;
}

/** Восстанавливает UTF-8, ошибочно прочитанный как latin-1. */
function repairMojibake(text) {
    if (!text || !/^[\x00-\xFF]*$/.test(text)) return text;
    try {
        const repaired = Buffer.from(text, 'latin1').toString('utf8');
        return repaired.includes('�') ? text : repaired;
    } catch (err) {
        return text;
    }
}

/**
 * Декодирует значение заголовка в нормализованный токен.
 * Поддерживает plain (если дошёл), percent-encoding и mojibake.
 */
function decodeToken(value) {
    if (typeof value !== 'string') return '';
    let text = value.trim();
    text = repairMojibake(text);

    if (text.includes('%')) {
        try {
            text = decodeURIComponent(text);
        } catch (err) {
            // Некорректный percent-encoding — оставляем как есть.
        }
    }

    return normalizeToken(text);
}

module.exports = {
    SIMPLE_TOKEN_ALPHABET,
    SIMPLE_TOKEN_LENGTH,
    normalizeToken,
    isSimpleToken,
    generateToken,
    decodeToken
};
