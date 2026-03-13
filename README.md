# isc-transforms-mcp

> **SailPoint ISC transform authoring, right inside Claude.**
> Catalog · Build · Lint · Validate · Explain — without leaving your AI assistant.

[![npm version](https://img.shields.io/npm/v/isc-transforms-mcp)](https://www.npmjs.com/package/isc-transforms-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP compatible](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

---

## What is this?

`isc-transforms-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude a complete SailPoint ISC transform authoring toolkit. Instead of handwriting transform JSON, debugging schema errors in the UI, and cross-referencing the docs manually — you describe what you need in plain English and Claude does the rest.

**Free (Personal)** — 11 offline tools. No ISC tenant needed. Works entirely on your laptop.
**Enterprise (coming soon)** — All 15 tools, including live tenant operations (list, get, find references). See [Enterprise Plan](#-enterprise-plan).

---

## How to Use — Recommended Prompt Pattern

For best results, always ask Claude to follow this workflow: **catalog → build → lint until clean → output JSON**.

The magic phrase to use:

```
Use MCP tools only. [describe your transform requirement].
Start with isc_transforms_operationCatalog, then build the transform,
lint it until there are no errors, and give me the final JSON.
```

Claude will then:
1. Call `isc_transforms_operationCatalog` to get exact attribute specs for the operations it needs
2. Build the transform JSON from scratch using those specs
3. Call `isc_transforms_lint` repeatedly, fixing any errors each round
4. Return the final clean JSON once lint passes with 0 errors and 0 warnings

---

## Real-World Prompt Examples

### Lifecycle State from Start/End Dates

```
Use MCP tools only. Create a transform to calculate cloudLifecycleState based on:
- startDate > today → prehire
- startDate ≤ today AND endDate ≥ today AND employeeStatus = LEAVE → leave
- startDate ≤ today AND endDate ≥ today AND employeeStatus = ACTIVE → active
- endDate < today AND endDate ≥ today-30 → inactive
- endDate < today-30 → archived

Inputs from source SimplifyAuth-HRMS:
  startDate (attribute: startDate, format: dd-MM-yyyy)
  endDate   (attribute: endDate,   format: dd-MM-yyyy)
  status    (attribute: employeeStatus)

Start with isc_transforms_operationCatalog, lint until no errors, give me the JSON.
```

### Temporary Password from Account Attributes

```
Use MCP tools only. Build a static transform named Temporary-Password that produces:
  ${firstInitialLower}${lastNameProper}${hireMonth}RstP*!7

Where:
  firstInitialLower = lowercase first character of first_name (source: HRMS)
  lastNameProper    = uppercase first char + rest of last_name (source: HRMS)
  hireMonth         = 2-digit month from hire_date (format: yyyy-MM-dd, source: HRMS)

Start with isc_transforms_operationCatalog, lint until no errors, give me the JSON.
```

### Username with Uniqueness Counter

```
Use MCP tools only. Create a username transform:
  first initial + last name, all lowercase, max 20 chars.
  If taken, append a number (uniqueCounter).
  Source: Workday HR, attributes: firstName and lastName.

Start with isc_transforms_operationCatalog, lint until no errors, give me the JSON.
```

### Email from Name Attributes

```
Use MCP tools only. Build a transform that generates an email address as:
  firstname.lastname@acme.com
  Normalize both names (remove diacritics, lowercase) before concatenating.
  Source: Active Directory, attributes: givenName and sn.

Start with isc_transforms_operationCatalog, lint until no errors, give me the JSON.
```

### Fallback Chain

```
Use MCP tools only. Build a transform that returns the first non-empty value from:
  1. workEmail (source: HR System)
  2. personalEmail (source: HR System)
  3. static fallback: noemail@acme.com

Start with isc_transforms_operationCatalog, lint until no errors, give me the JSON.
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
"Use MCP tools only. Build a transform that lowercases the first name from Workday.
 Start with isc_transforms_operationCatalog, lint until no errors, give me the JSON."
```

---

## Free Tools (Phase 1 — No ISC Tenant Required)

All 11 tools below work completely offline. No credentials, no tenant, no internet connection needed.

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
