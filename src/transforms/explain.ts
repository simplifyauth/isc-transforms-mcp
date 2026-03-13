// src/transforms/explain.ts
// Human-readable error explanation + best-effort auto-correction for SailPoint ISC transforms.
// Fully offline — no tenant access required.

import { validateTransform, type ValidationError } from "./validate.js";
import { lintTransform, type LintMessage } from "./lint.js";

// ---------------------------------------------------------------------------
// Per-keyword correction recipes
// ---------------------------------------------------------------------------

type CorrectionRecipe = {
  /** AJV keyword or lint rule that triggers this recipe */
  match: (err: ValidationError | LintMessage) => boolean;
  /** Human-readable explanation of why this error occurs */
  explain: (err: ValidationError | LintMessage) => string;
  /** Optionally attempt to auto-correct the transform JSON */
  correct?: (transform: any, err: ValidationError | LintMessage) => void;
};

const RECIPES: CorrectionRecipe[] = [
  // --- Required field missing ---
  {
    match: (e) => e.message.includes("Missing required") || e.message.includes("required field"),
    explain: (e) => {
      const field = e.message.match(/['`]([^'`]+)['`]/)?.[1] ?? "field";
      return (
        `The field '${field}' is required by SailPoint and must be present in the transform JSON. ` +
        `Check the official docs for this operation to see what value is expected.`
      );
    },
  },
  // --- Unknown / additional property ---
  {
    match: (e) => e.message.toLowerCase().includes("unknown") || e.message.toLowerCase().includes("additional"),
    explain: (e) => {
      const field = e.message.match(/['`"]([^'`"]+)['`"]/)?.[1] ?? "property";
      return (
        `The field '${field}' is not a recognised attribute for this transform type. ` +
        `SailPoint's JSON Schema for this operation uses additionalProperties:false, ` +
        `meaning only documented attributes are permitted. Remove or rename this field.`
      );
    },
    correct: (transform, e) => {
      const field = e.message.match(/['`"]([^'`"]+)['`"]/)?.[1];
      if (field && transform.attributes && Object.prototype.hasOwnProperty.call(transform.attributes, field)) {
        delete transform.attributes[field];
      } else if (field && Object.prototype.hasOwnProperty.call(transform, field) && !["type","name","attributes","requiresPeriodicRefresh","internal"].includes(field)) {
        delete transform[field];
      }
    },
  },
  // --- Type mismatch (boolean) ---
  {
    match: (e) => e.message.toLowerCase().includes("type mismatch") && e.message.toLowerCase().includes("boolean"),
    explain: (e) => {
      const path = (e as any).path ?? "";
      return (
        `The field at '${path}' must be a boolean (true or false), not a string like "true". ` +
        `SailPoint's schema enforces the native JSON boolean type for this attribute.`
      );
    },
    correct: (transform, e) => {
      const path = ((e as any).path ?? "").replace(/^\//, "").split("/");
      let obj = transform;
      for (let i = 0; i < path.length - 1; i++) obj = obj?.[path[i]];
      const key = path[path.length - 1];
      if (key && obj && typeof obj[key] === "string") {
        obj[key] = obj[key].toLowerCase() === "true";
      }
    },
  },
  // --- Type mismatch (string) ---
  {
    match: (e) => e.message.toLowerCase().includes("type mismatch") && e.message.toLowerCase().includes("string"),
    explain: (e) => {
      const path = (e as any).path ?? "";
      const rawData = (e as any).raw?.data;
      const rawType = rawData !== undefined ? typeof rawData : "different type";
      return `The field at '${path}' must be a string, not a ${rawType}. Wrap the value in double quotes.`;
    },
  },
  // --- conditional expression operator ---
  {
    match: (e) => e.message.toLowerCase().includes("eq") && e.message.toLowerCase().includes("expression"),
    explain: () =>
      `SailPoint's conditional transform only supports the 'eq' (equals) comparator in expressions. ` +
      `Operators like '!=', '>', '<', '>=', '<=', or others are NOT supported. ` +
      `Rewrite your expression using: '<ValueA> eq <ValueB>'.`,
  },
  // --- dateFormat named format ---
  {
    match: (e) => e.message.includes("EPOCH_TIME_JAVA") || (e.message.toLowerCase().includes("epoch") && e.message.toLowerCase().includes("format")),
    explain: () =>
      `SailPoint's dateFormat transform does not accept 'epoch' as a format token. ` +
      `Use the named constant 'EPOCH_TIME_JAVA' for Java-epoch milliseconds, ` +
      `'EPOCH_TIME_WIN32' for Windows FILETIME, or 'ISO8601' for standard ISO datetime strings.`,
  },
  // --- week rounding in dateMath ---
  {
    match: (e) => e.message.includes("Rounding with 'w'"),
    explain: () =>
      `SailPoint's dateMath transform does not support rounding by week ('w'). ` +
      `You can add/subtract weeks (e.g. 'now+1w') but cannot round to the week boundary. ` +
      `Use day ('d'), month ('M'), or year ('y') rounding instead.`,
  },
  // --- accountAttribute multiple sources ---
  {
    match: (e) => e.message.toLowerCase().includes("exactly one source"),
    explain: () =>
      `The accountAttribute transform requires exactly ONE of: sourceName, applicationId, or applicationName. ` +
      `Providing more than one creates an ambiguous source reference. ` +
      `Remove all but the one you intend to use: prefer 'sourceName' for human-readable references, ` +
      `or 'applicationName' for immutable source references.`,
    correct: (transform) => {
      const attrs = transform.attributes;
      if (!attrs) return;
      const sourceFields = ["sourceName", "applicationId", "applicationName"];
      const present = sourceFields.filter((f) => attrs[f] !== undefined);
      // Keep sourceName if present; otherwise keep first found
      const keep = present.includes("sourceName") ? "sourceName" : present[0];
      for (const f of present) {
        if (f !== keep) delete attrs[f];
      }
    },
  },
  // --- replace regex invalid ---
  {
    match: (e) => e.message.toLowerCase().includes("valid regular expression") || e.message.toLowerCase().includes("invalid regex"),
    explain: (e) => {
      const regexMatch = e.message.match(/regex '([^']+)'/);
      const regex = regexMatch?.[1] ?? "<pattern>";
      return (
        `The regex '${regex}' is not a valid regular expression. ` +
        `Check for: unmatched brackets, invalid escape sequences (use \\\\ for literal backslash), ` +
        `or unsupported regex syntax. Test your regex at regex101.com before using it here.`
      );
    },
  },
  // --- join delimiter → separator ---
  {
    match: (e) => e.message.includes("delimiter") && e.message.includes("separator"),
    explain: () =>
      `The join transform uses 'separator' (not 'delimiter') as the attribute name. ` +
      `Rename your attribute from 'delimiter' to 'separator'.`,
    correct: (transform) => {
      if (transform.attributes?.delimiter !== undefined) {
        transform.attributes.separator = transform.attributes.delimiter;
        delete transform.attributes.delimiter;
      }
    },
  },
  // --- getEndOfString uses numChars not length ---
  {
    match: (e) => e.message.includes("numChars") && e.message.includes("length"),
    explain: () =>
      `The getEndOfString transform uses 'numChars' (not 'length') to specify how many characters ` +
      `to return from the end of the string. Rename 'length' to 'numChars'.`,
    correct: (transform) => {
      if (transform.attributes?.length !== undefined && transform.attributes?.numChars === undefined) {
        transform.attributes.numChars = transform.attributes.length;
        delete transform.attributes.length;
      }
    },
  },
  // --- requiresPeriodicRefresh type ---
  {
    match: (e) => e.message.includes("requiresPeriodicRefresh"),
    explain: () =>
      `'requiresPeriodicRefresh' must be a native JSON boolean (true or false). ` +
      `If you wrote "true" (a string), change it to true (no quotes). ` +
      `This flag controls whether ISC re-evaluates the transform during the nightly identity refresh.`,
    correct: (transform) => {
      if (typeof transform.requiresPeriodicRefresh === "string") {
        transform.requiresPeriodicRefresh = transform.requiresPeriodicRefresh.toLowerCase() === "true";
      }
    },
  },
  // --- lookup missing default ---
  {
    match: (e) => e.message.toLowerCase().includes("default") && e.message.toLowerCase().includes("lookup"),
    explain: () =>
      `The lookup table is missing a 'default' key. Without it, the transform throws an error ` +
      `whenever the input value doesn't match any key in the table. ` +
      `Add: "default": "<fallback value>" to handle unmatched inputs gracefully.`,
    correct: (transform) => {
      if (transform.attributes?.table && typeof transform.attributes.table === "object" && !transform.attributes.table.default) {
        transform.attributes.table.default = "UNKNOWN";
      }
    },
  },
  // --- usernameGenerator sourceCheck type ---
  {
    match: (e) => e.message.includes("sourceCheck") && e.message.toLowerCase().includes("boolean"),
    explain: () =>
      `'sourceCheck' must be a boolean (true or false). ` +
      `When true, the username generator checks uniqueness against the target system directly; ` +
      `when false (default), it checks only the ISC database.`,
    correct: (transform) => {
      if (typeof transform.attributes?.sourceCheck === "string") {
        transform.attributes.sourceCheck = transform.attributes.sourceCheck.toLowerCase() === "true";
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type ExplainResult = {
  explanation: string;
  issues: Array<{ message: string; suggestion: string }>;
  corrected_json: any | null;
};

export function explainTransformErrors(
  transformJson: any,
  externalError?: string
): ExplainResult {
  if (!transformJson || typeof transformJson !== "object") {
    return {
      explanation: "The input is not a valid JSON object.",
      issues: [{ message: "Not a JSON object.", suggestion: "Wrap your transform in braces: { ... }" }],
      corrected_json: null,
    };
  }

  // Collect all validation + lint errors
  const validation = validateTransform(transformJson);
  const lintResult = lintTransform(transformJson);
  const allErrors: Array<ValidationError | LintMessage> = [
    ...validation.errors,
    ...lintResult.messages.filter((m) => m.level === "error"),
  ];

  // Add external error as a synthetic lint message
  if (externalError) {
    allErrors.push({ level: "error", message: externalError, path: "<external>" } as LintMessage);
  }

  if (allErrors.length === 0 && !externalError) {
    return {
      explanation: "No errors detected. The transform passed both schema validation and semantic lint.",
      issues: [],
      corrected_json: null,
    };
  }

  // Deep-clone for correction attempts
  let corrected: any = JSON.parse(JSON.stringify(transformJson));
  let correctionApplied = false;

  const issues: Array<{ message: string; suggestion: string }> = [];
  const seen = new Set<string>();

  for (const err of allErrors) {
    const key = err.message.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);

    let matched = false;
    for (const recipe of RECIPES) {
      if (recipe.match(err)) {
        const suggestion = recipe.explain(err);
        issues.push({ message: err.message, suggestion });
        if (recipe.correct) {
          try {
            recipe.correct(corrected, err);
            correctionApplied = true;
          } catch {
            // best-effort; skip silently
          }
        }
        matched = true;
        break;
      }
    }

    if (!matched) {
      issues.push({
        message: err.message,
        suggestion:
          `Refer to the official SailPoint docs for this transform type and verify that ` +
          `all required fields are present and correctly typed. ` +
          `Path: ${(err as any).path ?? "unknown"}.`,
      });
    }
  }

  // Verify corrected JSON actually improved (re-validate)
  let finalCorrected: any = null;
  if (correctionApplied) {
    const reValidated = validateTransform(corrected);
    const reLinted = lintTransform(corrected);
    const reErrors = [
      ...reValidated.errors,
      ...reLinted.messages.filter((m) => m.level === "error"),
    ];
    if (reErrors.length < allErrors.length) {
      finalCorrected = corrected;
    }
  }

  const countFixed = correctionApplied && finalCorrected
    ? allErrors.length - (validateTransform(finalCorrected).errors.length + lintTransform(finalCorrected).messages.filter((m) => m.level === "error").length)
    : 0;

  const explanation =
    issues.length === 1
      ? `Found 1 error in the transform.`
      : `Found ${issues.length} error(s) in the transform.` +
        (countFixed > 0 ? ` Auto-correction fixed ${countFixed} of them.` : "");

  return {
    explanation,
    issues,
    corrected_json: finalCorrected,
  };
}
