// src/index.ts  —  SailPoint ISC Transforms MCP Server
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │  PHASE 1 — Offline transform authoring (no ISC tenant required)         │
// │  isc.transforms.generate          Requirement → transform JSON           │
// │  isc.transforms.validate          JSON Schema validation (AJV + schemas) │
// │  isc.transforms.lint              Semantic lint (doc-aligned rules)       │
// │  isc.transforms.explain           Explain errors + auto-correct          │
// │  isc.transforms.suggestPattern    Named nested-transform patterns         │
// │  isc.transforms.generateTestCases Illustrative test cases per operation  │
// │  isc.transforms.catalog           List all 44+ operation types           │
// │  isc.transforms.getSchema         Return the JSON Schema for an op type  │
// │  isc.transforms.scaffold          Scaffold a valid starter payload       │
// │  isc.ping                         Health check                           │
// ├─────────────────────────────────────────────────────────────────────────┤
// │  PHASE 2 — Connected publish (requires ISC tenant credentials)           │
// │  isc.transforms.list              GET /v3/transforms                     │
// │  isc.transforms.get               GET /v3/transforms/:id                 │
// │  isc.transforms.upsert            Create / update with dry-run + confirm │
// │  isc.transforms.findReferences    Scan identity profiles for transform   │
// └─────────────────────────────────────────────────────────────────────────┘

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  TRANSFORM_CATALOG,
  listTransformTypes,
  lintTransform,
  toCanonicalType,
  getTransformSpec,
  validateTransform,
  generateTransform,
  suggestPattern,
  listPatterns,
  generateTestCases,
  explainTransformErrors,
  getOperationSchema,
  listSchemaCoverage,
} from "./transforms/index.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { redactDeep } from "./redact.js";
import { getAllowlist } from "./allowlist.js";
import { IScClient } from "./http/iscClient.js";
import { toSafeError } from "./http/errors.js";
import { jsonPatch } from "./util/diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asText(obj: any): string {
  return JSON.stringify(obj, null, 2);
}

const TOOL_STYLE = (process.env.MCP_TOOL_STYLE ?? "flat").toLowerCase();
function tn(name: string): string {
  return TOOL_STYLE === "flat" ? name.replace(/[.]/g, "_") : name;
}

function summarizeLint(lint: {
  messages: Array<{ level: string; message: string; path?: string }>;
}) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  for (const m of lint.messages ?? []) {
    const line = `${m.path ? m.path + ": " : ""}${m.message}`;
    if (m.level === "error") errors.push(line);
    else if (m.level === "warn") warnings.push(line);
    else infos.push(line);
  }
  return { errors, warnings, infos };
}

function jsonPointerEscape(s: string): string {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

function findJsonPointers(
  root: any,
  predicate: (value: any, key?: string) => boolean
): Array<{ path: string; value: any }> {
  const hits: Array<{ path: string; value: any }> = [];
  const walk = (node: any, path: string, key?: string) => {
    if (predicate(node, key)) hits.push({ path, value: node });
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${path}/${i}`, String(i));
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node))
        walk(v, `${path}/${jsonPointerEscape(k)}`, k);
    }
  };
  walk(root, "");
  return hits;
}

function phase2Guard(cfg: { offline: boolean; licenseTier: string }, toolName: string): string | null {
  // Check license tier first — must be enterprise to use Phase 2 tools
  if (cfg.licenseTier !== "enterprise") {
    return (
      `Tool '${toolName}' requires an Enterprise license. ` +
      `Phase 2 tools (list, get, upsert, findReferences) that connect to a live ISC tenant ` +
      `are available on the Enterprise plan. ` +
      `Get your license key at: https://YOUR-STORE-URL (set it as ISC_MCP_LICENSE_KEY). ` +
      `All Phase 1 tools (generate, validate, lint, explain, patterns, test-cases, catalog, schema, scaffold) ` +
      `are free and work fully offline.`
    );
  }
  // License OK — now check ISC credentials
  if (cfg.offline) {
    return (
      `Tool '${toolName}' requires ISC tenant credentials (Phase 2). ` +
      `Set ISC_TENANT + (ISC_PAT_CLIENT_ID & ISC_PAT_CLIENT_SECRET) or ISC_ACCESS_TOKEN ` +
      `in your environment variables, then restart the MCP server.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Server builder — shared between stdio (index.ts) and HTTP (server.ts)
// ---------------------------------------------------------------------------

export async function buildMcpServer(cfg: ReturnType<typeof loadConfig>) {
  const log = createLogger(cfg.debug);
  const isc = new IScClient(cfg);

  const server = new McpServer({
    name: "isc-transforms-mcp",
    version: "1.0.0",
  });

  // =========================================================================
  // PHASE 1 — Offline authoring tools (no ISC credentials needed)
  // =========================================================================

  // ── Health ────────────────────────────────────────────────────────────────

  server.registerTool(
    tn("isc.ping"),
    {
      title: "Ping",
      description: "Basic health check. Returns 'pong' and reports whether the server is running in offline (Phase 1 only) or connected (Phase 1 + 2) mode.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        {
          type: "text",
          text: asText({
            status: "pong",
            license: cfg.licenseTier === "enterprise" ? "Enterprise" : "Personal (Free)",
            phase1_tools: "available",
            phase2_tools: cfg.licenseTier === "enterprise"
              ? (cfg.offline ? "licensed but no ISC credentials set" : "available")
              : "requires Enterprise license — see ISC_MCP_LICENSE_KEY",
            connection: cfg.offline ? "offline (no ISC credentials)" : "connected to ISC tenant",
            server: "isc-transforms-mcp@1.0.0",
          }),
        },
      ],
    })
  );

  // ── 1. Generate transform from plain-English requirement ─────────────────

  server.registerTool(
    tn("isc.transforms.generate"),
    {
      title: "Generate Transform from Requirement",
      description:
        "Converts a plain-English requirement into a SailPoint ISC transform JSON payload. " +
        "Parses the requirement for operation keywords, entity names, date formats, and null-handling hints, " +
        "then selects the best matching operation and builds the JSON. " +
        "Returns the transform JSON, confidence level, alternative operations, a doc URL, " +
        "and a list of <placeholder> fields that need real values before deployment. " +
        "OFFLINE — no ISC tenant required.",
      inputSchema: z.object({
        requirement: z
          .string()
          .min(5)
          .describe(
            "Plain-English description of what the transform should do. " +
            "Examples: 'Generate a unique username using first initial plus last name', " +
            "'Fall back from work email to personal email', " +
            "'Convert a Java epoch timestamp to ISO8601', " +
            "'If department equals Engineering return Building A else Building B'."
          ),
        transform_name: z
          .string()
          .optional()
          .describe("Optional explicit name for the transform. Auto-derived from the requirement if omitted."),
      }),
    },
    async ({ requirement, transform_name }) => {
      try {
        const result = generateTransform(requirement, transform_name);
        return { content: [{ type: "text", text: asText(result) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: asText({ error: e?.message ?? String(e) }) }] };
      }
    }
  );

  // ── 2. Validate transform JSON (AJV + JSON Schema) ────────────────────────

  server.registerTool(
    tn("isc.transforms.validate"),
    {
      title: "Validate Transform JSON",
      description:
        "Validates a transform JSON payload in two stages: " +
        "(1) Against the root index schema (name/type/attributes shape). " +
        "(2) Against the operation-specific JSON Schema from the JSONS/ schema pack. " +
        "Returns a structured result with valid flag, per-error path+message, doc URL, and warnings. " +
        "OFFLINE — no ISC tenant required.",
      inputSchema: z.object({
        transform_json: z
          .union([z.any(), z.string()])
          .describe("The transform JSON object or JSON string to validate."),
      }),
    },
    async ({ transform_json }) => {
      let payload = transform_json;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload.trim()); }
        catch (e: any) {
          return { content: [{ type: "text", text: asText({ valid: false, errors: [{ stage: "parse", message: `Invalid JSON: ${e?.message}` }], warnings: [] }) }] };
        }
      }
      const result = validateTransform(payload);
      return { content: [{ type: "text", text: asText(result) }] };
    }
  );

  // ── 3. Semantic lint (doc-aligned rules) ─────────────────────────────────

  server.registerTool(
    tn("isc.transforms.lint"),
    {
      title: "Lint Transform Semantics",
      description:
        "Runs semantic lint rules that JSON Schema cannot enforce: " +
        "conditional expression operator (eq only), dateMath expression grammar, " +
        "accountAttribute source uniqueness, replace regex validity, " +
        "requiresPeriodicRefresh type, unknown top-level fields, lookup default key, " +
        "and 25+ other doc-aligned checks. " +
        "When strict=true (default), throws on any error so the caller must fix and retry. " +
        "OFFLINE — no ISC tenant required.",
      inputSchema: z.object({
        body: z.union([z.any(), z.string()]).optional(),
        raw: z.string().optional(),
        strict: z.boolean().optional().default(true),
      }),
    },
    async ({ body, raw, strict = true }) => {
      let payload: any = body ?? raw;
      if (typeof payload === "string") {
        const t = (payload as string).trim();
        try { payload = t ? JSON.parse(t) : null; }
        catch (e: any) {
          const msg = `Invalid JSON: ${e?.message}`;
          if (strict) throw new Error(msg);
          return { content: [{ type: "text", text: asText({ ok: false, errors: [msg], warnings: [], infos: [] }) }] };
        }
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        const msg = "Transform must be a JSON object.";
        if (strict) throw new Error(`Lint failed.\n- ${msg}`);
        return { content: [{ type: "text", text: asText({ ok: false, errors: [msg], warnings: [], infos: [] }) }] };
      }
      const res = lintTransform(payload);
      const sum = summarizeLint(res);
      const ok = sum.errors.length === 0;
      if (strict && !ok) throw new Error(`Transform lint failed.\n- ${sum.errors.join("\n- ")}`);
      const out: any = { ok, messages: res.messages, errors: sum.errors, warnings: sum.warnings, infos: sum.infos };
      if (ok) out.normalized = res.normalized;
      return { content: [{ type: "text", text: asText(out) }] };
    }
  );

  // ── 4. Explain errors ────────────────────────────────────────────────────

  server.registerTool(
    tn("isc.transforms.explain"),
    {
      title: "Explain Transform Error",
      description:
        "Validates the transform, translates each schema/lint error into plain-English guidance, " +
        "and attempts to produce a corrected JSON for simple/automatable issues " +
        "(e.g. boolean string coercion, duplicate source reference, delimiter→separator rename, " +
        "missing lookup default key, requiresPeriodicRefresh type). " +
        "OFFLINE — no ISC tenant required.",
      inputSchema: z.object({
        transform_json: z
          .union([z.any(), z.string()])
          .describe("The transform JSON that has errors."),
        error_message: z
          .string()
          .optional()
          .describe("Optional external error or log message from the ISC transform tester."),
      }),
    },
    async ({ transform_json, error_message }) => {
      let payload = transform_json;
      if (typeof payload === "string") {
        try { payload = JSON.parse((payload as string).trim()); }
        catch (e: any) {
          return { content: [{ type: "text", text: asText({ explanation: `Invalid JSON: ${e?.message}`, issues: [], corrected_json: null }) }] };
        }
      }
      const result = explainTransformErrors(payload, error_message);
      return { content: [{ type: "text", text: asText(result) }] };
    }
  );

  // ── 5. Suggest nested-transform pattern ──────────────────────────────────

  server.registerTool(
    tn("isc.transforms.suggestPattern"),
    {
      title: "Suggest Nested Transform Pattern",
      description:
        "Matches a plain-English use-case description against a library of named nested-transform patterns " +
        "and returns the best-matching complete example transform JSON. " +
        "Available patterns: fallback email chain, conditional department→building, " +
        "username first-initial+last-name+uniqueCounter, EPOCH→ISO8601 date, " +
        "normalize+lowercase name, country code→region lookup, email from first.last@domain, " +
        "date compare lifecycle state, E.164 phone normalisation, split domain from email. " +
        "OFFLINE — no ISC tenant required.",
      inputSchema: z.object({
        description: z
          .string()
          .min(5)
          .describe(
            "Plain-English description of the pattern needed. " +
            "Examples: 'fallback from work email to personal email to generated placeholder', " +
            "'normalize first and last name and lowercase for email prefix'."
          ),
      }),
    },
    async ({ description }) => {
      const result = suggestPattern(description);
      return { content: [{ type: "text", text: asText(result) }] };
    }
  );

  // ── 6. Generate test cases ────────────────────────────────────────────────

  server.registerTool(
    tn("isc.transforms.generateTestCases"),
    {
      title: "Generate Test Cases",
      description:
        "Generates 2–5 illustrative test cases for a transform (happy-path, null-input, and edge cases). " +
        "Each test case includes a description, input_value, expected_output, and an optional note. " +
        "Suitable for manual QA in the ISC transform tester or as a reference for automated tests. " +
        "OFFLINE — no ISC tenant required.",
      inputSchema: z.object({
        transform_json: z
          .union([z.any(), z.string()])
          .describe("The transform JSON to generate test cases for."),
      }),
    },
    async ({ transform_json }) => {
      let payload = transform_json;
      if (typeof payload === "string") {
        try { payload = JSON.parse((payload as string).trim()); }
        catch (e: any) {
          return { content: [{ type: "text", text: asText({ error: `Invalid JSON: ${e?.message}` }) }] };
        }
      }
      try {
        const result = generateTestCases(payload);
        return { content: [{ type: "text", text: asText(result) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: asText({ error: e?.message ?? String(e) }) }] };
      }
    }
  );

  // ── 7. Operation catalog ──────────────────────────────────────────────────

  server.registerTool(
    tn("isc.transforms.catalog"),
    {
      title: "List Transform Operations Catalog",
      description:
        "Returns all supported SailPoint ISC transform operation types with: " +
        "type key, human-readable title, required attributes, doc URL, schema coverage flag, and scaffold example. " +
        "OFFLINE — no ISC tenant required.",
      inputSchema: z.object({
        include_scaffold: z.boolean().optional().default(true),
      }),
    },
    async ({ include_scaffold = true }) => {
      const schemaCoverage = Object.fromEntries(
        listSchemaCoverage().map((e) => [e.type, e.hasSchema])
      );
      const items = listTransformTypes().map((t) => {
        const s = TRANSFORM_CATALOG[t];
        return {
          type: s.type,
          title: s.title,
          docUrl: s.docUrl,
          requiredAttributes: s.requiredAttributes ?? [],
          attributesOptional: Boolean(s.attributesOptional),
          hasJsonSchema: Boolean(schemaCoverage[t]),
          scaffoldExample: include_scaffold ? s.scaffold(`EXAMPLE-${t}`) : undefined,
        };
      });
      return { content: [{ type: "text", text: asText({ count: items.length, types: listTransformTypes(), items }) }] };
    }
  );

  // ── 7b. Full operation catalog (all ops + schemas in one call) ───────────

  server.registerTool(
    tn("isc.transforms.operationCatalog"),
    {
      title: "Full Transform Operation Catalog",
      description:
        "Returns EVERYTHING the LLM needs to build any SailPoint ISC transform — all 39 operation types " +
        "in a single response. For each operation: type key, title, required attributes (with types), " +
        "optional attributes, attribute constraints, doc URL, scaffold example, and JSON Schema. " +
        "Call this FIRST before building any transform. Use it to decide which operation(s) to use, " +
        "understand what attributes are required, and see a working scaffold to start from. " +
        "This eliminates the need to call catalog, getSchema, and scaffold separately. " +
        "OFFLINE — no ISC tenant required.",
      inputSchema: z.object({
        operation_types: z
          .array(z.string())
          .optional()
          .describe(
            "Optional list of specific operation types to return (e.g. ['dateCompare','dateMath','conditional']). " +
            "Omit to return all 39 operations."
          ),
      }),
    },
    async ({ operation_types }) => {
      const allTypes = listTransformTypes();
      const requested: Array<keyof typeof TRANSFORM_CATALOG> =
        operation_types && operation_types.length > 0
          ? (operation_types
              .map((t) => toCanonicalType(t) ?? t)
              .filter((t) => (allTypes as string[]).includes(t)) as Array<keyof typeof TRANSFORM_CATALOG>)
          : allTypes;

      const items = requested.map((t) => {
        const s = TRANSFORM_CATALOG[t];
        const schema = getOperationSchema(t as string);
        return {
          type: s.type,
          title: s.title,
          doc_url: s.docUrl,
          required_attributes: s.requiredAttributes ?? [],
          attributes_optional: Boolean(s.attributesOptional),
          is_rule_backed: Boolean(s.injectedAttributes),
          scaffold: s.scaffold(`my-${t}-transform`),
          json_schema: schema ?? null,
        };
      });

      return {
        content: [{
          type: "text",
          text: asText({
            instruction:
              "Use this catalog to select the right operation type(s) for the requirement. " +
              "Check required_attributes to know what you must supply. " +
              "Use scaffold as your starting JSON shape. " +
              "Validate and lint the result after building.",
            total_operations: items.length,
            operations: items,
          }),
        }],
      };
    }
  );

  // ── 8. Get JSON Schema for an operation ──────────────────────────────────

  server.registerTool(
    tn("isc.transforms.getSchema"),
    {
      title: "Get Operation JSON Schema",
      description:
        "Returns the full JSON Schema (Draft 2020-12) for a specific SailPoint ISC transform operation type. " +
        "The schema shows exactly which attributes are required, optional, and what their types/constraints are, " +
        "including nested-transform shapes. " +
        "OFFLINE — no ISC tenant required.",
      inputSchema: z.object({
        operation_type: z
          .string()
          .min(1)
          .describe("The operation type string, e.g. 'conditional', 'dateFormat', 'usernameGenerator', 'accountAttribute'."),
      }),
    },
    async ({ operation_type }) => {
      const canon = toCanonicalType(operation_type) ?? operation_type;
      const schema = getOperationSchema(canon);
      if (!schema) {
        const types = listTransformTypes().join(", ");
        return {
          content: [{
            type: "text",
            text: asText({ error: `No schema found for type '${operation_type}'. Available types: ${types}` }),
          }],
        };
      }
      return { content: [{ type: "text", text: asText(schema) }] };
    }
  );

  // ── 9. Scaffold ───────────────────────────────────────────────────────────

  server.registerTool(
    tn("isc.transforms.scaffold"),
    {
      title: "Scaffold Transform",
      description:
        "Generates a valid minimal starter JSON payload for a given transform operation type. " +
        "OFFLINE — no ISC tenant required.",
      inputSchema: z.object({
        type: z.string().min(1),
        name: z.string().min(1).optional(),
      }),
    },
    async ({ type, name }) => {
      const canon = toCanonicalType(String(type));
      const spec = canon ? getTransformSpec(canon) : undefined;
      if (!canon || !spec) {
        return {
          content: [{
            type: "text",
            text: asText({ error: `Unknown type '${type}'. Run isc.transforms.catalog to see all valid types.` }),
          }],
        };
      }
      return { content: [{ type: "text", text: asText(spec.scaffold(name ?? `TF-${canon}`)) }] };
    }
  );

  // =========================================================================
  // PHASE 2 — Connected (ISC tenant credentials required)
  // =========================================================================

  // ── 10. List transforms ───────────────────────────────────────────────────

  server.registerTool(
    tn("isc.transforms.list"),
    {
      title: "List Transforms (ISC)",
      description:
        "GET /v3/transforms — fetches all transform objects from the connected ISC tenant. " +
        "REQUIRES ISC credentials (ISC_TENANT + ISC_PAT_CLIENT_ID / ISC_PAT_CLIENT_SECRET or ISC_ACCESS_TOKEN).",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(250).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    },
    async ({ limit, offset }) => {
      const guard = phase2Guard(cfg, "isc.transforms.list");
      if (guard) return { content: [{ type: "text", text: asText({ error: guard }) }] };
      try {
        const qs = new URLSearchParams();
        if (limit !== undefined) qs.set("limit", String(limit));
        if (offset !== undefined) qs.set("offset", String(offset));
        const path = qs.toString() ? `/transforms?${qs}` : "/transforms";
        const res = await isc.request<any>("GET", path);
        return { content: [{ type: "text", text: asText(redactDeep(res)) }] };
      } catch (e) {
        return { content: [{ type: "text", text: asText({ error: redactDeep(toSafeError(e)) }) }] };
      }
    }
  );

  // ── 11. Get transform ─────────────────────────────────────────────────────

  server.registerTool(
    tn("isc.transforms.get"),
    {
      title: "Get Transform (ISC)",
      description:
        "GET /v3/transforms/:id — fetches a single transform by ID from the connected ISC tenant. " +
        "REQUIRES ISC credentials.",
      inputSchema: z.object({ id: z.string().min(1) }),
    },
    async ({ id }) => {
      const guard = phase2Guard(cfg, "isc.transforms.get");
      if (guard) return { content: [{ type: "text", text: asText({ error: guard }) }] };
      try {
        const res = await isc.request<any>("GET", `/transforms/${encodeURIComponent(id)}`);
        return { content: [{ type: "text", text: asText(redactDeep(res)) }] };
      } catch (e) {
        return { content: [{ type: "text", text: asText({ error: redactDeep(toSafeError(e)) }) }] };
      }
    }
  );

  // ── 12. Upsert transform ──────────────────────────────────────────────────

  server.registerTool(
    tn("isc.transforms.upsert"),
    {
      title: "Upsert Transform (ISC, Safe)",
      description:
        "Create or update a transform in the connected ISC tenant with dryRun + JSON-Patch diff + confirm-to-apply guardrails. " +
        "Runs normalize + validate + lint before any write. " +
        "dryRun=true (default) shows the planned change without applying it. " +
        "Set confirm='APPLY_TRANSFORM_CREATE:<name>' or 'APPLY_TRANSFORM_UPDATE:<name>' to apply. " +
        "REQUIRES ISC credentials. ISC_MCP_MODE=write required to apply changes.",
      inputSchema: z.object({
        id: z.string().min(1).optional().describe("Existing transform ID → update. Omit → create."),
        body: z.union([z.any(), z.string()]).describe("Transform payload JSON."),
        dryRun: z.boolean().optional().default(true),
        confirm: z.string().optional(),
        reason: z.string().optional(),
        traceId: z.string().optional(),
      }),
    },
    async ({ id, body, dryRun = true, confirm, reason, traceId }) => {
      const guard = phase2Guard(cfg, "isc.transforms.upsert");
      if (guard) return { content: [{ type: "text", text: asText({ error: guard }) }] };

      try {
        const isUpdate = Boolean(id);
        const mode = cfg.mode;

        if (typeof body === "string") {
          try { body = JSON.parse((body as string).trim()); }
          catch (e: any) { throw new Error(`body must be valid JSON: ${e?.message}`); }
        }
        if (!body || typeof body !== "object") throw new Error("body must be a JSON object.");

        // Stage 1: schema validation
        const schemaResult = validateTransform(body);
        if (!schemaResult.valid) {
          const errList = schemaResult.errors.map((e) => `[${e.stage}] ${e.path ?? ""}: ${e.message}`).join("\n- ");
          throw new Error(`Schema validation failed:\n- ${errList}`);
        }

        // Stage 2: semantic lint
        const lintResult = lintTransform(body);
        const lintErrors = lintResult.messages.filter((m) => m.level === "error");
        if (lintErrors.length) {
          const errList = lintErrors.map((m) => `${m.path ? m.path + ": " : ""}${m.message}`).join("\n- ");
          throw new Error(`Semantic lint failed:\n- ${errList}`);
        }
        const lintWarnings = lintResult.messages.filter((m) => m.level === "warn");

        if (isUpdate) {
          const transformId = id!;
          const before = await isc.request<any>("GET", `/transforms/${encodeURIComponent(transformId)}`);
          if (body?.name && body.name !== before?.name) throw new Error(`Update blocked: 'name' is immutable.`);
          if (body?.type && body.type !== before?.type) throw new Error(`Update blocked: 'type' is immutable.`);
          const nextAttributes = body?.attributes ?? before?.attributes;
          const after = { ...before, attributes: nextAttributes };
          const diff = jsonPatch(before, after);
          const expectedConfirm = `APPLY_TRANSFORM_UPDATE:${before?.name ?? transformId}`;
          if (dryRun) {
            return { content: [{ type: "text", text: asText(redactDeep({ traceId, dryRun: true, expectedConfirm, reason, lint: { warnings: lintWarnings }, diff })) }] };
          }
          if (mode !== "write") throw new Error("Server is readonly. Set ISC_MCP_MODE=write.");
          if ((confirm ?? "").trim() !== expectedConfirm) throw new Error(`Confirm mismatch. Expected: "${expectedConfirm}".`);
          const res = await isc.request<any>("PUT", `/transforms/${encodeURIComponent(transformId)}`, { attributes: nextAttributes });
          return { content: [{ type: "text", text: asText(redactDeep({ traceId, applied: true, expectedConfirm, result: res })) }] };
        }

        if (!body?.name) throw new Error("Create requires body.name.");
        if (!body?.type) throw new Error("Create requires body.type.");
        const createBody = { internal: body.internal ?? false, ...lintResult.normalized };
        const diff = jsonPatch(null, createBody);
        const expectedConfirm = `APPLY_TRANSFORM_CREATE:${createBody?.name}`;
        if (dryRun) {
          return { content: [{ type: "text", text: asText(redactDeep({ traceId, dryRun: true, expectedConfirm, reason, lint: { warnings: lintWarnings }, diff, bodyPreview: createBody })) }] };
        }
        if (mode !== "write") throw new Error("Server is readonly. Set ISC_MCP_MODE=write.");
        if ((confirm ?? "").trim() !== expectedConfirm) throw new Error(`Confirm mismatch. Expected: "${expectedConfirm}".`);
        const res = await isc.request<any>("POST", "/transforms", createBody);
        return { content: [{ type: "text", text: asText(redactDeep({ traceId, applied: true, expectedConfirm, result: res })) }] };

      } catch (e) {
        return { content: [{ type: "text", text: asText({ error: redactDeep(toSafeError(e)) }) }] };
      }
    }
  );

  // ── 13. Find transform references ────────────────────────────────────────

  server.registerTool(
    tn("isc.transforms.findReferences"),
    {
      title: "Find Transform References (ISC)",
      description:
        "Scans identity profiles in the connected ISC tenant for references to a transform ID or name. " +
        "Returns JSON-pointer paths where the transform appears, grouped by identity profile. " +
        "REQUIRES ISC credentials.",
      inputSchema: z.object({
        transformId: z.string().min(1).optional(),
        transformName: z.string().min(1).optional(),
        identityProfileIds: z.array(z.string().min(1)).optional(),
        maxProfiles: z.number().int().min(1).max(500).optional().default(200),
        includeSnippets: z.boolean().optional().default(true),
        traceId: z.string().optional(),
      }),
    },
    async ({ transformId, transformName, identityProfileIds, maxProfiles = 200, includeSnippets = true, traceId }) => {
      const guard = phase2Guard(cfg, "isc.transforms.findReferences");
      if (guard) return { content: [{ type: "text", text: asText({ error: guard }) }] };
      try {
        if (!transformId && !transformName) throw new Error("Provide transformId and/or transformName.");
        const targets = [transformId, transformName].filter(Boolean).map(String);
        const ids: string[] = [];
        if (identityProfileIds?.length) {
          ids.push(...identityProfileIds);
        } else {
          let offset = 0;
          while (ids.length < maxProfiles) {
            const page = await isc.request<any>("GET", `/identity-profiles?limit=250&offset=${offset}`);
            const items: any[] = Array.isArray(page) ? page : page?.items ?? [];
            if (!items.length) break;
            for (const it of items) { if (it?.id) ids.push(String(it.id)); if (ids.length >= maxProfiles) break; }
            offset += 250;
          }
        }
        const results: any[] = [];
        for (const pid of ids) {
          const profile = await isc.request<any>("GET", `/identity-profiles/${encodeURIComponent(pid)}`);
          const hits = findJsonPointers(profile, (v, k) => {
            if (typeof v !== "string") return false;
            if (!targets.includes(v)) return false;
            const kk = String(k ?? "").toLowerCase();
            return kk.includes("transform") || kk.includes("mapping") || kk.endsWith("id");
          });
          if (hits.length) {
            results.push({
              identityProfile: { id: profile?.id ?? pid, name: profile?.name },
              matchCount: hits.length,
              matches: hits.map((h) => ({ path: h.path, ...(includeSnippets ? { value: String(h.value).slice(0, 120) } : {}) })),
            });
          }
        }
        return { content: [{ type: "text", text: asText(redactDeep({ traceId, scanned: ids.length, targets, found: results.length, results })) }] };
      } catch (e) {
        return { content: [{ type: "text", text: asText({ error: redactDeep(toSafeError(e)) }) }] };
      }
    }
  );

  // =========================================================================
  // Start
  // =========================================================================

  log.debug(
    `isc-transforms-mcp built — ${cfg.offline ? "OFFLINE (Phase 1 only)" : "CONNECTED (Phase 1 + 2)"}, ` +
    `license: ${cfg.licenseTier}`
  );
  return server;
}

// ---------------------------------------------------------------------------
// Stdio entry point (local Claude Desktop)
// ---------------------------------------------------------------------------

async function main() {
  const cfg = loadConfig();
  const server = await buildMcpServer(cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
