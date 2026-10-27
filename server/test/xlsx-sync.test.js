'use strict';

const { describe, it, expect } = require('bun:test');
const { pickSpreadsheet, computeRevision } = require('../xlsx-sync');

describe('pickSpreadsheet', () => {
    const files = [
        { name: 'locations.xlsx', mtime: 100, file_id: 'a' },
        { name: 'locations_1.xlsx', mtime: 300, file_id: 'b' },
        { name: 'other.xlsx', mtime: 500, file_id: 'c' },
        { name: 'readme.txt', mtime: 900, file_id: 'd' }
    ];

    it('выбирает самый свежий XLSX', () => {
        expect(pickSpreadsheet(files).file_id).toBe('c');
    });

    it('при locationsFile учитывает суффиксы _1 и берёт свежий из них', () => {
        expect(pickSpreadsheet(files, 'locations.xlsx').file_id).toBe('b');
    });

    it('игнорирует не-таблицы', () => {
        const result = pickSpreadsheet([{ name: 'a.txt', mtime: 1 }]);
        expect(result).toBeNull();
    });

    it('поддерживает xls и ods', () => {
        expect(pickSpreadsheet([{ name: 'a.ods', mtime: 1 }]).name).toBe('a.ods');
        expect(pickSpreadsheet([{ name: 'a.xls', mtime: 1 }]).name).toBe('a.xls');
    });

    it('возвращает null для пустого списка', () => {
        expect(pickSpreadsheet([])).toBeNull();
        expect(pickSpreadsheet(null)).toBeNull();
    });
});

describe('computeRevision', () => {
    const points = [
        { name: 'Щит Б', city: 'Ростов-на-Дону', address: 'ул. Мира, 2', side: 'Б', lat: 47.2, lon: 39.4 },
        { name: 'Щит А', city: 'Азов', address: 'ул. Мира, 1', side: 'А', lat: 47.1, lon: 39.3 }
    ];

    it('стабильна и не зависит от порядка', () => {
        expect(computeRevision(points)).toBe(computeRevision(points.slice().reverse()));
        expect(computeRevision(points)).toHaveLength(32);
    });

    it('меняется при изменении координат, имени, города, адреса или стороны', () => {
        const variants = [
            { lat: 47.2001 },
            { name: 'Другая' },
            { city: 'Батайск' },
            { address: 'ул. Мира, 3' },
            { side: 'В' }
        ];

        for (const change of variants) {
            const changed = points.map((point, index) =>
                index === 0 ? Object.assign({}, point, change) : point);
            expect(computeRevision(changed)).not.toBe(computeRevision(points));
        }
    });
});
