# isc-transforms-mcp

> **SailPoint ISC transform authoring, right inside Claude.**
> Catalog · Build · Lint · Validate · Explain — without leaving your AI assistant.

[![npm version](https://img.shields.io/npm/v/isc-transforms-mcp)](https://www.npmjs.com/package/isc-transforms-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP compatible](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

> **Community Project** — This is an independent, community-built tool. It is not affiliated with, endorsed by, or supported by SailPoint Technologies.

---

## What is this?

`isc-transforms-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude a complete SailPoint ISC transform authoring toolkit. Instead of handwriting transform JSON, debugging schema errors in the UI, and cross-referencing the docs manually — you describe what you need in plain English and Claude does the rest.

**Free (Personal)** — 11 tools. No ISC tenant needed. Works entirely on your laptop.
**Enterprise (coming soon)** — All 15 tools, including live tenant operations (list, get, find references). See [Enterprise Plan](#-enterprise-plan).

> **Note on "no tenant needed":** The MCP server itself runs as a local Node.js process on your machine — it makes no calls to any ISC tenant for the free tools. Your transform JSON is validated and linted entirely locally. Claude (the AI) is a cloud service provided by Anthropic, so your conversation — including any transform JSON you share — passes through Anthropic's infrastructure as part of normal Claude usage, the same as any other Claude session.

---

## How to Use — Strict Prompt Pattern

Copy and adapt this exact structure. The explicit step numbering and the **DO NOT** rules are what keep Claude on track.

```
Use MCP tools only. Follow these steps exactly and do not skip any:

Step 1 — Call isc_transforms_operationCatalog to retrieve the full spec for every
operation type you plan to use. Do not build anything yet.

Step 2 — Build the complete transform JSON using only the attribute names, types,
and structure from the catalog response in Step 1.

Step 3 — Call isc_transforms_lint on the JSON you built.
  - If lint returns errors or warnings, fix every one of them and call
    isc_transforms_lint again.
  - Repeat until isc_transforms_lint returns ok: true with 0 errors and 0 warnings.
  - DO NOT output the final JSON until lint passes completely.

Step 4 — Output the final lint-clean JSON and nothing else.

[describe your transform requirement here]
```

---

## Real-World Prompt Examples

### Lifecycle State from Start/End Dates

```
Use MCP tools only. Follow these steps exactly and do not skip any:

Step 1 — Call isc_transforms_operationCatalog to retrieve the full spec for every
operation type you plan to use. Do not build anything yet.

Step 2 — Build the complete transform JSON using only the attribute names, types,
and structure from the catalog response in Step 1.

Step 3 — Call isc_transforms_lint on the JSON you built.
  - If lint returns errors or warnings, fix every one of them and call
    isc_transforms_lint again.
  - Repeat until isc_transforms_lint returns ok: true with 0 errors and 0 warnings.
  - DO NOT output the final JSON until lint passes completely.

Step 4 — Output the final lint-clean JSON and nothing else.

Transform requirement:
Create a transform named cloudLifecycleState with requiresPeriodicRefresh: true.
Logic:
  - startDate > today → prehire
  - startDate ≤ today AND endDate ≥ today AND employeeStatus = LEAVE → leave
  - startDate ≤ today AND endDate ≥ today AND employeeStatus = ACTIVE → active
  - endDate < today AND endDate ≥ today-30 → inactive
  - endDate < today-30 → archived
Inputs (source: SimplifyAuth-HRMS):
  - startDate   attribute: startDate,       format: dd-MM-yyyy
  - endDate     attribute: endDate,         format: dd-MM-yyyy
  - leaveStatus attribute: employeeStatus
```

### Temporary Password from Account Attributes

```
Use MCP tools only. Follow these steps exactly and do not skip any:

Step 1 — Call isc_transforms_operationCatalog to retrieve the full spec for every
operation type you plan to use. Do not build anything yet.

Step 2 — Build the complete transform JSON using only the attribute names, types,
and structure from the catalog response in Step 1.

Step 3 — Call isc_transforms_lint on the JSON you built.
  - If lint returns errors or warnings, fix every one of them and call
    isc_transforms_lint again.
  - Repeat until isc_transforms_lint returns ok: true with 0 errors and 0 warnings.
  - DO NOT output the final JSON until lint passes completely.

Step 4 — Output the final lint-clean JSON and nothing else.

Transform requirement:
Build a static transform named Temporary-Password that produces:
  ${firstInitialLower}${lastNameProper}${hireMonth}RstP*!7
Variables (source: HRMS):
  - firstInitialLower = lowercase first character of first_name
  - lastNameProper    = uppercase first char of last_name + remaining chars of last_name
  - hireMonth         = 2-digit month extracted from hire_date (input format: yyyy-MM-dd)
```

### Username with Uniqueness Counter

```
Use MCP tools only. Follow these steps exactly and do not skip any:

Step 1 — Call isc_transforms_operationCatalog to retrieve the full spec for every
operation type you plan to use. Do not build anything yet.

Step 2 — Build the complete transform JSON using only the attribute names, types,
and structure from the catalog response in Step 1.

Step 3 — Call isc_transforms_lint on the JSON you built.
  - If lint returns errors or warnings, fix every one of them and call
    isc_transforms_lint again.
  - Repeat until isc_transforms_lint returns ok: true with 0 errors and 0 warnings.
  - DO NOT output the final JSON until lint passes completely.

Step 4 — Output the final lint-clean JSON and nothing else.

Transform requirement:
Create a username transform named username-generator.
  - Pattern: first initial + last name, all lowercase, max 20 chars
  - If the username is already taken, append a uniqueCounter
  - Source: Workday HR, attributes: firstName and lastName
```

### Email from Name Attributes

```
Use MCP tools only. Follow these steps exactly and do not skip any:

Step 1 — Call isc_transforms_operationCatalog to retrieve the full spec for every
operation type you plan to use. Do not build anything yet.

Step 2 — Build the complete transform JSON using only the attribute names, types,
and structure from the catalog response in Step 1.

Step 3 — Call isc_transforms_lint on the JSON you built.
  - If lint returns errors or warnings, fix every one of them and call
    isc_transforms_lint again.
  - Repeat until isc_transforms_lint returns ok: true with 0 errors and 0 warnings.
  - DO NOT output the final JSON until lint passes completely.

Step 4 — Output the final lint-clean JSON and nothing else.

Transform requirement:
Build a transform named email-generator that produces: firstname.lastname@acme.com
  - Normalize both names (remove diacritics, lowercase) before concatenating
  - Source: Active Directory, attributes: givenName and sn
```

### Fallback Chain

```
Use MCP tools only. Follow these steps exactly and do not skip any:

Step 1 — Call isc_transforms_operationCatalog to retrieve the full spec for every
operation type you plan to use. Do not build anything yet.

Step 2 — Build the complete transform JSON using only the attribute names, types,
and structure from the catalog response in Step 1.

Step 3 — Call isc_transforms_lint on the JSON you built.
  - If lint returns errors or warnings, fix every one of them and call
    isc_transforms_lint again.
  - Repeat until isc_transforms_lint returns ok: true with 0 errors and 0 warnings.
  - DO NOT output the final JSON until lint passes completely.

Step 4 — Output the final lint-clean JSON and nothing else.

Transform requirement:
Build a transform named email-fallback that returns the first non-empty value from:
  1. workEmail (source: HR System)
  2. personalEmail (source: HR System)
  3. Static fallback: noemail@acme.com
```

---

## Quick Start

### 1. Install

```bash
npm install -g isc-transforms-mcp
# or use without installing:
# npx isc-transforms-mcp
```

### 2. Add to Claude Desktop

Open `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).

```json
{
  "mcpServers": {
    "isc-transforms": {
      "command": "npx",
      "args": ["isc-transforms-mcp"]
    }
  }
}
```

> If you installed globally, you can also point directly to the binary:
> `"command": "isc-transforms-mcp"`

### 3. Restart Claude Desktop

Look for the 🔨 hammer icon at the bottom of the chat input — that confirms the tools loaded.

### 4. Try it

```
"Use isc_ping to check the server"
```

```
Use MCP tools only. Follow these steps exactly and do not skip any:
Step 1 — Call isc_transforms_operationCatalog for the operations you need. Do not build yet.
Step 2 — Build the transform JSON using only specs from Step 1.
Step 3 — Call isc_transforms_lint. Fix all errors and repeat until ok: true, 0 errors, 0 warnings.
         DO NOT output JSON until lint passes completely.
Step 4 — Output the final lint-clean JSON and nothing else.

Transform requirement: Build a transform that lowercases the first name from Workday HR
(source: Workday, attribute: firstName). Name it lowercase-firstname.
```

---

## Free Tools (Phase 1 — No ISC Tenant Required)

All 11 tools below run locally on your machine with no ISC tenant connection required. No ISC credentials needed.

### `isc_transforms_operationCatalog`
**Start here when building any transform.** Returns everything needed in a single call — all 39 operation types with type key, title, doc URL, required attributes, scaffold JSON, and full JSON Schema. Optionally filter to specific operation types to keep the response focused.

```
"Show me the full spec for dateCompare and dateMath"
"What attributes does accountAttribute require?"
"Give me the scaffold for a conditional transform"
```

### `isc_transforms_lint`
27 semantic lint rules that go beyond what JSON Schema can check. Catches issues like wrong case on nested transform types (`datemath` vs `dateMath`), multiple source references on `accountAttribute`, using `delimiter` instead of `separator` on `join`, invalid regex patterns, `requiresPeriodicRefresh` as a string instead of boolean, missing `default` key on `lookup`, and more. Always run this after building — fix all errors before treating the JSON as final.

### `isc_transforms_validate`
Two-stage JSON Schema validation powered by AJV and the official SailPoint JSON Schema pack. Stage 1 validates the root shape (name, type, attributes). Stage 2 validates against the operation-specific schema for all 39 operation types, including attribute requirements, allowed values, and nested transform shapes.

### `isc_transforms_explain`
Takes a broken transform (or an ISC error message) and returns plain-English guidance plus an auto-corrected JSON where the fix is automatable. Handles 13 known error patterns including boolean coercion, deprecated attribute names, conditional operator restrictions, and missing required fields.

### `isc_transforms_generate`
Converts a plain-English requirement into a SailPoint ISC transform JSON payload. Returns the transform JSON, confidence level, alternative operations, and a link to the official SailPoint docs. Best used as a quick starting point — always follow up with `isc_transforms_operationCatalog` and `isc_transforms_lint`.

```
"Generate a transform that converts an EPOCH timestamp to ISO8601 date format"
"Create a username transform using first initial plus last name with a uniqueness counter"
```

### `isc_transforms_suggestPattern`
Matches your description against 10 named nested-transform patterns and returns a complete working example. Patterns include: fallback email chain, conditional department → building code, username first-initial + last-name + uniqueCounter, EPOCH → ISO8601, normalize + lowercase name, country code → region lookup, email from first.last@domain, date compare for lifecycle state, E.164 phone normalisation, and split to extract domain from email.

### `isc_transforms_generateTestCases`
Generates 2–5 illustrative test cases for a transform: happy-path, null input, and edge cases. Each test case includes a description, sample input, expected output, and notes. Use these directly in the ISC transform tester.

### `isc_transforms_catalog`
Returns all 39 supported SailPoint ISC transform operation types with: type key, human-readable title, required attributes, doc URL, schema coverage flag, and scaffold example. Use `isc_transforms_operationCatalog` instead when you need full specs — this is the lightweight index.

### `isc_transforms_getSchema`
Returns the full JSON Schema (Draft 2020-12) for any single operation type. Useful when you want to inspect exactly which attributes are required, optional, and what their constraints are.

### `isc_transforms_scaffold`
Generates a valid minimal starter JSON payload for any operation type. Good starting point before filling in actual values.

### `isc_ping`
Health check. Returns the server status, active license tier, and whether Phase 2 tools are available.

---

## Enterprise Plan

The 4 tools below connect to a live ISC tenant and require an **Enterprise license key**.

| Tool | What it does |
|---|---|
| `isc_transforms_list` | `GET /v3/transforms` — fetch all transforms from your tenant |
| `isc_transforms_get` | `GET /v3/transforms/:id` — fetch a single transform by ID |
| `isc_transforms_upsert` | Create or update with dry-run preview + JSON-Patch diff + lint before write |
| `isc_transforms_findReferences` | Scan identity profiles for every place a transform is referenced |

**Enterprise plan coming soon** — [join the waitlist](https://docs.google.com/forms/d/e/1FAIpQLScrSaxD8sev0NuX0t5RXo5B9M0qIz8FQW5Wps2WJAF7fqbs4w/viewform) to be notified when it launches.

Once you have a license key, add it to your Claude Desktop config:

```json
{
  "mcpServers": {
    "isc-transforms": {
      "command": "npx",
      "args": ["isc-transforms-mcp"],
      "env": {
        "ISC_MCP_LICENSE_KEY": "ISC-XXXX-XXXX-XXXX-XXXX",
        "ISC_TENANT": "your-tenant.identitynow.com",
        "ISC_PAT_CLIENT_ID": "your-client-id",
        "ISC_PAT_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

### Hosted (Remote) Mode

Enterprise customers can also point Claude Desktop directly at the hosted server — no local install required:

```json
{
  "mcpServers": {
    "isc-transforms": {
      "url": "https://YOUR-DOMAIN.COM/mcp",
      "headers": {
        "Authorization": "Bearer ISC-XXXX-XXXX-XXXX-XXXX"
      }
    }
  }
}
```

---

## Configuration Reference

All settings are optional for Personal use. Enterprise users need the `ISC_*` credentials for Phase 2 tools.

| Variable | Default | Description |
|---|---|---|
| `ISC_MCP_LICENSE_KEY` | — | Enterprise license key. Format: `ISC-XXXX-XXXX-XXXX-XXXX` |
| `ISC_TENANT` | — | Your tenant name. Expands to `https://{tenant}.api.identitynow.com` |
| `ISC_API_BASE_URL` | — | Explicit API base URL (alternative to `ISC_TENANT`) |
| `ISC_PAT_CLIENT_ID` | — | PAT client ID for authentication |
| `ISC_PAT_CLIENT_SECRET` | — | PAT client secret for authentication |
| `ISC_ACCESS_TOKEN` | — | Pre-minted bearer token (alternative to PAT) |
| `ISC_MCP_DEBUG` | `false` | Enable verbose debug logging to stderr |
| `ISC_TIMEOUT_MS` | `30000` | HTTP request timeout in milliseconds |

---

## Supported Operations

All 39 SailPoint ISC transform operation types are fully supported for generation, validation, and linting:

`accountAttribute` · `base64Decode` · `base64Encode` · `concat` · `conditional` · `dateCompare` · `dateFormat` · `dateMath` · `decomposeDiacriticalMarks` · `displayName` · `e164phone` · `firstValid` · `generateRandomString`\* · `getEndOfString`\* · `getReferenceIdentityAttribute`\* · `identityAttribute` · `indexOf` · `iso3166` · `join` · `lastIndexOf` · `leftPad` · `lookup` · `lower` · `normalizeNames` · `randomAlphaNumeric` · `randomNumeric` · `reference` · `replace` · `replaceAll` · `rfc5646` · `rightPad` · `rule` · `split` · `static` · `substring` · `trim` · `upper` · `usernameGenerator` · `uuid`

\* Rule-backed operations (executed via the Cloud Services Deployment Utility).

---

## Running from Source

```bash
git clone https://github.com/simplifyauth/isc-transforms-mcp.git
cd isc-transforms-mcp
npm install
npm run build
npm start        # stdio mode (Claude Desktop)
npm run serve    # HTTP mode (hosted/remote)
```

---

## License

MIT — free to use, modify, and distribute.
Commercial hosting and enterprise features require a license key. See [Enterprise Plan](#-enterprise-plan).
