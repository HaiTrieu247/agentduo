"""YAML loading with a stdlib-only fallback.

PyYAML is used when installed. Otherwise a small parser handles the subset
used by config.yaml: nested block mappings, block lists (of scalars or
mappings), flow lists, quoted strings, numbers, booleans and null.
"""
from __future__ import annotations

import json
import re
from typing import Any, List, NamedTuple, Tuple


class YamlError(ValueError):
    pass


def load(text: str) -> Any:
    try:
        import yaml  # type: ignore
    except ImportError:
        return loads(text)
    return yaml.safe_load(text)


class _Line(NamedTuple):
    indent: int
    content: str
    lineno: int


def loads(text: str) -> Any:
    lines = _prepare(text)
    if not lines:
        return {}
    value, i = _parse_block(lines, 0, lines[0].indent)
    if i != len(lines):
        raise YamlError(f"line {lines[i].lineno}: unexpected content {lines[i].content!r}")
    return value


def _prepare(text: str) -> List[_Line]:
    out = []
    for n, raw in enumerate(text.splitlines(), start=1):
        if "\t" in raw[: len(raw) - len(raw.lstrip())]:
            raise YamlError(f"line {n}: tabs are not allowed for indentation")
        stripped = _strip_comment(raw).rstrip()
        if not stripped.strip():
            continue
        if stripped.strip() in ("---", "..."):
            continue
        indent = len(stripped) - len(stripped.lstrip(" "))
        out.append(_Line(indent, stripped.strip(), n))
    return out


def _strip_comment(line: str) -> str:
    quote = None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
        elif ch in ("'", '"'):
            quote = ch
        elif ch == "#" and (i == 0 or line[i - 1] in " \t"):
            return line[:i]
    return line


def _is_list_item(content: str) -> bool:
    return content == "-" or content.startswith("- ")


def _parse_block(lines: List[_Line], i: int, indent: int) -> Tuple[Any, int]:
    if _is_list_item(lines[i].content):
        return _parse_list(lines, i, indent)
    return _parse_map(lines, i, indent)


def _parse_map(lines: List[_Line], i: int, indent: int) -> Tuple[dict, int]:
    result: dict = {}
    while i < len(lines) and lines[i].indent == indent and not _is_list_item(lines[i].content):
        line = lines[i]
        key, rest = _split_key(line)
        if key in result:
            raise YamlError(f"line {line.lineno}: duplicate key {key!r}")
        i += 1
        if rest:
            result[key] = _parse_scalar(rest, line.lineno)
            continue
        nested = i < len(lines) and (
            lines[i].indent > indent
            or (lines[i].indent == indent and _is_list_item(lines[i].content))
        )
        if nested:
            result[key], i = _parse_block(lines, i, lines[i].indent)
        else:
            result[key] = None
    if i < len(lines) and lines[i].indent > indent:
        raise YamlError(f"line {lines[i].lineno}: unexpected indentation")
    return result, i


def _parse_list(lines: List[_Line], i: int, indent: int) -> Tuple[list, int]:
    result: list = []
    while i < len(lines) and lines[i].indent == indent and _is_list_item(lines[i].content):
        line = lines[i]
        rest = line.content[1:].strip()
        if not rest:
            i += 1
            if i < len(lines) and lines[i].indent > indent:
                value, i = _parse_block(lines, i, lines[i].indent)
            else:
                value = None
        elif _looks_like_key(rest):
            # "- key: value" starts a mapping whose keys align with "key".
            sub_indent = indent + (len(line.content) - len(rest))
            lines[i] = _Line(sub_indent, rest, line.lineno)
            value, i = _parse_map(lines, i, sub_indent)
        else:
            value = _parse_scalar(rest, line.lineno)
            i += 1
        result.append(value)
    return result, i


_KEY_RE = re.compile(r"^(?P<key>\"[^\"]*\"|'[^']*'|[^\s\"'\[\]{}#][^:]*?)\s*:(?:\s+(?P<rest>.*))?$")


def _looks_like_key(text: str) -> bool:
    return bool(_KEY_RE.match(text))


def _split_key(line: _Line) -> Tuple[str, str]:
    m = _KEY_RE.match(line.content)
    if not m:
        raise YamlError(f"line {line.lineno}: expected 'key: value', got {line.content!r}")
    key = m.group("key")
    if key[0] in "\"'":
        key = key[1:-1]
    rest = (m.group("rest") or "").strip()
    if rest in ("|", ">", "|-", ">-"):
        raise YamlError(f"line {line.lineno}: block scalars are not supported; install PyYAML")
    return key, rest


def _split_flow(text: str, lineno: int) -> List[str]:
    parts, depth, quote, buf = [], 0, None, ""
    for ch in text:
        if quote:
            buf += ch
            if ch == quote:
                quote = None
            continue
        if ch in ("'", '"'):
            quote = ch
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append(buf.strip())
            buf = ""
            continue
        buf += ch
    if quote or depth:
        raise YamlError(f"line {lineno}: unbalanced flow collection")
    if buf.strip():
        parts.append(buf.strip())
    return parts


def _parse_scalar(text: str, lineno: int) -> Any:
    if text.startswith('"'):
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise YamlError(f"line {lineno}: invalid double-quoted string: {exc}") from None
    if text.startswith("'"):
        if not text.endswith("'") or len(text) < 2:
            raise YamlError(f"line {lineno}: unterminated single-quoted string")
        return text[1:-1].replace("''", "'")
    if text.startswith("["):
        if not text.endswith("]"):
            raise YamlError(f"line {lineno}: unterminated flow list")
        return [_parse_scalar(p, lineno) for p in _split_flow(text[1:-1], lineno)]
    if text.startswith("{"):
        if text.replace(" ", "") == "{}":
            return {}
        raise YamlError(f"line {lineno}: flow mappings are not supported; install PyYAML")
    lowered = text.lower()
    if lowered in ("true", "false"):
        return lowered == "true"
    if lowered in ("null", "~"):
        return None
    if re.fullmatch(r"[-+]?\d+", text):
        return int(text)
    if re.fullmatch(r"[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?", text):
        return float(text)
    return text
