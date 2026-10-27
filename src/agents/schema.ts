import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { packageRoot } from "../paths.js";

export const SCHEMA_NAMES = ["plan", "plan_critique", "plan_approval", "implementation", "review"] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

const ajv = new Ajv({ allErrors: true, strict: false });
const schemas = new Map<SchemaName, Record<string, unknown>>();
const validators = new Map<SchemaName, ValidateFunction>();

export function schemaPath(name: SchemaName): string {
  return join(packageRoot(), "schemas", `${name}.schema.json`);
}

export function loadSchema(name: SchemaName): Record<string, unknown> {
  let schema = schemas.get(name);
  if (!schema) {
    schema = JSON.parse(readFileSync(schemaPath(name), "utf8")) as Record<string, unknown>;
    schemas.set(name, schema);
  }
  return schema;
}

function pointerToPath(pointer: string): string {
  return "$" + pointer.split("/").slice(1).map((s) => (/^\d+$/.test(s) ? `[${s}]` : `.${s}`)).join("");
}

function formatError(e: ErrorObject): string {
  const where = pointerToPath(e.instancePath);
  if (e.keyword === "required") return `${where}: missing required property '${(e.params as { missingProperty: string }).missingProperty}'`;
  if (e.keyword === "additionalProperties") return `${where}: unexpected property '${(e.params as { additionalProperty: string }).additionalProperty}'`;
  if (e.keyword === "enum") return `${where}: must be one of ${JSON.stringify((e.params as { allowedValues: unknown[] }).allowedValues)}`;
  return `${where}: ${e.message}`;
}

/** Validate an agent's final JSON; returns human-readable errors (empty = valid). */
export function validateOutput(name: SchemaName, data: unknown): string[] {
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile(loadSchema(name));
    validators.set(name, validate);
  }
  return validate(data) ? [] : (validate.errors ?? []).map(formatError);
}

/** Constraints of OpenAI strict structured outputs (Codex --output-schema). */
export function strictProblems(schema: Record<string, unknown>, path = "$"): string[] {
  const problems: string[] = [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("object")) {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    if (schema.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
    const required = [...((schema.required as string[]) ?? [])].sort();
    if (JSON.stringify(required) !== JSON.stringify(Object.keys(props).sort())) problems.push(`${path}: required must list every property`);
    for (const [key, sub] of Object.entries(props)) problems.push(...strictProblems(sub, `${path}.${key}`));
  }
  if (types.includes("array") && schema.items) problems.push(...strictProblems(schema.items as Record<string, unknown>, `${path}[]`));
  return problems;
}
