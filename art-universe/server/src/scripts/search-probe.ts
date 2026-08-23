import { createContext } from '../context.js';

/**
 * Dev helper: check what the universe actually returns for a query, without a
 * browser. Pass queries as arguments, or run with none for the defaults.
 */
const DEFAULTS = [
  'purple dinosaurs',
  'something peaceful',
  'art that feels lonely',
  'funny monsters',
  'underwater worlds',
  'strange faces',
  'show me something completely different'
];

const ctx = createContext();
const queries = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;

for (const query of queries) {
  const result = ctx.search.byText(query, { limit: 5 });
  console.log(`\n${query}`);
  for (const c of result.candidates.slice(0, 5)) {
    console.log(
      `  ${c.relevance.toFixed(2)}  ${(c.artwork.subject ?? '—').slice(0, 44).padEnd(44)}` +
        `  ${(c.artwork.mood ?? '').padEnd(11)}  ${c.artwork.palette[0]}`
    );
  }
  if (!result.candidates.length) console.log('  (nothing)');
}
