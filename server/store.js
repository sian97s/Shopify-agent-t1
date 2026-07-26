// Durable, file-backed session store.
//
// Replaces the old in-memory Map that reset on every server restart (and on
// Render's free tier, every cold start). Each session persists:
//   { history, cartId, widgetMessages, widgetCart }
// so both the AI chat and the Shopify cart survive restarts, refreshes, and
// re-opening the widget.
//
// This is intentionally dependency-free (a single JSON file). It's durable
// enough for a prototype / client demo. For real production traffic, swap the
// read/write internals for Redis or a database — the exported API stays the same.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Allow overriding the location (e.g. a mounted Render disk) via env.
const DATA_FILE =
  process.env.SESSION_STORE_FILE || path.join(__dirname, "..", ".data", "sessions.json");

// Sessions older than this are pruned on load (Storefront carts expire anyway).
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function emptySession() {
  return {
    history: [],
    cartId: null,
    widgetMessages: [],
    widgetCart: null,
    updatedAt: Date.now(),
  };
}

let sessions = load();
let writeQueued = false;

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const now = Date.now();
    for (const [id, s] of Object.entries(parsed)) {
      if (!s || now - (s.updatedAt ?? 0) > MAX_AGE_MS) delete parsed[id];
    }
    return parsed;
  } catch {
    return {}; // missing or corrupt file -> start fresh
  }
}

// Debounced write so a burst of tool calls in one turn only hits disk once.
function persist() {
  if (writeQueued) return;
  writeQueued = true;
  setImmediate(() => {
    writeQueued = false;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(sessions), "utf8");
    } catch (err) {
      console.error("session store write failed:", err.message);
    }
  });
}

export function getSession(sessionId) {
  if (!sessions[sessionId]) sessions[sessionId] = emptySession();
  return sessions[sessionId];
}

// Call after mutating a session so changes hit disk.
export function saveSession(sessionId, session) {
  session.updatedAt = Date.now();
  sessions[sessionId] = session;
  persist();
}
