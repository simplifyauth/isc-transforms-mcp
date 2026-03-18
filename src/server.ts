// src/server.ts  —  Hosted (SaaS) HTTP entry point for isc-transforms-mcp
//
// Transport: StreamableHTTP  (MCP spec §4.2)
// Auth:      Bearer API key  (ISC-XXXX-XXXX-XXXX-XXXX)
// Each request creates its own McpServer instance so customer configs stay isolated.
//
// Usage:
//   PORT=3000 node dist/server.js
//
// Claude Desktop config (remote mode):
//   {
//     "mcpServers": {
//       "isc-transforms": {
//         "url": "https://your-domain.com/mcp",
//         "headers": { "Authorization": "Bearer ISC-XXXX-XXXX-XXXX-XXXX" }
//       }
//     }
//   }

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./index.js";
import { lookupApiKey } from "./apikeys.js";
import { loadConfig } from "./config.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ---------------------------------------------------------------------------
// Extract and validate the Bearer token from the request
// ---------------------------------------------------------------------------
function extractBearerKey(req: Request): string | null {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice(7).trim() || null;
}

// ---------------------------------------------------------------------------
// Build a per-request Config based on the customer's API key record.
// Phase 2 ISC credentials can be stored per-key (advanced) or read from env
// (single-tenant hosted). For now we use shared env credentials + key decides
// the license tier.
// ---------------------------------------------------------------------------
function buildConfigForKey(tier: "personal" | "enterprise") {
  const base = loadConfig();
  return {
    ...base,
    licenseTier: tier,
    // Enterprise API key overrides any local license key check
    licenseKey: tier === "enterprise" ? "ENV_KEYED" : undefined,
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// CORS — restrict to known origins in production via ALLOWED_ORIGINS env var
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map(o => o.trim()).filter(Boolean);
app.use(cors(allowedOrigins?.length ? { origin: allowedOrigins } : undefined));

// Rate limiting — prevent brute-force and DoS
const limiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_RPM ?? "60", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});
app.use(limiter);

app.use(express.json({ limit: "1mb" }));

// Health endpoint (no auth required)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "isc-transforms-mcp", transport: "streamableHttp" });
});

// MCP endpoint
app.all("/mcp", async (req: Request, res: Response) => {
  // 1. Authenticate
  const key = extractBearerKey(req);
  if (!key) {
    res.status(401).json({
      error: "Missing API key. Add header: Authorization: Bearer ISC-XXXX-XXXX-XXXX-XXXX",
    });
    return;
  }

  const record = lookupApiKey(key);
  if (!record) {
    res.status(401).json({
      error: "Invalid or inactive API key. Purchase a license at https://YOUR-STORE-URL",
    });
    return;
  }

  // 2. Build per-request MCP server with the customer's tier
  const cfg = buildConfigForKey(record.plan);
  const mcpServer = await buildMcpServer(cfg);

  // 3. Create transport and handle the MCP request
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — new session per request
  });

  // Clean up when the response ends
  res.on("close", () => {
    transport.close().catch(() => {});
    mcpServer.close().catch(() => {});
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    if (!res.headersSent) {
      console.error("[mcp] request error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// Global error handler — prevent Express from leaking stack traces
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[express] unhandled error:", err);
  if (!res.headersSent) {
    const status = typeof err.status === "number" ? err.status : 500;
    res.status(status).json({ error: status === 413 ? "Payload too large" : "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`isc-transforms-mcp HTTP server listening on port ${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/health`);
  console.log(`  MCP:    http://localhost:${PORT}/mcp`);
});
