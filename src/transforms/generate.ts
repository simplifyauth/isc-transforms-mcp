// src/transforms/generate.ts
// Requirement-to-Transform JSON generator.
//
// Pipeline:
//   1. Parse requirement for entities (source names, attribute names, date formats, literals, etc.)
//   2. Score each operation type against requirement keywords
//   3. Select best operation, build JSON from catalog scaffold + extracted params
//   4. Return transform JSON + confidence + alternatives + placeholders
//
// This module is fully offline — no tenant access required.

import { TRANSFORM_CATALOG, toCanonicalType, type TransformType } from "./catalog.js";

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

export type ParsedRequirement = {
  raw: string;
  lower: string;
  quotedStrings: string[];      // values inside "…" or '…'
  potentialSources: string[];   // looks like a source system name
  potentialAttributes: string[];
  datePatterns: string[];       // looks like a date format token
  numberLiterals: number[];
  hasNullHandling: boolean;     // fallback / null / empty / missing
  hasFallback: boolean;
  hasUniqueness: boolean;       // unique / uniqueness / duplicate
  hasNesting: boolean;          // nested / combine / multiple
};

function parseRequirement(req: string): ParsedRequirement {
  const lower = req.toLowerCase();

  // Extract quoted strings
  const quotedStrings: string[] = [];
  for (const m of req.matchAll(/["']([^"']+)["']/g)) quotedStrings.push(m[1]!);

  // Date format patterns — Java-style tokens
  const datePatterns = (req.match(/\b(yyyy|YYYY|MM|dd|HH|hh|mm|ss|SSS|Z|'T'|ISO8601|EPOCH_TIME_JAVA|EPOCH_TIME_WIN32|LDAP_GENERALIZED_TIME)\b/g) ?? []).map(String);

  // Number literals
  const numberLiterals = (req.match(/\b\d+\b/g) ?? []).map(Number).filter((n) => n >= 0 && n <= 1000);

  // Capitalised words (2+ chars) that aren't at the start of sentence → likely source/attr names
  const properNouns = (req.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? [])
    .filter((w) => !["SailPoint","ISC","MCP","JSON","The","This","For","From","When","If","Or","And","Get","Set","Use"].includes(w));

  const potentialSources = properNouns.filter((w) =>
    /source|system|app|directory|ldap|active|hr|workday|sap|salesforce|ad|azure|okta/i.test(req) &&
    !["True","False"].includes(w)
  );
  const potentialAttributes = properNouns.filter((w) =>
    /attribute|field|column|property/i.test(req) || w.match(/^(email|phone|name|dept|department|title|manager|company|country|locale|username|login|displayname|givenname|surname|sn|lastname|firstname|middlename|employeeid|costcenter|division|location|city|state|zip|postalcode|birthdate|hiredate|terminationdate)$/i)
  );

  return {
    raw: req,
    lower,
    quotedStrings,
    potentialSources,
    potentialAttributes,
    datePatterns,
    numberLiterals,
    hasNullHandling: /null|empty|missing|blank|undefined|not set|no value/i.test(req),
    hasFallback: /fallback|default|if null|first valid|first non.?null|otherwise/i.test(req),
    hasUniqueness: /unique|uniqueness|duplicate|conflict|counter/i.test(req),
    hasNesting: /nested|combine|multiple|chain|composed|build from/i.test(req),
  };
}

// ---------------------------------------------------------------------------
// Scoring engine
// ---------------------------------------------------------------------------

type KeywordRule = {
  keywords: string[];         // any of these → add score
  phraseBoost?: string[];     // multi-word phrases → add extra score
  weight: number;
};

const OPERATION_SCORES: Record<string, KeywordRule[]> = {
  static: [
    { keywords: ["static", "constant", "fixed", "hardcoded", "literal", "always"], weight: 10 },
    { keywords: ["value", "string"], phraseBoost: ["static value", "constant value", "fixed value"], weight: 5 },
  ],
  concat: [
    { keywords: ["concat", "concatenate", "join", "combine", "merge", "append", "build", "construct"], weight: 10 },
    { phraseBoost: ["first name", "last name", "full name", "display name"], keywords: [], weight: 6 },
    { keywords: ["dot", "dash", "hyphen", "space", "separator", "between"], weight: 4 },
  ],
  conditional: [
    { keywords: ["if", "else", "when", "conditional", "condition", "depends", "based on", "evaluate"], weight: 10 },
    { keywords: ["true", "false", "yes", "no", "return"], weight: 3 },
    { phraseBoost: ["if equals", "when equals", "based on value", "if department", "if status"], keywords: [], weight: 7 },
  ],
  firstValid: [
    { keywords: ["fallback", "first valid", "first non-null", "first non null", "coalesce"], weight: 12 },
    { keywords: ["null", "empty", "missing", "not set"], phraseBoost: ["if null", "if empty", "fallback to"], weight: 8 },
    { keywords: ["preferred", "alternative", "backup"], weight: 5 },
  ],
  dateFormat: [
    { keywords: ["date format", "format date", "convert date", "reformat", "date conversion"], weight: 12 },
    { keywords: ["epoch", "iso8601", "iso 8601", "timestamp", "dateformat", "inputformat", "outputformat"], weight: 10 },
    { keywords: ["yyyy", "mm/dd", "dd/mm", "date pattern", "java date"], weight: 8 },
    { keywords: ["date", "time", "format"], weight: 5 },
  ],
  dateMath: [
    { keywords: ["add days", "subtract days", "date math", "date arithmetic", "days from", "months from", "plus days", "minus days"], weight: 12 },
    { keywords: ["add", "subtract", "plus", "minus", "future", "past", "offset", "round"], phraseBoost: ["add to date", "subtract from date"], weight: 5 },
    { keywords: ["expiry", "expiration", "90 days", "30 days", "1 year"], weight: 8 },
  ],
  dateCompare: [
    { keywords: ["compare date", "date compare", "before", "after", "earlier", "later"], weight: 12 },
    { keywords: ["gt", "lt", "gte", "lte", "greater than", "less than"], phraseBoost: ["date before", "date after"], weight: 8 },
    { keywords: ["expired", "active", "inactive", "lifecycle"], weight: 5 },
  ],
  usernameGenerator: [
    { keywords: ["username", "login", "account name", "user id", "userid", "unique username", "generate username"], weight: 15 },
    { keywords: ["unique", "uniquecounter", "collision", "duplicate check"], phraseBoost: ["unique username", "no duplicates"], weight: 10 },
    { keywords: ["pattern", "template", "${", "fn", "ln"], weight: 6 },
  ],
  accountAttribute: [
    { keywords: ["account attribute", "source attribute", "from source", "from active directory", "from hr", "from workday"], weight: 12 },
    { keywords: ["source", "application", "account", "sourcename", "attributename"], weight: 6 },
  ],
  identityAttribute: [
    { keywords: ["identity attribute", "identity field", "profile attribute"], weight: 12 },
    { keywords: ["identity", "givenname", "sn", "email", "manager"], weight: 4 },
  ],
  lookup: [
    { keywords: ["lookup", "map", "mapping", "table", "dictionary", "translate", "convert code", "replace code"], weight: 12 },
    { keywords: ["key", "value", "pair", "department code", "country code", "abbreviation"], weight: 5 },
  ],
  replace: [
    { keywords: ["replace", "regex", "regular expression", "remove characters", "strip", "substitute"], weight: 10 },
    { keywords: ["pattern", "match", "find and replace"], weight: 5 },
  ],
  replaceAll: [
    { keywords: ["replace all", "remove spaces", "remove dashes", "clean string", "sanitize", "normalize string"], weight: 10 },
    { phraseBoost: ["replace multiple", "clean up"], keywords: [], weight: 5 },
  ],
  split: [
    { keywords: ["split", "extract part", "delimiter", "tokenize", "divide"], weight: 10 },
    { keywords: ["comma separated", "pipe separated", "first part", "second part", "index"], weight: 6 },
  ],
  substring: [
    { keywords: ["substring", "extract characters", "first n characters", "chars", "slice", "truncate"], weight: 10 },
    { keywords: ["begin", "end", "start", "position", "character"], weight: 5 },
  ],
  lower: [
    { keywords: ["lowercase", "lower case", "lower"], weight: 12 },
    { phraseBoost: ["all lowercase", "convert to lowercase"], keywords: [], weight: 8 },
  ],
  upper: [
    { keywords: ["uppercase", "upper case", "upper", "caps"], weight: 12 },
    { phraseBoost: ["all uppercase", "all caps", "convert to uppercase"], keywords: [], weight: 8 },
  ],
  trim: [
    { keywords: ["trim", "strip whitespace", "remove spaces", "leading spaces", "trailing spaces"], weight: 12 },
  ],
  normalizeNames: [
    { keywords: ["normalize name", "name normalizer", "capitalize name", "format name", "normalize capitalization"], weight: 12 },
    { keywords: ["mcintosh", "von", "de la", "roman numeral", "mc mac"], weight: 8 },
  ],
  e164phone: [
    { keywords: ["e.164", "e164", "phone number", "international phone", "phone format", "standardize phone"], weight: 12 },
    { keywords: ["phone", "mobile", "telephone", "region code", "country code"], weight: 5 },
  ],
  iso3166: [
    { keywords: ["iso3166", "iso 3166", "country code", "alpha2", "alpha3", "numeric country"], weight: 12 },
    { keywords: ["country", "nation", "iso"], weight: 4 },
  ],
  rfc5646: [
    { keywords: ["rfc5646", "rfc 5646", "locale", "language code", "bcp47", "language tag"], weight: 12 },
    { keywords: ["locale", "language", "region"], weight: 3 },
  ],
  leftPad: [
    { keywords: ["left pad", "zero pad", "pad left", "leading zeros", "zero fill"], weight: 12 },
    { keywords: ["pad", "fill", "length", "zeros"], weight: 5 },
  ],
  rightPad: [
    { keywords: ["right pad", "pad right", "trailing"], weight: 12 },
    { keywords: ["pad", "fill", "length"], weight: 5 },
  ],
  indexOf: [
    { keywords: ["index of", "find position", "position of", "find char", "find string"], weight: 10 },
    { keywords: ["position", "offset", "location"], weight: 4 },
  ],
  lastIndexOf: [
    { keywords: ["last index", "last occurrence", "last position", "last slash", "last dot"], weight: 10 },
  ],
  join: [
    { keywords: ["join array", "array to string", "list to string", "join with"], weight: 10 },
    { keywords: ["separator", "values array", "list"], weight: 4 },
  ],
  decomposeDiacriticalMarks: [
    { keywords: ["diacritical", "accent", "diacritic", "decompose", "unicode normalize", "ascii", "strip accent"], weight: 12 },
    { keywords: ["special characters", "unicode", "é", "ü", "ñ"], weight: 6 },
  ],
  displayName: [
    { keywords: ["display name", "displayname", "preferred name", "full display"], weight: 12 },
  ],
  base64Encode: [
    { keywords: ["base64 encode", "encode base64", "base64"], weight: 12 },
  ],
  base64Decode: [
    { keywords: ["base64 decode", "decode base64", "base64 encoded"], weight: 12 },
  ],
  uuid: [
    { keywords: ["uuid", "guid", "unique id", "random uuid", "generate uuid"], weight: 15 },
  ],
  randomAlphaNumeric: [
    { keywords: ["random alphanumeric", "random string", "random password", "alphanumeric"], weight: 12 },
    { keywords: ["random", "generate", "string"], weight: 3 },
  ],
  randomNumeric: [
    { keywords: ["random numeric", "random number", "random digits", "numeric random"], weight: 12 },
  ],
  generateRandomString: [
    { keywords: ["random string", "generate random", "random password", "secure random"], phraseBoost: ["generate random string"], weight: 14 },
    { keywords: ["numbers", "special chars", "include numbers"], weight: 6 },
  ],
  getEndOfString: [
    { keywords: ["end of string", "last n characters", "last chars", "last digits", "trailing chars"], weight: 12 },
    { keywords: ["numchars", "last", "end"], weight: 4 },
  ],
  getReferenceIdentityAttribute: [
    { keywords: ["reference identity", "manager attribute", "get reference", "manager email", "manager name"], weight: 12 },
    { keywords: ["manager", "reference", "uid", "linked identity"], weight: 5 },
  ],
  reference: [
    { keywords: ["reference transform", "reuse transform", "call transform", "existing transform"], weight: 12 },
  ],
};

function scoreOperations(parsed: ParsedRequirement): Array<{ type: string; score: number }> {
  const scores: Record<string, number> = {};

  for (const [opType, rules] of Object.entries(OPERATION_SCORES)) {
    let total = 0;
    for (const rule of rules) {
      for (const kw of rule.keywords) {
        if (parsed.lower.includes(kw.toLowerCase())) total += rule.weight;
      }
      for (const phrase of rule.phraseBoost ?? []) {
        if (parsed.lower.includes(phrase.toLowerCase())) total += rule.weight * 0.8;
      }
    }

    // Boosts from parsed metadata
    if ((opType === "firstValid" || opType === "concat") && parsed.hasFallback) total += 5;
    if (opType === "usernameGenerator" && parsed.hasUniqueness) total += 10;
    if (opType === "dateFormat" && parsed.datePatterns.length > 0) total += 8;
    if ((opType === "substring" || opType === "leftPad" || opType === "rightPad") && parsed.numberLiterals.length > 0) total += 4;
    if (opType === "concat" && parsed.hasNesting) total += 4;
    if (opType === "firstValid" && parsed.hasNullHandling) total += 6;

    if (total > 0) scores[opType] = total;
  }

  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([type, score]) => ({ type, score }));
}

// ---------------------------------------------------------------------------
// JSON builder — fills in scaffold with extracted params
// ---------------------------------------------------------------------------

function buildTransformJson(
  opType: string,
  parsed: ParsedRequirement,
  transformName: string
): { transform: any; placeholders: string[] } {
  const spec = TRANSFORM_CATALOG[opType as TransformType];
  const placeholders: string[] = [];
  let transform: any;

  if (!spec) {
    transform = { type: opType, name: transformName, attributes: {} };
    placeholders.push("<attributes>");
    return { transform, placeholders };
  }

  // Start from the scaffold
  transform = spec.scaffold(transformName);

  // Apply extracted parameters to common operations
  switch (opType) {
    case "static": {
      const val = parsed.quotedStrings[0] ?? "<STATIC_VALUE>";
      if (!parsed.quotedStrings[0]) placeholders.push("<STATIC_VALUE>");
      transform.attributes.value = val;
      break;
    }
    case "concat": {
      // Build values from attribute names or use defaults
      if (parsed.potentialAttributes.length >= 2) {
        transform.attributes.values = parsed.potentialAttributes.slice(0, 3).map((a) => ({
          type: "identityAttribute",
          attributes: { name: a },
        }));
      }
      break;
    }
    case "accountAttribute": {
      if (parsed.potentialSources[0]) {
        transform.attributes.sourceName = parsed.potentialSources[0];
      } else {
        placeholders.push("<sourceName>");
      }
      if (parsed.potentialAttributes[0]) {
        transform.attributes.attributeName = parsed.potentialAttributes[0];
      } else {
        placeholders.push("<attributeName>");
      }
      break;
    }
    case "identityAttribute": {
      if (parsed.potentialAttributes[0]) {
        transform.attributes.name = parsed.potentialAttributes[0];
      } else {
        placeholders.push("<attributeName>");
      }
      break;
    }
    case "dateFormat": {
      if (parsed.datePatterns.length >= 2) {
        transform.attributes.inputFormat = parsed.datePatterns[0];
        transform.attributes.outputFormat = parsed.datePatterns[1];
      } else if (parsed.datePatterns.length === 1) {
        transform.attributes.outputFormat = parsed.datePatterns[0];
        placeholders.push("<inputFormat>");
      } else {
        placeholders.push("<inputFormat>", "<outputFormat>");
      }
      break;
    }
    case "dateMath": {
      // Look for patterns like "+90d", "now+1y"
      const mathMatch = parsed.raw.match(/\b(now)?([+-]\d+[yMwdhmS])\b/);
      if (mathMatch) {
        transform.attributes.expression = (mathMatch[1] ?? "now") + mathMatch[2];
      } else {
        placeholders.push("<expression> (e.g. 'now+90d' or 'now-1y/M')");
      }
      break;
    }
    case "conditional": {
      if (parsed.potentialAttributes[0]) {
        transform.attributes[parsed.potentialAttributes[0].toLowerCase()] = {
          type: "accountAttribute",
          attributes: { sourceName: parsed.potentialSources[0] ?? "<SOURCE_NAME>", attributeName: parsed.potentialAttributes[0] },
        };
        if (!parsed.potentialSources[0]) placeholders.push("<sourceName>");
        transform.attributes.expression = `$${parsed.potentialAttributes[0].toLowerCase()} eq <VALUE>`;
        placeholders.push("<VALUE> in expression");
      } else {
        placeholders.push("<variable>", "<expression>", "<positiveCondition>", "<negativeCondition>");
      }
      if (parsed.quotedStrings.length >= 2) {
        transform.attributes.positiveCondition = parsed.quotedStrings[0];
        transform.attributes.negativeCondition = parsed.quotedStrings[1];
      } else {
        placeholders.push("<positiveCondition>", "<negativeCondition>");
      }
      break;
    }
    case "lookup": {
      if (parsed.quotedStrings.length >= 2) {
        const table: Record<string, string> = {};
        for (let i = 0; i + 1 < parsed.quotedStrings.length; i += 2) {
          table[parsed.quotedStrings[i]!] = parsed.quotedStrings[i + 1]!;
        }
        table["default"] = "Unknown";
        transform.attributes.table = table;
      } else {
        placeholders.push("<table> key-value pairs");
      }
      break;
    }
    case "replace": {
      if (parsed.quotedStrings[0]) {
        transform.attributes.regex = parsed.quotedStrings[0];
        transform.attributes.replacement = parsed.quotedStrings[1] ?? "";
      } else {
        placeholders.push("<regex>", "<replacement>");
      }
      break;
    }
    case "replaceAll": {
      if (parsed.quotedStrings.length >= 2) {
        const table: Record<string, string> = {};
        for (let i = 0; i + 1 < parsed.quotedStrings.length; i += 2) {
          table[parsed.quotedStrings[i]!] = parsed.quotedStrings[i + 1]!;
        }
        transform.attributes.table = table;
      } else {
        placeholders.push("<table> of characters-to-replace");
      }
      break;
    }
    case "split": {
      if (parsed.quotedStrings[0]) {
        transform.attributes.delimiter = parsed.quotedStrings[0];
      } else {
        placeholders.push("<delimiter>");
      }
      transform.attributes.index = parsed.numberLiterals[0] ?? 0;
      break;
    }
    case "substring": {
      transform.attributes.begin = parsed.numberLiterals[0] ?? 0;
      if (parsed.numberLiterals[1] !== undefined) {
        transform.attributes.end = parsed.numberLiterals[1];
      }
      break;
    }
    case "leftPad":
    case "rightPad": {
      if (parsed.numberLiterals[0]) transform.attributes.length = String(parsed.numberLiterals[0]);
      else placeholders.push("<length>");
      if (parsed.quotedStrings[0]) transform.attributes.padding = parsed.quotedStrings[0];
      break;
    }
    case "usernameGenerator": {
      // Build patterns from attribute names if available
      const attrs = parsed.potentialAttributes;
      if (attrs.length >= 2) {
        const fn = attrs[0]!.toLowerCase().slice(0, 2); // e.g. "gi" from "givenName"
        const ln = attrs[1]!.toLowerCase().slice(0, 2); // e.g. "su" from "surname"
        transform.attributes = {
          patterns: [
            `\${${fn}}.\${${ln}}`,
            `\${${fn}}.\${${ln}}\${uniqueCounter}`,
          ],
          [fn]: { type: "identityAttribute", attributes: { name: attrs[0] } },
          [ln]: { type: "identityAttribute", attributes: { name: attrs[1] } },
        };
      } else {
        placeholders.push("<patterns array>", "<dynamic variable definitions>");
      }
      break;
    }
    case "e164phone": {
      const regionMatch = parsed.raw.match(/\b([A-Z]{2})\b/);
      if (regionMatch) transform.attributes.defaultRegion = regionMatch[1];
      else placeholders.push("<defaultRegion> (ISO 3166-1 alpha-2 e.g. 'US')");
      break;
    }
    case "iso3166": {
      const fmt = parsed.lower.includes("alpha3") ? "alpha3" :
                  parsed.lower.includes("numeric") ? "numeric" : "alpha2";
      transform.attributes.format = fmt;
      break;
    }
    case "generateRandomString": {
      const len = parsed.numberLiterals.find((n) => n >= 4 && n <= 450) ?? 16;
      transform.attributes.length = String(len);
      transform.attributes.includeNumbers = parsed.lower.includes("number") ? "true" : "false";
      transform.attributes.includeSpecialChars = parsed.lower.includes("special") ? "true" : "false";
      break;
    }
    case "getEndOfString": {
      const n = parsed.numberLiterals.find((v) => v >= 1 && v <= 100) ?? 4;
      transform.attributes.numChars = String(n);
      break;
    }
    case "getReferenceIdentityAttribute": {
      const isManager = parsed.lower.includes("manager");
      transform.attributes.uid = isManager ? "manager" : "<IDENTITY_UID>";
      if (!isManager) placeholders.push("<uid> — identity user name or 'manager'");
      if (parsed.potentialAttributes[0]) {
        transform.attributes.attributeName = parsed.potentialAttributes[0];
      } else {
        transform.attributes.attributeName = "<ATTRIBUTE_NAME>";
        placeholders.push("<attributeName>");
      }
      break;
    }
    case "firstValid": {
      if (parsed.potentialAttributes.length > 0) {
        const vals = parsed.potentialAttributes.map((a) => ({
          type: "identityAttribute",
          attributes: { name: a },
        }));
        // Add a static fallback if there are quoted strings
        if (parsed.quotedStrings[0]) {
          vals.push({ type: "static", attributes: { value: parsed.quotedStrings[0] } } as any);
        } else {
          vals.push({ type: "static", attributes: { value: "UNKNOWN" } } as any);
          placeholders.push("<fallback value> in last values entry");
        }
        transform.attributes.values = vals;
      } else {
        placeholders.push("<values array with ordered fallbacks>");
      }
      break;
    }
  }

  return { transform, placeholders };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

const DOCS_BASE = "https://developer.sailpoint.com/docs/extensibility/transforms/operations";
const TYPE_TO_DOC_SLUG: Record<string, string> = {
  accountAttribute: "account-attribute", base64Decode: "base64-decode",
  base64Encode: "base64-encode", concat: "concatenation", conditional: "conditional",
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

export type GenerateResult = {
  transform: any;
  operation_type: string;
  confidence: "high" | "medium" | "low";
  alternative_operations: string[];
  doc_url: string;
  explanation: string;
  warnings: string[];
  placeholders: string[];
};

export function generateTransform(
  requirement: string,
  transformName?: string
): GenerateResult {
  if (!requirement || typeof requirement !== "string" || requirement.trim().length === 0) {
    throw new Error("requirement must be a non-empty string describing what the transform should do.");
  }

  const parsed = parseRequirement(requirement.trim());
  const ranked = scoreOperations(parsed);

  const warnings: string[] = [];

  if (ranked.length === 0) {
    warnings.push("No strong keyword match found. Defaulting to 'static' transform as a starting point.");
    ranked.push({ type: "static", score: 1 });
  }

  const best = ranked[0]!;
  const topScore = best.score;
  const alternatives = ranked.slice(1, 4).map((r) => r.type);

  const confidence: "high" | "medium" | "low" =
    topScore >= 10 ? "high" : topScore >= 5 ? "medium" : "low";

  if (confidence === "low") {
    warnings.push(
      `Low confidence (score=${topScore}). Consider using isc.transforms.catalog to browse all operations and pick the right one manually.`
    );
  }

  const name = transformName ?? deriveTransformName(requirement, best.type);
  const { transform, placeholders } = buildTransformJson(best.type, parsed, name);

  const spec = TRANSFORM_CATALOG[best.type as TransformType];
  const docSlug = TYPE_TO_DOC_SLUG[best.type];
  const doc_url = docSlug ? `${DOCS_BASE}/${docSlug}/` : `${DOCS_BASE}/`;

  let explanation = `Selected operation: '${best.type}'`;
  if (spec?.title) explanation = `Selected '${spec.title}' (${best.type}) based on the requirement.`;
  if (placeholders.length) {
    explanation += ` Replace placeholder(s) before deploying: ${placeholders.join(", ")}.`;
  }
  if (alternatives.length) {
    explanation += ` Alternatives to consider: ${alternatives.join(", ")}.`;
  }

  return {
    transform,
    operation_type: best.type,
    confidence,
    alternative_operations: alternatives,
    doc_url,
    explanation,
    warnings,
    placeholders,
  };
}

function deriveTransformName(req: string, type: string): string {
  // Build a reasonable transform name from the requirement
  const words = req.replace(/[^a-zA-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const capped = words.slice(0, 5).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
  return capped || `${type} Transform`;
}
