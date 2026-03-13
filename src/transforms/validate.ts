// src/transforms/validate.ts
// AJV-powered JSON Schema validation for SailPoint ISC Transforms.
// Stage 1 → validate against the index (root shape) schema.
// Stage 2 → validate against the operation-specific schema.
//
// All schemas are loaded from ../JSONS/ at module init and compiled once.
// Schemas use JSON Schema Draft 2020-12.

import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

const __dirname = dirname(fileURLToPath(import.meta.url));
// Both src/transforms/ and dist/transforms/ are two levels deep from the project root.
const SCHEMAS_DIR = join(__dirname, "../../JSONS");

// ---------------------------------------------------------------------------
// Schema file name map: transform type → filename
// Rule-backed operations have their own dedicated schema files.
// ---------------------------------------------------------------------------
const SCHEMA_FILE_MAP: Record<string, string> = {
  accountAttribute:             "sailpoint.isc.transforms.accountAttribute.schema.json",
  base64Decode:                 "sailpoint.isc.transforms.base64Decode.schema.json",
  base64Encode:                 "sailpoint.isc.transforms.base64Encode.schema.json",
  concat:                       "sailpoint.isc.transforms.concat.schema.json",
  conditional:                  "sailpoint.isc.transforms.conditional.schema.json",
  dateCompare:                  "sailpoint.isc.transforms.dateCompare.schema.json",
  dateFormat:                   "sailpoint.isc.transforms.dateFormat.schema.json",
  dateMath:                     "sailpoint.isc.transforms.dateMath.schema.json",
  decomposeDiacriticalMarks:    "sailpoint.isc.transforms.decomposeDiacriticalMarks.schema.json",
  displayName:                  "sailpoint.isc.transforms.displayName.schema.json",
  e164phone:                    "sailpoint.isc.transforms.e164phone.schema.json",
  firstValid:                   "sailpoint.isc.transforms.firstValid.schema.json",
  generateRandomString:         "sailpoint.isc.transforms.generateRandomString.schema.json",
  getEndOfString:               "sailpoint.isc.transforms.getEndOfString.schema.json",
  getReferenceIdentityAttribute:"sailpoint.isc.transforms.getReferenceIdentityAttribute.schema.json",
  identityAttribute:            "sailpoint.isc.transforms.identityAttribute.schema.json",
  indexOf:                      "sailpoint.isc.transforms.indexOf.schema.json",
  iso3166:                      "sailpoint.isc.transforms.iso3166.schema.json",
  join:                         "sailpoint.isc.transforms.join.schema.json",
  lastIndexOf:                  "sailpoint.isc.transforms.lastIndexOf.schema.json",
  leftPad:                      "sailpoint.isc.transforms.leftPad.schema.json",
  lookup:                       "sailpoint.isc.transforms.lookup.schema.json",
  lower:                        "sailpoint.isc.transforms.lower.schema.json",
  normalizeNames:               "sailpoint.isc.transforms.normalizeNames.schema.json",
  randomAlphaNumeric:           "sailpoint.isc.transforms.randomAlphaNumeric.schema.json",
  randomNumeric:                "sailpoint.isc.transforms.randomNumeric.schema.json",
  reference:                    "sailpoint.isc.transforms.reference.schema.json",
  replace:                      "sailpoint.isc.transforms.replace.schema.json",
  replaceAll:                   "sailpoint.isc.transforms.replaceAll.schema.json",
  rfc5646:                      "sailpoint.isc.transforms.rfc5646.schema.json",
  rightPad:                     "sailpoint.isc.transforms.rightPad.schema.json",
  rule:                         "sailpoint.isc.transforms.rule.schema.json",
  split:                        "sailpoint.isc.transforms.split.schema.json",
  static:                       "sailpoint.isc.transforms.static.schema.json",
  substring:                    "sailpoint.isc.transforms.substring.schema.json",
  trim:                         "sailpoint.isc.transforms.trim.schema.json",
  upper:                        "sailpoint.isc.transforms.upper.schema.json",
  usernameGenerator:            "sailpoint.isc.transforms.usernameGenerator.schema.json",
  uuid:                         "sailpoint.isc.transforms.uuid.schema.json",
};

export type ValidationError = {
  stage: "index" | "operation";
  message: string;
  path?: string;
  raw?: any;
};

export type ValidationResult = {
  valid: boolean;
  errors: ValidationError[];
  warnings: string[];
  operation_type?: string;
  doc_url?: string;
};

// ---------------------------------------------------------------------------
// AJV setup — compiled once at module init
// ---------------------------------------------------------------------------
const ajv = new (Ajv2020 as any)({
  allErrors: true,
  strict: false,       // allow unknown keywords (e.g. 'examples', 'description' on $defs)
  verbose: true,
});
addFormats(ajv as any);

// Load all JSON Schema files from the JSONS/ folder
let indexValidator: any = null;
const operationValidators: Record<string, any> = {};
const schemaLoadWarnings: string[] = [];

function loadSchemas() {
  // Load index (root shape) schema
  try {
    const indexPath = join(SCHEMAS_DIR, "sailpoint.isc.transforms.index.schema.json");
    const indexSchema = JSON.parse(readFileSync(indexPath, "utf-8"));
    indexValidator = ajv.compile(indexSchema);
  } catch (e: any) {
    schemaLoadWarnings.push(`Could not load index schema: ${e?.message ?? e}`);
  }

  // Load each operation schema
  for (const [type, filename] of Object.entries(SCHEMA_FILE_MAP)) {
    try {
      const schemaPath = join(SCHEMAS_DIR, filename);
      const schemaText = readFileSync(schemaPath, "utf-8");
      const schema = JSON.parse(schemaText);
      // Remove $id to avoid AJV URI conflicts when registering multiple schemas
      delete schema.$id;
      operationValidators[type] = ajv.compile(schema);
    } catch (e: any) {
      schemaLoadWarnings.push(`Could not load schema for '${type}': ${e?.message ?? e}`);
    }
  }
}

loadSchemas();

// ---------------------------------------------------------------------------
// AJV error → readable message
// ---------------------------------------------------------------------------
function formatAjvError(err: any): ValidationError {
  const path = err.instancePath || err.schemaPath || "";
  let message = err.message ?? "Validation error";

  // Make messages more human-readable
  if (err.keyword === "additionalProperties") {
    const extra = err.params?.additionalProperty;
    message = extra
      ? `Unknown property '${extra}' is not allowed here.`
      : "Unknown additional property not allowed.";
  } else if (err.keyword === "required") {
    const missing = err.params?.missingProperty;
    message = missing ? `Missing required field: '${missing}'.` : message;
  } else if (err.keyword === "const") {
    message = `Value must be exactly '${err.params?.allowedValue}'.`;
  } else if (err.keyword === "enum") {
    const allowed = (err.params?.allowedValues ?? []).join(", ");
    message = `Value must be one of: ${allowed}.`;
  } else if (err.keyword === "minLength") {
    message = `Value must be at least ${err.params?.limit} characters.`;
  } else if (err.keyword === "type") {
    message = `Type mismatch: expected ${err.params?.type}, got ${typeof err.data}.`;
  } else if (err.keyword === "pattern") {
    message = `Value '${String(err.data).slice(0, 60)}' does not match required pattern: ${err.params?.pattern}.`;
  } else if (err.keyword === "oneOf") {
    message = `Value must match exactly one of the allowed schemas.`;
  }

  return {
    stage: "index", // will be overridden by caller
    message,
    path: path || undefined,
    raw: { keyword: err.keyword, params: err.params, schemaPath: err.schemaPath },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

const DOCS_BASE = "https://developer.sailpoint.com/docs/extensibility/transforms/operations";
const TYPE_TO_DOC_SLUG: Record<string, string> = {
  accountAttribute: "account-attribute",
  base64Decode: "base64-decode", base64Encode: "base64-encode",
  concat: "concatenation", conditional: "conditional",
  dateCompare: "date-compare", dateFormat: "date-format", dateMath: "date-math",
  decomposeDiacriticalMarks: "decompose-diacritical-marks", displayName: "display-name",
  e164phone: "e-164-phone", firstValid: "first-valid",
  generateRandomString: "generate-random-string", getEndOfString: "get-end-of-string",
  getReferenceIdentityAttribute: "get-reference-identity-attribute",
  identityAttribute: "identity-attribute", indexOf: "index-of", iso3166: "iso3166",
  join: "join", lastIndexOf: "last-index-of", leftPad: "left-pad", lookup: "lookup",
  lower: "lower", normalizeNames: "name-normalizer", randomAlphaNumeric: "random-alphanumeric",
  randomNumeric: "random-numeric", reference: "reference", replace: "replace",
  replaceAll: "replace-all", rfc5646: "rfc5646", rightPad: "right-pad",
  rule: "rule", split: "split", static: "static", substring: "substring",
  trim: "trim", upper: "upper", usernameGenerator: "username-generator", uuid: "uuid-generator",
};

export function validateTransform(input: any): ValidationResult {
  const warnings: string[] = [...schemaLoadWarnings];
  const errors: ValidationError[] = [];

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      valid: false,
      errors: [{ stage: "index", message: "Transform must be a JSON object." }],
      warnings,
    };
  }

  // ---- Stage 1: Index (root shape) schema ----
  if (indexValidator) {
    const valid = indexValidator(input);
    if (!valid) {
      for (const err of indexValidator.errors ?? []) {
        const formatted = formatAjvError(err);
        formatted.stage = "index";
        errors.push(formatted);
      }
    }
  } else {
    warnings.push("Index schema not available; root shape validation skipped.");
  }

  // Determine operation type
  const rawType = String(input.type ?? "").trim();
  // Resolve rule-backed ops: type=rule with known operation attribute
  let opType = rawType;
  if (rawType === "rule" && typeof input.attributes?.operation === "string") {
    const ruleBacked = ["generateRandomString", "getEndOfString", "getReferenceIdentityAttribute"];
    if (ruleBacked.includes(input.attributes.operation)) {
      opType = input.attributes.operation;
    }
  }

  const docSlug = TYPE_TO_DOC_SLUG[opType] ?? TYPE_TO_DOC_SLUG[rawType];
  const docUrl = docSlug ? `${DOCS_BASE}/${docSlug}/` : undefined;

  // ---- Stage 2: Operation-specific schema ----
  const opValidator = operationValidators[opType] ?? operationValidators[rawType];
  if (opValidator) {
    const valid = opValidator(input);
    if (!valid) {
      for (const err of opValidator.errors ?? []) {
        const formatted = formatAjvError(err);
        formatted.stage = "operation";
        errors.push(formatted);
      }
    }
  } else if (rawType) {
    warnings.push(`No operation-specific schema found for type '${opType}'. Only root-level validation was performed.`);
  }

  // Deduplicate errors by message+path
  const seen = new Set<string>();
  const deduped = errors.filter((e) => {
    const key = `${e.stage}:${e.path ?? ""}:${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    valid: deduped.length === 0,
    errors: deduped,
    warnings,
    operation_type: opType || undefined,
    doc_url: docUrl,
  };
}

export function getOperationSchema(type: string): object | null {
  const filename = SCHEMA_FILE_MAP[type];
  if (!filename) return null;
  try {
    const schemaPath = join(SCHEMAS_DIR, filename);
    return JSON.parse(readFileSync(schemaPath, "utf-8"));
  } catch {
    return null;
  }
}

export function listSchemaCoverage(): { type: string; hasSchema: boolean }[] {
  return Object.keys(SCHEMA_FILE_MAP).map((type) => ({
    type,
    hasSchema: Boolean(operationValidators[type]),
  }));
}
