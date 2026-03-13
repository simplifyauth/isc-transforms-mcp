// src/transforms/catalog.ts
/**
 * Transform operation catalog for SailPoint Identity Security Cloud (ISC).
 *
 * Source of truth (official SailPoint docs):
 * - Operations index: https://developer.sailpoint.com/docs/extensibility/transforms/operations/
 * - Individual operation pages are linked from the index above.
 *
 * Notes:
 * - Some "operations" (e.g., generateRandomString, getEndOfString, getReferenceIdentityAttribute) are implemented
 *   as *rule-backed* transforms via the SailPoint-provided rule named "Cloud Services Deployment Utility".
 *   In those cases, the *payload* sent to ISC is `{ type: "rule", attributes: { name: "Cloud Services Deployment Utility", operation: "<op>", ... } }`.
 *   The catalog keeps the "operation key" (e.g., "generateRandomString") so the MCP can lint/guide users,
 *   while normalization can emit the correct `type: "rule"` payload.
 */

export type TransformType =
  // Standard transform "type" values (as accepted by the ISC Transform API)
  | "accountAttribute"
  | "base64Decode"
  | "base64Encode"
  | "concat"
  | "conditional"
  | "dateCompare"
  | "dateFormat"
  | "dateMath"
  | "decomposeDiacriticalMarks"
  | "displayName"
  | "e164phone"
  | "firstValid"
  | "identityAttribute"
  | "indexOf"
  | "iso3166"
  | "join"
  | "lastIndexOf"
  | "leftPad"
  | "lookup"
  | "lower"
  | "normalizeNames"
  | "randomAlphaNumeric"
  | "randomNumeric"
  | "reference"
  | "replaceAll"
  | "replace"
  | "rfc5646"
  | "rightPad"
  | "rule"
  | "split"
  | "static"
  | "substring"
  | "trim"
  | "upper"
  | "usernameGenerator"
  | "uuid"
  // Rule-backed "operation keys" (normalized to payload type "rule")
  | RuleBackedOperation;

export type RuleBackedOperation =
  | "generateRandomString"
  | "getEndOfString"
  | "getReferenceIdentityAttribute";

export type TransformSpec = {
  /** Catalog key. For standard transforms, this equals payload type; for rule-backed, it's the operation key. */
  type: TransformType;

  title: string;

  /** Official SailPoint doc URL for the operation. */
  docUrl: string;

  /**
   * Required keys inside the final `attributes` object (after normalization/injection).
   * Keep this aligned with the official docs.
   */
  requiredAttributes?: string[];

  /**
   * If present, these are the attributes the *caller must supply* (before normalization).
   * (Useful for rule-backed ops where `name` + `operation` are injected/locked.)
   */
  requiredUserAttributes?: string[];

  /**
   * Attributes that are auto-injected (or locked) by normalization for safety.
   * Example: `{ name: "Cloud Services Deployment Utility", operation: "generateRandomString" }`
   */
  injectedAttributes?: Record<string, any>;

  /**
   * If true, the `attributes` object can be omitted entirely.
   * (Some transforms accept only top-level `type` + `name`.)
   */
  attributesOptional?: boolean;

  /** Minimal working example payload (for documentation + scaffolding). */
  scaffold: (name: string) => any;
};

const DOCS_BASE = "https://developer.sailpoint.com/docs/extensibility/transforms/operations";
const doc = (slug: string) => `${DOCS_BASE}/${slug}/`;

const CSDU_RULE_NAME = "Cloud Services Deployment Utility"; // Official SailPoint rule name (see rule-backed operation docs)

function buildRuleBackedSpec(opts: {
  op: RuleBackedOperation;
  title: string;
  docSlug: string;
  requiredUserAttributes: string[];
  scaffoldAttributes: Record<string, any>;
}): TransformSpec {
  const injected = { name: CSDU_RULE_NAME, operation: opts.op };
  return {
    type: opts.op,
    title: `${opts.title} (rule-backed)`,
    docUrl: doc(opts.docSlug),
    // Final payload must include name + operation + user attrs
    requiredAttributes: ["name", "operation", ...opts.requiredUserAttributes],
    requiredUserAttributes: [...opts.requiredUserAttributes],
    injectedAttributes: injected,
    attributesOptional: false,
    scaffold: (name) => ({
      type: "rule",
      name,
      attributes: {
        ...injected,
        ...opts.scaffoldAttributes,
      },
    }),
  };
}

// Rule-backed operations via CSDU
const ruleBacked: Record<RuleBackedOperation, TransformSpec> = {
  generateRandomString: buildRuleBackedSpec({
    op: "generateRandomString",
    title: "Generate Random String",
    docSlug: "generate-random-string",
    requiredUserAttributes: ["length", "includeNumbers", "includeSpecialChars"],
    scaffoldAttributes: {
      // Docs: max length is 450; includeNumbers/includeSpecialChars are strings "true"/"false"
      length: "16",
      includeNumbers: "true",
      includeSpecialChars: "true",
    },
  }),

  getEndOfString: buildRuleBackedSpec({
    op: "getEndOfString",
    title: "Get End of String",
    docSlug: "get-end-of-string",
    requiredUserAttributes: ["numChars"],
    scaffoldAttributes: {
      numChars: "4",
      // optional: input
    },
  }),

  getReferenceIdentityAttribute: buildRuleBackedSpec({
    op: "getReferenceIdentityAttribute",
    title: "Get Reference Identity Attribute",
    docSlug: "get-reference-identity-attribute",
    requiredUserAttributes: ["uid", "attributeName"],
    scaffoldAttributes: {
      // uid = Identity user name or "manager" keyword; attributeName = identity attribute system name
      uid: "2c9180...EXAMPLE_ID",
      attributeName: "email",
    },
  }),
};

export const TRANSFORM_CATALOG: Record<TransformType, TransformSpec> = {
  // --- Standard transforms (payload type == catalog key) ---
  accountAttribute: {
    type: "accountAttribute",
    title: "Account Attribute",
    docUrl: doc("account-attribute"),
    // Docs allow one of: sourceName OR applicationId/applicationName (plus attributeName)
    requiredAttributes: ["attributeName", "sourceName|applicationId|applicationName"],
    requiredUserAttributes: ["attributeName", "sourceName|applicationId|applicationName"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "accountAttribute",
      name,
      attributes: {
        sourceName: "HR Source",
        attributeName: "department",
        // Optional filters (examples in docs):
        // accountPropertyFilter: "(department == \"Engineering\")",
        // accountFilter: "Employee",
      },
    }),
  },

  base64Decode: {
    type: "base64Decode",
    title: "Base64 Decode",
    docUrl: doc("base64-decode"),
    attributesOptional: true,
    scaffold: (name) => ({ type: "base64Decode", name }),
  },

  base64Encode: {
    type: "base64Encode",
    title: "Base64 Encode",
    docUrl: doc("base64-encode"),
    attributesOptional: true,
    scaffold: (name) => ({ type: "base64Encode", name }),
  },

  concat: {
    type: "concat",
    title: "Concatenation",
    docUrl: doc("concatenation"),
    requiredAttributes: ["values"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "concat",
      name,
      attributes: {
        values: [
          { type: "identityAttribute", attributes: { name: "givenName" } },
          " ",
          { type: "identityAttribute", attributes: { name: "sn" } },
        ],
      },
    }),
  },

  conditional: {
    type: "conditional",
    title: "Conditional",
    docUrl: doc("conditional"),
    requiredAttributes: ["expression", "positiveCondition", "negativeCondition"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "conditional",
      name,
      attributes: {
        // Optional variables can be defined and referenced via $variableName syntax.
        department: {
          type: "accountAttribute",
          attributes: { sourceName: "HR Source", attributeName: "department" },
        },
        // Docs: expression follows "ValueA eq ValueB" and `eq` is the only valid operator.
        // Example: "$department eq Engineering"
        expression: "$department eq Engineering",
        positiveCondition: "ENG",
        negativeCondition: "NONENG",
      },
    }),
  },

  dateCompare: {
    type: "dateCompare",
    title: "Date Compare",
    docUrl: doc("date-compare"),
    // SailPoint docs show dateCompare returns positiveCondition/negativeCondition values.
    // Source: https://developer.sailpoint.com/docs/extensibility/transforms/operations/date-compare/
    requiredAttributes: ["firstDate", "secondDate", "operator", "positiveCondition", "negativeCondition"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "dateCompare",
      name,
      attributes: {
        firstDate: "2025-01-01T00:00:00Z",
        secondDate: "2025-01-31T00:00:00Z",
        operator: "LT",
        positiveCondition: "true",
        negativeCondition: "false",
      },
    }),
  },

  dateFormat: {
    type: "dateFormat",
    title: "Date Format",
    docUrl: doc("date-format"),
    // Docs: inputFormat and outputFormat are both optional (default: ISO8601)
    requiredAttributes: [],
    attributesOptional: true,
    scaffold: (name) => ({
      type: "dateFormat",
      name,
      attributes: {
        inputFormat: "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        outputFormat: "yyyy-MM-dd",
        // Optional: input
      },
    }),
  },

  dateMath: {
    type: "dateMath",
    title: "Date Math",
    docUrl: doc("date-math"),
    requiredAttributes: ["expression"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "dateMath",
      name,
      attributes: {
        expression: "now+1w",
      },
    }),
  },

  decomposeDiacriticalMarks: {
    type: "decomposeDiacriticalMarks",
    title: "Decompose Diacritical Marks",
    docUrl: doc("decompose-diacritical-marks"),
    attributesOptional: true,
    scaffold: (name) => ({ type: "decomposeDiacriticalMarks", name }),
  },

  displayName: {
    type: "displayName",
    title: "Display Name",
    docUrl: doc("display-name"),
    requiredAttributes: ["input"], // docs require attributes object; include input placeholder
    attributesOptional: false,
    scaffold: (name) => ({
      type: "displayName",
      name,
      attributes: { input: "input" },
    }),
  },

  e164phone: {
    type: "e164phone",
    title: "E.164 Phone",
    docUrl: doc("e-164-phone"),
    // Docs: defaultRegion is optional (default: "US")
    requiredAttributes: [],
    attributesOptional: true,
    scaffold: (name) => ({
      type: "e164phone",
      name,
      attributes: { defaultRegion: "US" },
    }),
  },

  firstValid: {
    type: "firstValid",
    title: "First Valid",
    docUrl: doc("first-valid"),
    requiredAttributes: ["values"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "firstValid",
      name,
      attributes: {
        values: [
          { type: "identityAttribute", attributes: { name: "preferredName" } },
          { type: "identityAttribute", attributes: { name: "givenName" } },
          "UNKNOWN",
        ],
      },
    }),
  },

  identityAttribute: {
    type: "identityAttribute",
    title: "Identity Attribute",
    docUrl: doc("identity-attribute"),
    requiredAttributes: ["name"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "identityAttribute",
      name,
      attributes: { name: "email" },
    }),
  },

  indexOf: {
    type: "indexOf",
    title: "Index Of",
    docUrl: doc("index-of"),
    requiredAttributes: ["substring"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "indexOf",
      name,
      attributes: { substring: "@" },
    }),
  },

  iso3166: {
    type: "iso3166",
    title: "ISO3166",
    docUrl: doc("iso3166"),
    // Docs: format is optional (default: "alpha2"). No "defaultRegion" attribute exists for iso3166.
    requiredAttributes: [],
    attributesOptional: true,
    scaffold: (name) => ({
      type: "iso3166",
      name,
      attributes: { format: "alpha2" },
    }),
  },

  join: {
    type: "join",
    title: "Join",
    docUrl: doc("join"),
    // Docs: "values" is required. "separator" is optional (default: ","). Docs use "separator", NOT "delimiter".
    requiredAttributes: ["values"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "join",
      name,
      attributes: { values: ["a", "b", "c"], separator: "," },
    }),
  },

  lastIndexOf: {
    type: "lastIndexOf",
    title: "Last Index Of",
    docUrl: doc("last-index-of"),
    requiredAttributes: ["substring"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "lastIndexOf",
      name,
      attributes: { substring: "/" },
    }),
  },

  leftPad: {
    type: "leftPad",
    title: "Left Pad",
    docUrl: doc("left-pad"),
    // Docs: "length" is required. "padding" is optional (default: single space " ").
    requiredAttributes: ["length"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "leftPad",
      name,
      attributes: { length: "8", padding: "0" },
    }),
  },

  lookup: {
    type: "lookup",
    title: "Lookup",
    docUrl: doc("lookup"),
    requiredAttributes: ["table"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "lookup",
      name,
      attributes: {
        table: { A: "Alpha", B: "Beta", default: "Unknown" },
      },
    }),
  },

  lower: {
    type: "lower",
    title: "Lower",
    docUrl: doc("lower"),
    attributesOptional: true,
    scaffold: (name) => ({ type: "lower", name }),
  },

  normalizeNames: {
    type: "normalizeNames",
    title: "Name Normalizer",
    docUrl: doc("name-normalizer"),
    // Docs: type is "normalizeNames". No configurable attributes (regex/replacement are NOT part of this transform).
    // The transform uses built-in normalization rules (capitalization, patronymic Mc/Mac, toponymic von/de, Roman numerals).
    requiredAttributes: [],
    attributesOptional: true,
    scaffold: (name) => ({ type: "normalizeNames", name }),
  },

  randomAlphaNumeric: {
    type: "randomAlphaNumeric",
    title: "Random Alphanumeric",
    docUrl: doc("random-alphanumeric"),
    attributesOptional: true,
    scaffold: (name) => ({ type: "randomAlphaNumeric", name, attributes: { length: "32" } }),
  },

  randomNumeric: {
    type: "randomNumeric",
    title: "Random Numeric",
    docUrl: doc("random-numeric"),
    attributesOptional: true,
    scaffold: (name) => ({ type: "randomNumeric", name, attributes: { length: "10" } }),
  },

  reference: {
    type: "reference",
    title: "Reference",
    docUrl: doc("reference"),
    requiredAttributes: ["id"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "reference",
      name,
      attributes: { id: "Existing Transform Name" },
    }),
  },

  replaceAll: {
    type: "replaceAll",
    title: "Replace All",
    docUrl: doc("replace-all"),
    requiredAttributes: ["table"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "replaceAll",
      name,
      attributes: {
        table: { "-": "", " ": "" },
      },
    }),
  },

  replace: {
    type: "replace",
    title: "Replace",
    docUrl: doc("replace"),
    requiredAttributes: ["regex", "replacement"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "replace",
      name,
      attributes: { regex: "[^a-zA-Z]", replacement: "" },
    }),
  },

  rfc5646: {
    type: "rfc5646",
    title: "RFC5646",
    docUrl: doc("rfc5646"),
    requiredAttributes: ["format"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "rfc5646",
      name,
      attributes: { format: "alpha2" },
    }),
  },

  rightPad: {
    type: "rightPad",
    title: "Right Pad",
    docUrl: doc("right-pad"),
    // Docs: "length" is required. "padding" is optional (default: single space " ").
    requiredAttributes: ["length"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "rightPad",
      name,
      attributes: { length: "8", padding: "0" },
    }),
  },

  rule: {
    type: "rule",
    title: "Rule",
    docUrl: doc("rule"),
    // Generic rule transform: docs require attributes.name (rule name). Operation is rule-specific.
    requiredAttributes: ["name"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "rule",
      name,
      attributes: { name: "My Custom Rule Name", operation: "optionalOperation" },
    }),
  },

  split: {
    type: "split",
    title: "Split",
    docUrl: doc("split"),
    requiredAttributes: ["delimiter", "index"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "split",
      name,
      attributes: { delimiter: ",", index: 0 },
    }),
  },

  static: {
    type: "static",
    title: "Static",
    docUrl: doc("static"),
    requiredAttributes: ["value"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "static",
      name,
      attributes: { value: "HelloWorld" },
    }),
  },

  substring: {
    type: "substring",
    title: "Substring",
    docUrl: doc("substring"),
    // Docs: "begin" is required. "end" is optional (defaults to end of string / -1).
    requiredAttributes: ["begin"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "substring",
      name,
      attributes: { begin: 0, end: 5 },
    }),
  },

  trim: {
    type: "trim",
    title: "Trim",
    docUrl: doc("trim"),
    attributesOptional: true,
    scaffold: (name) => ({ type: "trim", name }),
  },

  upper: {
    type: "upper",
    title: "Upper",
    docUrl: doc("upper"),
    attributesOptional: true,
    scaffold: (name) => ({ type: "upper", name }),
  },

  usernameGenerator: {
    type: "usernameGenerator",
    title: "Username Generator",
    docUrl: doc("username-generator"),
    requiredAttributes: ["patterns"],
    attributesOptional: false,
    scaffold: (name) => ({
      type: "usernameGenerator",
      name,
      attributes: {
        // Minimal example; patterns and uniqueness settings vary by use-case.
        patterns: ["${firstName}.${lastName}"],
      },
    }),
  },

  uuid: {
    type: "uuid",
    title: "UUID Generator",
    docUrl: doc("uuid-generator"),
    attributesOptional: true,
    scaffold: (name) => ({ type: "uuid", name }),
  },

  // --- Rule-backed operation keys ---
  ...ruleBacked,
};

export function getTransformSpec(type: string): TransformSpec | undefined {
  const t = toCanonicalType(type);
  return t ? TRANSFORM_CATALOG[t] : undefined;
}

export function listTransformTypes(): TransformType[] {
  return Object.keys(TRANSFORM_CATALOG) as TransformType[];
}

export function toCanonicalType(type: string): TransformType | undefined {
  if (!type) return undefined;
  const t = String(type).trim();

  // Accept some friendly aliases for people typing from docs/UI
  const map: Record<string, TransformType> = {
    concatenation: "concat",
    namenormalizer: "normalizeNames",
    "name normalizer": "normalizeNames",
    normalizenames: "normalizeNames",
    join: "join",
    "e.164phone": "e164phone",
    "e164 phone": "e164phone",
    iso3166: "iso3166",
    "iso-3166": "iso3166",
    "replace all": "replaceAll",
    "replaceall": "replaceAll",
    "random alphanumeric": "randomAlphaNumeric",
    "random alphanum": "randomAlphaNumeric",
    "random numeric": "randomNumeric",
    "uuid generator": "uuid",
    "username generator": "usernameGenerator",
    "generate random string": "generateRandomString",
    "get end of string": "getEndOfString",
    "get reference identity attribute": "getReferenceIdentityAttribute",
  };

  const key = t.toLowerCase();
  if (map[key]) return map[key];

  // Exact match (case-sensitive API types)
  if ((TRANSFORM_CATALOG as any)[t]) return t as TransformType;

  return undefined;
}
