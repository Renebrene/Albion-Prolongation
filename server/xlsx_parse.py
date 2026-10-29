#!/usr/bin/env python3
"""CLI-обёртка над парсером Локатора: XLSX -> JSON для GeoPhoto.

Переписан под модель GeoPhoto: на выходе всегда есть отдельные поля
«Город» (city), «Адрес» (address), «Сторона» (side), координаты и
«Наименование» (name).

Использование:
    python3 xlsx_parse.py /path/to/locations.xlsx

Успех: JSON в stdout {points, skipped, errors, sheets}.
Ошибка: JSON {"error": "..."} в stderr, код возврата 2.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor"))

import xls_import  # noqa: E402


def _text(value: Any) -> str:
    return xls_import.normalize_text(value)


def _normalize_points(points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Оставляем только поля, нужные GeoPhoto, и чистим значения."""
    result: list[dict[str, Any]] = []
    for point in points:
        city = _text(point.get("city"))
        address = _text(point.get("address"))
        side = xls_import.normalize_side(point.get("side"))
        name = _text(point.get("name"))          # колонка «Наименование»
        display_name = _text(point.get("display_name")) or name
        try:
            latitude = round(float(point.get("lat")), 6)
            longitude = round(float(point.get("lon")), 6)
        except (TypeError, ValueError):
            continue
        if not (-90.0 <= latitude <= 90.0 and -180.0 <= longitude <= 180.0):
            continue
        if not city and not address and not name:
            continue
        result.append({
            "name": name,
            "display_name": display_name,
            "city": city,
            "address": address,
            "side": side,
            "format": _text(point.get("format")),
            "lat": latitude,
            "lon": longitude,
        })
    return result


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(json.dumps({"error": "Нужен путь к файлу XLSX"}, ensure_ascii=False), file=sys.stderr)
        return 2

    path = Path(argv[1])
    try:
        data = path.read_bytes()
        parsed = xls_import.parse_workbook(data, path.name)
        points = _normalize_points(parsed.points)
        print(json.dumps({
            "points": points,
            "skipped": parsed.skipped,
            "errors": parsed.errors,
            "sheets": parsed.sheets,
        }, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001 — CLI должен вернуть причину, а не трассировку
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
