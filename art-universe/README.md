# Art Universe

A visual, anonymous world of art. You open it and you are already inside it —
no landing page, no sign-up, no feed. You move through the universe, notice
things, search it in plain language and watch it rearrange itself, add your own
work, and get an **Art Key** that lets you come back. There are no accounts,
no usernames, no followers and no counts anywhere.

```bash
npm install
npm run seed        # fills the universe with generated placeholder artwork
npm run dev         # http://localhost:5173  (API on :8788)
```

Production:

```bash
npm run build && npm start   # serves the built client and the API on :8788
npm test                     # 72 tests, security-critical paths included
```

Everything runs with no API keys and no external services. Set
`ANTHROPIC_API_KEY` to swap the offline AI provider for Claude — see
[AI providers](#ai-providers).

---

## What is actually built

| Area | State |
| --- | --- |
| Infinite pan/zoom universe, LOD, culling, virtualisation | real, canvas renderer |
| Semantic layout, relationships, constellation clustering | real, from embeddings |
| Natural-language search that reorganises space | real, no results page |
| Visual search ("more like this") | real, colour + concept blended |
| Anonymous upload, single gesture | real |
| Live moderation inside the upload session | real, cancels on abandonment |
| Art Key ownership (scrypt + blind index) | real, tested |
| My Universe, qualitative signals | real |
| Public / private artwork | real, separate vector partitions |
| Visual Gravity, decay, hidden popularity | real |
| Respond With Art, branching responses | real |
| Reactions, reporting, moderation admin | real |
| Anonymous aggregate analytics | real, allow-listed events only |
| Evolution engine + evolution log | real, with hard autonomy boundaries |

---

## Architecture

Domains are separated and none of them know about HTTP or the DOM. The
composition root is `server/src/context.ts`; it is the only place that wires
things together, which is what makes the clock, the AI provider and the storage
driver swappable in tests.

```
shared/                    types the server and the browser agree on
server/src/
  infra/                   config, sqlite + vector schema, ids, clock, websocket hub
  services/
    ai/                    embeddings, concept lexicon, providers (local / Claude), PII
    images/                sharp pipeline, visual feature extraction
    storage/               object-storage interface + local driver
  domain/
    artwork/               entity, repository, semantic layout, public projection
    artkey/                key generation, scrypt hashing, blind index, service
    ownership/             anonymous ownership + authorisation
    upload-session/        session lifecycle, heartbeat, grace window, reaper
    moderation/            state machine, pipeline, decision policy, intake
    relationships/         similarity + response edges
    search/ discovery/     semantic & visual search, discovery ranking
    gravity/               visual gravity, decay, qualitative signals
    reactions/ reporting/  constrained interactions
    analytics/ experiments/ anonymous aggregates, evolution engine + log
  http/                    routes, key sessions, rate limiting
web/src/
  universe/                camera, scene, renderer, input, image cache
  ui/                      controls, upload, Art Key, detail, search, stage
  net/                     API client, live upload session
```

### Stack, and why

**TypeScript end to end, Express, Vite.** A typed language across the whole
stack means the artwork contract (`shared/types.ts`) is checked on both sides —
important when the rule is "the client must never receive a count", because that
is enforced by the type of what crosses the wire.

**SQLite + `sqlite-vec` instead of Postgres + pgvector.** The brief asks for a
relational database with vector search. `sqlite-vec` gives real `vec0` virtual
tables with KNN queries and partition keys, so `vec_semantic` and `vec_visual`
are partitioned by visibility and a private artwork is physically unreachable
from a public search. The schema and every query are ordinary SQL; moving to
Postgres + pgvector means changing `openDb` and the two `MATCH` queries. The
substitution buys a product that runs from `npm install` with no services.

**Local disk object storage behind an `ObjectStorage` interface.** Four
derivatives are written per artwork (`thumb` 96px, `small` 384px, `large`
1400px, plus a cleaned master), addressed by the artwork's *public* reference so
no internal id ever appears in a URL. An S3/R2 driver is a class that implements
four methods.

**WebSocket for the upload session heartbeat**, with an HTTP heartbeat fallback
so the session survives a browser that cannot hold a socket. It is the only
realtime surface in the product — there is no chat, presence or notification
channel to build.

**Canvas 2D for rendering**, not WebGL. The far-zoom representation is a
palette-derived orb, which costs one radial gradient; the mid tier is a 96px
thumbnail; only artwork you are actually looking at loads a large derivative.
With culling, a resident-node budget and load shedding, the expensive case is
bounded before the GPU would start to matter. `UniverseRenderer` is one class
behind a small interface, so a WebGL implementation is a drop-in if the resident
set ever needs to be much larger.

### AI providers

`AiProvider` has three methods: `analyse`, `ocr`, `safety`. Two implementations:

- **`LocalAiProvider`** (default, no network). It reads colour, composition,
  texture and lighting from the pixels; infers mood and style from those; detects
  QR-style finder patterns by their 1:1:3:1:1 scanline signature; and detects
  dense rendered text by its run-length signature. It reports
  `degraded: true` from `safety()`, because a pixel heuristic cannot judge
  whether an image is hateful or exploitative, and the moderation policy treats a
  degraded verdict accordingly rather than pretending to have screened content.
- **`AnthropicAiProvider`** (set `ANTHROPIC_API_KEY`). One vision call returns
  the semantic reading, the OCR text and the safety verdict together, so a
  moderation run costs one request. It falls back to the local provider on any
  error or timeout. Its system prompt carries the safety policy verbatim,
  including the rule that sadness, politics, religion, fear, anatomy, darkness,
  strangeness and surrealism are never grounds for rejection.

**Embeddings are computed locally and deterministically**, not fetched. A
semantic vector (384d) is built from named concept axes plus a signed hashing
space; the same encoder runs over a query and over an artwork's analysis, which
is what makes "art that feels lonely" land on work analysed as solitary and
empty. A visual vector (128d) is built from hue/saturation/value histograms, a
Lab palette, 4×4 luminance, saturation and edge-energy grids, and global
descriptors. This is a genuine trade-off: it is weaker than CLIP at recognising
unusual subjects, and it is honest about being a lexical-plus-conceptual match
rather than a learned joint embedding. It costs nothing, needs no model server,
and is reproducible. `embedArtwork` is the seam to replace.

**Positions are derived from meaning.** A fixed gaussian random projection maps
the semantic vector to the plane, so pieces that share subject, mood or palette
land near each other, clusters emerge on their own, and an artwork is always in
the same place. There is no force-directed layout and no per-frame layout cost.

---

## The parts that had to be exactly right

### Live moderation, and cancellation

Every public upload completes moderation while the session is alive:

```
open session → local preview → moderation runs → approve / review / reject → publish
```

The session is the thing that keeps a submission alive. `stillAlive()` is checked
between *every* pipeline stage, and again immediately before anything is written,
so a creator who leaves mid-check publishes nothing. A submission is cancelled by:
leaving the page, an explicit cancel, no heartbeat for longer than the grace
window, the hard TTL, or a server restart — every live session is cancelled at
boot, because a session cannot have survived one.

**Mobile grace is deliberate.** A dropped websocket is not abandonment: the
socket reconnects, the heartbeat continues over HTTP if it cannot, and only the
90-second grace window (`UPLOAD_SESSION_GRACE_MS`) decides. Normal
app-switching is not punished.

The state machine is pure and lives on its own
(`domain/moderation/state-machine.ts`). `approved`, `rejected` and `cancelled`
are terminal with no path back — nothing can be revived and published after the
creator has gone.

Work that needs a human stays in `needs_review` only while its session is alive.
The admin queue lists live sessions only, and approving a session whose creator
has left returns `cancelled` and publishes nothing.

### Art Key

Format: `MOON-WHALE-73-KITE-K7QF9M`.

The memorable four segments carry about 31 bits, which is not enough for the
only credential in the system, so one six-character segment from a 30-character
alphabet is appended, bringing the key to **~61 bits**. This is a deliberate
deviation from the example key shape in the brief, and the reason is in
`domain/artkey/key.ts`.

- Generated **only** on a first successful publish, never before moderation
  succeeds, and never for a rejected submission.
- One key owns many artworks; there is no per-artwork key.
- The server stores a **scrypt** hash (N=2¹⁵, r=8, p=1) with a per-key 16-byte
  salt, verified with `timingSafeEqual`.
- Because a slow KDF cannot be run against every row on every return, lookup
  goes through a **blind index**: `HMAC-SHA256(pepper, normalised key)`, with the
  pepper stored outside the database (`data/artkey.pepper`, mode 0600). The raw
  key is still never stored — a test asserts that no segment of it appears
  anywhere in the table.
- An unknown key runs a decoy hash, so "no such key" and "wrong key" cost the
  same. Returning is rate limited per client and globally.
- After the first exchange the key never travels again: the browser holds a
  short-lived stateless HMAC session token instead.
- It is shown once, with copy, save (a PNG card), a QR code and
  "remember on this device". It never appears in a URL and is never called a
  token in the interface.

### Hidden popularity

No view counts, likes, totals, rankings or follower counts exist — not in the
UI, not in the API payloads, not in the shared types. Attention becomes **Visual
Gravity**: slightly stronger glow, a slower pulse, a few particles, richer
relationship lines, more presence in relevant exploration paths.

The accumulator decays with a half-life (7 days by default) and is passed
through a saturating curve with a hard ceiling of 0.9, so a much-discovered
piece can never light all the way up and no artwork becomes a celebrity node.
Attention is weighted by kind: an artistic response is worth 50× a passive view.

Discovery ranks on relevance + freshness + meaningful attention + an
under-explored bonus + randomness + mood diversity. Popularity alone never ranks
anything.

### Privacy

The app never asks for a name, age, gender, address, country, username, email,
password, photo, biography, occupation, school or social link — there is no
field for any of them anywhere in the codebase.

Analytics are anonymous aggregates: an allow-list of 20 event names, a bucket
that is `sha256(day + per-browser token)` and therefore stops meaning anything
at midnight, properties reduced to numbers, booleans and short enum-like strings
(free text is dropped), and a 30-day retention prune. No IP, no user agent, no
referrer.

### The evolution engine

`observe → understand → propose → test → measure → keep / modify / roll back`,
with every phase written to an evolution log that can always explain why a
change happened.

Observations come from real aggregates: searches that never led to opening an
artwork, uploads abandoned after choosing an image, failed gestures against
camera moves, slow-frame reports. Each proposal carries the observed problem,
its evidence, a hypothesis, the change, a risk level, an experiment design,
the audience share, the metrics and its rollback state.

The boundary is enforced in code, not in prose. `LOW_RISK_SURFACES` (spacing,
motion speed, clustering, search suggestions, relationship visibility,
performance, animation timing, …) can start running on a small share of
anonymous sessions by themselves. `PROTECTED_SURFACES` (Art Key security,
authentication, upload-session security, privacy policy, moderation policy,
content-safety boundaries, data collection, data retention, admin permissions,
external data sharing, legal consent, security controls, anonymous ownership)
are recorded as `blocked` with `audience_pct = 0` and reach nobody until a human
calls `humanApprove`. Tests assert this for every protected surface.

Assignment is a pure hash of the experiment key and the anonymous bucket, so no
per-visitor state is stored anywhere.

### Accessibility

The canvas is unreadable to assistive technology, so the artworks near you are
mirrored as real focusable buttons positioned over their nodes, with labels.
Arrow keys move the camera, `+`/`-` zoom, `/` opens search, `Escape` releases a
selection; sheets trap focus and return it. Every icon-only control has a label,
touch targets are at least 48px, `prefers-reduced-motion` removes drift,
particles, travelling sparks and easing, and `prefers-contrast: more` raises the
whole palette.

---

## Tests

`npm test` — 72 tests. The security-critical paths the brief names are the ones
covered hardest:

- **Art Key hashing and verification** — format and entropy, salt uniqueness,
  constant-time verification, failure-closed on tampered material, blind index
  pepper binding, and that the raw key is nowhere in the database.
- **Upload-session lifecycle and cancellation** — grace window vs. abandonment,
  hard TTL, dropped socket ≠ abandonment, token authorisation, terminal states,
  cancel-all at boot, and that only live sessions reach human review.
- **Moderation state machine** — the full transition table, terminal states that
  can never re-enter the pipeline, and the decision policy for every combination
  of visibility, safety verdict, personal information and scannable codes.
- **Ownership authorisation** — key issued only on first successful publish,
  never on rejection, one key per creator across many artworks, cross-owner
  access refused, private work excluded from the public universe.
- **Intake integration** — leaving mid-moderation publishes nothing and leaves no
  temporary file, a reviewed submission whose creator left is never published,
  and a response is connected to the artwork it answers.

---

## Configuration

Everything is optional; see `.env.example`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8788` | HTTP + websocket port |
| `DATA_DIR` | `./data` | database, media, temp, key pepper |
| `ANTHROPIC_API_KEY` | — | enables the Claude vision provider |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | model for analysis and screening |
| `UPLOAD_SESSION_TTL_MS` | `600000` | hard lifetime of an upload session |
| `UPLOAD_SESSION_GRACE_MS` | `90000` | mobile grace before abandonment |
| `GRAVITY_HALF_LIFE_MS` | `7 days` | how fast attention decays |
| `ADMIN_TOKEN` | generated | bearer token for `/api/admin/*` |

## Scripts

| Command | Does |
| --- | --- |
| `npm run seed [perTheme]` | generates placeholder artwork across 14 subjects |
| `npm run dev` | server + client with reload |
| `npm run build && npm start` | production build and serve |
| `npm test` | the full suite |
| `npm run typecheck` | server and client type checking |
| `npx tsx server/src/scripts/relayout.ts` | recompute positions after tuning layout |
| `npx tsx server/src/scripts/contact-sheet.ts out.png` | render one of every seed kind |

## Known limits

- **Perspective correction** is deskew plus frame-crop, both applied only when
  detected and only within conservative bounds. A true four-point projective
  warp needs OpenCV; the seam is `prepareImage`.
- **OCR** without an API key detects that text is present, not what it says, so
  personal-information detection is only as good as the text it is given. With
  Claude configured it reads the text and the detection is real.
- **Content-safety screening** without an API key is honest about being
  heuristic — it reports `degraded` rather than claiming an image is safe.
- The **discovery weights** are tuned by hand and are meant to be tuned by the
  evolution engine over time. The formula may evolve; the philosophy may not.
