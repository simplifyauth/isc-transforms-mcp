// src/transforms/testcases.ts
// Per-operation test case generator for SailPoint ISC transforms.
// Produces illustrative happy-path, null-input, and edge-case examples for
// manual QA in the ISC transform tester or automated test harnesses.
// Fully offline — no tenant access required.

import { toCanonicalType } from "./catalog.js";

export type TestCase = {
  description: string;
  input_value: string | null;
  expected_output: string | null | "error";
  note?: string;
};

export type TestCaseResult = {
  operation_type: string;
  transform_name: string;
  test_cases: TestCase[];
  note: string;
};

// ---------------------------------------------------------------------------
// Per-operation test case templates
// ---------------------------------------------------------------------------

type TestCaseFactory = (transform: any) => TestCase[];

const FACTORIES: Record<string, TestCaseFactory> = {

  static: (t) => {
    const val = t.attributes?.value ?? "VALUE";
    return [
      { description: "Happy path — input is ignored", input_value: "anything", expected_output: val },
      { description: "Null input — still returns static value", input_value: null, expected_output: val },
      { description: "Empty string input — still returns static value", input_value: "", expected_output: val },
    ];
  },

  lower: () => [
    { description: "Lowercase a mixed-case string", input_value: "John.DOE", expected_output: "john.doe" },
    { description: "Already lowercase — no change", input_value: "alice", expected_output: "alice" },
    { description: "Null input", input_value: null, expected_output: null, note: "SailPoint passes null through when input is null." },
    { description: "Empty string", input_value: "", expected_output: "" },
  ],

  upper: () => [
    { description: "Uppercase a mixed-case string", input_value: "john.doe", expected_output: "JOHN.DOE" },
    { description: "Already uppercase — no change", input_value: "ALICE", expected_output: "ALICE" },
    { description: "Null input", input_value: null, expected_output: null },
    { description: "Empty string", input_value: "", expected_output: "" },
  ],

  trim: () => [
    { description: "Leading and trailing spaces removed", input_value: "  hello world  ", expected_output: "hello world" },
    { description: "No spaces — no change", input_value: "noSpaces", expected_output: "noSpaces" },
    { description: "Only spaces → empty string", input_value: "   ", expected_output: "" },
    { description: "Null input", input_value: null, expected_output: null },
  ],

  concat: (t) => {
    const values = t.attributes?.values ?? ["a", "b"];
    const staticParts = values.filter((v: any) => typeof v === "string");
    const example = staticParts.length ? staticParts.join("") : "John.Doe";
    return [
      { description: "Concatenate two values", input_value: null, expected_output: example, note: "Input is the combined result of all values in the array." },
      { description: "One value is null → concat returns null for that segment", input_value: null, expected_output: null, note: "If any nested transform returns null, that segment is treated as empty string or null depending on ISC version." },
    ];
  },

  firstValid: () => [
    { description: "First value is non-null — returns it", input_value: "preferred@example.com", expected_output: "preferred@example.com" },
    { description: "First value is null, second is non-null", input_value: null, expected_output: "fallback@example.com", note: "Evaluation continues until a non-null value is found." },
    { description: "All values are null — returns null", input_value: null, expected_output: null, note: "If no non-null value exists in the list, the transform returns null." },
  ],

  conditional: (t) => {
    const pos = t.attributes?.positiveCondition ?? "true";
    const neg = t.attributes?.negativeCondition ?? "false";
    const expr = t.attributes?.expression ?? "$var eq value";
    const parts = expr.split(/\beq\b/i);
    const matchVal = (parts[1] ?? "VALUE").trim();
    return [
      { description: `Expression evaluates to true (input matches '${matchVal}')`, input_value: matchVal, expected_output: pos, note: "String comparison is case-sensitive." },
      { description: "Expression evaluates to false (input does not match)", input_value: "something_else", expected_output: neg },
      { description: "Null input — evaluates to false", input_value: null, expected_output: neg, note: "A null operand never equals a non-null string; evaluates as false." },
    ];
  },

  split: (t) => {
    const delim = t.attributes?.delimiter ?? ",";
    const idx = t.attributes?.index ?? 0;
    const sampleInput = ["part0", "part1", "part2"].join(delim);
    const expected = ["part0", "part1", "part2"][idx] ?? "part0";
    return [
      { description: `Split on '${delim}' and return index ${idx}`, input_value: sampleInput, expected_output: expected },
      { description: "Index out of range → returns null", input_value: `only${delim}two`, expected_output: idx >= 2 ? null : "two", note: "ISC returns null if the split index doesn't exist." },
      { description: "Delimiter not found → entire string at index 0 or null", input_value: "no-delimiter-here", expected_output: idx === 0 ? "no-delimiter-here" : null },
      { description: "Null input → null output", input_value: null, expected_output: null },
    ];
  },

  substring: (t) => {
    const begin = t.attributes?.begin ?? 0;
    const end = t.attributes?.end;
    const sample = "HelloWorld";
    const result = end !== undefined ? sample.slice(begin, end) : sample.slice(begin);
    return [
      { description: `Extract from position ${begin}${end !== undefined ? ` to ${end}` : " to end"}`, input_value: sample, expected_output: result },
      { description: "Input shorter than begin index → returns empty string or null", input_value: "Hi", expected_output: begin >= 2 ? null : "Hi".slice(begin, end), note: "ISC may return null for out-of-bounds begin." },
      { description: "Null input → null output", input_value: null, expected_output: null },
    ];
  },

  replace: (t) => {
    const regex = t.attributes?.regex ?? "[^a-zA-Z]";
    const repl = t.attributes?.replacement ?? "";
    return [
      { description: `Replace /${regex}/ with '${repl}'`, input_value: "Hello World!", expected_output: "Hello World!".replace(new RegExp(regex, "g"), repl), note: `Applies global replacement of pattern /${regex}/ with '${repl}'.` },
      { description: "No match — input returned unchanged", input_value: "abc", expected_output: "abc" },
      { description: "Null input → null output", input_value: null, expected_output: null },
    ];
  },

  replaceAll: (t) => {
    const table = t.attributes?.table ?? { "-": "", " ": "_" };
    const keys = Object.keys(table).filter((k) => k !== "default");
    const sampleInput = keys.length ? `a${keys[0]}b` : "a-b";
    const sampleOutput = keys.length ? `a${table[keys[0]] ?? ""}b` : "ab";
    return [
      { description: "Replace characters per table", input_value: sampleInput, expected_output: sampleOutput },
      { description: "No table keys match — input unchanged", input_value: "NOMATCHES", expected_output: "NOMATCHES" },
      { description: "Null input → null output", input_value: null, expected_output: null },
    ];
  },

  lookup: (t) => {
    const table = t.attributes?.table ?? { A: "Alpha", default: "Unknown" };
    const firstKey = Object.keys(table).find((k) => k !== "default") ?? "A";
    const firstVal = table[firstKey] ?? "Alpha";
    const defVal = table["default"] ?? null;
    return [
      { description: `Key '${firstKey}' found in table`, input_value: firstKey, expected_output: firstVal },
      { description: "Key not found — returns 'default' value", input_value: "UNKNOWN_KEY", expected_output: defVal ?? "error", note: defVal ? "Returns the 'default' table entry." : "No 'default' key in table — ISC will throw an error." },
      { description: "Null input → returns 'default' or null", input_value: null, expected_output: defVal, note: "Null input is treated as a lookup miss." },
    ];
  },

  dateFormat: (t) => {
    const inFmt = t.attributes?.inputFormat ?? "EPOCH_TIME_JAVA";
    const outFmt = t.attributes?.outputFormat ?? "ISO8601";
    const epochSample = inFmt === "EPOCH_TIME_JAVA" ? "1700000000000" : "2025-01-15T10:00:00Z";
    const expectedNote = `Convert from ${inFmt} to ${outFmt}.`;
    return [
      { description: "Happy path — valid date input", input_value: epochSample, expected_output: "<formatted date>", note: expectedNote },
      { description: "Invalid date string → error", input_value: "not-a-date", expected_output: "error", note: "ISC throws a parse error for unparseable date strings." },
      { description: "Null input → null output", input_value: null, expected_output: null },
    ];
  },

  dateMath: (t) => {
    const expr = t.attributes?.expression ?? "now+90d";
    return [
      { description: `Apply dateMath expression '${expr}'`, input_value: "2025-01-01T00:00:00Z", expected_output: "<date with math applied>", note: `Expression '${expr}' applied relative to the input date.` },
      { description: "Null input (when expression uses 'now') → current date + offset", input_value: null, expected_output: "<today + offset>", note: "If expression starts with 'now', input is ignored." },
      { description: "Invalid input format → error", input_value: "not-a-date", expected_output: "error", note: "If input is not a valid date string, ISC throws." },
    ];
  },

  dateCompare: (t) => {
    const op = (t.attributes?.operator ?? "LT").toUpperCase();
    const pos = t.attributes?.positiveCondition ?? "true";
    const neg = t.attributes?.negativeCondition ?? "false";
    return [
      { description: `Condition is true (firstDate ${op} secondDate)`, input_value: null, expected_output: pos, note: `Returns positiveCondition when comparison '${op}' is satisfied.` },
      { description: "Condition is false", input_value: null, expected_output: neg, note: `Returns negativeCondition when '${op}' is not satisfied.` },
      { description: "Either date is null → error", input_value: null, expected_output: "error", note: "Both date operands must be non-null." },
    ];
  },

  accountAttribute: (t) => {
    const attr = t.attributes?.attributeName ?? "department";
    const source = t.attributes?.sourceName ?? "HR Source";
    return [
      { description: `Account has attribute '${attr}' in '${source}'`, input_value: null, expected_output: "<attribute value from account>", note: `The transform reads '${attr}' from the first matching account in '${source}'.` },
      { description: "No account linked for this source → null", input_value: null, expected_output: null, note: "If the identity has no account in the named source, the transform returns null." },
      { description: "Multiple accounts → returns based on sort/filter settings", input_value: null, expected_output: "<value from sorted first account>", note: "Controlled by accountSortAttribute, accountSortDescending, accountReturnFirstLink." },
    ];
  },

  identityAttribute: (t) => {
    const name = t.attributes?.name ?? "email";
    return [
      { description: `Identity has attribute '${name}'`, input_value: null, expected_output: "<identity attribute value>", note: `Returns the value of '${name}' from the identity profile.` },
      { description: `Identity attribute '${name}' is not set → null`, input_value: null, expected_output: null },
    ];
  },

  leftPad: (t) => {
    const len = Number(t.attributes?.length ?? 8);
    const pad = t.attributes?.padding ?? "0";
    const sample = "123";
    const padded = sample.padStart(len, pad);
    return [
      { description: `Pad '${sample}' to length ${len} with '${pad}'`, input_value: sample, expected_output: padded },
      { description: "Input already at or beyond length → returned as-is", input_value: "1234567890", expected_output: "1234567890", note: "leftPad does not truncate." },
      { description: "Null input → null output", input_value: null, expected_output: null },
    ];
  },

  rightPad: (t) => {
    const len = Number(t.attributes?.length ?? 8);
    const pad = t.attributes?.padding ?? " ";
    const sample = "abc";
    const padded = sample.padEnd(len, pad);
    return [
      { description: `Pad '${sample}' to length ${len} with '${pad}'`, input_value: sample, expected_output: padded },
      { description: "Input already at or beyond length → returned as-is", input_value: "abcdefghij", expected_output: "abcdefghij" },
      { description: "Null input → null output", input_value: null, expected_output: null },
    ];
  },

  usernameGenerator: (t) => {
    const patterns = t.attributes?.patterns ?? ["${fn}.${ln}"];
    return [
      { description: "First pattern resolves to unique value", input_value: null, expected_output: "<resolved pattern>", note: `Pattern '${patterns[0]}' is evaluated first. If it's unique, it's returned.` },
      { description: "First pattern collides → falls back to next pattern", input_value: null, expected_output: "<next pattern variant>", note: "ISC checks uniqueness automatically when sourceCheck=true." },
      { description: "All patterns exhausted → error", input_value: null, expected_output: "error", note: "If all patterns produce duplicates, ISC throws an error." },
    ];
  },

  e164phone: (t) => {
    const region = t.attributes?.defaultRegion ?? "US";
    return [
      { description: "US number without country code", input_value: "2125551234", expected_output: "+12125551234", note: `Region '${region}' used for country-code insertion.` },
      { description: "Already E.164 formatted", input_value: "+442071234567", expected_output: "+442071234567" },
      { description: "Invalid phone number", input_value: "not-a-phone", expected_output: "error", note: "ISC throws for unparseable phone numbers." },
      { description: "Null input → null output", input_value: null, expected_output: null },
    ];
  },

  iso3166: (t) => {
    const fmt = t.attributes?.format ?? "alpha2";
    const outputs: Record<string, string> = { alpha2: "US", alpha3: "USA", numeric: "840" };
    const expected = outputs[fmt] ?? "US";
    return [
      { description: `Convert country name 'United States' to ${fmt}`, input_value: "United States", expected_output: expected, note: `Format: ${fmt}.` },
      { description: "Already in target format → returned as-is", input_value: expected, expected_output: expected },
      { description: "Unrecognised country → null or error", input_value: "Narnia", expected_output: null },
      { description: "Null input → null output", input_value: null, expected_output: null },
    ];
  },

  normalizeNames: () => [
    { description: "Patronymic name normalisation (McIntosh)", input_value: "mcintosh", expected_output: "McIntosh" },
    { description: "Toponymic prefix (de la Cruz)", input_value: "de la cruz", expected_output: "De la Cruz", note: "SailPoint follows standard capitalisation rules for toponymic prefixes." },
    { description: "Roman numerals preserved", input_value: "henry viii", expected_output: "Henry VIII" },
    { description: "Null input → null output", input_value: null, expected_output: null },
  ],

  decomposeDiacriticalMarks: () => [
    { description: "Strip accents from é, ü, ñ", input_value: "Ségolène", expected_output: "Segolene" },
    { description: "No accents → unchanged", input_value: "hello", expected_output: "hello" },
    { description: "Null input → null output", input_value: null, expected_output: null },
  ],

  uuid: () => [
    { description: "Returns a random UUID v4", input_value: null, expected_output: "<UUID v4>", note: "Value is non-deterministic; verify format is 8-4-4-4-12 hex." },
  ],

  randomAlphaNumeric: (t) => {
    const len = Number(t.attributes?.length ?? 32);
    return [
      { description: `Generates ${len}-char alphanumeric string`, input_value: null, expected_output: `<${len}-char alphanumeric string>`, note: "Non-deterministic; verify length and character set." },
    ];
  },

  randomNumeric: (t) => {
    const len = Number(t.attributes?.length ?? 10);
    return [
      { description: `Generates ${len}-digit numeric string`, input_value: null, expected_output: `<${len}-digit numeric string>` },
    ];
  },

  indexOf: (t) => {
    const sub = t.attributes?.substring ?? "@";
    return [
      { description: `Find position of '${sub}' in email address`, input_value: `user${sub}example.com`, expected_output: String(`user${sub}example.com`.indexOf(sub)) },
      { description: `'${sub}' not found → -1`, input_value: "no-such-char", expected_output: "-1" },
      { description: "Null input → null", input_value: null, expected_output: null },
    ];
  },

  lastIndexOf: (t) => {
    const sub = t.attributes?.substring ?? "/";
    return [
      { description: `Find last '${sub}' in path`, input_value: `a${sub}b${sub}c`, expected_output: String(`a${sub}b${sub}c`.lastIndexOf(sub)) },
      { description: `'${sub}' not found → -1`, input_value: "no-such-char", expected_output: "-1" },
      { description: "Null input → null", input_value: null, expected_output: null },
    ];
  },

  generateRandomString: (t) => {
    const len = Number(t.attributes?.length ?? 16);
    const nums = String(t.attributes?.includeNumbers ?? "true") === "true";
    const spec = String(t.attributes?.includeSpecialChars ?? "false") === "true";
    return [
      { description: `Generate ${len}-char random string${nums ? " with numbers" : ""}${spec ? " with special chars" : ""}`, input_value: null, expected_output: `<${len}-char random string>`, note: "Uses the 'Cloud Services Deployment Utility' rule. Non-deterministic." },
    ];
  },

  getEndOfString: (t) => {
    const n = Number(t.attributes?.numChars ?? 4);
    return [
      { description: `Return last ${n} characters`, input_value: "Hello World", expected_output: "Hello World".slice(-n) },
      { description: "Input shorter than numChars → whole string returned", input_value: "Hi", expected_output: "Hi", note: `Input has fewer than ${n} chars; whole string is returned.` },
      { description: "Null input → null", input_value: null, expected_output: null },
    ];
  },

  getReferenceIdentityAttribute: (t) => {
    const uid = t.attributes?.uid ?? "manager";
    const attr = t.attributes?.attributeName ?? "email";
    return [
      { description: `Get '${attr}' from referenced identity '${uid}'`, input_value: null, expected_output: `<${attr} of ${uid}>`, note: `Looks up the identity referenced by '${uid}' and returns its '${attr}' attribute.` },
      { description: "Referenced identity not found → null", input_value: null, expected_output: null },
    ];
  },

  rfc5646: (t) => {
    const fmt = t.attributes?.format ?? "alpha2";
    return [
      { description: `Convert locale to RFC5646 (format: ${fmt})`, input_value: "en_US", expected_output: "en-US", note: "Converts underscore locale format to BCP 47 tag." },
      { description: "Null input → null", input_value: null, expected_output: null },
    ];
  },

  reference: (t) => {
    const id = t.attributes?.id ?? "Some Other Transform";
    return [
      { description: `Delegates to transform '${id}'`, input_value: "<any input>", expected_output: "<output of referenced transform>", note: `The referenced transform '${id}' must exist in the tenant.` },
    ];
  },

  base64Encode: () => [
    { description: "Encode plain text", input_value: "hello", expected_output: "aGVsbG8=" },
    { description: "Empty string", input_value: "", expected_output: "" },
    { description: "Null input → null", input_value: null, expected_output: null },
  ],

  base64Decode: () => [
    { description: "Decode base64 string", input_value: "aGVsbG8=", expected_output: "hello" },
    { description: "Invalid base64 → error", input_value: "not!!valid", expected_output: "error" },
    { description: "Null input → null", input_value: null, expected_output: null },
  ],

  join: (t) => {
    const sep = t.attributes?.separator ?? ",";
    return [
      { description: `Join array values with '${sep}'`, input_value: null, expected_output: `val1${sep}val2${sep}val3`, note: "Input is the values array from attributes." },
    ];
  },

  displayName: () => [
    { description: "Returns preferredName if set", input_value: null, expected_output: "<preferredName>", note: "Falls back to givenName if preferredName is null." },
    { description: "preferredName null → returns givenName", input_value: null, expected_output: "<givenName>" },
  ],

  rule: (t) => {
    const rName = t.attributes?.name ?? "My Rule";
    return [
      { description: `Execute custom rule '${rName}'`, input_value: "<input defined by rule>", expected_output: "<rule output>", note: "Rule logic is defined in BeanShell/Java. Test in the ISC rule tester." },
    ];
  },
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function generateTestCases(transformJson: any): TestCaseResult {
  if (!transformJson || typeof transformJson !== "object") {
    throw new Error("transformJson must be a JSON object.");
  }

  const rawType = String(transformJson.type ?? "");
  // Resolve rule-backed ops
  let opType = rawType;
  if (rawType === "rule" && typeof transformJson.attributes?.operation === "string") {
    const rb = ["generateRandomString", "getEndOfString", "getReferenceIdentityAttribute"];
    if (rb.includes(transformJson.attributes.operation)) opType = transformJson.attributes.operation;
  }

  const canonType = toCanonicalType(opType) ?? opType;
  const factory = FACTORIES[canonType] ?? FACTORIES[rawType];

  const cases: TestCase[] = factory
    ? factory(transformJson)
    : [
        {
          description: "Happy path",
          input_value: "<sample input>",
          expected_output: "<expected output>",
          note: `No test template available for type '${canonType}'. Write tests based on the official docs.`,
        },
      ];

  return {
    operation_type: canonType,
    transform_name: String(transformJson.name ?? ""),
    test_cases: cases,
    note:
      "These are illustrative test cases for manual QA in the ISC transform tester. " +
      "Actual results depend on live identity and account data. " +
      "Verify with a real identity that matches each scenario.",
  };
}
