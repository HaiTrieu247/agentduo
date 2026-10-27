"""Minimal JSON Schema validation for agent outputs (stdlib only).

Supports the keywords used in ../schemas: type (incl. unions), enum,
properties, required, additionalProperties: false, items, minItems,
minLength and minimum.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schemas"


def load_schema(name: str) -> dict:
    return json.loads(schema_path(name).read_text(encoding="utf-8"))


def schema_path(name: str) -> Path:
    path = SCHEMA_DIR / f"{name}.schema.json"
    if not path.is_file():
        raise FileNotFoundError(f"schema not found: {path}")
    return path


def _is_type(value: Any, type_name: str) -> bool:
    if type_name == "null":
        return value is None
    if type_name == "boolean":
        return isinstance(value, bool)
    if type_name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if type_name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if type_name == "string":
        return isinstance(value, str)
    if type_name == "array":
        return isinstance(value, list)
    if type_name == "object":
        return isinstance(value, dict)
    raise ValueError(f"unsupported schema type: {type_name}")


def validate(instance: Any, schema: Dict[str, Any], path: str = "$") -> List[str]:
    """Return a list of human-readable errors; empty means valid."""
    errors: List[str] = []
    expected = schema.get("type")
    if expected is not None:
        types = expected if isinstance(expected, list) else [expected]
        if not any(_is_type(instance, t) for t in types):
            return [f"{path}: expected {'|'.join(types)}, got {type(instance).__name__}"]
    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: {instance!r} is not one of {schema['enum']}")
    if isinstance(instance, dict):
        for key in schema.get("required", []):
            if key not in instance:
                errors.append(f"{path}: missing required property {key!r}")
        props = schema.get("properties", {})
        for key, value in instance.items():
            if key in props:
                errors.extend(validate(value, props[key], f"{path}.{key}"))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}: unexpected property {key!r}")
    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: expected at least {schema['minItems']} items")
        if "items" in schema:
            for i, item in enumerate(instance):
                errors.extend(validate(item, schema["items"], f"{path}[{i}]"))
    if isinstance(instance, str) and "minLength" in schema and len(instance) < schema["minLength"]:
        errors.append(f"{path}: string shorter than {schema['minLength']}")
    if _is_type(instance, "number") and "minimum" in schema and instance < schema["minimum"]:
        errors.append(f"{path}: {instance} is less than minimum {schema['minimum']}")
    return errors


def strict_problems(schema: Dict[str, Any], path: str = "$") -> List[str]:
    """Check the constraints of OpenAI strict structured outputs (used by Codex
    --output-schema): every object lists all properties as required and sets
    additionalProperties to false."""
    problems: List[str] = []
    types = schema.get("type")
    types = types if isinstance(types, list) else [types]
    if "object" in types:
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is not False:
            problems.append(f"{path}: additionalProperties must be false")
        if sorted(schema.get("required", [])) != sorted(props):
            problems.append(f"{path}: required must list every property")
        for key, sub in props.items():
            problems.extend(strict_problems(sub, f"{path}.{key}"))
    if "array" in types and "items" in schema:
        problems.extend(strict_problems(schema["items"], f"{path}[]"))
    return problems
