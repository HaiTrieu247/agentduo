import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { packageRoot } from "../paths.js";

export const SCHEMA_NAMES = [
  "plan", "planner", "plan_critique", "plan_approval", "implementation", "review",
  // Team mode (packages/engine/src/team).
  "team_pm", "team_plan", "team_work", "team_review", "team_tests", "team_check", "team_triage", "team_answer",
] as const;
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

/** The two branches of the planner's answer, each compiled on its own: see validatePlanner. */
const PLANNER_KINDS = ["needs_clarification", "plan"] as const;
const branches = new Map<string, ValidateFunction>();

function plannerBranch(kind: (typeof PLANNER_KINDS)[number]): ValidateFunction {
  let validate = branches.get(kind);
  if (!validate) {
    const variants = ((loadSchema("planner").properties as Record<string, any>).result.anyOf as Array<Record<string, any>>);
    validate = ajv.compile(variants.find((v) => v.properties.kind.enum[0] === kind)!);
    branches.set(kind, validate);
  }
  return validate;
}

/**
 * The planner's answer is one of two objects (`result.kind`): its errors are those of the branch it chose, never of the
 * other, because a retry sees only them and must be told exactly what to correct.
 */
function validatePlanner(data: unknown): string[] {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return ["$: must be an object with a 'result'"];
  const root = data as Record<string, unknown>;
  const errors = Object.keys(root).filter((k) => k !== "result").map((k) => `$: unexpected property '${k}'`);
  const result = root.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return [...errors, "$.result: must be an object with a 'kind'"];
  const kind = (result as Record<string, unknown>).kind;
  if (!(PLANNER_KINDS as readonly unknown[]).includes(kind)) return [...errors, `$.result.kind: must be one of ${JSON.stringify(PLANNER_KINDS)}`];
  const validate = plannerBranch(kind as (typeof PLANNER_KINDS)[number]);
  if (validate(result)) return errors;
  return [...errors, ...(validate.errors ?? []).map((e) => formatError({ ...e, instancePath: `/result${e.instancePath}` }))];
}

/** Validate an agent's final JSON; returns human-readable errors (empty = valid). */
export function validateOutput(name: SchemaName, data: unknown): string[] {
  if (name === "planner") return validatePlanner(data);
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
  // The root of a structured output must be an object, so a choice between shapes sits inside it, not at the top.
  if (path === "$" && (schema.anyOf || schema.oneOf)) problems.push("$: the root must not be anyOf/oneOf");
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    (Array.isArray(schema[key]) ? schema[key] as Array<Record<string, unknown>> : []).forEach((sub, i) => problems.push(...strictProblems(sub, `${path}.${key}[${i}]`)));
  }
  for (const key of ["$defs", "definitions"] as const) {
    for (const [name, sub] of Object.entries((schema[key] ?? {}) as Record<string, Record<string, unknown>>)) problems.push(...strictProblems(sub, `${path}.${key}.${name}`));
  }
  return problems;
}
