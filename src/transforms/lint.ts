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
  dateCompare:    new Set(["firstDate", "secondDate", "operator", "positiveCondition", "negativeCondition"]),
  dateFormat:     new Set(["input", "inputFormat", "outputFormat"]),
  dateMath:       new Set(["expression", "input", "roundUp"]),
  decomposeDiacriticalMarks: new Set(["input"]),
  displayName:    new Set(["input"]),
  e164phone:      new Set(["input", "defaultRegion"]),
  firstValid:     new Set(["values", "ignoreErrors"]),
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
  substring:      new Set(["begin", "beginOffset", "end", "endOffset", "input"]),
  trim:           new Set(["input"]),
  upper:          new Set(["input"]),
  usernameGenerator: "open",   // patterns + sourceCheck + cloudMaxSize/Checks/Required + dynamic variable keys (fn, ln, etc.)
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
// 7. firstValid — values array + ignoreErrors
// ---------------------------------------------------------------------------

function lintFirstValid(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  const values = attrs?.values;

  // --- 1. values: required non-empty array (schema enforces, lint gives richer message) ---
  if (values === undefined || values === null) {
    push(msgs, "error",
      "values is required for firstValid. Provide an ordered array of strings or nested transforms — first non-null result is returned.",
      "attributes.values"
    );
    return msgs;
  }
  if (!Array.isArray(values)) {
    push(msgs, "error",
      "values must be an array of strings and/or nested transform objects.",
      "attributes.values"
    );
    return msgs;
  }
  if (values.length === 0) {
    push(msgs, "error",
      "values array must not be empty. Provide at least one string or nested transform.",
      "attributes.values"
    );
    return msgs;
  }

  // --- 2. Warn if only one value — firstValid is pointless with a single entry ---
  if (values.length === 1) {
    push(msgs, "warn",
      "values array has only one entry. firstValid is designed to fall back across multiple options — " +
      "consider adding additional fallback values or using a simpler transform.",
      "attributes.values"
    );
  }

  // --- 3. Validate each item: must be string or nested transform object ---
  values.forEach((item: any, idx: number) => {
    if (item === null || item === undefined) {
      push(msgs, "warn",
        `values[${idx}] is null/undefined — this entry will always be skipped. Remove it or replace with a static string fallback.`,
        `attributes.values[${idx}]`
      );
    } else if (typeof item === "string") {
      // strings are valid — no error
    } else if (isPlainObject(item)) {
      if (typeof (item as any).type !== "string" || (item as any).type.trim() === "") {
        push(msgs, "error",
          `values[${idx}] is an object but is missing a 'type' field — it does not look like a valid nested transform. ` +
          "Add a 'type' (e.g., 'accountAttribute', 'identityAttribute', 'static').",
          `attributes.values[${idx}]`
        );
      }
    } else {
      push(msgs, "error",
        `values[${idx}] must be a string or a nested transform object {type, attributes}. ` +
        `Got: ${typeof item}.`,
        `attributes.values[${idx}]`
      );
    }
  });

  // --- 4. Recommend a string fallback as the last entry ---
  const lastItem = values[values.length - 1];
  if (values.length > 1 && typeof lastItem !== "string") {
    push(msgs, "info",
      "Consider making the last entry in values a static string fallback (e.g., 'none', 'N/A') " +
      "to guarantee a non-null result when all other values are unavailable.",
      "attributes.values"
    );
  }

  // --- 5. ignoreErrors: boolean check + semantics info ---
  if (attrs?.ignoreErrors !== undefined) {
    if (typeof attrs.ignoreErrors !== "boolean") {
      push(msgs, "error",
        "ignoreErrors must be a boolean. " +
        "true = skip values that throw errors (e.g., NPE on missing manager) and evaluate next entry. " +
        "false = throw on errors (default).",
        "attributes.ignoreErrors"
      );
    } else if (attrs.ignoreErrors === false) {
      // Explicit false — check if any nested transforms reference identity attributes that could NPE
      const hasReferenceTransforms = values.some(
        (v: any) => isPlainObject(v) &&
          ["identityAttribute", "accountAttribute", "getReferenceIdentityAttribute"].includes((v as any).type)
      );
      if (hasReferenceTransforms) {
        push(msgs, "info",
          "ignoreErrors is false (default). If any entry references an attribute that doesn't exist on some identities " +
          "(e.g., a manager attribute for users without managers), a null pointer exception will stop evaluation. " +
          "Set ignoreErrors: true to safely skip failing entries.",
          "attributes.ignoreErrors"
        );
      }
    }
  } else {
    // ignoreErrors not set — same NPE risk hint if reference transforms present
    const hasReferenceTransforms = values.some(
      (v: any) => isPlainObject(v) &&
        ["identityAttribute", "accountAttribute", "getReferenceIdentityAttribute"].includes((v as any).type)
    );
    if (hasReferenceTransforms) {
      push(msgs, "info",
        "ignoreErrors defaults to false. If any entry may throw an error on some identities " +
        "(e.g., accessing a manager attribute for users without managers), set ignoreErrors: true " +
        "to skip failing entries instead of halting evaluation.",
        "attributes.ignoreErrors"
      );
    }
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// 8. replace — regex compile, all-instances info, backreference hint
// Docs: https://developer.sailpoint.com/docs/extensibility/transforms/operations/replace
// ---------------------------------------------------------------------------

function lintReplace(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];

  // 1. regex: must be a non-empty string and a valid compilable regex
  if (attrs?.regex !== undefined) {
    if (typeof attrs.regex !== "string") {
      push(msgs, "error", "regex must be a string.", "attributes.regex");
    } else if (attrs.regex.trim() === "") {
      push(msgs, "error", "regex must not be empty.", "attributes.regex");
    } else {
      // Compile check — surface syntax errors before ISC does
      try {
        new RegExp(attrs.regex);
      } catch (e: any) {
        push(msgs, "error",
          `regex '${attrs.regex}' is not a valid regular expression: ${e?.message ?? String(e)}. ` +
          "Use bracket notation for literal special characters (e.g., '[.]' for a literal dot, '[-]' for a literal hyphen).",
          "attributes.regex"
        );
      }

      // All-instances info — users often expect first-match-only behaviour
      push(msgs, "info",
        "replace replaces ALL occurrences of the pattern in the input string, not just the first match. " +
        "To target only a specific occurrence, use a more precise regex that anchors to the position you want.",
        "attributes.regex"
      );
    }
  }

  // 2. replacement: must be a string; empty string is valid and deletes all matches
  if (attrs?.replacement !== undefined) {
    if (typeof attrs.replacement !== "string") {
      push(msgs, "error",
        "replacement must be a string. Use an empty string \"\" to delete all text matched by the regex.",
        "attributes.replacement"
      );
    } else if (/\$\d+/.test(attrs.replacement)) {
      // Backreference detected — confirm the regex has the matching capture group
      push(msgs, "info",
        "replacement contains a backreference (e.g., '$1'). Ensure the regex contains a matching capture group (e.g., '(.+)'). " +
        "'$0' refers to the entire match; '$1' refers to the first capture group, '$2' to the second, etc.",
        "attributes.replacement"
      );
    }
  }

  // 3. input: optional per docs (omit to use UI-configured source+attribute).
  //    Validate type only when present.
  if (attrs?.input !== undefined) {
    const inp = attrs.input;
    if (!(typeof inp === "string" || (isPlainObject(inp) && typeof (inp as any).type === "string"))) {
      push(msgs, "warn",
        "input must be a nested transform object {type, attributes} providing the string to apply the regex to, or a static string. " +
        "If omitted, the transform uses the source+attribute combination configured in the identity profile UI.",
        "attributes.input"
      );
    }
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// 8. replaceAll — regex key validation, value type, case-sensitivity info
// Docs: https://developer.sailpoint.com/docs/extensibility/transforms/operations/replace-all
// ---------------------------------------------------------------------------

function lintReplaceAll(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];

  if (attrs?.table !== undefined) {
    if (!isPlainObject(attrs.table) || Array.isArray(attrs.table)) {
      push(msgs, "error",
        "table must be an object map where keys are regex patterns and values are replacement strings " +
        "(e.g., {\"[aeiou]\": \"\", \"\\\\s+\": \"_\"}). Keys are interpreted as standard Java regular expressions.",
        "attributes.table"
      );
    } else {
      const entries = Object.entries(attrs.table);

      // 1. Empty table
      if (entries.length === 0) {
        push(msgs, "warn",
          "replaceAll table is empty. Add at least one regex pattern key and its replacement string value.",
          "attributes.table"
        );
      } else {
        // 2. All values must be strings (replacement text; empty string is valid — deletes all matches)
        const badVals = entries.filter(([, v]) => typeof v !== "string");
        if (badVals.length) {
          push(msgs, "error",
            `All table values must be strings (the replacement text). Non-string entries: ${badVals.map(([k]) => `'${k}'`).join(", ")}. ` +
            "Use an empty string \"\" as the value to delete all text that matches the pattern.",
            "attributes.table"
          );
        }

        // 3. Validate each key as a compilable Java-compatible regex (JS RegExp is a close proxy)
        for (const [key] of entries) {
          try {
            new RegExp(key);
          } catch (e: any) {
            push(msgs, "error",
              `table key '${key}' is not a valid regex pattern: ${e?.message ?? String(e)}. ` +
              "All table keys are interpreted as Java regular expressions. " +
              "Use bracket notation to match literal special characters (e.g., '[.]' for a literal dot, '[+]' for a literal plus).",
              "attributes.table"
            );
          }
        }

        // 4. Case-sensitivity info — comparisons are case-sensitive by default
        push(msgs, "info",
          "replaceAll pattern matching is case-sensitive by default. " +
          "To match both cases, use a character class (e.g., '[Aa]bc' matches 'Abc' or 'abc') or include separate table entries for each case variant.",
          "attributes.table"
        );

        // 5. Simultaneous replacement info — all patterns apply in one pass
        if (entries.length > 1) {
          push(msgs, "info",
            "replaceAll applies all pattern replacements simultaneously in a single pass. " +
            "Each pattern matches against the original input — not against output already modified by a previous pattern. " +
            "Order of entries does not affect which text is matched.",
            "attributes.table"
          );
        }
      }
    }
  }

  // 6. input: validate type if provided
  if (attrs?.input !== undefined) {
    const inp = attrs.input;
    if (!(typeof inp === "string" || (isPlainObject(inp) && typeof (inp as any).type === "string"))) {
      push(msgs, "warn",
        "input must be a nested transform object {type, attributes} providing the string to apply replacements to, or a static string. " +
        "If omitted, the transform uses the source+attribute combination configured in the identity profile UI.",
        "attributes.input"
      );
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

  let startsWithNow = false;
  let sawRound = false;

  if (expr !== undefined) {
    if (typeof expr !== "string" || expr.trim().length === 0) {
      push(msgs, "error", "expression must be a non-empty string.", "attributes.expression");
    } else {
      const s = expr.trim();

      // --- No whitespace allowed ---
      if (/\s/.test(s)) {
        push(msgs, "error", "expression must not contain whitespace.", "attributes.expression");
      }

      // --- Valid character set: digits, y M w d h m s, n o w (for 'now'), +, -, / ---
      if (!/^[0-9yMwdhmsnow+\-/]+$/.test(s)) {
        push(msgs, "error",
          "expression contains invalid characters. " +
          "Allowed units: y(year) M(month) w(week) d(day) h(hour) m(minute) s(second), keyword 'now', operators: + - /.",
          "attributes.expression"
        );
      }

      let i = 0;
      const n = s.length;
      startsWithNow = s.startsWith("now");
      if (startsWithNow) i += 3;

      // 'now' must only appear at the start
      if (!startsWithNow && s.includes("now")) {
        push(msgs, "error",
          "'now' keyword must appear only at the start of the expression (e.g., 'now-5d/d', 'now+1w').",
          "attributes.expression"
        );
      }

      let sawOp = false;
      let roundUnit: string | null = null;

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
        if (!num) {
          push(msgs, "error", `Missing integer after '${op}' in expression. Example: '${op}3d'.`, "attributes.expression");
          return;
        }
        if (Number(num) === 0) {
          push(msgs, "warn", `Term '${op}${num}' adds/subtracts zero — this is a no-op.`, "attributes.expression");
        }
        const unit = readUnit();
        if (!unit) {
          push(msgs, "error",
            `Missing time unit after '${op}${num}'. Allowed units: y(year) M(month) w(week) d(day) h(hour) m(minute) s(second).`,
            "attributes.expression"
          );
        }
      };
      const readRound = () => {
        const unit = readUnit();
        if (!unit) {
          push(msgs, "error",
            "Rounding operator '/' must be followed by a time unit. Allowed: y M d h m s (NOT w — week rounding is unsupported).",
            "attributes.expression"
          );
          return;
        }
        sawRound = true;
        roundUnit = unit;
      };

      if (i < n && s[i] === "/") {
        i++; readRound();
        if (i < n) push(msgs, "error", "Rounding '/' must be the last segment of the expression (e.g., 'now-5d/d').", "attributes.expression");
      } else {
        while (i < n) {
          const ch = s[i]!;
          if (ch === "+" || ch === "-") {
            if (sawRound) {
              push(msgs, "error", "Add/subtract terms cannot appear after the rounding operator ('/').", "attributes.expression");
              break;
            }
            sawOp = true; i++;
            readSignedTerm(ch as "+" | "-");
            continue;
          }
          if (ch === "/") {
            if (sawRound) {
              push(msgs, "error", "Only one rounding operator '/' is allowed per expression.", "attributes.expression");
              break;
            }
            i++; readRound();
            if (i < n) push(msgs, "error", "Rounding '/' must be the last segment of the expression.", "attributes.expression");
            break;
          }
          push(msgs, "error",
            `Unexpected token '${ch}' in expression '${s}'. ` +
            "Valid forms: 'now', 'now-5d/d', 'now+1y+1M', '+3M', '+12h/s'.",
            "attributes.expression"
          );
          break;
        }
      }

      // Expression must start with 'now', +, -, or /
      if (!startsWithNow && s !== "" && s[0] !== "+" && s[0] !== "-" && s[0] !== "/") {
        push(msgs, "error",
          `Expression must start with 'now', '+', '-', or '/'. Got: '${s}'. ` +
          "Examples: 'now-5d/d', '+3M', '-1y/d'.",
          "attributes.expression"
        );
      }

      // Week rounding is explicitly unsupported per docs
      if (roundUnit === "w") {
        push(msgs, "error",
          "Rounding with 'w' (week) is not supported by SailPoint dateMath and will produce an error at runtime. " +
          "Use a different unit for rounding (y, M, d, h, m, s).",
          "attributes.expression"
        );
      }

      // Expression without 'now' and no ops is invalid
      if (!startsWithNow && !sawOp && !sawRound) {
        push(msgs, "error",
          "Expression must contain 'now', at least one +/- term, or a rounding segment. " +
          "Examples: 'now', 'now-5d/d', '+3M/h'.",
          "attributes.expression"
        );
      }

      // Expression without 'now' requires an input date
      if (!startsWithNow && attrs?.input === undefined) {
        push(msgs, "error",
          "dateMath expression without 'now' requires an explicit input date via attributes.input (nested transform). " +
          "The input must produce an ISO8601 UTC datetime. Use a dateFormat transform with outputFormat: 'ISO8601' if needed.",
          "attributes.input"
        );
      }

      // Output format info — dateMath output is yyyy-MM-dd'T'HH:mm, not full ISO8601
      push(msgs, "info",
        "dateMath output format is 'yyyy-MM-dd\\'T\\'HH:mm' — this is NOT full ISO8601. " +
        "If this transform feeds into another transform that expects ISO8601 (e.g., dateCompare), " +
        "wrap it with a dateFormat transform using outputFormat: 'ISO8601'.",
        "attributes.expression"
      );

      // Recommend requiresPeriodicRefresh when 'now' is used
      if (startsWithNow) {
        push(msgs, "info",
          "Expression uses 'now'. Set requiresPeriodicRefresh: true at the transform root level " +
          "so the date re-evaluates during nightly identity refresh — otherwise results may become stale.",
          "attributes.expression"
        );
      }
    }
  }

  // --- roundUp: boolean check ---
  if (attrs?.roundUp !== undefined && typeof attrs.roundUp !== "boolean") {
    push(msgs, "error",
      "roundUp must be a boolean. true = round up (truncate + add one unit); false = truncate only (default).",
      "attributes.roundUp"
    );
  }

  // --- roundUp without rounding operator has no effect ---
  if (
    attrs?.roundUp === true &&
    typeof expr === "string" &&
    !expr.includes("/")
  ) {
    push(msgs, "warn",
      "roundUp is true but expression contains no rounding operator '/'. " +
      "roundUp has no effect without '/'. Add a rounding segment (e.g., '/d') or remove roundUp.",
      "attributes.roundUp"
    );
  }

  // --- input: must be a nested transform object ---
  if (attrs?.input !== undefined) {
    const inp = attrs.input;
    if (!(inp && typeof inp === "object" && typeof inp.type === "string")) {
      push(msgs, "warn",
        "input must be a nested transform object {type, attributes} that produces an ISO8601 UTC datetime. " +
        "Use a dateFormat transform with outputFormat: 'ISO8601' if the source attribute is not already ISO8601.",
        "attributes.input"
      );
    }
  }

  // --- 'now' + input conflict warning ---
  if (startsWithNow && attrs?.input !== undefined) {
    push(msgs, "warn",
      "Expression uses 'now' and an input attribute is also provided. " +
      "Per SailPoint docs, when 'now' is in the expression the transform ignores the input attribute entirely.",
      "attributes.input"
    );
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
  let usesNow = false;

  const checkDateOperand = (field: "firstDate" | "secondDate") => {
    const v = attrs?.[field];
    if (v === undefined || v === null) {
      push(msgs, "error", `${field} is required.`, `attributes.${field}`);
      return;
    }
    if (typeof v === "string") {
      const t = v.trim();
      // "now" keyword — SailPoint docs show lowercase; warn if casing differs
      if (t.toLowerCase() === "now") {
        usesNow = true;
        if (t !== "now") {
          push(msgs, "warn",
            `${field} value '${t}' should be the lowercase keyword 'now'. ISC evaluates it case-sensitively.`,
            `attributes.${field}`
          );
        }
        return;
      }
      // Must be a full ISO8601 datetime with time and timezone
      if (!ISO8601_RE.test(t)) {
        push(msgs, "error",
          `${field} string '${t}' is not valid. Must be an ISO8601 datetime with time and timezone ` +
          "(e.g., '2025-01-15T00:00:00Z' or '2025-01-15T00:00:00+05:30'), the keyword 'now', or a nested transform object.",
          `attributes.${field}`
        );
      }
      return;
    }
    if (isNestedTransform(v)) {
      // Nested transforms must ultimately output an ISO8601 string for the comparison to work
      push(msgs, "info",
        `${field} uses a nested '${v.type}' transform. Ensure its output is an ISO8601 datetime string. ` +
        "If the source attribute is not ISO8601, wrap it with a dateFormat transform using outputFormat: 'ISO8601'.",
        `attributes.${field}`
      );
      return;
    }
    push(msgs, "error",
      `${field} must be an ISO8601 datetime string, the keyword 'now', or a nested transform object with a 'type' field.`,
      `attributes.${field}`
    );
  };

  checkDateOperand("firstDate");
  checkDateOperand("secondDate");

  // --- operator: required, LT / LTE / GT / GTE ---
  const VALID_OPS = new Set(["LT", "LTE", "GT", "GTE"]);
  const OP_SEMANTICS: Record<string, string> = {
    LT:  "firstDate < secondDate",
    LTE: "firstDate ≤ secondDate",
    GT:  "firstDate > secondDate",
    GTE: "firstDate ≥ secondDate",
  };

  const op = attrs?.operator;
  if (!op || String(op).trim() === "") {
    push(msgs, "error",
      "operator is required. Must be one of: LT (less than), LTE (less than or equal), GT (greater than), GTE (greater than or equal).",
      "attributes.operator"
    );
  } else {
    const opUpper = String(op).trim().toUpperCase();
    if (!VALID_OPS.has(opUpper)) {
      push(msgs, "error",
        `operator '${op}' is not valid. Allowed values: LT, LTE, GT, GTE (case-insensitive). ` +
        "LT = firstDate < secondDate, LTE = ≤, GT = >, GTE = ≥.",
        "attributes.operator"
      );
    } else {
      if (op !== opUpper) {
        push(msgs, "warn",
          `operator '${op}' is accepted but SailPoint docs specify uppercase. Use '${opUpper}' for consistency.`,
          "attributes.operator"
        );
      }
      push(msgs, "info",
        `operator '${opUpper}': ${OP_SEMANTICS[opUpper]}. ` +
        "Returns positiveCondition when true, negativeCondition when false.",
        "attributes.operator"
      );
    }
  }

  // --- positiveCondition: required string ---
  if (attrs?.positiveCondition === undefined || attrs.positiveCondition === null) {
    push(msgs, "error",
      "positiveCondition is required — the string value returned when the date comparison evaluates to true.",
      "attributes.positiveCondition"
    );
  } else if (typeof attrs.positiveCondition !== "string") {
    push(msgs, "error", "positiveCondition must be a string.", "attributes.positiveCondition");
  }

  // --- negativeCondition: required string ---
  if (attrs?.negativeCondition === undefined || attrs.negativeCondition === null) {
    push(msgs, "error",
      "negativeCondition is required — the string value returned when the date comparison evaluates to false.",
      "attributes.negativeCondition"
    );
  } else if (typeof attrs.negativeCondition !== "string") {
    push(msgs, "error", "negativeCondition must be a string.", "attributes.negativeCondition");
  }

  // --- Warn if positiveCondition === negativeCondition (comparison has no effect) ---
  if (
    typeof attrs?.positiveCondition === "string" &&
    typeof attrs?.negativeCondition === "string" &&
    attrs.positiveCondition === attrs.negativeCondition
  ) {
    push(msgs, "warn",
      `positiveCondition and negativeCondition are both '${attrs.positiveCondition}'. ` +
      "The comparison result has no effect since both branches return the same value.",
      "attributes"
    );
  }

  // --- Recommend requiresPeriodicRefresh when 'now' is used ---
  if (usesNow) {
    push(msgs, "info",
      "One or both date operands use 'now'. Set requiresPeriodicRefresh: true at the transform root level " +
      "so the comparison re-evaluates during nightly identity refresh — otherwise results may become stale for active identities.",
      "attributes"
    );
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

  // Human-readable descriptions for each named format (shown as info when used correctly)
  const NAMED_FORMAT_DESCRIPTIONS: Record<string, string> = {
    ISO8601:          "yyyy-MM-dd'T'HH:mm:ss.SSSZ — ISO 8601 standard datetime",
    LDAP:             "yyyyMMddHHmmss.Z — LDAP directory format",
    PEOPLE_SOFT:      "MM/dd/yyyy — PeopleSoft system format",
    EPOCH_TIME_JAVA:  "milliseconds since Jan 1, 1970 (Java epoch) — input must be a numeric string",
    EPOCH_TIME_WIN32: "100-nanosecond intervals since Jan 1, 1601 (Windows/Win32 epoch) — input must be a numeric string",
  };

  // ALL_CAPS_WITH_UNDERSCORES values are clearly intended as named constants, not patterns.
  // Do NOT fall through to isLikelyPattern — e.g. EPOCH_TIME_JAVA_IN_MILLIS contains
  // 'H' and 'M' and would falsely pass the pattern check.
  const looksLikeNamedConstant = (s: string) => /^[A-Z][A-Z0-9_]+$/.test(s);
  const isLikelyPattern = (s: string) => /[yMdHhmsSZ]/.test(s);

  const checkFmt = (field: "inputFormat" | "outputFormat") => {
    const raw = attrs?.[field];
    if (raw === undefined) return;
    if (typeof raw !== "string") {
      push(msgs, "error",
        `${field} must be a string — either a named format (${Array.from(NAMED_FORMATS).join(", ")}) or a Java SimpleDateFormat pattern.`,
        `attributes.${field}`
      );
      return;
    }
    const t = raw.trim();
    if (looksLikeNamedConstant(t)) {
      if (!NAMED_FORMATS.has(t)) {
        push(msgs, "error",
          `'${t}' is not a valid named format for ${field}. ` +
          `Allowed named formats: ${Array.from(NAMED_FORMATS).join(", ")}. ` +
          `Alternatively, use a Java SimpleDateFormat pattern (e.g. 'dd-MM-yyyy', 'yyyy-MM-dd\\'T\\'HH:mm:ssZ').`,
          `attributes.${field}`
        );
      } else {
        push(msgs, "info",
          `${field} '${t}' → ${NAMED_FORMAT_DESCRIPTIONS[t]}.`,
          `attributes.${field}`
        );
      }
      return;
    }
    // Value looks like a date pattern — check it has at least one recognisable date token.
    if (!isLikelyPattern(t)) {
      push(msgs, "warn",
        `${field} '${t}' doesn't match a known named format and doesn't look like a Java SimpleDateFormat pattern ` +
        "(expected tokens like y, M, d, H, h, m, s, S, Z). " +
        `Valid named formats: ${Array.from(NAMED_FORMATS).join(", ")}.`,
        `attributes.${field}`
      );
    }
  };

  checkFmt("inputFormat");
  checkFmt("outputFormat");

  // --- EPOCH format input reminders ---
  const inFmt = attrs?.inputFormat;
  if (typeof inFmt === "string" && (inFmt === "EPOCH_TIME_JAVA" || inFmt === "EPOCH_TIME_WIN32")) {
    push(msgs, "info",
      `inputFormat '${inFmt}' expects a numeric string as input — ` +
      (inFmt === "EPOCH_TIME_JAVA"
        ? "milliseconds since Jan 1, 1970 (e.g., '1609459200000')."
        : "100-nanosecond intervals since Jan 1, 1601 (Windows FILETIME)."),
      "attributes.inputFormat"
    );
  }

  // --- input: validate type, reject 'now', guide on valid forms ---
  if (attrs?.input !== undefined) {
    const inp = attrs.input;

    if (typeof inp === "string") {
      // 'now' is explicitly NOT supported by dateFormat per official docs
      if (inp.trim().toLowerCase() === "now") {
        push(msgs, "error",
          "dateFormat does not support 'now' as an input value (official docs limitation). " +
          "To derive a date from the current time, use a dateMath transform producing an ISO8601 string " +
          "and reference it as a nested transform in the input field.",
          "attributes.input"
        );
      }
      // A static date string is valid — no further warning needed
    } else if (isPlainObject(inp)) {
      if (typeof (inp as any).type !== "string") {
        push(msgs, "warn",
          "input is an object but is missing a 'type' field — it does not look like a valid nested transform. " +
          "Add a 'type' (e.g., 'accountAttribute', 'dateMath') to make it a proper nested transform.",
          "attributes.input"
        );
      }
      // Otherwise it's a well-formed nested transform — no warning
    } else {
      push(msgs, "warn",
        "input should be a static date string matching inputFormat, or a nested transform object {type, attributes}.",
        "attributes.input"
      );
    }
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// 12. usernameGenerator — patterns, tokens, cloud* fields, dynamic variable cross-check
// Docs: https://developer.sailpoint.com/docs/extensibility/transforms/operations/username-generator
// ---------------------------------------------------------------------------

// Known non-variable attribute keys for usernameGenerator
const USERNAME_GENERATOR_KNOWN_KEYS = new Set([
  "patterns", "sourceCheck", "cloudMaxSize", "cloudMaxUniqueChecks", "cloudRequired",
]);

function lintUsernameGenerator(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];
  const patterns = attrs?.patterns;

  // --- 1. patterns: required non-empty array of format strings ---
  if (patterns !== undefined) {
    if (!Array.isArray(patterns) || patterns.length === 0) {
      push(msgs, "error",
        "patterns must be a non-empty array of format strings (e.g., ['$fn$ln', '$fn.$ln${uniqueCounter}']).",
        "attributes.patterns"
      );
    } else {
      // 1a. Each entry must be a non-empty string
      patterns.forEach((p: any, idx: number) => {
        if (typeof p !== "string" || p.trim().length === 0) {
          push(msgs, "error",
            `patterns[${idx}] must be a non-empty format string. ` +
            "Use $varName or ${varName} tokens for variable substitution.",
            `attributes.patterns[${idx}]`
          );
        }
      });

      // 1b. ${uniqueCounter} must be last — patterns after it are never evaluated
      const ucIdx = patterns.findIndex(
        (p: any) => typeof p === "string" && p.includes("uniqueCounter")
      );
      if (ucIdx >= 0 && ucIdx !== patterns.length - 1) {
        push(msgs, "error",
          "The pattern containing '${uniqueCounter}' must be the last entry in the patterns array. " +
          "The generator stops after exhausting the uniqueCounter pattern — any patterns listed after it are never evaluated.",
          "attributes.patterns"
        );
      }

      // 1c. No uniqueCounter at all — exhausting all patterns throws IllegalStateException
      if (ucIdx === -1) {
        push(msgs, "warn",
          "No pattern contains '${uniqueCounter}'. If all patterns generate values that already exist, " +
          "the generator throws an IllegalStateException. " +
          "Add a final fallback pattern with '${uniqueCounter}' (e.g., '$fn$ln${uniqueCounter}') to handle conflicts.",
          "attributes.patterns"
        );
      }

      // 1d. Token syntax info
      push(msgs, "info",
        "Pattern tokens use dollar-sign notation: $varName (simple) or ${varName} (formal). " +
        "Each variable name (e.g., $fn, $ln, $fi) must be defined as an additional key in the attributes object, " +
        "set to a static string or a nested transform that supplies the value. " +
        "The reserved token ${uniqueCounter} auto-increments when a generated value already exists.",
        "attributes.patterns"
      );

      // 1e. Cross-check: tokens used in patterns must have a matching variable defined in attributes
      const RESERVED_TOKENS = new Set(["uniqueCounter"]);
      const definedVars = new Set(
        Object.keys(attrs ?? {}).filter((k) => !USERNAME_GENERATOR_KNOWN_KEYS.has(k))
      );
      const referencedTokens = new Set<string>();
      for (const p of patterns) {
        if (typeof p !== "string") continue;
        const re = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(p)) !== null) {
          referencedTokens.add(m[1]!);
        }
      }
      for (const tok of referencedTokens) {
        if (RESERVED_TOKENS.has(tok)) continue;
        if (!definedVars.has(tok)) {
          push(msgs, "warn",
            `Pattern references '$${tok}' but no variable '${tok}' is defined in attributes. ` +
            `Add a '${tok}' key to attributes as a static string or a nested transform (e.g., identityAttribute).`,
            `attributes.${tok}`
          );
        }
      }

      // 1f. Cross-check: variables defined in attributes but never referenced in any pattern
      for (const varName of definedVars) {
        if (!referencedTokens.has(varName)) {
          push(msgs, "warn",
            `Variable '${varName}' is defined in attributes but not referenced as $${varName} in any pattern. ` +
            "Remove it to keep the transform clean, or check for a typo in the pattern.",
            `attributes.${varName}`
          );
        }
      }
    }
  }

  // --- 2. sourceCheck ---
  if (attrs?.sourceCheck !== undefined) {
    if (typeof attrs.sourceCheck !== "boolean") {
      push(msgs, "error",
        "sourceCheck must be a boolean. " +
        "true = check the target system directly (only if the source supports getObject). " +
        "false = check only the ISC database (default).",
        "attributes.sourceCheck"
      );
    } else if (attrs.sourceCheck === true) {
      push(msgs, "info",
        "sourceCheck: true validates uniqueness against the target system directly. " +
        "This only works for sources that support the getObject operation — " +
        "for sources that don't, the check automatically falls back to the ISC database.",
        "attributes.sourceCheck"
      );
    }
  }

  // --- 3. cloudMaxSize: positive integer — truncates generated values exceeding this length ---
  if (attrs?.cloudMaxSize !== undefined) {
    const n = Number(attrs.cloudMaxSize);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      push(msgs, "error",
        "cloudMaxSize must be a positive integer. Generated usernames longer than this value will be truncated to this length.",
        "attributes.cloudMaxSize"
      );
    } else {
      push(msgs, "info",
        `cloudMaxSize: ${n} — generated values exceeding ${n} characters will be automatically truncated.`,
        "attributes.cloudMaxSize"
      );
    }
  }

  // --- 4. cloudMaxUniqueChecks: positive integer, maximum 50 ---
  if (attrs?.cloudMaxUniqueChecks !== undefined) {
    const n = Number(attrs.cloudMaxUniqueChecks);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      push(msgs, "error",
        "cloudMaxUniqueChecks must be a positive integer (maximum: 50). " +
        "The generator throws IllegalStateException when this number of uniqueness iterations is exceeded.",
        "attributes.cloudMaxUniqueChecks"
      );
    } else if (n > 50) {
      push(msgs, "error",
        `cloudMaxUniqueChecks ${n} exceeds the documented maximum of 50. ` +
        "Values above 50 cause an error at runtime. Set to 50 or less.",
        "attributes.cloudMaxUniqueChecks"
      );
    } else {
      push(msgs, "info",
        `cloudMaxUniqueChecks: ${n} — generator throws IllegalStateException after ${n} failed uniqueness iterations.`,
        "attributes.cloudMaxUniqueChecks"
      );
    }
  }

  // --- 5. cloudRequired: internal flag — must remain true ---
  if (attrs?.cloudRequired !== undefined && attrs.cloudRequired !== true) {
    push(msgs, "warn",
      "cloudRequired is an internal flag that must remain true. " +
      "Setting it to any other value may cause unexpected behavior.",
      "attributes.cloudRequired"
    );
  }

  // --- 6. Standalone use limitation ---
  push(msgs, "info",
    "usernameGenerator is designed specifically for account create profiles. " +
    "It should be placed within a create profile attribute definition — not used as a standalone identity profile attribute transform.",
    "type"
  );

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
// 18. lookup — table validation, default key, case-sensitivity, input
// Docs: https://developer.sailpoint.com/docs/extensibility/transforms/operations/lookup
// ---------------------------------------------------------------------------

function lintLookup(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];

  if (attrs?.table !== undefined) {
    if (!isPlainObject(attrs.table)) {
      push(msgs, "error",
        "table must be an object map of string keys to string output values (e.g., {\"US\": \"United States\", \"default\": \"Unknown\"}). " +
        "Nested transforms and conditional logic are not supported as table values.",
        "attributes.table"
      );
    } else {
      const tableKeys = Object.keys(attrs.table);

      // 1. default key is mandatory per docs — unmatched input causes a runtime error without it
      if (!Object.prototype.hasOwnProperty.call(attrs.table, "default")) {
        push(msgs, "error",
          "lookup table must include a 'default' key. Without it, any input that doesn't match a table key " +
          "causes a runtime error. Add: \"default\": \"<fallback value>\".",
          "attributes.table"
        );
      }

      // 2. All values must be strings — nested transforms and dynamic values are not supported
      const badVals = Object.entries(attrs.table).filter(([, v]) => typeof v !== "string");
      if (badVals.length) {
        push(msgs, "error",
          `All lookup table values must be static strings. Non-string entries: ${badVals.map(([k]) => `'${k}'`).join(", ")}. ` +
          "Nested transforms and conditional logic inside table values are not supported.",
          "attributes.table"
        );
      }

      // 3. Empty table (no keys at all — can't happen if default is required, but guard anyway)
      if (tableKeys.length === 0) {
        push(msgs, "error",
          "lookup table is empty. Add at least a 'default' key and one or more mapping entries.",
          "attributes.table"
        );
      // 4. Table has only a default key — no lookup entries, always returns default
      } else if (tableKeys.length === 1 && tableKeys[0] === "default") {
        push(msgs, "warn",
          "lookup table contains only a 'default' key with no other mapping entries. " +
          "This will always return the default value regardless of input. " +
          "If you want a fixed output, use a static transform instead.",
          "attributes.table"
        );
      }

      // 5. Empty-string key — unusual, only matches when input is an empty string
      if (tableKeys.includes("")) {
        push(msgs, "warn",
          "lookup table contains an empty-string key (\"\"). This matches only when the input value is an empty string. " +
          "If unintentional, remove it.",
          "attributes.table"
        );
      }

      // 6. Case-sensitivity info — only when there are real mapping entries
      if (tableKeys.filter(k => k !== "default").length > 0) {
        push(msgs, "info",
          "Lookup table comparisons are case-sensitive — table keys must match the input value exactly. " +
          "'US' and 'us' are treated as different keys. " +
          "If case may vary in the input, normalize it first with a lower or upper transform.",
          "attributes.table"
        );
      }
    }
  }

  // 7. input: validate type if provided
  if (attrs?.input !== undefined) {
    const inp = attrs.input;
    if (!(typeof inp === "string" || (isPlainObject(inp) && typeof (inp as any).type === "string"))) {
      push(msgs, "warn",
        "input must be a nested transform object {type, attributes} that provides the value to look up, or a static string. " +
        "If omitted, the transform uses the source+attribute combination configured in the identity profile UI.",
        "attributes.input"
      );
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
// 23. substring — begin/end indexing, offset cross-checks, begin>=end guard
// Docs: https://developer.sailpoint.com/docs/extensibility/transforms/operations/substring
// ---------------------------------------------------------------------------

function lintSubstring(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];

  const begin       = attrs?.begin;
  const end         = attrs?.end;
  const beginOffset = attrs?.beginOffset;
  const endOffset   = attrs?.endOffset;

  // 1. begin: required integer; -1 is the "start from character 0" sentinel
  if (begin !== undefined) {
    if (!isNumberish(begin)) {
      push(msgs, "error",
        "begin must be an integer (zero-based start index). Use -1 to start from character 0.",
        "attributes.begin"
      );
    } else {
      const beginNum = Number(begin);

      if (beginNum === -1) {
        push(msgs, "info",
          "begin: -1 starts the substring at character 0 (the very beginning of the string). " +
          "beginOffset is ignored when begin is -1.",
          "attributes.begin"
        );
      } else if (beginNum < -1) {
        push(msgs, "error",
          `begin value ${beginNum} is invalid. Only -1 (start at char 0) or a non-negative zero-based index are allowed.`,
          "attributes.begin"
        );
      }

      // beginOffset only applies when begin != -1
      if (beginOffset !== undefined) {
        if (!isNumberish(beginOffset)) {
          push(msgs, "error",
            "beginOffset must be an integer added to the begin index.",
            "attributes.beginOffset"
          );
        } else if (beginNum === -1) {
          push(msgs, "warn",
            "beginOffset has no effect when begin is -1. beginOffset is only applied when begin is a non-negative index.",
            "attributes.beginOffset"
          );
        }
      }
    }
  }

  // 2. end: optional integer; -1 or omitted means "through end of string"
  if (end !== undefined) {
    if (!isNumberish(end)) {
      push(msgs, "error",
        "end must be an integer (zero-based exclusive end index). Use -1 or omit end to return characters through the end of the string.",
        "attributes.end"
      );
    } else {
      const endNum = Number(end);

      if (endNum === -1) {
        push(msgs, "info",
          "end: -1 returns all characters from begin through the end of the string. endOffset is ignored when end is -1.",
          "attributes.end"
        );
      } else if (endNum < -1) {
        push(msgs, "error",
          `end value ${endNum} is invalid. Only -1 (through end of string) or a non-negative zero-based index are allowed.`,
          "attributes.end"
        );
      }

      // endOffset only applies when end is provided and end != -1
      if (endOffset !== undefined) {
        if (!isNumberish(endOffset)) {
          push(msgs, "error",
            "endOffset must be an integer added to the end index.",
            "attributes.endOffset"
          );
        } else if (endNum === -1) {
          push(msgs, "warn",
            "endOffset has no effect when end is -1. endOffset is only applied when end is a non-negative index.",
            "attributes.endOffset"
          );
        }
      }
    }
  }

  // 3. endOffset without end is meaningless
  if (endOffset !== undefined && end === undefined) {
    push(msgs, "warn",
      "endOffset has no effect when end is not provided. endOffset is only applied when end is explicitly set to a non-negative index.",
      "attributes.endOffset"
    );
  }

  // 4. Effective begin >= effective end guard
  if (
    begin !== undefined && end !== undefined &&
    isNumberish(begin) && isNumberish(end)
  ) {
    const beginNum = Number(begin);
    const endNum   = Number(end);

    if (beginNum !== -1 && endNum !== -1) {
      const effectiveBegin = beginNum + (isNumberish(beginOffset) ? Number(beginOffset) : 0);
      const effectiveEnd   = endNum   + (isNumberish(endOffset)   ? Number(endOffset)   : 0);

      if (effectiveBegin >= effectiveEnd) {
        push(msgs, "error",
          `Effective begin (${effectiveBegin}) is ≥ effective end (${effectiveEnd}). ` +
          "This produces an empty or error result. Ensure begin + beginOffset < end + endOffset.",
          "attributes"
        );
      }
    }
  }

  // 5. "Last N chars" limitation note — docs explicitly call this out and recommend getEndOfString
  push(msgs, "info",
    "To extract the last N characters of a string, use the getEndOfString transform instead. " +
    "The substring transform does not provide an easy way to extract characters from the end of a string.",
    "attributes"
  );

  // 6. input: validate type if provided (optional per docs)
  if (attrs?.input !== undefined) {
    const inp = attrs.input;
    if (!(typeof inp === "string" || (isPlainObject(inp) && typeof (inp as any).type === "string"))) {
      push(msgs, "warn",
        "input must be a nested transform object {type, attributes} providing the string to extract from, or a static string. " +
        "If omitted, the transform uses the source+attribute combination configured in the identity profile UI.",
        "attributes.input"
      );
    }
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// 24. static — value (fixed string or VTL), dynamic VTL variable cross-check
// Docs: https://developer.sailpoint.com/docs/extensibility/transforms/operations/static
// ---------------------------------------------------------------------------

function lintStatic(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];

  // 1. value type check — must be a string (fixed literal or VTL expression)
  if (attrs?.value !== undefined && attrs?.value !== null && typeof attrs.value !== "string") {
    push(msgs, "error",
      "value must be a string — either a fixed literal (e.g. 'Contractor') or a VTL expression " +
      "(e.g. \"#if($workerType=='Employee')Full-Time#{else}Contingent#end\").",
      "attributes.value"
    );
    return msgs; // cannot do VTL analysis without a string value
  }

  const value: string | undefined = attrs?.value;

  // 2. Empty value warning
  if (typeof value === "string" && value.trim() === "") {
    push(msgs, "warn",
      "value is an empty string — this will produce an empty (null-equivalent) attribute. " +
      "Provide a non-empty fixed string or VTL expression.",
      "attributes.value"
    );
  }

  if (typeof value === "string" && value.length > 0) {
    // 3. Extract VTL variable references ($varName, ${varName}, $!varName, $!{varName})
    const vtlRefs = new Set<string>();
    const refPattern = /\$!?\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
    let m: RegExpExecArray | null;
    while ((m = refPattern.exec(value)) !== null) {
      vtlRefs.add(m[1]);
    }

    if (vtlRefs.size > 0) {
      // 4. Warn for each VTL reference that has no matching dynamic variable in attributes
      for (const varName of vtlRefs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, varName)) {
          push(msgs, "warn",
            `VTL references $${varName} in value but no dynamic variable '${varName}' is defined in attributes. ` +
            `Add a '${varName}' key to attributes with a static string or nested transform that supplies the value.`,
            `attributes.${varName}`
          );
        }
      }

      // 5. Ordering hint — VTL variables must be positioned before the value attribute in the identity profile
      push(msgs, "info",
        "VTL variables detected in value. Attribute ordering matters in identity profiles: " +
        "all dynamic variable attributes must be mapped and evaluated before the static transform's value expression runs. " +
        "Review the attribute mapping order in your identity profile.",
        "attributes.value"
      );
    }

    // 6. Warn for dynamic variables defined in attributes but never referenced in value (likely a typo or leftover)
    const reservedKeys = new Set(["value"]);
    for (const key of Object.keys(attrs ?? {})) {
      if (reservedKeys.has(key)) continue;
      if (!vtlRefs.has(key)) {
        push(msgs, "warn",
          `Dynamic variable '${key}' is defined in attributes but not referenced as $${key} in value. ` +
          `If intentional, remove it to keep the transform clean; otherwise check for a typo.`,
          `attributes.${key}`
        );
      }
    }
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// 25. identityAttribute — name format + critical use-case limitation
// Docs: https://developer.sailpoint.com/docs/extensibility/transforms/operations/identity-attribute
// ---------------------------------------------------------------------------

function lintIdentityAttribute(attrs: any): LintMessage[] {
  const msgs: LintMessage[] = [];

  // 1. name: must be a camelCase system name — no spaces, ideally no hyphens
  const name = attrs?.name;
  if (typeof name === "string" && name.trim().length > 0) {
    if (/\s/.test(name)) {
      push(msgs, "error",
        `attributes.name '${name}' contains whitespace. Identity attribute system names are camelCase with no spaces ` +
        "(e.g., 'uid', 'email', 'identificationNumber'). Check the identity profile attribute's system name in the Admin UI.",
        "attributes.name"
      );
    } else if (/-/.test(name)) {
      push(msgs, "warn",
        `attributes.name '${name}' contains a hyphen. Identity attribute system names are camelCase ` +
        "(e.g., 'identificationNumber', not 'identification-number'). Verify this is the exact system name shown in the Admin UI.",
        "attributes.name"
      );
    }
  }

  // 2. Critical use-case limitation — identityAttribute is NOT safe inside identity profile attribute calculations
  push(msgs, "warn",
    "identityAttribute is NOT intended for use within another identity profile attribute's calculation. " +
    "Due to multi-threaded identity processing, the referenced attribute may not yet exist or may hold stale data at evaluation time. " +
    "Intended use: provisioning policies and entitlement request forms. " +
    "If you need an account attribute value inside an identity profile mapping, use accountAttribute instead.",
    "type"
  );

  // 3. input: must be a nested transform object if provided
  if (attrs?.input !== undefined) {
    const inp = attrs.input;
    if (!(isPlainObject(inp) && typeof (inp as any).type === "string")) {
      push(msgs, "warn",
        "input must be a nested transform object {type, attributes} providing explicit input data. " +
        "If omitted, the transform uses the source+attribute combination configured in the identity profile UI.",
        "attributes.input"
      );
    }
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// 27. indexOf / lastIndexOf
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
// 28. randomAlphaNumeric / randomNumeric — length
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
// 29. rfc5646 — format type check
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
  if (requestedType === "firstValid")                   messages.push(...lintFirstValid(attrs));
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
  if (requestedType === "identityAttribute")            messages.push(...lintIdentityAttribute(attrs));
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
