import { searchProducts } from "./shopify.js";

// Turns a pasted freeform shopping/materials list into cart matches.
// Each input line becomes { name, quantity }; we search the catalog for each,
// score candidates against the request, and classify confidence high/low/none.

const HIGH_CONFIDENCE = 0.6; // auto-add threshold (hybrid flow)
const LOW_CONFIDENCE = 0.25; // below this we treat as "not found"

// Words that add no matching signal — dropped before scoring.
const STOPWORDS = new Set([
  "a", "an", "the", "of", "for", "and", "with", "in", "to", "x", "pcs", "pc",
  "pack", "packs", "box", "boxes", "set", "sets", "unit", "units", "piece", "pieces",
]);

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // punctuation -> space
    .replace(/\s+/g, " ")
    .trim();
}

// Crude singularization so "screws" matches "screw".
function stem(token) {
  if (token.length > 3 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function tokenize(str) {
  return normalize(str)
    .split(" ")
    .filter((t) => t && !STOPWORDS.has(t))
    .map(stem);
}

// Pull a quantity out of a raw line and return { name, quantity }.
// Handles: "2x cedar plank", "2 x cedar plank", "10 - screws", "3 cedar planks",
// "cedar planks x4", "cedar planks, 3", "- 5 bolts", bullets, etc.
export function parseLine(rawLine) {
  let line = String(rawLine || "").trim();
  if (!line) return null;

  // Strip leading bullets / list markers.
  line = line.replace(/^[-*•·\d]+[.)]\s+/, (m) =>
    /^\d/.test(m) ? m : ""
  );
  line = line.replace(/^[-*•·]\s+/, "").trim();
  if (!line) return null;

  let quantity = null;
  let name = line;

  // Leading "2x", "2 x", "2 -", "2 " quantity.
  let m = line.match(/^(\d{1,4})\s*(?:x|×|\*|-|:)?\s+(.+)$/i);
  if (m) {
    quantity = parseInt(m[1], 10);
    name = m[2];
  }

  // Trailing "name x4", "name, 4", "name - 4", "name qty 4".
  if (quantity === null) {
    m = name.match(/^(.+?)[\s,]+(?:x|×|\*|qty|quantity)?\s*(\d{1,4})$/i);
    if (m && normalize(m[1]).length) {
      name = m[1];
      quantity = parseInt(m[2], 10);
    }
  }

  name = name.replace(/[\s,;:-]+$/, "").trim();
  if (!name) return null;

  if (!quantity || quantity < 1) quantity = 1;
  if (quantity > 999) quantity = 999; // sanity cap

  return { name, quantity };
}

// Parse a whole pasted block into line items. Splits on newlines; if the paste
// is a single line with commas (and no newlines), split on commas as a fallback.
export function parseList(text) {
  const raw = String(text || "");
  let pieces = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (pieces.length <= 1 && raw.includes(",")) {
    pieces = raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const items = [];
  for (const p of pieces) {
    const parsed = parseLine(p);
    if (parsed) items.push({ ...parsed, raw: p });
  }
  return items;
}

// Score a candidate product title (0..1) against the requested tokens.
// Coverage = fraction of request tokens found in the title; we also reward
// title conciseness so an exact-ish product beats a long tangential one.
function scoreMatch(requestTokens, product) {
  if (!requestTokens.length) return 0;
  const titleTokens = tokenize(product.title);
  if (!titleTokens.length) return 0;
  const titleSet = new Set(titleTokens);

  let hits = 0;
  for (const t of requestTokens) {
    if (titleSet.has(t)) hits += 1;
    else if ([...titleSet].some((tt) => tt.includes(t) || t.includes(tt))) hits += 0.5;
  }
  const coverage = hits / requestTokens.length; // how much of the request is covered
  const precision = hits / titleTokens.length; // how focused the title is
  // Weighted toward coverage; precision breaks ties between similar titles.
  return Math.min(1, coverage * 0.8 + precision * 0.2);
}

function firstSellableVariant(product) {
  const edges = product.variants?.edges ?? [];
  const available = edges.find((e) => e.node.availableForSale);
  return (available ?? edges[0])?.node ?? null;
}

function candidateView(product, score) {
  const variant = firstSellableVariant(product);
  return {
    title: product.title,
    handle: product.handle,
    image: product.featuredImage?.url ?? null,
    price: variant?.price ?? product.priceRange?.minVariantPrice ?? null,
    variantId: variant?.id ?? null,
    availableForSale: variant?.availableForSale ?? false,
    score: Math.round(score * 100) / 100,
  };
}

// Match one parsed line against the catalog. Returns the request, the chosen
// match (or null), ranked alternatives, and a confidence tier.
export async function matchLine(item) {
  const requestTokens = tokenize(item.name);
  let products = [];
  try {
    products = await searchProducts(item.name, 6);
  } catch {
    products = [];
  }

  const ranked = products
    .map((p) => candidateView(p, scoreMatch(requestTokens, p)))
    .filter((c) => c.variantId) // must be orderable
    .sort((a, b) => b.score - a.score);

  const best = ranked[0] ?? null;
  let confidence = "none";
  if (best) {
    if (best.score >= HIGH_CONFIDENCE && best.availableForSale) confidence = "high";
    else if (best.score >= LOW_CONFIDENCE) confidence = "low";
    else confidence = "none";
  }

  return {
    request: item.name,
    quantity: item.quantity,
    confidence,
    match: confidence === "none" ? null : best,
    alternatives: ranked.slice(0, 4),
  };
}

// Full pipeline: parse the pasted list and match every line (in parallel).
// Returns a report the model summarizes and the widget renders.
export async function processMaterialsList(text) {
  const items = parseList(text);
  const lines = await Promise.all(items.map((it) => matchLine(it)));

  const high = lines.filter((l) => l.confidence === "high");
  const low = lines.filter((l) => l.confidence === "low");
  const none = lines.filter((l) => l.confidence === "none");

  return {
    totalLines: lines.length,
    counts: { high: high.length, low: low.length, none: none.length },
    lines,
  };
}
