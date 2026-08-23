/** Vector widths. Kept here so the DB schema and the AI providers can never drift apart. */
export const SEMANTIC_DIM = 384;
export const VISUAL_DIM = 128;

export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS art_keys (
  id            TEXT PRIMARY KEY,
  -- Blind index: HMAC(server pepper, normalised key). Lets us find the one
  -- candidate row without storing the key and without running the slow KDF
  -- against every row in the table.
  lookup        TEXT NOT NULL UNIQUE,
  kdf           TEXT NOT NULL,
  salt          TEXT NOT NULL,
  key_hash      TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artworks (
  id            TEXT PRIMARY KEY,
  public_ref    TEXT NOT NULL UNIQUE,
  art_key_id    TEXT REFERENCES art_keys(id),
  visibility    TEXT NOT NULL CHECK (visibility IN ('universe','private')),
  title         TEXT,
  title_source  TEXT,
  status        TEXT NOT NULL DEFAULT 'published'
                CHECK (status IN ('published','withdrawn','removed')),
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  palette       TEXT NOT NULL,
  caption       TEXT,
  tags          TEXT,
  mood          TEXT,
  style         TEXT,
  medium        TEXT,
  subject       TEXT,
  storage_key   TEXT NOT NULL,
  x             REAL NOT NULL,
  y             REAL NOT NULL,
  gravity       REAL NOT NULL DEFAULT 0,
  gravity_at    INTEGER NOT NULL,
  responds_to   TEXT REFERENCES artworks(id),
  seeded        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artworks_owner   ON artworks(art_key_id);
CREATE INDEX IF NOT EXISTS idx_artworks_live    ON artworks(status, visibility);
CREATE INDEX IF NOT EXISTS idx_artworks_space   ON artworks(x, y);
CREATE INDEX IF NOT EXISTS idx_artworks_parent  ON artworks(responds_to);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id                TEXT PRIMARY KEY,
  token_hash        TEXT NOT NULL UNIQUE,
  art_key_id        TEXT REFERENCES art_keys(id),
  visibility        TEXT NOT NULL CHECK (visibility IN ('universe','private')),
  state             TEXT NOT NULL CHECK (state IN
                      ('processing','approved','needs_review','rejected','cancelled')),
  reason            TEXT,
  detail            TEXT,
  artwork_id        TEXT REFERENCES artworks(id),
  responds_to       TEXT REFERENCES artworks(id),
  title             TEXT,
  suggested_title   TEXT,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,
  connections       INTEGER NOT NULL DEFAULT 0,
  finished_at       INTEGER,
  cancel_reason     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_state ON upload_sessions(state, last_heartbeat_at);

CREATE TABLE IF NOT EXISTS moderation_runs (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES upload_sessions(id),
  state        TEXT NOT NULL,
  checks       TEXT NOT NULL DEFAULT '[]',
  reason       TEXT,
  detail       TEXT,
  reviewed_by  TEXT,
  review_note  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moderation_state ON moderation_runs(state, created_at);

CREATE TABLE IF NOT EXISTS relationships (
  a_id       TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  b_id       TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('similarity','response')),
  strength   REAL NOT NULL,
  facet      TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_rel_b ON relationships(b_id, kind);

CREATE TABLE IF NOT EXISTS reactions (
  id         TEXT PRIMARY KEY,
  artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  actor_hash TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('appreciate','inspired')),
  created_at INTEGER NOT NULL,
  UNIQUE (artwork_id, actor_hash, kind)
);
CREATE INDEX IF NOT EXISTS idx_reactions_art ON reactions(artwork_id, created_at);

CREATE TABLE IF NOT EXISTS explorations (
  artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  weight     REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expl_art ON explorations(artwork_id, created_at);

CREATE TABLE IF NOT EXISTS reports (
  id         TEXT PRIMARY KEY,
  artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,
  actor_hash TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','actioned','dismissed')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reports_state ON reports(state, created_at);

-- Anonymous aggregate analytics. No identifiers, no IP, no user agent.
-- 'bucket' is a rotating anonymous session bucket, not a person.
CREATE TABLE IF NOT EXISTS analytics_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  props      TEXT NOT NULL DEFAULT '{}',
  bucket     TEXT NOT NULL,
  day        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_name_day ON analytics_events(name, day);

CREATE TABLE IF NOT EXISTS experiments (
  id            TEXT PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  surface       TEXT NOT NULL,
  problem       TEXT NOT NULL,
  evidence      TEXT NOT NULL,
  hypothesis    TEXT NOT NULL,
  change        TEXT NOT NULL,
  risk          TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  design        TEXT NOT NULL,
  audience_pct  REAL NOT NULL,
  metrics       TEXT NOT NULL,
  variant       TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL CHECK (status IN
                  ('proposed','running','measured','kept','modified','rolled_back','blocked')),
  requires_human INTEGER NOT NULL DEFAULT 0,
  result        TEXT,
  decision      TEXT,
  rollback_state TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_log (
  id            TEXT PRIMARY KEY,
  experiment_id TEXT REFERENCES experiments(id),
  phase         TEXT NOT NULL,
  note          TEXT NOT NULL,
  payload       TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evolution_exp ON evolution_log(experiment_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_semantic USING vec0(
  artwork_id TEXT PRIMARY KEY,
  visibility TEXT PARTITION KEY,
  embedding  FLOAT[${SEMANTIC_DIM}]
);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_visual USING vec0(
  artwork_id TEXT PRIMARY KEY,
  visibility TEXT PARTITION KEY,
  embedding  FLOAT[${VISUAL_DIM}]
);
`;
