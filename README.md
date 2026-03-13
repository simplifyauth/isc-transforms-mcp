# isc-transforms-mcp

> **SailPoint ISC transform authoring, right inside Claude.**
> Generate · Validate · Lint · Explain · Push to tenant — without leaving your AI assistant.

[![npm version](https://img.shields.io/npm/v/isc-transforms-mcp)](https://www.npmjs.com/package/isc-transforms-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP compatible](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

---

## What is this?

`isc-transforms-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude a complete SailPoint ISC transform authoring toolkit. Instead of handwriting transform JSON, debugging schema errors in the UI, and cross-referencing the docs manually — you describe what you need in plain English and Claude does the rest.

**Free (Personal)** — 10 offline tools. No ISC tenant needed. Works entirely on your laptop.
**Enterprise (coming soon)** — All 14 tools, including live tenant operations (list, get, push, find references). See [Enterprise Plan](#-enterprise-plan).

---

## Demo

```
You: Generate a SailPoint transform that concatenates first name, a dot, and last name
     to produce an email prefix. Then validate and lint it.

Claude: [calls isc_transforms_generate]
        → { "type": "concat", "name": "email-prefix", "attributes": { "values": [ ... ] } }
        Confidence: high | Doc: https://developer.sailpoint.com/...

        [calls isc_transforms_validate]
        → valid: true

        [calls isc_transforms_lint]
        → ok: true | 0 errors | 0 warnings
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
"Generate a SailPoint transform that falls back from work email to personal email"
"Validate this transform JSON: { ... }"
"What SailPoint transform pattern should I use for username generation?"
```

---

## Free Tools (Phase 1 — No ISC Tenant Required)

All 10 tools below work completely offline. No credentials, no tenant, no internet connection needed.

### `isc_transforms_generate`
Converts a plain-English requirement into a SailPoint ISC transform JSON payload. Parses your description for operation keywords, attribute names, date formats, and fallback hints. Returns the transform JSON, confidence level, alternative operations, and a link to the official SailPoint docs for that operation type.

```
"Generate a transform that converts an EPOCH timestamp to ISO8601 date format"
"Create a username transform using first initial plus last name with a uniqueness counter"
"Fall back from department to costCenter if department is empty"
```

### `isc_transforms_validate`
Two-stage JSON Schema validation powered by AJV and the official SailPoint JSON Schema pack. Stage 1 validates the root shape (name, type, attributes). Stage 2 validates against the operation-specific schema for all 44 operation types, including attribute requirements, allowed values, and nested transform shapes.

### `isc_transforms_lint`
27 semantic lint rules that go beyond what JSON Schema can check. Catches issues like multiple source references on `accountAttribute`, using `delimiter` instead of `separator` on `join`, invalid regex patterns, `requiresPeriodicRefresh` set as a string instead of boolean, missing `default` keys on `lookup` transforms, and 22 more. Errors include the doc URL for the affected operation so you know exactly what to fix.

### `isc_transforms_explain`
Takes a broken transform (or an ISC error message) and returns plain-English guidance plus an auto-corrected JSON where the fix is automatable. Handles 13 known error patterns including boolean coercion, deprecated attribute names, conditional operator restrictions, and missing required fields.

### `isc_transforms_suggestPattern`
Matches your description against 10 named nested-transform patterns and returns a complete working example. Patterns include: fallback email chain, conditional department → building code, username first-initial + last-name + uniqueCounter, EPOCH → ISO8601, normalize + lowercase name, country code → region lookup, email from first.last@domain, date compare for lifecycle state, E.164 phone normalisation, and split to extract domain from email.

### `isc_transforms_generateTestCases`
Generates 2–5 illustrative test cases for a transform: happy-path, null input, and edge cases. Each test case includes a description, sample input, expected output, and notes. Use these directly in the ISC transform tester.

### `isc_transforms_catalog`
Returns all 44+ supported SailPoint ISC transform operation types with: type key, human-readable title, required attributes, doc URL, schema coverage flag, and scaffold example. Essential reference when you are not sure which operation to use.

### `isc_transforms_getSchema`
Returns the full JSON Schema (Draft 2020-12) for any operation type — the exact schema used internally for validation. Useful when you want to understand precisely which attributes are required, optional, and what their constraints are.

### `isc_transforms_scaffold`
Generates a valid minimal starter JSON payload for any operation type. Good starting point before you fill in the actual values.

### `isc_ping`
Health check. Returns the server status, active license tier, and whether Phase 2 tools are available.

---

## Enterprise Plan

The 4 tools below connect to a live ISC tenant and require an **Enterprise license key**.

| Tool | What it does |
|---|---|
| `isc_transforms_list` | `GET /v3/transforms` — fetch all transforms from your tenant |
| `isc_transforms_get` | `GET /v3/transforms/:id` — fetch a single transform |
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
| `ISC_MCP_MODE` | `readonly` | Set to `write` to allow `isc_transforms_upsert` to apply changes |
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
