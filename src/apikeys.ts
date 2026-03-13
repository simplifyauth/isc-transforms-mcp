// src/apikeys.ts
// Simple flat-file API key store for the hosted (SaaS) MCP server.
// Keys are stored in data/apikeys.json next to the dist folder.
// Format: { [key: string]: ApiKeyRecord }
//
// In production you can swap this for SQLite, Redis, or a Polar/Gumroad webhook.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve to <project-root>/data/apikeys.json regardless of whether we're in
// src/ (ts-node) or dist/ (compiled).
const DATA_DIR  = join(__dirname, "..", "data");
const KEYS_FILE = join(DATA_DIR,  "apikeys.json");

export type ApiKeyPlan = "personal" | "enterprise";

export interface ApiKeyRecord {
  email:     string;
  plan:      ApiKeyPlan;
  active:    boolean;
  createdAt: string;   // ISO date string
  note?:     string;
}

type KeyStore = Record<string, ApiKeyRecord>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readStore(): KeyStore {
  ensureDataDir();
  if (!existsSync(KEYS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(KEYS_FILE, "utf-8")) as KeyStore;
  } catch {
    return {};
  }
}

function writeStore(store: KeyStore): void {
  ensureDataDir();
  writeFileSync(KEYS_FILE, JSON.stringify(store, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Look up a key and return its record, or null if not found / inactive. */
export function lookupApiKey(key: string): ApiKeyRecord | null {
  if (!key) return null;
  const store = readStore();
  const record = store[key];
  if (!record || !record.active) return null;
  return record;
}

/** Add or update a key in the store. */
export function upsertApiKey(key: string, record: ApiKeyRecord): void {
  const store = readStore();
  store[key] = record;
  writeStore(store);
}

/** Deactivate (soft-delete) a key. */
export function deactivateApiKey(key: string): boolean {
  const store = readStore();
  if (!store[key]) return false;
  store[key].active = false;
  writeStore(store);
  return true;
}

/** List all keys (for admin CLI use). */
export function listApiKeys(): Array<{ key: string } & ApiKeyRecord> {
  const store = readStore();
  return Object.entries(store).map(([key, rec]) => ({ key, ...rec }));
}

/**
 * Generate a new ISC-format key: ISC-XXXX-XXXX-XXXX-XXXX
 * (uppercase A-Z0-9, suitable as a Bearer token)
 */
export function generateApiKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const seg = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `ISC-${seg()}-${seg()}-${seg()}-${seg()}`;
}
