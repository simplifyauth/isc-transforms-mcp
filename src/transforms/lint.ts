// src/transforms/lint.ts
// Strict SailPoint ISC transform linter — aligned with official docs and per-type JSON schemas.
//
// Doc references:
// https://developer.sailpoint.com/docs/extensibility/transforms/operations/
// JSON schemas: ../JSONS/sailpoint.isc.transforms.<type>.schema.json (all have additionalProperties:false)

import type { TransformSpec } from "./catalog.js";
import { getTransformSpec, toCanonicalType } from "./catalog.js";
import { deepNormalizeTransform } from "./normalize.js";

export type LintMessage = {
  level: "error" | "warn" | "info";
  message: string;
  path?: string;
};

// ---------------------------------------------------------------------------
// Per-type allowed attribute sets (derived from JSON schemas, additionalProperties:false)
// "open" = schema permits additionalProperties (dynamic variables etc.)
// ---------------------------------------------------------------------------
const ALLOWED_ATTRS: Record<string, Set<string> | "open"> = {
  accountAttribute: new Set([
    "sourceName", "applicationId", "applicationName", "attributeName",
    "accountSortAttribute", "accountSortDescending", "accountReturnFirstLink",
    "accountFilter", "accountPropertyFilter", "input",
  ]),
  base64Decode:   new Set(["input"]),
  base64Encode:   new Set(["input"]),
  concat:         new Set(["values", "input"]),
  conditional:    "open",     // dynamic variable keys allowed per docs
  dateCompare:    new Set(["firstDate", "secondDate", "operator", "positiveCondition", "negativeCondition", "input"]),
  dateFormat:     new Set(["input", "inputFormat", "outputFormat"]),
  dateMath:       new Set(["expression", "input", "roundUp"]),
  decomposeDiacriticalMarks: new Set(["input"]),
  displayName:    new Set(["input"]),
  e164phone:      new Set(["input", "defaultRegion"]),
  firstValid:     new Set(["values", "input"]),
  identityAttribute: new Set(["name", "input"]),
  indexOf:        new Set(["substring", "input"]),
  iso3166:        new Set(["format", "input"]),
  join:           new Set(["values", "separator"]),
  lastIndexOf:    new Set(["substring", "input"]),
  leftPad:        new Set(["length", "padding", "input"]),
  lookup:         new Set(["table", "input"]),
  lower:          new Set(["input"]),
  normalizeNames: new Set(["input"]),
  randomAlphaNumeric: new Set(["length"]),
  randomNumeric:  new Set(["length"]),
  reference:      new Set(["id"]),
  replace:        new Set(["regex", "replacement", "input"]),
  replaceAll:     new Set(["table", "input"]),
  rfc5646:        new Set(["format", "input"]),
  rightPad:       new Set(["length", "padding", "input"]),
  rule:           "open",     // rule-specific attributes vary
  split:          new Set(["delimiter", "index", "input"]),
  static:         "open",     // value + any named VTL dynamic variable keys allowed per docs
  substring:      new Set(["begin", "end", "input"]),
  trim:           new Set(["input"]),
  upper:          new Set(["input"]),
  usernameGenerator: new Set(["patterns", "sourceCheck"]),
  uuid:           new Set([]),
  // Rule-backed ops (normalized to type=rule, but linted by operation key)
  generateRandomString:          new Set(["name", "operation", "length", "includeNumbers", "includeSpecialChars"]),
  getEndOfString:                new Set(["name", "operation", "numChars", "input"]),
  getReferenceIdentityAttribute: new Set(["name", "operation", "uid", "attributeName"]),
};

// Top-level fields allowed on every transform (per ISC Transform API schema)
const ALLOWED_TOP_LEVEL = new Set(["type", "name", "attributes", "internal", "requiresPeriodicRefresh", "id"]);

// ---------------------------------------------------------------------------
// Tiny utilities
// ---------------------------------------------------------------------------

type Severity = "error" | "warn" | "info";

function push(msgs: LintMessage[], level: Severity, message: string, path?: string) {
  msgs.push({ level, message, path });
}

function hasAny(obj: any, keys: string[]): boolean {
  return keys.some(
    (k) => obj?.[k] !== undefined && obj?.[k] !== null && String(obj[k]).length > 0
  );
}

function isPlainObject(v: any): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNumberish(v: any): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string" && v.trim().length) return Number.isFinite(Number(v));
  return false;
}

function isBooleanString(v: any): boolean {
  const s = String(v).toLowerCase();
  return s === "true" || s === "false";
}

function looksLikeTransform(v: any): boolean {
  if (!isPlainObject(v)) return false;
  if (typeof v.type !== "string" || v.type.length === 0) return false;
  if (v.attributes !== undefined && !isPlainObject(v.attributes)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 1. Top-level field validation
// ---------------------------------------------------------------------------

function lintTopLevel(input: any): LintMessage[] {
  const msgs: LintMessage[] = [];

  // Unknown top-level keys → error (additionalProperties:false at root)
  for (const k of Object.keys(input)) {
    if (!ALLOWED_TOP_LEVEL.has(k)) {
      push(msgs, "error", `Unknown top-level field '${k}'. Allowed: ${Array.from(ALLOWED_TOP_LEVEL).join(", ")}.`, k);
    }
  }

  // name — required string, non-empty
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      push(msgs, "error", "name must be a non-empty string.", "name");
    }
  }

  // internal — boolean only
  if (input.internal !== undefined && typeof input.internal !== "boolean") {
    push(msgs, "error", "internal must be a boolean (true/false).", "internal");
  }

  // requiresPeriodicRefresh — boolean only (controls nightly identity refresh)
  // Docs: https://developer.sailpoint.com/docs/extensibility/transforms/
  if (input.requiresPeriodicRefresh !== undefined && typeof input.requiresPeriodicRefresh !== "boolean") {
    push(msgs, "error", "requiresPeriodicRefresh must be a boolean (true/false). Default: false.", "requiresPeriodicRefresh");
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// 2. Required attribute checks (catalog-driven, with OR support)
// ---------------------------------------------------------------------------

function checkRequired(spec: TransformSpec, attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  for (const req of spec.requiredAttributes ?? []) {
    if (req.includes("|")) {
      const opts = req.split("|").map((s) => s.trim());
      if (!hasAny(attrs, opts)) {
        push(msgs, "error", `Missing required attribute — one of: ${opts.join(", ")}.`, "attributes");
      }
      continue;
    }
    const val = attrs?.[req];
    if (val === undefined || val === null || (typeof val === "string" && val.length === 0)) {
      push(msgs, "error", `Missing required attribute: ${req}.`, `attributes.${req}`);
    }
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 3. Unknown attribute check (strict per JSON schemas)
// ---------------------------------------------------------------------------

function lintUnknownAttributes(type: string, attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  const allowed = ALLOWED_ATTRS[type];
  if (!allowed || allowed === "open") return msgs; // dynamic/open schemas

  for (const k of Object.keys(attrs ?? {})) {
    if (!allowed.has(k)) {
      push(
        msgs,
        "error",
        `Unknown attribute '${k}' for transform type '${type}'. ` +
          `Allowed attributes: ${Array.from(allowed).join(", ")}. ` +
          `Remove or correct this field.`,
        `attributes.${k}`
      );
    }
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 4. Rule-backed invariants
// ---------------------------------------------------------------------------

function lintRuleBackedInvariants(requestedType: string, normalized: any, msgs: LintMessage[]) {
  const ruleBackedOps = new Set(["generateRandomString", "getEndOfString", "getReferenceIdentityAttribute"]);
  if (!ruleBackedOps.has(requestedType)) return;

  const attrs = normalized?.attributes ?? {};
  if (normalized?.type !== "rule") {
    push(msgs, "error", `Rule-backed operation '${requestedType}' must be sent as type='rule' after normalization.`, "type");
  }
  if (String(attrs?.operation ?? "") !== requestedType) {
    push(msgs, "error", `Rule-backed operation '${requestedType}' must set attributes.operation='${requestedType}'.`, "attributes.operation");
  }
  const expectedRuleName = "Cloud Services Deployment Utility";
  if (String(attrs?.name ?? "") !== expectedRuleName) {
    push(msgs, "error", `Rule-backed operation '${requestedType}' must set attributes.name='${expectedRuleName}'.`, "attributes.name");
  }
}

// ---------------------------------------------------------------------------
// 5. accountAttribute — source uniqueness (exactly ONE of sourceName / applicationId / applicationName)
// ---------------------------------------------------------------------------

function lintAccountAttribute(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];

  // --- 1. Source reference: exactly one of sourceName / applicationId / applicationName ---
  const sourceFields = ["sourceName", "applicationId", "applicationName"] as const;
  const presentSources = sourceFields.filter(
    (f) => attrs?.[f] !== undefined && attrs?.[f] !== null && String(attrs[f]).trim() !== ""
  );

  if (presentSources.length === 0) {
    push(msgs, "error",
      "accountAttribute requires exactly one source reference: sourceName (display name), " +
      "applicationId (external GUID), or applicationName (immutable internal name).",
      "attributes"
    );
  } else if (presentSources.length > 1) {
    push(msgs, "error",
      `accountAttribute must have exactly ONE source reference; found multiple: ${presentSources.join(", ")}. ` +
      "Remove all but one. Prefer applicationName for stability (display names can change).",
      "attributes"
    );
  }

  // --- 2. sourceName: non-empty, and warn about display-name fragility ---
  if (attrs?.sourceName !== undefined) {
    if (typeof attrs.sourceName !== "string" || attrs.sourceName.trim() === "") {
      push(msgs, "error", "sourceName must be a non-empty string matching the source's display name.", "attributes.sourceName");
    } else {
      push(msgs, "warn",
        "sourceName references the source display name, which can change. " +
        "If the source is renamed the transform will break. Consider using applicationName (immutable) for long-term stability.",
        "attributes.sourceName"
      );
    }
  }

  // --- 3. applicationId: non-empty string ---
  if (attrs?.applicationId !== undefined) {
    if (typeof attrs.applicationId !== "string" || attrs.applicationId.trim() === "") {
      push(msgs, "error", "applicationId must be a non-empty string (external GUID of the source).", "attributes.applicationId");
    }
  }

  // --- 4. applicationName: non-empty string ---
  if (attrs?.applicationName !== undefined) {
    if (typeof attrs.applicationName !== "string" || attrs.applicationName.trim() === "") {
      push(msgs, "error", "applicationName must be a non-empty string (immutable internal source name).", "attributes.applicationName");
    }
  }

  // --- 5. attributeName: required (caught by schema), but also check non-empty ---
  if (attrs?.attributeName !== undefined) {
    if (typeof attrs.attributeName !== "string" || attrs.attributeName.trim() === "") {
      push(msgs, "error",
        "attributeName must be a non-empty string matching the account attribute name in the source schema.",
        "attributes.attributeName"
      );
    }
  }

  // --- 6. accountSortAttribute: non-empty string; default is 'created' ---
  if (attrs?.accountSortAttribute !== undefined) {
    if (typeof attrs.accountSortAttribute !== "string") {
      push(msgs, "error", "accountSortAttribute must be a string (schema attribute name). Default is 'created'.", "attributes.accountSortAttribute");
    } else if (attrs.accountSortAttribute.trim() === "") {
      push(msgs, "error",
        "accountSortAttribute must not be empty. Omit it to use the default ('created'), or provide a valid account schema attribute name.",
        "attributes.accountSortAttribute"
      );
    }
  }

  // --- 7. accountSortDescending: boolean ---
  if (attrs?.accountSortDescending !== undefined && typeof attrs.accountSortDescending !== "boolean") {
    push(msgs, "error", "accountSortDescending must be a boolean (true = descending, false = ascending). Default is false.", "attributes.accountSortDescending");
  }

  // --- 8. accountReturnFirstLink: boolean ---
  if (attrs?.accountReturnFirstLink !== undefined && typeof attrs.accountReturnFirstLink !== "boolean") {
    push(msgs, "error",
      "accountReturnFirstLink must be a boolean. " +
      "true = return the first sorted account's value even if null; false = skip nulls and return first non-null. Default is false.",
      "attributes.accountReturnFirstLink"
    );
  }

  // --- 9. accountFilter: type, non-empty, and searchable-fields hint ---
  if (attrs?.accountFilter !== undefined) {
    if (typeof attrs.accountFilter !== "string") {
      push(msgs, "error", "accountFilter must be a string (sailpoint.object.Filter expression).", "attributes.accountFilter");
    } else if (attrs.accountFilter.trim() === "") {
      push(msgs, "error", "accountFilter must not be empty if provided. Omit it to disable database-level filtering.", "attributes.accountFilter");
    } else {
      push(msgs, "info",
        "accountFilter applies a database-level sailpoint.object.Filter. " +
        "Only these fields are searchable at database level: nativeIdentity, displayName, entitlements. " +
        "For other account attributes (e.g. custom fields, status), use accountPropertyFilter instead.",
        "attributes.accountFilter"
      );
    }
  }

  // --- 10. accountPropertyFilter: type and non-empty ---
  if (attrs?.accountPropertyFilter !== undefined) {
    if (typeof attrs.accountPropertyFilter !== "string") {
      push(msgs, "error", "accountPropertyFilter must be a string (sailpoint.object.Filter expression).", "attributes.accountPropertyFilter");
    } else if (attrs.accountPropertyFilter.trim() === "") {
      push(msgs, "error", "accountPropertyFilter must not be empty if provided. Omit it to disable in-memory filtering.", "attributes.accountPropertyFilter");
    }
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// 6. conditional — expression format
// ---------------------------------------------------------------------------

function lintConditional(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  const RESERVED = new Set(["expression", "positiveCondition", "negativeCondition"]);

  // Helper: extract all $varName references from a string
  const extractVars = (s: string): string[] =>
    (s.match(/\$([A-Za-z_][A-Za-z0-9_]*)/g) ?? []).map((v) => v.slice(1));

  // All non-reserved keys in attributes are declared dynamic variables
  const declaredVars = new Set(
    Object.keys(attrs ?? {}).filter((k) => !RESERVED.has(k))
  );

  // --- 1. expression: required, non-empty ---
  const exprRaw = attrs?.expression;
  const expr = String(exprRaw ?? "").trim();

  if (!expr) {
    push(msgs, "error", "Missing required attribute: expression.", "attributes.expression");
    return msgs;
  }

  // --- 2. Forbidden operators (using any of these throws IllegalArgumentException at runtime) ---
  const forbidden = /(!=|==|>=|<=|>|<|\bne\b|\bgt\b|\blt\b|\bge\b|\ble\b)/i;
  if (forbidden.test(expr)) {
    push(msgs, "error",
      `Unsupported operator in expression '${expr}'. ` +
      "Only 'eq' is supported — using !=, ==, >, <, ne, gt, lt, ge, le throws IllegalArgumentException at runtime.",
      "attributes.expression"
    );
  }

  // --- 3. Must contain exactly one 'eq' ---
  const eqMatches = expr.match(/\beq\b/gi) ?? [];
  if (eqMatches.length === 0) {
    push(msgs, "error",
      `Conditional expression must use the 'eq' comparator: '<ValueA> eq <ValueB>'. Got: '${expr}'.`,
      "attributes.expression"
    );
  } else if (eqMatches.length > 1) {
    push(msgs, "error",
      `Expression must contain exactly one 'eq'. Found ${eqMatches.length} occurrences in: '${expr}'. ` +
      "Nest multiple conditions using separate conditional transforms if needed.",
      "attributes.expression"
    );
  }

  // --- 4. Both sides of 'eq' must be non-empty ---
  const parts = expr.split(/\beq\b/i);
  const valueA = parts[0]?.trim() ?? "";
  const valueB = parts[1]?.trim() ?? "";

  if (parts.length !== 2 || valueA.length === 0 || valueB.length === 0) {
    push(msgs, "error",
      `Expression must follow '<ValueA> eq <ValueB>' with non-empty values on both sides. Got: '${expr}'.`,
      "attributes.expression"
    );
  }

  // --- 5. Case-sensitivity info for literal operands ---
  if (valueA.length > 0 && valueB.length > 0) {
    const aIsVar = valueA.startsWith("$");
    const bIsVar = valueB.startsWith("$");
    if (!aIsVar || !bIsVar) {
      push(msgs, "info",
        "Conditional comparisons are case-sensitive. " +
        `'${!aIsVar ? valueA : valueB}' must match the source value exactly — ` +
        "'Engineering' and 'engineering' are treated as different values.",
        "attributes.expression"
      );
    }
  }

  // --- 6. Cross-check $variable references in expression ---
  if (valueA.length > 0 && valueB.length > 0) {
    for (const varName of extractVars(expr)) {
      if (!declaredVars.has(varName)) {
        push(msgs, "error",
          `Expression references '$${varName}' but no matching variable key '${varName}' is declared in attributes. ` +
          `Add a '${varName}' key to attributes as a static string or nested transform.`,
          "attributes.expression"
        );
      }
    }
  }

  // --- 7. positiveCondition: type check + $var cross-check ---
  const posRaw = attrs?.positiveCondition;
  if (posRaw !== undefined) {
    if (typeof posRaw !== "string") {
      push(msgs, "error",
        "positiveCondition must be a string — either a static value or a $variableName reference.",
        "attributes.positiveCondition"
      );
    } else {
      for (const varName of extractVars(posRaw)) {
        if (!declaredVars.has(varName)) {
          push(msgs, "error",
            `positiveCondition references '$${varName}' but no matching variable key '${varName}' is declared in attributes. ` +
            `Add a '${varName}' key to attributes as a static string or nested transform.`,
            "attributes.positiveCondition"
          );
        }
      }
    }
  }

  // --- 8. negativeCondition: type check + $var cross-check ---
  const negRaw = attrs?.negativeCondition;
  if (negRaw !== undefined) {
    if (typeof negRaw !== "string") {
      push(msgs, "error",
        "negativeCondition must be a string — either a static value or a $variableName reference.",
        "attributes.negativeCondition"
      );
    } else {
      for (const varName of extractVars(negRaw)) {
        if (!declaredVars.has(varName)) {
          push(msgs, "error",
            `negativeCondition references '$${varName}' but no matching variable key '${varName}' is declared in attributes. ` +
            `Add a '${varName}' key to attributes as a static string or nested transform.`,
            "attributes.negativeCondition"
          );
        }
      }
    }
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// 7. replace — validate regex compiles
// ---------------------------------------------------------------------------

function lintReplace(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];

  if (attrs?.regex !== undefined) {
    if (typeof attrs.regex !== "string") {
      push(msgs, "error", "regex must be a string.", "attributes.regex");
    } else {
      // Try to compile the regex — catch syntax errors early before ISC does
      try {
        new RegExp(attrs.regex);
      } catch (e: any) {
        push(msgs, "error",
          `regex '${attrs.regex}' is not a valid regular expression: ${e?.message ?? e}.`,
          "attributes.regex"
        );
      }
    }
  }

  if (attrs?.replacement !== undefined && typeof attrs.replacement !== "string") {
    push(msgs, "error", "replacement must be a string.", "attributes.replacement");
  }

  if (attrs?.input === undefined) {
    push(msgs, "warn",
      "replace typically expects an attributes.input (nested transform or attribute reference).",
      "attributes.input"
    );
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// 8. replaceAll — table validation
// ---------------------------------------------------------------------------

function lintReplaceAll(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  if (attrs?.table !== undefined) {
    if (!isPlainObject(attrs.table) || Array.isArray(attrs.table)) {
      push(msgs, "error", "table must be an object map of key → value string pairs.", "attributes.table");
    } else {
      const badEntries = Object.entries(attrs.table).filter(([, v]) => typeof v !== "string");
      if (badEntries.length) {
        push(msgs, "error",
          `All table values must be strings. Non-string entries: ${badEntries.map(([k]) => k).join(", ")}.`,
          "attributes.table"
        );
      }
    }
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 9. dateMath — expression grammar
// ---------------------------------------------------------------------------

function lintDateMath(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  const expr = attrs?.expression;

  if (expr !== undefined) {
    if (typeof expr !== "string" || expr.trim().length === 0) {
      push(msgs, "error", "expression must be a non-empty string.", "attributes.expression");
    } else {
      const s = expr.trim();

      if (/\s/.test(s)) {
        push(msgs, "error", "expression must not contain whitespace.", "attributes.expression");
      }

      if (!/^[0-9yMwdhmsnow+\-/]+$/.test(s)) {
        push(msgs, "error",
          "expression contains invalid characters. Allowed: digits, y M w d h m s, now, +, -, /.",
          "attributes.expression"
        );
      }

      let i = 0;
      const n = s.length;
      const startsWithNow = s.startsWith("now");
      if (startsWithNow) i += 3;
      if (!startsWithNow && s.includes("now")) {
        push(msgs, "error", "'now' keyword must appear only at the start of the expression.", "attributes.expression");
      }

      let sawOp = false, sawRound = false, roundUnit: string | null = null;

      const readInt = (): string | null => {
        const start = i;
        while (i < n && /[0-9]/.test(s[i]!)) i++;
        return i > start ? s.slice(start, i) : null;
      };
      const readUnit = (): string | null => {
        if (i >= n) return null;
        const ch = s[i]!;
        if (!new Set(["y","M","w","d","h","m","s"]).has(ch)) return null;
        i++;
        return ch;
      };
      const readSignedTerm = (op: "+" | "-") => {
        const num = readInt();
        if (!num) { push(msgs, "error", `Missing integer after '${op}' in expression.`, "attributes.expression"); return; }
        if (Number(num) === 0) push(msgs, "warn", `Term '${op}${num}' is a no-op (zero).`, "attributes.expression");
        const unit = readUnit();
        if (!unit) push(msgs, "error", `Missing unit after '${op}${num}'. Allowed: y M w d h m s.`, "attributes.expression");
      };
      const readRound = () => {
        const unit = readUnit();
        if (!unit) { push(msgs, "error", "Rounding '/' must be followed by a unit (y M w d h m s).", "attributes.expression"); return; }
        sawRound = true; roundUnit = unit;
      };

      if (i < n && s[i] === "/") {
        i++; readRound();
        if (i < n) push(msgs, "error", "Rounding must be the last part of the expression.", "attributes.expression");
      } else {
        while (i < n) {
          const ch = s[i]!;
          if (ch === "+" || ch === "-") {
            if (sawRound) { push(msgs, "error", "Add/subtract terms cannot appear after rounding ('/').", "attributes.expression"); break; }
            sawOp = true; i++;
            readSignedTerm(ch as "+" | "-");
            continue;
          }
          if (ch === "/") {
            if (sawRound) { push(msgs, "error", "Only one rounding operator '/' is supported.", "attributes.expression"); break; }
            i++; readRound();
            if (i < n) push(msgs, "error", "Rounding must be the last part of the expression.", "attributes.expression");
            break;
          }
          push(msgs, "error", `Unexpected token '${ch}'. Use patterns like 'now-5d/d' or '+3M/h'.`, "attributes.expression");
          break;
        }
      }

      if (!startsWithNow && s !== "" && s[0] !== "+" && s[0] !== "-" && s[0] !== "/") {
        push(msgs, "error", "Expression must start with 'now', '+', '-', or '/'.", "attributes.expression");
      }
      // Week rounding not supported (SailPoint docs)
      if (roundUnit === "w") {
        push(msgs, "error", "Rounding with 'w' (week) is not supported in dateMath expressions.", "attributes.expression");
      }
      if (!startsWithNow && !sawOp && !sawRound) {
        push(msgs, "error", "Expression must contain 'now', at least one +/- term, or a rounding segment.", "attributes.expression");
      }
      if (!startsWithNow && attrs?.input === undefined) {
        push(msgs, "error",
          "dateMath expression without 'now' requires an input date transform in attributes.input.",
          "attributes.input"
        );
      }
    }
  }

  if (attrs?.roundUp !== undefined && typeof attrs.roundUp !== "boolean") {
    push(msgs, "error", "roundUp must be a boolean.", "attributes.roundUp");
  }
  if (attrs?.input !== undefined) {
    const inp = attrs.input;
    if (!(inp && typeof inp === "object" && typeof inp.type === "string")) {
      push(msgs, "warn", "input should be a nested transform object {type, attributes}.", "attributes.input");
    }
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// 10. dateCompare — field validation
// ---------------------------------------------------------------------------

function lintDateCompare(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
  const isNestedTransform = (v: any): boolean => !!(v && typeof v === "object" && typeof v.type === "string");

  const checkDateOperand = (field: "firstDate" | "secondDate") => {
    const v = attrs?.[field];
    if (v === undefined || v === null) {
      push(msgs, "error", `${field} is required.`, `attributes.${field}`);
      return;
    }
    if (typeof v === "string") {
      const t = v.trim();
      if (t.toLowerCase() === "now") return;
      if (!ISO8601_RE.test(t)) {
        push(msgs, "error",
          `${field} must be an ISO8601 datetime (e.g., 2025-01-01T00:00:00Z), 'now', or a nested transform.`,
          `attributes.${field}`
        );
      }
      return;
    }
    if (isNestedTransform(v)) return;
    push(msgs, "error", `${field} must be a string (ISO8601/'now') or a nested transform object.`, `attributes.${field}`);
  };

  checkDateOperand("firstDate");
  checkDateOperand("secondDate");

  const op = attrs?.operator;
  if (!op || String(op).trim() === "") {
    push(msgs, "error", "operator is required.", "attributes.operator");
  } else {
    const v = String(op).trim().toUpperCase();
    if (!new Set(["LT", "LTE", "GT", "GTE"]).has(v)) {
      push(msgs, "error", "operator must be one of: LT, LTE, GT, GTE (case-insensitive).", "attributes.operator");
    }
  }

  if (attrs?.positiveCondition === undefined || attrs.positiveCondition === null) {
    push(msgs, "error", "positiveCondition is required for dateCompare.", "attributes.positiveCondition");
  } else if (typeof attrs.positiveCondition !== "string") {
    push(msgs, "error", "positiveCondition must be a string.", "attributes.positiveCondition");
  }
  if (attrs?.negativeCondition === undefined || attrs.negativeCondition === null) {
    push(msgs, "error", "negativeCondition is required for dateCompare.", "attributes.negativeCondition");
  } else if (typeof attrs.negativeCondition !== "string") {
    push(msgs, "error", "negativeCondition must be a string.", "attributes.negativeCondition");
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// 11. dateFormat — named formats + pattern validation
// ---------------------------------------------------------------------------

function lintDateFormat(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  // Exact set of named formats per SailPoint docs — no variants accepted.
  const NAMED_FORMATS = new Set(["ISO8601", "LDAP", "PEOPLE_SOFT", "EPOCH_TIME_JAVA", "EPOCH_TIME_WIN32"]);
  // A value that is ALL_CAPS_WITH_UNDERSCORES is clearly intended as a named constant, not a pattern.
  const looksLikeNamedConstant = (s: string) => /^[A-Z][A-Z0-9_]+$/.test(s);
  const isLikelyPattern = (s: string) => /[yMdHhmsSZ]/.test(s);

  const checkFmt = (field: "inputFormat" | "outputFormat") => {
    const raw = attrs?.[field];
    if (raw === undefined) return;
    if (typeof raw !== "string") {
      push(msgs, "error", `${field} must be a string (named format or pattern).`, `attributes.${field}`);
      return;
    }
    const t = raw.trim();
    // If the value looks like a named constant (ALL_CAPS_UNDERSCORES), validate strictly.
    // Do NOT fall through to isLikelyPattern — e.g. EPOCH_TIME_JAVA_IN_MILLIS contains
    // 'H' and 'M' and would falsely pass the pattern check.
    if (looksLikeNamedConstant(t)) {
      if (!NAMED_FORMATS.has(t)) {
        push(msgs, "error",
          `'${t}' is not a valid named format for ${field}. ` +
          `Allowed named formats: ${Array.from(NAMED_FORMATS).join(", ")}. ` +
          `Alternatively, use a Java SimpleDateFormat pattern (e.g. dd-MM-yyyy, yyyy-MM-dd'T'HH:mm:ssZ).`,
          `attributes.${field}`
        );
      }
      return;
    }
    // Value looks like a date pattern — check it has at least one date token.
    if (!isLikelyPattern(t)) {
      push(msgs, "warn",
        `${field} '${t}' doesn't match a known named format and doesn't look like a date pattern (missing tokens like y/M/d/H).`,
        `attributes.${field}`
      );
    }
  };

  checkFmt("inputFormat");
  checkFmt("outputFormat");

  if (attrs?.input !== undefined) {
    const inp = attrs.input;
    if (typeof inp === "object" && inp !== null && typeof (inp as any).type !== "string") {
      push(msgs, "warn", "input looks like an object but is missing a nested transform 'type'.", "attributes.input");
    } else if (typeof inp !== "string" && !isPlainObject(inp)) {
      push(msgs, "warn", "input should be a string or a nested transform object.", "attributes.input");
    }
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// 12. usernameGenerator — patterns array
// ---------------------------------------------------------------------------

function lintUsernameGenerator(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  const patterns = attrs?.patterns;
  if (patterns !== undefined) {
    if (!Array.isArray(patterns) || patterns.length === 0) {
      push(msgs, "error", "patterns must be a non-empty array of strings.", "attributes.patterns");
    } else {
      const bad = patterns.findIndex((p) => typeof p !== "string" || p.trim().length === 0);
      if (bad >= 0) {
        push(msgs, "error", `Each pattern must be a non-empty string. Invalid at index [${bad}].`, `attributes.patterns[${bad}]`);
      }
      // uniqueCounter must be last per docs
      const idx = patterns.findIndex((p) => typeof p === "string" && p.includes("uniqueCounter"));
      if (idx >= 0 && idx !== patterns.length - 1) {
        push(msgs, "warn", "Pattern containing 'uniqueCounter' should be last in the patterns array.", "attributes.patterns");
      }
    }
  }
  if (attrs?.sourceCheck !== undefined && typeof attrs.sourceCheck !== "boolean") {
    push(msgs, "error", "sourceCheck must be a boolean.", "attributes.sourceCheck");
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 13. generateRandomString — length + bool string attrs
// ---------------------------------------------------------------------------

function lintGenerateRandomString(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  const length = attrs?.length;
  if (length !== undefined) {
    const n = Number(length);
    if (!Number.isFinite(n) || n <= 0) {
      push(msgs, "error", "length must be a positive number (string or number).", "attributes.length");
    } else if (n > 450) {
      push(msgs, "warn", "length exceeds documented maximum (450).", "attributes.length");
    }
  }
  for (const k of ["includeNumbers", "includeSpecialChars"] as const) {
    if (attrs?.[k] !== undefined && !isBooleanString(attrs[k])) {
      push(msgs, "error", `${k} must be "true" or "false" (string), as required by the CSDU rule.`, `attributes.${k}`);
    }
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 14. getEndOfString — numChars (not length)
// ---------------------------------------------------------------------------

function lintGetEndOfString(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  if (attrs?.length !== undefined && attrs?.numChars === undefined) {
    push(msgs, "error",
      "getEndOfString uses 'numChars', not 'length'. Rename the attribute. Docs: https://developer.sailpoint.com/docs/extensibility/transforms/operations/get-end-of-string/",
      "attributes.length"
    );
  }
  const numChars = attrs?.numChars;
  if (numChars !== undefined) {
    const n = Number(numChars);
    if (!Number.isFinite(n) || n <= 0) {
      push(msgs, "error", "numChars must be a positive number.", "attributes.numChars");
    }
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 15. getReferenceIdentityAttribute
// ---------------------------------------------------------------------------

function lintGetReferenceIdentityAttribute(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  if (attrs?.uid !== undefined && typeof attrs.uid !== "string") {
    push(msgs, "error", "uid must be a string (identity username or 'manager' keyword).", "attributes.uid");
  }
  if (attrs?.attributeName !== undefined && typeof attrs.attributeName !== "string") {
    push(msgs, "error", "attributeName must be a string (identity attribute system name).", "attributes.attributeName");
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 16. join — separator (not delimiter)
// ---------------------------------------------------------------------------

function lintJoin(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  if (attrs?.delimiter !== undefined) {
    push(msgs, "error",
      "'delimiter' is not a valid attribute for join. Use 'separator' instead. Docs: https://developer.sailpoint.com/docs/extensibility/transforms/operations/join/",
      "attributes.delimiter"
    );
  }
  if (attrs?.separator !== undefined && typeof attrs.separator !== "string") {
    push(msgs, "error", "separator must be a string.", "attributes.separator");
  }
  if (attrs?.values !== undefined && !Array.isArray(attrs.values)) {
    push(msgs, "error", "values must be an array.", "attributes.values");
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 17. iso3166 — format enum
// ---------------------------------------------------------------------------

function lintIso3166(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  if (attrs?.format !== undefined) {
    if (typeof attrs.format !== "string") {
      push(msgs, "error", "format must be a string.", "attributes.format");
    } else if (!new Set(["alpha2", "alpha3", "numeric"]).has(attrs.format)) {
      push(msgs, "error", "format must be one of: alpha2, alpha3, numeric.", "attributes.format");
    }
  }
  if (attrs?.defaultRegion !== undefined) {
    push(msgs, "error",
      "'defaultRegion' is not a valid attribute for iso3166. Did you mean the e164phone transform?",
      "attributes.defaultRegion"
    );
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 18. lookup — table validation + default key warning
// ---------------------------------------------------------------------------

function lintLookup(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  if (attrs?.table !== undefined) {
    if (!isPlainObject(attrs.table)) {
      push(msgs, "error", "table must be an object map of key → string value.", "attributes.table");
    } else {
      if (!Object.prototype.hasOwnProperty.call(attrs.table, "default")) {
        push(msgs, "warn",
          "lookup table is missing a 'default' key. Without it, the transform errors if input doesn't match any key.",
          "attributes.table"
        );
      }
      const badVals = Object.entries(attrs.table).filter(([, v]) => typeof v !== "string");
      if (badVals.length) {
        push(msgs, "error",
          `All lookup table values must be strings. Non-string entries: ${badVals.map(([k]) => k).join(", ")}.`,
          "attributes.table"
        );
      }
    }
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 19. e164phone — defaultRegion format
// ---------------------------------------------------------------------------

function lintE164Phone(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  if (attrs?.defaultRegion !== undefined) {
    if (typeof attrs.defaultRegion !== "string") {
      push(msgs, "error", "defaultRegion must be an ISO 3166-1 alpha-2 region code string (e.g., 'US', 'AU').", "attributes.defaultRegion");
    } else if (!/^[A-Z]{2}$/.test(attrs.defaultRegion.toUpperCase())) {
      push(msgs, "warn",
        `defaultRegion '${attrs.defaultRegion}' doesn't look like a 2-letter ISO 3166-1 alpha-2 code.`,
        "attributes.defaultRegion"
      );
    }
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 20. normalizeNames — unsupported attributes
// ---------------------------------------------------------------------------

function lintNormalizeNames(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  if (attrs?.regex !== undefined) {
    push(msgs, "error",
      "'regex' is not a documented attribute for normalizeNames. This transform uses built-in normalization rules.",
      "attributes.regex"
    );
  }
  if (attrs?.replacement !== undefined) {
    push(msgs, "error",
      "'replacement' is not a documented attribute for normalizeNames. This transform uses built-in normalization rules.",
      "attributes.replacement"
    );
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 21. split — delimiter + index types
// ---------------------------------------------------------------------------

function lintSplit(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  if (attrs?.delimiter !== undefined && typeof attrs.delimiter !== "string") {
    push(msgs, "error", "delimiter must be a string.", "attributes.delimiter");
  }
  if (attrs?.index !== undefined && !isNumberish(attrs.index)) {
    push(msgs, "error", "index must be a number (or numeric string).", "attributes.index");
  }
  if (attrs?.input === undefined) {
    push(msgs, "warn", "split typically expects attributes.input.", "attributes.input");
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 22. pad transforms (leftPad / rightPad)
// ---------------------------------------------------------------------------

function lintPad(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  if (attrs?.length !== undefined && !isNumberish(attrs.length)) {
    push(msgs, "error", "length must be a number (or numeric string).", "attributes.length");
  }
  if (attrs?.padding !== undefined && typeof attrs.padding !== "string") {
    push(msgs, "error", "padding must be a string.", "attributes.padding");
  }
  if (attrs?.input === undefined) {
    push(msgs, "warn", "pad transforms typically expect attributes.input.", "attributes.input");
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 23. substring — begin/end numbers
// ---------------------------------------------------------------------------

function lintSubstring(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  if (attrs?.begin !== undefined && !isNumberish(attrs.begin)) {
    push(msgs, "error", "begin must be a number (or numeric string).", "attributes.begin");
  }
  if (attrs?.end !== undefined && !isNumberish(attrs.end)) {
    push(msgs, "error", "end must be a number (or numeric string).", "attributes.end");
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 24. static — value must be a string
// ---------------------------------------------------------------------------

function lintStatic(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  // Presence check is handled by checkRequired (spec.requiredAttributes).
  // Here we only validate the type when value is present.
  if (attrs?.value !== undefined && attrs?.value !== null && typeof attrs.value !== "string") {
    push(msgs, "error", "value must be a string.", "attributes.value");
  }
  // Any other keys in attributes are valid dynamic VTL variable definitions — no unknown-attribute errors.
  return msgs;
}

// ---------------------------------------------------------------------------
// 25. indexOf / lastIndexOf
// ---------------------------------------------------------------------------

function lintIndexOf(t: string, attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  if (attrs?.substring !== undefined && typeof attrs.substring !== "string") {
    push(msgs, "error", "substring must be a string.", "attributes.substring");
  }
  if (attrs?.input === undefined) {
    push(msgs, "warn", `${t} typically expects attributes.input.`, "attributes.input");
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 26. randomAlphaNumeric / randomNumeric — length
// ---------------------------------------------------------------------------

function lintRandom(t: string, attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  if (attrs?.length !== undefined) {
    const n = Number(attrs.length);
    if (!Number.isFinite(n) || n <= 0) {
      push(msgs, "error", "length must be a positive number.", "attributes.length");
    } else if (n > 450) {
      push(msgs, "warn", "length exceeds documented maximum (450).", "attributes.length");
    }
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 27. rfc5646 — format type check
// ---------------------------------------------------------------------------

function lintRfc5646(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  if (attrs?.format !== undefined && typeof attrs.format !== "string") {
    push(msgs, "error", "format must be a string.", "attributes.format");
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// Main lintTransform export
// ---------------------------------------------------------------------------

export function lintTransform(input: any): { normalized: any; messages: LintMessage[] } {
  const messages: LintMessage[] = [];

  if (!input || typeof input !== "object") {
    return { normalized: input, messages: [{ level: "error", message: "Transform must be a JSON object." }] };
  }

  // --- Top-level field validation ---
  messages.push(...lintTopLevel(input));

  const requestedType = toCanonicalType(String(input.type || ""));
  if (!requestedType) {
    return {
      normalized: input,
      messages: [
        ...messages,
        { level: "error", message: `Unknown transform type: '${String(input.type)}'. Run isc.transforms.catalog to see all valid types.` },
      ],
    };
  }

  const spec = getTransformSpec(requestedType);
  if (!spec) {
    return {
      normalized: input,
      messages: [...messages, { level: "error", message: `No spec found for transform type: ${requestedType}` }],
    };
  }

  // --- Normalize ---
  const normalized = deepNormalizeTransform(input);
  const attrs = normalized.attributes ?? {};

  // --- attributes object required check ---
  if (!spec.attributesOptional && (!normalized.attributes || typeof normalized.attributes !== "object")) {
    push(messages, "error", "attributes is required and must be an object.", "attributes");
  }

  // --- Required attribute checks ---
  messages.push(...checkRequired(spec, attrs));

  // --- Unknown attribute check (strict, per JSON schemas) ---
  messages.push(...lintUnknownAttributes(requestedType, attrs));

  // --- Rule-backed invariants ---
  lintRuleBackedInvariants(requestedType, normalized, messages);

  // --- Operation-specific lint ---
  if (requestedType === "accountAttribute")             messages.push(...lintAccountAttribute(attrs));
  if (requestedType === "conditional")                  messages.push(...lintConditional(attrs));
  if (requestedType === "replace")                      messages.push(...lintReplace(attrs));
  if (requestedType === "replaceAll")                   messages.push(...lintReplaceAll(attrs));
  if (requestedType === "dateMath")                     messages.push(...lintDateMath(attrs));
  if (requestedType === "dateCompare")                  messages.push(...lintDateCompare(attrs));
  if (requestedType === "dateFormat")                   messages.push(...lintDateFormat(attrs));
  if (requestedType === "usernameGenerator")            messages.push(...lintUsernameGenerator(attrs));
  if (requestedType === "generateRandomString")         messages.push(...lintGenerateRandomString(attrs));
  if (requestedType === "getEndOfString")               messages.push(...lintGetEndOfString(attrs));
  if (requestedType === "getReferenceIdentityAttribute") messages.push(...lintGetReferenceIdentityAttribute(attrs));
  if (requestedType === "join")                         messages.push(...lintJoin(attrs));
  if (requestedType === "iso3166")                      messages.push(...lintIso3166(attrs));
  if (requestedType === "lookup")                       messages.push(...lintLookup(attrs));
  if (requestedType === "e164phone")                    messages.push(...lintE164Phone(attrs));
  if (requestedType === "normalizeNames")               messages.push(...lintNormalizeNames(attrs));
  if (requestedType === "split")                        messages.push(...lintSplit(attrs));
  if (requestedType === "leftPad" || requestedType === "rightPad") messages.push(...lintPad(attrs));
  if (requestedType === "substring")                    messages.push(...lintSubstring(attrs));
  if (requestedType === "static")                       messages.push(...lintStatic(attrs));
  if (requestedType === "indexOf" || requestedType === "lastIndexOf") messages.push(...lintIndexOf(requestedType, attrs));
  if (requestedType === "randomAlphaNumeric" || requestedType === "randomNumeric") messages.push(...lintRandom(requestedType, attrs));
  if (requestedType === "rfc5646")                      messages.push(...lintRfc5646(attrs));

  // --- Recursive nested transform lint ---
  // Recursively lint every nested transform found inside attributes.
  // We start from normalized.attributes (not the root) to avoid double-linting root.
  if (normalized.attributes && typeof normalized.attributes === "object") {
    messages.push(...lintNestedTransforms(normalized.attributes, "attributes"));
  }

  return { normalized, messages };
}

/**
 * Recursively walks a subtree (starting from a transform's attributes object)
 * and lints every nested object that carries a 'type' field — i.e. nested transforms.
 * Reports errors with a path prefix so the user knows exactly where the problem is.
 */
function lintNestedTransforms(subtree: any, path: string): LintMessage[] {
  if (!subtree || typeof subtree !== "object") return [];
  const msgs: LintMessage[] = [];

  if (Array.isArray(subtree)) {
    subtree.forEach((item, idx) => {
      const itemPath = `${path}[${idx}]`;
      if (item && typeof item === "object" && typeof item.type === "string") {
        // lintTransform already recurses into the nested transform's own attributes,
        // so we only call it here — no additional recursion needed.
        const result = lintTransform(item);
        result.messages.forEach((m) =>
          msgs.push({ ...m, path: `${itemPath}${m.path ? "." + m.path : ""}` })
        );
      } else if (item && typeof item === "object") {
        msgs.push(...lintNestedTransforms(item, itemPath));
      }
    });
    return msgs;
  }

  for (const [key, value] of Object.entries(subtree)) {
    const childPath = `${path}.${key}`;
    if (value && typeof value === "object" && typeof (value as any).type === "string") {
      // Nested transform object — lintTransform handles further recursion internally.
      const result = lintTransform(value as any);
      result.messages.forEach((m) =>
        msgs.push({ ...m, path: `${childPath}${m.path ? "." + m.path : ""}` })
      );
    } else if (Array.isArray(value)) {
      msgs.push(...lintNestedTransforms(value, childPath));
    } else if (value && typeof value === "object") {
      msgs.push(...lintNestedTransforms(value, childPath));
    }
  }

  return msgs;
}
