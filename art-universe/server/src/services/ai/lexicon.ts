/**
 * A small hand-built concept lexicon.
 *
 * It is what lets a natural-language query ("art that feels lonely") land on
 * the same axes as an artwork's analysed description ("empty shoreline,
 * solitary figure, melancholy"). Both sides go through the same expansion, so
 * search is genuinely semantic rather than literal string matching — without
 * requiring a hosted embedding model to be reachable.
 */

export interface WeightedTerm {
  term: string;
  weight: number;
}

/** Named axes get a dedicated dimension: robust, interpretable matching. */
export const MOOD_AXES = [
  'peaceful', 'lonely', 'joyful', 'eerie', 'melancholy', 'energetic', 'dreamy',
  'tense', 'playful', 'mysterious', 'hopeful', 'angry', 'nostalgic', 'tender',
  'chaotic', 'solemn'
] as const;

export const SUBJECT_AXES = [
  'creature', 'dinosaur', 'monster', 'face', 'figure', 'animal', 'bird', 'fish',
  'underwater', 'ocean', 'forest', 'plant', 'flower', 'mountain', 'landscape',
  'city', 'architecture', 'space', 'star', 'moon', 'planet', 'robot', 'machine',
  'insect', 'dragon', 'ghost', 'hand', 'eye', 'bone', 'water', 'fire', 'sky'
] as const;

export const STYLE_AXES = [
  'abstract', 'geometric', 'surreal', 'minimal', 'expressive', 'illustrative',
  'painterly', 'collage', 'line-art', 'pixel', 'glitch', 'organic', 'psychedelic',
  'folk', 'graphic'
] as const;

export const MEDIUM_AXES = [
  'painting', 'drawing', 'ink', 'watercolour', 'digital', 'photograph', 'print',
  'sculpture', 'mixed-media', 'textile'
] as const;

export const COLOUR_AXES = [
  'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'magenta', 'pink',
  'black', 'white', 'grey', 'brown', 'gold', 'dark', 'bright', 'vivid', 'muted',
  'warm', 'cool', 'high-contrast', 'smooth', 'detailed', 'symmetrical'
] as const;

export const AXES: string[] = [
  ...MOOD_AXES, ...SUBJECT_AXES, ...STYLE_AXES, ...MEDIUM_AXES, ...COLOUR_AXES
];

export const AXIS_INDEX = new Map(AXES.map((a, i) => [a, i]));

/** term -> related terms with weights. Applied to queries and artworks alike. */
const RELATIONS: Record<string, [string, number][]> = {
  // moods
  calm: [['peaceful', 1]], serene: [['peaceful', 1]], quiet: [['peaceful', 0.9], ['lonely', 0.3]],
  still: [['peaceful', 0.7]], restful: [['peaceful', 0.9]], gentle: [['peaceful', 0.7], ['tender', 0.6]],
  soft: [['peaceful', 0.5], ['tender', 0.5], ['smooth', 0.6]],
  lonely: [['melancholy', 0.6], ['lonely', 1]], alone: [['lonely', 1]], solitude: [['lonely', 1]],
  solitary: [['lonely', 0.9]], empty: [['lonely', 0.7], ['minimal', 0.5]], isolated: [['lonely', 0.9]],
  sad: [['melancholy', 1], ['lonely', 0.4]], sorrow: [['melancholy', 1]], grief: [['melancholy', 1]],
  wistful: [['melancholy', 0.8], ['nostalgic', 0.8]], blue: [['blue', 1], ['melancholy', 0.25]],
  happy: [['joyful', 1]], joy: [['joyful', 1]], cheerful: [['joyful', 1]], bright: [['bright', 1], ['joyful', 0.3]],
  funny: [['playful', 1], ['joyful', 0.6]], humour: [['playful', 1]], silly: [['playful', 1]],
  cute: [['playful', 0.8], ['tender', 0.6]], whimsical: [['playful', 0.9], ['dreamy', 0.5]],
  creepy: [['eerie', 1]], spooky: [['eerie', 1]], haunting: [['eerie', 0.9], ['mysterious', 0.6]],
  strange: [['surreal', 0.8], ['mysterious', 0.6], ['eerie', 0.3]],
  weird: [['surreal', 0.9], ['playful', 0.3]], odd: [['surreal', 0.7]],
  scary: [['eerie', 0.8], ['tense', 0.7]], nightmare: [['eerie', 0.9], ['surreal', 0.7]],
  dream: [['dreamy', 1], ['surreal', 0.6]], dreamlike: [['dreamy', 1], ['surreal', 0.7]],
  wild: [['energetic', 0.8], ['chaotic', 0.7]], loud: [['energetic', 0.8]],
  vibrant: [['energetic', 0.7], ['vivid', 1]], busy: [['chaotic', 0.7], ['detailed', 0.7]],
  mystery: [['mysterious', 1]], secret: [['mysterious', 0.8]], hidden: [['mysterious', 0.7]],
  hope: [['hopeful', 1]], warmth: [['warm', 1], ['tender', 0.4]],
  memory: [['nostalgic', 1]], old: [['nostalgic', 0.7]], vintage: [['nostalgic', 0.9]],
  rage: [['angry', 1]], fury: [['angry', 1]], violent: [['angry', 0.7], ['tense', 0.8]],
  // subjects
  dinosaur: [['dinosaur', 1], ['creature', 0.8], ['animal', 0.5]],
  dinosaurs: [['dinosaur', 1], ['creature', 0.8]],
  dino: [['dinosaur', 1], ['creature', 0.7]], trex: [['dinosaur', 1]],
  monster: [['monster', 1], ['creature', 0.9]], monsters: [['monster', 1], ['creature', 0.9]],
  beast: [['monster', 0.8], ['creature', 0.9]], creature: [['creature', 1]],
  alien: [['creature', 0.8], ['space', 0.6], ['surreal', 0.4]],
  face: [['face', 1], ['figure', 0.4]], faces: [['face', 1]], portrait: [['face', 0.9], ['figure', 0.7]],
  head: [['face', 0.7]], person: [['figure', 1], ['face', 0.4]], people: [['figure', 1]],
  body: [['figure', 0.9]], human: [['figure', 0.9]], hand: [['hand', 1], ['figure', 0.4]],
  eye: [['eye', 1], ['face', 0.5]], eyes: [['eye', 1], ['face', 0.5]],
  skull: [['bone', 1], ['eerie', 0.4]], bones: [['bone', 1]],
  cat: [['animal', 1], ['creature', 0.6]], dog: [['animal', 1], ['creature', 0.6]],
  bird: [['bird', 1], ['animal', 0.8]], birds: [['bird', 1], ['animal', 0.8]],
  fish: [['fish', 1], ['animal', 0.7], ['underwater', 0.7]],
  whale: [['fish', 0.6], ['animal', 0.9], ['underwater', 0.9]],
  jellyfish: [['underwater', 1], ['creature', 0.7]],
  underwater: [['underwater', 1], ['water', 0.9], ['ocean', 0.9]],
  ocean: [['ocean', 1], ['water', 1], ['underwater', 0.6]], sea: [['ocean', 1], ['water', 1]],
  wave: [['water', 0.9], ['ocean', 0.7]], river: [['water', 1]], rain: [['water', 0.8]],
  forest: [['forest', 1], ['plant', 0.8], ['landscape', 0.6]], tree: [['plant', 1], ['forest', 0.7]],
  trees: [['plant', 1], ['forest', 0.8]], leaf: [['plant', 1]], flower: [['flower', 1], ['plant', 0.9]],
  flowers: [['flower', 1], ['plant', 0.9]], botanical: [['plant', 1], ['flower', 0.6]],
  mountain: [['mountain', 1], ['landscape', 0.9]], hill: [['mountain', 0.7], ['landscape', 0.8]],
  landscape: [['landscape', 1]], horizon: [['landscape', 0.8], ['sky', 0.6]],
  city: [['city', 1], ['architecture', 0.8]], building: [['architecture', 1], ['city', 0.7]],
  house: [['architecture', 0.9]], street: [['city', 0.9]], window: [['architecture', 0.7]],
  space: [['space', 1], ['star', 0.7]], cosmos: [['space', 1], ['star', 0.8]],
  galaxy: [['space', 1], ['star', 0.9]], star: [['star', 1], ['space', 0.8]],
  stars: [['star', 1], ['space', 0.8]], moon: [['moon', 1], ['space', 0.7], ['sky', 0.6]],
  planet: [['planet', 1], ['space', 0.9]], sun: [['star', 0.6], ['sky', 0.7], ['warm', 0.5]],
  sky: [['sky', 1]], cloud: [['sky', 0.9]], clouds: [['sky', 0.9]],
  robot: [['robot', 1], ['machine', 0.9]], machine: [['machine', 1]], gear: [['machine', 0.9]],
  insect: [['insect', 1], ['animal', 0.6]], butterfly: [['insect', 1], ['flower', 0.3]],
  moth: [['insect', 1], ['eerie', 0.3]], spider: [['insect', 1], ['eerie', 0.4]],
  dragon: [['dragon', 1], ['creature', 0.9], ['monster', 0.6]],
  ghost: [['ghost', 1], ['eerie', 0.8]], fire: [['fire', 1], ['warm', 0.7]],
  flame: [['fire', 1]], ice: [['cool', 0.8], ['water', 0.5]],
  // styles / mediums
  abstract: [['abstract', 1]], geometry: [['geometric', 1]], geometric: [['geometric', 1]],
  shapes: [['geometric', 0.8], ['abstract', 0.6]], pattern: [['geometric', 0.7], ['detailed', 0.6]],
  surreal: [['surreal', 1]], surrealism: [['surreal', 1]], minimal: [['minimal', 1]],
  simple: [['minimal', 0.9], ['smooth', 0.4]], sparse: [['minimal', 0.9]],
  sketch: [['drawing', 1], ['line-art', 0.8]], drawing: [['drawing', 1]],
  line: [['line-art', 1]], lines: [['line-art', 0.9], ['geometric', 0.4]],
  ink: [['ink', 1], ['drawing', 0.7]], paint: [['painting', 1], ['painterly', 0.8]],
  painting: [['painting', 1], ['painterly', 0.8]], watercolour: [['watercolour', 1], ['painting', 0.8]],
  watercolor: [['watercolour', 1], ['painting', 0.8]], oil: [['painting', 0.9]],
  photo: [['photograph', 1]], photograph: [['photograph', 1]], photography: [['photograph', 1]],
  digital: [['digital', 1]], pixel: [['pixel', 1], ['digital', 0.7]],
  glitch: [['glitch', 1], ['digital', 0.7]], collage: [['collage', 1], ['mixed-media', 0.7]],
  sculpture: [['sculpture', 1]], textile: [['textile', 1]], fabric: [['textile', 0.9]],
  psychedelic: [['psychedelic', 1], ['vivid', 0.8]], folk: [['folk', 1]],
  organic: [['organic', 1]], blob: [['organic', 0.9], ['abstract', 0.5]],
  // colours
  purple: [['purple', 1]], violet: [['purple', 1]], lilac: [['purple', 0.9], ['pink', 0.4]],
  red: [['red', 1], ['warm', 0.6]], crimson: [['red', 1]], orange: [['orange', 1], ['warm', 0.6]],
  yellow: [['yellow', 1], ['bright', 0.5]], gold: [['gold', 1], ['yellow', 0.7]],
  green: [['green', 1]], emerald: [['green', 1]], teal: [['teal', 1], ['cool', 0.6]],
  cyan: [['teal', 1], ['cool', 0.6]], indigo: [['blue', 1], ['purple', 0.5]],
  navy: [['blue', 1], ['dark', 0.6]], magenta: [['magenta', 1]], pink: [['pink', 1]],
  black: [['black', 1], ['dark', 0.9]], white: [['white', 1], ['bright', 0.7]],
  grey: [['grey', 1], ['muted', 0.5]], gray: [['grey', 1], ['muted', 0.5]],
  brown: [['brown', 1], ['warm', 0.5]], earthy: [['brown', 0.8], ['muted', 0.6]],
  dark: [['dark', 1]], darkness: [['dark', 1]], night: [['dark', 0.9], ['sky', 0.6]],
  glowing: [['bright', 0.8], ['vivid', 0.6]], neon: [['vivid', 1], ['bright', 0.7]],
  pastel: [['muted', 0.7], ['smooth', 0.5], ['tender', 0.4]],
  monochrome: [['grey', 0.8], ['minimal', 0.5]]
};

const STOP = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'to', 'in', 'on', 'with', 'that', 'this',
  'is', 'are', 'it', 'its', 'me', 'my', 'i', 'show', 'find', 'something',
  'anything', 'some', 'art', 'artwork', 'piece', 'like', 'feels', 'feeling',
  'looks', 'about', 'for', 'more', 'very', 'really', 'please', 'kind', 'sort'
]);

const crudeStem = (w: string): string => {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('sses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  return w;
};

export const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));

/** Expand raw text into weighted concept terms (original words kept too). */
export function expand(text: string, baseWeight = 1): WeightedTerm[] {
  const out = new Map<string, number>();
  const add = (term: string, w: number) => out.set(term, Math.max(out.get(term) ?? 0, w));
  for (const raw of tokenize(text)) {
    const word = raw;
    const stem = crudeStem(word);
    add(stem, baseWeight);
    const rel = RELATIONS[word] ?? RELATIONS[stem];
    if (rel) for (const [term, w] of rel) add(term, baseWeight * w);
    else if (AXIS_INDEX.has(stem)) add(stem, baseWeight);
  }
  return [...out].map(([term, weight]) => ({ term, weight }));
}

/** Intent hints a natural-language query can carry. */
export function readIntent(query: string): {
  diversify: boolean;
  visual: boolean;
  cleaned: string;
} {
  const q = query.toLowerCase();
  const diversify =
    /\b(different|else|new|surprise|random|unexpected|elsewhere|anything but)\b/.test(q);
  const visual = /\b(like this|similar|more of this|same as this)\b/.test(q);
  return { diversify, visual, cleaned: query };
}
