"""Parse city/address/side/coordinates from XLS/XLSX tables.

Взят из проекта albion-locator-autonom (src/xls_import.py) и дополнен
поддержкой колонки «Наименование»: для GeoPhoto она становится названием
локации на телефоне.

The column detection follows the address tables used by the company site:
find a header row containing city/address/coordinates, then read data rows
below it. Only the fields needed by the locator map are kept.
"""
from __future__ import annotations

import io
import math
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

MAX_ROWS = 20_000
MAX_SHEETS = 20
MAX_COLUMNS = 120
HEADER_SCAN_ROWS = 100
MAX_ERRORS = 50

NAME_HEADERS = {
    "наименование", "наименование объекта", "наименование адреса",
    "название", "название объекта", "объект", "имя",
}
CITY_HEADERS = {
    "город", "город1", "город 1", "город2", "город 2",
    "населенный пункт", "населенный пункт 1",
}
ADDRESS_HEADERS = {
    "адрес", "адресс", "адрес размещения", "адрес объекта",
    "местоположение", "адрес установки",
}
SIDE_HEADERS = {"сторона", "сторона конструкции", "направление", "side"}
FORMAT_HEADERS = {
    "формат", "формат конструкции", "тип конструкции",
    "вид конструкции", "конструкция",
}
COORD_HEADERS = {
    "координаты", "координаты wgs84", "координаты wgs 84",
    "координаты wgs-84", "координаты объекта", "coords", "coord",
}
LAT_HEADERS = {"широта", "latitude", "lat", "широта wgs84"}
LON_HEADERS = {"долгота", "longitude", "lon", "lng", "долгота wgs84"}

_NUMBER_RE = re.compile(r"[-+]?\d+(?:[.,]\d+)?")
_SPACES_RE = re.compile(r"\s+")


class ExcelImportError(ValueError):
    """The uploaded workbook cannot be parsed as a supported table."""


class ExcelDependencyError(RuntimeError):
    """The optional XLS/XLSX reader is not installed."""


@dataclass
class ParsedWorkbook:
    points: list[dict[str, Any]] = field(default_factory=list)
    skipped: int = 0
    errors: list[dict[str, Any]] = field(default_factory=list)
    sheets: list[dict[str, Any]] = field(default_factory=list)


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return _SPACES_RE.sub(" ", str(value).replace("\xa0", " ")).strip()


def normalize_header(value: Any) -> str:
    text = normalize_text(value).lower().replace("ё", "е")
    text = re.sub(r"[^\w\s.-]", " ", text)
    return _SPACES_RE.sub(" ", text).strip()


def _number(value: Any) -> float | None:
    text = normalize_text(value)
    if not text:
        return None
    text = text.replace(" ", "").replace(",", ".")
    try:
        number = float(text)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _coordinate_pair(value: Any) -> tuple[float, float] | None:
    text = normalize_text(value)
    if not text:
        return None
    numbers = _NUMBER_RE.findall(text)
    parsed: list[float] = []
    if len(numbers) == 2:
        parsed = [float(number.replace(",", ".")) for number in numbers]
    elif len(numbers) in {3, 4} and all("." not in number for number in numbers[:2]):
        # Decimal commas: "47,237201, 39,816711" -> 47.237201, 39.816711.
        first = float(numbers[0] + "." + numbers[1])
        if len(numbers) == 3:
            parsed = [first, float(numbers[2].replace(",", "."))]
        else:
            parsed = [first, float(numbers[2] + "." + numbers[3])]
    if len(parsed) != 2 or not all(math.isfinite(item) for item in parsed):
        return None
    latitude, longitude = parsed
    if not -90.0 <= latitude <= 90.0 or not -180.0 <= longitude <= 180.0:
        return None
    return latitude, longitude


def normalize_side(value: Any) -> str:
    """Сторона как в исходной таблице (GeoPhoto показывает её пользователю).

    В оригинальном Локаторе кириллические А/Б/С приводились к A/B/C для
    фильтра карты. Здесь важно сохранить исходную букву: «Адрес (Б)».
    """
    return normalize_text(value)


def _header_kind(value: Any) -> str | None:
    norm = normalize_header(value)
    if not norm:
        return None
    if norm in LAT_HEADERS:
        return "lat"
    if norm in LON_HEADERS:
        return "lon"
    if norm in COORD_HEADERS or "координат" in norm:
        return "coords"
    if norm in NAME_HEADERS or norm.startswith("наименование") or norm.startswith("название"):
        return "name"
    if norm in CITY_HEADERS or norm.startswith("город"):
        return "city"
    if norm in ADDRESS_HEADERS or (
        norm.startswith("адрес") and "программ" not in norm
    ):
        return "address"
    if norm in SIDE_HEADERS or ("сторон" in norm and "тип" not in norm):
        return "side"
    if norm in FORMAT_HEADERS or norm.startswith("формат"):
        return "format"
    return None


def _map_headers(row: Iterable[Any]) -> dict[str, int]:
    mapping: dict[str, int] = {}
    for index, value in enumerate(row):
        kind = _header_kind(value)
        if kind and kind not in mapping:
            mapping[kind] = index
    return mapping


def _header_usable(mapping: dict[str, int]) -> bool:
    has_location = "name" in mapping or "address" in mapping or "city" in mapping
    has_coordinates = "coords" in mapping or (
        "lat" in mapping and "lon" in mapping
    )
    return has_location and has_coordinates


def _display_name(name: str, city: str, address: str) -> str:
    """Название локации: «Наименование», иначе город + адрес."""
    if name:
        return name
    if city and address:
        return f"{city}, {address}"
    return address or city


def _cell(row: list[Any], index: int | None) -> Any:
    if index is None or index >= len(row):
        return None
    return row[index]


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _xml_root(data: bytes) -> ET.Element:
    return ET.fromstring(data)


def _xlsx_relationship_target(base: str, target: str) -> str:
    target = target.replace("\\", "/")
    if target.startswith("/"):
        return target.lstrip("/")
    parts = (base.rstrip("/") + "/" + target).split("/")
    normalized: list[str] = []
    for part in parts:
        if part in {"", "."}:
            continue
        if part == "..":
            if normalized:
                normalized.pop()
        else:
            normalized.append(part)
    return "/".join(normalized)


def _xlsx_column_index(reference: str) -> int | None:
    match = re.match(r"([A-Za-z]+)", reference or "")
    if not match:
        return None
    index = 0
    for char in match.group(1).upper():
        index = index * 26 + (ord(char) - 64)
    return index - 1


def _read_xlsx_stdlib(data: bytes) -> list[tuple[str, list[list[Any]]]]:
    """Read a minimal XLSX/XLSM workbook without openpyxl.

    Some externally-produced files have a malformed ``styles.xml``; openpyxl
    refuses to open them even though the cell data is valid. This parser reads
    only workbook/sheet/sharedStrings XML and ignores styles entirely.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ExcelImportError(f"Не удалось открыть XLSX: {exc}") from exc
    try:
        names = set(archive.namelist())
        if "xl/workbook.xml" not in names:
            raise ExcelImportError("В XLSX не найден xl/workbook.xml")

        def read_xml(name: str) -> ET.Element:
            info = archive.getinfo(name)
            if info.file_size > 50 * 1024 * 1024:
                raise ExcelImportError(f"Слишком большой XML внутри XLSX: {name}")
            return _xml_root(archive.read(name))

        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            root = read_xml("xl/sharedStrings.xml")
            for item in root.iter():
                if _local_name(item.tag) != "si":
                    continue
                shared.append("".join(
                    text.text or "" for text in item.iter()
                    if _local_name(text.tag) == "t"
                ))

        rels: dict[str, str] = {}
        if "xl/_rels/workbook.xml.rels" in names:
            root = read_xml("xl/_rels/workbook.xml.rels")
            for rel in root.iter():
                if _local_name(rel.tag) != "Relationship":
                    continue
                rel_id = rel.attrib.get("Id")
                target = rel.attrib.get("Target")
                if rel_id and target and rel.attrib.get("TargetMode") != "External":
                    rels[rel_id] = _xlsx_relationship_target("xl", target)

        workbook = read_xml("xl/workbook.xml")
        sheets: list[tuple[str, str]] = []
        for sheet in workbook.iter():
            if _local_name(sheet.tag) != "sheet":
                continue
            name = sheet.attrib.get("name") or f"Лист {len(sheets) + 1}"
            rel_id = next(
                (value for key, value in sheet.attrib.items()
                 if _local_name(key) == "id"),
                None,
            )
            target = rels.get(rel_id or "")
            if not target:
                target = f"xl/worksheets/sheet{len(sheets) + 1}.xml"
            if target in names:
                sheets.append((name, target))
            if len(sheets) >= MAX_SHEETS:
                break

        result: list[tuple[str, list[list[Any]]]] = []
        for name, path in sheets:
            root = read_xml(path)
            rows: list[list[Any]] = []
            for row in root.iter():
                if _local_name(row.tag) != "row":
                    continue
                values: list[Any] = []
                for cell in row:
                    if _local_name(cell.tag) != "c":
                        continue
                    column = _xlsx_column_index(cell.attrib.get("r", ""))
                    if column is None or column >= MAX_COLUMNS:
                        continue
                    while len(values) <= column:
                        values.append(None)
                    cell_type = cell.attrib.get("t", "")
                    value_node = next(
                        (child for child in cell if _local_name(child.tag) == "v"),
                        None,
                    )
                    raw = value_node.text if value_node is not None else None
                    if cell_type == "s":
                        try:
                            value = shared[int(raw)] if raw is not None else None
                        except (ValueError, IndexError):
                            value = None
                    elif cell_type == "inlineStr":
                        value = "".join(
                            text.text or "" for text in cell.iter()
                            if _local_name(text.tag) == "t"
                        )
                    elif cell_type == "b":
                        value = "TRUE" if raw == "1" else "FALSE" if raw == "0" else raw
                    else:
                        value = raw
                    values[column] = value
                rows.append(values)
                if len(rows) >= MAX_ROWS:
                    break
            result.append((name, rows))
        return result
    finally:
        archive.close()

def _ods_cell_value(cell: ET.Element) -> Any:
    value_type = cell.attrib.get(
        "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}value-type", ""
    )
    value = cell.attrib.get(
        "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}value"
    )
    if value_type in {"float", "percentage", "currency"} and value is not None:
        return value
    if value_type == "boolean":
        return "TRUE" if value == "true" else "FALSE"
    return "".join(cell.itertext()).strip()


def _read_ods(data: bytes) -> list[tuple[str, list[list[Any]]]]:
    """Read OpenDocument Spreadsheet (.ods) without external libraries."""
    ns_table = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ExcelImportError(f"Не удалось открыть ODS: {exc}") from exc
    try:
        names = set(archive.namelist())
        if "content.xml" not in names:
            raise ExcelImportError("В ODS не найден content.xml")
        info = archive.getinfo("content.xml")
        if info.file_size > 80 * 1024 * 1024:
            raise ExcelImportError("Слишком большой content.xml внутри ODS")
        try:
            root = ET.fromstring(archive.read("content.xml"))
        except ET.ParseError as exc:
            raise ExcelImportError(f"Повреждён content.xml в ODS: {exc}") from exc

        result: list[tuple[str, list[list[Any]]]] = []
        for table in root.iter(f"{ns_table}table"):
            name = table.attrib.get(f"{ns_table}name") or f"Лист {len(result) + 1}"
            rows: list[list[Any]] = []
            for row in table.iter(f"{ns_table}table-row"):
                values: list[Any] = []
                for cell in row:
                    if _local_name(cell.tag) not in {"table-cell", "covered-table-cell"}:
                        continue
                    try:
                        repeat = int(cell.attrib.get(f"{ns_table}number-columns-repeated", "1"))
                    except ValueError:
                        repeat = 1
                    repeat = max(1, min(repeat, MAX_COLUMNS))
                    value = _ods_cell_value(cell)
                    values.extend([value] * repeat)
                    if len(values) >= MAX_COLUMNS:
                        break
                try:
                    row_repeat = int(row.attrib.get(f"{ns_table}number-rows-repeated", "1"))
                except ValueError:
                    row_repeat = 1
                row_repeat = max(1, min(row_repeat, MAX_ROWS))
                for _ in range(row_repeat):
                    rows.append(list(values[:MAX_COLUMNS]))
                    if len(rows) >= MAX_ROWS:
                        break
                if len(rows) >= MAX_ROWS:
                    break
            result.append((name, rows))
            if len(result) >= MAX_SHEETS:
                break
        return result
    finally:
        archive.close()


def _convert_to_ods(data: bytes, filename: str) -> bytes | None:
    """Convert a legacy/foreign workbook to ODS via headless LibreOffice."""
    executable = shutil.which("libreoffice") or shutil.which("soffice")
    if not executable:
        return None
    suffix = Path(filename).suffix.lower() or ".xlsx"
    if suffix not in {".xls", ".xlsx", ".xlsm"}:
        return None
    with tempfile.TemporaryDirectory(prefix="albion-xls-") as temporary:
        directory = Path(temporary)
        source = directory / f"input{suffix}"
        source.write_bytes(data)
        profile = directory / "profile"
        profile.mkdir()
        command = [
            executable, "--headless", "--nologo", "--nodefault", "--nolockcheck",
            "--norestore", f"-env:UserInstallation={profile.as_uri()}",
            "--convert-to", "ods", "--outdir", str(directory), str(source),
        ]
        try:
            subprocess.run(
                command, check=False, capture_output=True, text=True, timeout=90,
                env={**os.environ, "HOME": temporary},
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        target = directory / "input.ods"
        if target.is_file() and target.stat().st_size > 100:
            return target.read_bytes()
    return None


def _read_xlsx(data: bytes) -> list[tuple[str, list[list[Any]]]]:
    # Prefer the stylesheet-independent reader: some site exports contain
    # invalid styles.xml and openpyxl refuses to open them.
    try:
        sheets = _read_xlsx_stdlib(data)
        if any(rows for _name, rows in sheets):
            return sheets
    except Exception as primary_error:
        stdlib_error = primary_error
    else:
        stdlib_error = None
    try:
        from openpyxl import load_workbook
    except ImportError as exc:  # pragma: no cover - dependency guard
        if stdlib_error is not None:
            raise ExcelImportError(f"Не удалось открыть XLSX: {stdlib_error}") from exc
        raise ExcelDependencyError("Установите openpyxl для чтения XLSX") from exc
    try:
        workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as exc:
        detail = f"{stdlib_error}; openpyxl: {exc}" if stdlib_error else str(exc)
        raise ExcelImportError(f"Не удалось открыть XLSX: {detail}") from exc
    sheets = []
    try:
        for worksheet in workbook.worksheets[:MAX_SHEETS]:
            rows = []
            for row_index, row in enumerate(
                worksheet.iter_rows(values_only=True), start=1
            ):
                if row_index > MAX_ROWS:
                    break
                rows.append(list(row[:MAX_COLUMNS]))
            sheets.append((worksheet.title, rows))
    finally:
        workbook.close()
    return sheets


def _read_xls(data: bytes) -> list[tuple[str, list[list[Any]]]]:
    try:
        import xlrd
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise ExcelDependencyError("Установите xlrd для чтения XLS") from exc
    try:
        workbook = xlrd.open_workbook(file_contents=data, on_demand=True)
    except Exception as exc:
        raise ExcelImportError(f"Не удалось открыть XLS: {exc}") from exc
    sheets = []
    try:
        for name in workbook.sheet_names()[:MAX_SHEETS]:
            worksheet = workbook.sheet_by_name(name)
            rows = [
                worksheet.row_values(index)[:MAX_COLUMNS]
                for index in range(min(worksheet.nrows, MAX_ROWS))
            ]
            sheets.append((name, rows))
    finally:
        workbook.release_resources()
    return sheets


def _read_sheets(data: bytes, filename: str = "") -> list[tuple[str, list[list[Any]]]]:
    if not data:
        raise ExcelImportError("Файл пуст")
    suffix = Path(filename).suffix.lower()
    if suffix == ".ods":
        return _read_ods(data)
    # LibreOffice normalizes malformed styles/XML and legacy XLS files. If it
    # is unavailable, the direct readers below still work for valid files.
    converted = _convert_to_ods(data, filename)
    if converted:
        try:
            return _read_ods(converted)
        except ExcelImportError:
            pass
    if suffix not in {".xls"} and zipfile.is_zipfile(io.BytesIO(data)):
        return _read_xlsx(data)
    return _read_xls(data)


def parse_workbook(data: bytes, filename: str = "") -> ParsedWorkbook:
    """Parse the first usable table on every sheet of an XLS/XLSX file."""
    suffix = Path(filename).suffix.lower()
    if suffix not in {".xls", ".xlsx", ".xlsm", ".ods"}:
        raise ExcelImportError("Поддерживаются файлы .xls, .xlsx и .ods")
    result = ParsedWorkbook()
    seen: set[tuple[float, float, str, str]] = set()

    for sheet_name, rows in _read_sheets(data, filename):
        header_index = None
        mapping: dict[str, int] = {}
        for index, row in enumerate(rows[:HEADER_SCAN_ROWS]):
            candidate = _map_headers(row)
            if _header_usable(candidate):
                header_index = index
                mapping = candidate
                break
        if header_index is None:
            result.sheets.append({"name": sheet_name, "rows": 0, "skipped": True})
            continue

        parsed_rows = 0
        for row_index in range(header_index + 1, len(rows)):
            row = rows[row_index]
            if not any(normalize_text(value) for value in row):
                continue
            name = normalize_text(_cell(row, mapping.get("name")))
            city = normalize_text(_cell(row, mapping.get("city")))
            address = normalize_text(_cell(row, mapping.get("address")))
            side = normalize_side(_cell(row, mapping.get("side")))
            display_name = _display_name(name, city, address)
            format_name = normalize_text(_cell(row, mapping.get("format")))
            coordinates = None
            if "lat" in mapping and "lon" in mapping:
                latitude = _number(_cell(row, mapping["lat"]))
                longitude = _number(_cell(row, mapping["lon"]))
                if latitude is not None and longitude is not None:
                    coordinates = (latitude, longitude)
            coords_cell = _cell(row, mapping.get("coords"))
            if coordinates is None and "coords" in mapping:
                coordinates = _coordinate_pair(coords_cell)
            if not display_name:
                result.skipped += 1
                continue
            if coordinates is None:
                if len(result.errors) < MAX_ERRORS and normalize_text(coords_cell):
                    result.errors.append({
                        "sheet": sheet_name,
                        "row": row_index + 1,
                        "reason": "не удалось разобрать координаты",
                    })
                result.skipped += 1
                continue
            latitude, longitude = coordinates
            if not (-90.0 <= latitude <= 90.0 and -180.0 <= longitude <= 180.0):
                if len(result.errors) < MAX_ERRORS:
                    result.errors.append({
                        "sheet": sheet_name,
                        "row": row_index + 1,
                        "reason": "координаты вне допустимого диапазона",
                    })
                result.skipped += 1
                continue
            latitude = round(latitude, 6)
            longitude = round(longitude, 6)
            key = (latitude, longitude, display_name.casefold(), side.casefold())
            if key in seen:
                result.skipped += 1
                continue
            seen.add(key)
            result.points.append({
                # name — именно колонка «Наименование» (может быть пустой).
                # display_name — удобная подпись: name или «Город, Адрес (сторона)».
                "name": name,
                "display_name": display_name,
                "city": city,
                "address": address,
                "side": side,
                "format": format_name,
                "lat": latitude,
                "lon": longitude,
                "sheet": sheet_name,
                "row": row_index + 1,
            })
            parsed_rows += 1
            if len(result.points) >= MAX_ROWS:
                break
        result.sheets.append({"name": sheet_name, "rows": parsed_rows, "skipped": False})

    if not result.points:
        detail = "В файле не найдены строки с адресом/городом и координатами."
        raise ExcelImportError(detail)
    return result
