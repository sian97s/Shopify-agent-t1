/**
 * Procedural seed artwork.
 *
 * The universe has to be alive the first time anyone opens it, so it ships with
 * a set of generated pieces across real subjects, moods and palettes. They are
 * drawn as SVG and rasterised through the same image pipeline as any upload.
 */

export interface SeedMeta {
  subject: string;
  mood: string;
  style: string;
  medium: string;
  tags: string[];
  caption: string;
  title: string | null;
}

export interface SeedPiece {
  svg: string;
  meta: SeedMeta;
  width: number;
  height: number;
}

/** Deterministic RNG so the seeded universe is reproducible. */
export class Rng {
  private state: number;
  constructor(seed: string) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    this.state = h >>> 0 || 1;
  }
  next(): number {
    this.state ^= this.state << 13; this.state >>>= 0;
    this.state ^= this.state >> 17;
    this.state ^= this.state << 5; this.state >>>= 0;
    return this.state / 0xffffffff;
  }
  range(min: number, max: number) { return min + this.next() * (max - min); }
  int(min: number, max: number) { return Math.floor(this.range(min, max + 1)); }
  pick<T>(items: readonly T[]): T { return items[this.int(0, items.length - 1)]; }
  chance(p: number) { return this.next() < p; }
}

const PALETTES: Record<string, string[][]> = {
  deep: [
    ['#050a1c', '#0d1b3e', '#1b3b6f', '#2e6f9e', '#7fd1d8'],
    ['#04121f', '#0b2b3c', '#12556b', '#2a9d8f', '#e9f5db']
  ],
  ember: [
    ['#1a0a08', '#4a1414', '#8c2f1e', '#e07a3c', '#f6d6a8'],
    ['#170b16', '#4c1e3d', '#a63a50', '#f08a5d', '#ffd9a0']
  ],
  violet: [
    ['#0b0620', '#231447', '#4b2a91', '#8a4fff', '#e2c6ff'],
    ['#120a24', '#3a1a5e', '#7b3fa0', '#c77dff', '#ffe6f7']
  ],
  moss: [
    ['#08120c', '#12301f', '#2b5c3b', '#6aa84f', '#d9ed92'],
    ['#0a1410', '#1d3a2f', '#3e7d63', '#8fbf9f', '#f0f7da']
  ],
  ash: [
    ['#0a0a0c', '#1c1c22', '#3a3a44', '#6f6f7d', '#cfcfd8'],
    ['#101014', '#26262e', '#4a4a58', '#9a9aa8', '#ececf2']
  ],
  gold: [
    ['#1a1206', '#3d2a0c', '#7a5518', '#d99b2b', '#ffe9b0'],
    ['#150f08', '#3a2a14', '#8a6a2a', '#e8b64c', '#fff3cf']
  ],
  rose: [
    ['#1a0713', '#3f102c', '#7d2450', '#d2547e', '#ffd6e0'],
    ['#170a14', '#45163a', '#93386a', '#e0779b', '#ffe3ec']
  ]
};

const paletteOf = (rng: Rng, family: keyof typeof PALETTES) =>
  rng.pick(PALETTES[family]);

const noiseFilter = (id: string, opacity = 0.16) => `
  <filter id="${id}" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" seed="7"/>
    <feColorMatrix type="saturate" values="0"/>
    <feComponentTransfer><feFuncA type="linear" slope="${opacity}"/></feComponentTransfer>
  </filter>`;

const softGlow = (id: string, std = 18) =>
  `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">
     <feGaussianBlur stdDeviation="${std}"/></filter>`;

const grainOverlay = (w: number, h: number) =>
  `<rect width="${w}" height="${h}" filter="url(#grain)" opacity="0.5"/>`;

function backdrop(rng: Rng, w: number, h: number, p: string[]): string {
  const cx = rng.range(0.2, 0.8) * w;
  const cy = rng.range(0.2, 0.8) * h;
  return `
  <defs>
    <radialGradient id="bg" cx="${(cx / w) * 100}%" cy="${(cy / h) * 100}%" r="85%">
      <stop offset="0%" stop-color="${p[2]}"/>
      <stop offset="60%" stop-color="${p[1]}"/>
      <stop offset="100%" stop-color="${p[0]}"/>
    </radialGradient>
    ${noiseFilter('grain')}
    ${softGlow('glow', 22)}
    ${softGlow('softer', 42)}
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>`;
}

/** A light ground, so the universe is not uniformly dark. */
function paleBackdrop(rng: Rng, w: number, h: number, p: string[]): string {
  const cx = rng.range(0.25, 0.75) * w;
  const cy = rng.range(0.15, 0.4) * h;
  return `
  <defs>
    <radialGradient id="bg" cx="${(cx / w) * 100}%" cy="${(cy / h) * 100}%" r="95%">
      <stop offset="0%" stop-color="${p[4]}"/>
      <stop offset="55%" stop-color="${p[3]}"/>
      <stop offset="100%" stop-color="${p[2]}"/>
    </radialGradient>
    ${noiseFilter('grain')}
    ${softGlow('glow', 22)}
    ${softGlow('softer', 42)}
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>`;
}

type Generator = (rng: Rng, w: number, h: number) => { body: string; meta: SeedMeta };

const TITLES: Record<string, string[]> = {
  underwater: ['Slow Current', 'Deep Field', 'Bloom at Depth', 'Tidewalkers', 'Blue Hours'],
  dinosaur: ['Long Necks', 'Before Us', 'Warm Bones', 'The Old Ones', 'Thunder Step'],
  monster: ['Friendly Teeth', 'Three Eyes', 'Grumble', 'Soft Beast', 'It Waves Back'],
  face: ['Almost Someone', 'Passing Look', 'Held Breath', 'A Kind Stranger', 'Half Lit'],
  cosmos: ['Far Signal', 'Quiet Orbit', 'Dust and Light', 'Night Engine', 'Distant Bloom'],
  botanical: ['Slow Growth', 'Green Noise', 'Unfolding', 'Small Garden', 'Leaf Study'],
  mountain: ['Nine Ridges', 'Cold Morning', 'The Long Walk', 'Far Country', 'Stone Weather'],
  city: ['Ten Thousand Windows', 'Sleepless', 'Grid at Night', 'Home Somewhere', 'Late Shift'],
  geometric: ['Balance Study', 'Six Decisions', 'Quiet Order', 'Interval', 'Square Song'],
  wave: ['Breathing', 'Long Line', 'Undertow', 'Tide Study', 'Slow Water'],
  lonely: ['One Small Figure', 'The Wide Part', 'Waiting Out', 'Nobody Yet', 'Far From'],
  bird: ['Leaving Together', 'Migration', 'Small Wings', 'Above the Field', 'Turning Flock'],
  machine: ['Kind Machine', 'Still Working', 'Old Engine', 'It Remembers', 'Gear Sleep'],
  insect: ['Symmetry', 'Night Moth', 'Small Architect', 'Wing Study', 'Quiet Visitor']
};

const title = (rng: Rng, key: string): string | null =>
  rng.chance(0.62) ? rng.pick(TITLES[key] ?? ['Untitled']) : null;

const blob = (rng: Rng, cx: number, cy: number, r: number, points = 8): string => {
  const pts: string[] = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const rr = r * rng.range(0.72, 1.28);
    pts.push(`${(cx + Math.cos(a) * rr).toFixed(1)},${(cy + Math.sin(a) * rr).toFixed(1)}`);
  }
  return `<polygon points="${pts.join(' ')}"`;
};

const GENERATORS: Record<string, Generator> = {
  underwater(rng, w, h) {
    const p = paletteOf(rng, 'deep');
    let body = backdrop(rng, w, h, p);
    for (let i = 0; i < rng.int(3, 6); i++) {
      const cx = rng.range(0.15, 0.85) * w;
      const cy = rng.range(0.2, 0.7) * h;
      const r = rng.range(0.05, 0.13) * w;
      body += `<g opacity="${rng.range(0.55, 0.95).toFixed(2)}">
        <ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r * 0.8}" fill="${rng.pick(p.slice(3))}" filter="url(#glow)"/>
        <ellipse cx="${cx}" cy="${cy}" rx="${r * 0.7}" ry="${r * 0.6}" fill="${p[4]}" opacity="0.5"/>`;
      for (let t = 0; t < 7; t++) {
        const x = cx - r * 0.6 + (t / 6) * r * 1.2;
        const len = rng.range(r, r * 3);
        body += `<path d="M${x} ${cy + r * 0.5} q ${rng.range(-14, 14)} ${len * 0.5} ${rng.range(-10, 10)} ${len}"
          stroke="${p[4]}" stroke-opacity="0.35" stroke-width="${rng.range(1, 3).toFixed(1)}" fill="none"/>`;
      }
      body += `</g>`;
    }
    for (let i = 0; i < 60; i++) {
      body += `<circle cx="${rng.range(0, w)}" cy="${rng.range(0, h)}" r="${rng.range(0.6, 2.6).toFixed(1)}" fill="${p[4]}" opacity="${rng.range(0.05, 0.3).toFixed(2)}"/>`;
    }
    body += grainOverlay(w, h);
    return {
      body,
      meta: {
        subject: 'underwater creatures drifting in deep water',
        mood: rng.pick(['peaceful', 'dreamy', 'mysterious']),
        style: 'organic',
        medium: 'digital',
        tags: ['underwater', 'ocean', 'jellyfish', 'water', 'blue', 'teal', 'creature', 'deep', 'glow'],
        caption: 'Jellyfish-like forms drifting through deep blue water, trailing soft tendrils of light.',
        title: title(rng, 'underwater')
      }
    };
  },

  dinosaur(rng, w, h) {
    const p = paletteOf(rng, rng.pick(['ember', 'violet', 'gold'] as const));
    let body = backdrop(rng, w, h, p);
    const ground = h * rng.range(0.68, 0.82);
    body += `<circle cx="${w * rng.range(0.2, 0.8)}" cy="${ground - h * 0.3}" r="${w * 0.12}" fill="${p[4]}" opacity="0.5" filter="url(#glow)"/>`;
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++) {
      const bx = w * rng.range(0.12, 0.78);
      const scale = rng.range(0.42, 0.78) * (w / 900);
      const col = i === 0 ? p[0] : p[1];
      const flip = rng.chance(0.35) ? -1 : 1;
      // Built from primitives rather than one path, so the long-necked shape
      // reads instantly at thumbnail size.
      body += `<g transform="translate(${bx.toFixed(1)} ${ground.toFixed(1)}) scale(${(scale * flip).toFixed(3)} ${scale.toFixed(3)})" fill="${col}" stroke="${col}" stroke-linecap="round">
        <path d="M60 -70 C -40 -40 -130 10 -210 0" stroke-width="26" fill="none"/>
        <ellipse cx="150" cy="-78" rx="128" ry="66"/>
        <path d="M232 -110 C 300 -160 316 -250 300 -330" stroke-width="40" fill="none"/>
        <ellipse cx="304" cy="-346" rx="42" ry="26" transform="rotate(-16 304 -346)"/>
        <rect x="60" y="-30" width="34" height="34" rx="10"/>
        <rect x="120" y="-26" width="32" height="30" rx="10"/>
        <rect x="186" y="-32" width="34" height="36" rx="10"/>
        <rect x="236" y="-26" width="30" height="30" rx="10"/>
        <circle cx="322" cy="-354" r="5" fill="${p[4]}" stroke="none"/>
      </g>`;
    }
    body += `<rect y="${ground}" width="${w}" height="${h - ground}" fill="${p[0]}" opacity="0.9"/>`;
    body += grainOverlay(w, h);
    return {
      body,
      meta: {
        subject: 'dinosaurs standing against a wide sky',
        mood: rng.pick(['solemn', 'nostalgic', 'mysterious']),
        style: 'graphic',
        medium: 'digital',
        tags: ['dinosaur', 'creature', 'animal', 'silhouette', 'sky', 'landscape', 'prehistoric'],
        caption: 'Long-necked dinosaurs in silhouette beneath a burning sky.',
        title: title(rng, 'dinosaur')
      }
    };
  },

  monster(rng, w, h) {
    const p = paletteOf(rng, rng.pick(['violet', 'moss', 'rose'] as const));
    let body = backdrop(rng, w, h, p);
    const cx = w / 2 + rng.range(-w * 0.1, w * 0.1);
    const cy = h / 2 + rng.range(-h * 0.08, h * 0.08);
    const r = Math.min(w, h) * rng.range(0.22, 0.32);
    body += `${blob(rng, cx, cy, r, rng.int(7, 11))} fill="${p[3]}" filter="url(#glow)" opacity="0.35"/>`;
    body += `${blob(rng, cx, cy, r * 0.92, rng.int(7, 11))} fill="${p[3]}"/>`;
    const eyes = rng.int(1, 4);
    for (let i = 0; i < eyes; i++) {
      const ex = cx + rng.range(-r * 0.5, r * 0.5);
      const ey = cy + rng.range(-r * 0.45, r * 0.15);
      const er = r * rng.range(0.08, 0.18);
      body += `<circle cx="${ex}" cy="${ey}" r="${er}" fill="${p[4]}"/>
               <circle cx="${ex + er * 0.2}" cy="${ey + er * 0.1}" r="${er * 0.45}" fill="${p[0]}"/>`;
    }
    const my = cy + r * rng.range(0.35, 0.6);
    body += `<path d="M${cx - r * 0.35} ${my} q ${r * 0.35} ${r * rng.range(0.15, 0.4)} ${r * 0.7} 0"
      stroke="${p[0]}" stroke-width="${r * 0.08}" fill="none" stroke-linecap="round"/>`;
    for (let i = 0; i < rng.int(0, 6); i++) {
      const a = rng.range(0, Math.PI * 2);
      body += `<line x1="${cx + Math.cos(a) * r * 0.85}" y1="${cy + Math.sin(a) * r * 0.85}"
        x2="${cx + Math.cos(a) * r * 1.25}" y2="${cy + Math.sin(a) * r * 1.25}"
        stroke="${p[3]}" stroke-width="${r * 0.06}" stroke-linecap="round"/>`;
    }
    body += grainOverlay(w, h);
    return {
      body,
      meta: {
        subject: 'a funny soft monster with too many eyes',
        mood: 'playful',
        style: 'illustrative',
        medium: 'digital',
        tags: ['monster', 'creature', 'funny', 'eyes', 'cute', 'blob', 'friendly'],
        caption: 'A soft rounded monster with several bright eyes and a small crooked smile.',
        title: title(rng, 'monster')
      }
    };
  },

  face(rng, w, h) {
    const p = paletteOf(rng, rng.pick(['rose', 'ember', 'violet'] as const));
    let body = backdrop(rng, w, h, p);
    const cx = w / 2;
    const cy = h * 0.52;
    const fw = w * rng.range(0.22, 0.3);
    const fh = h * rng.range(0.3, 0.4);
    body += `<ellipse cx="${cx}" cy="${cy}" rx="${fw * 1.1}" ry="${fh * 1.1}" fill="${p[3]}" opacity="0.28" filter="url(#glow)"/>`;
    body += `<ellipse cx="${cx}" cy="${cy}" rx="${fw}" ry="${fh}" fill="${p[3]}" opacity="0.95"/>`;
    body += `<ellipse cx="${cx - fw * 0.3}" cy="${cy - fh * 0.15}" rx="${fw * 0.16}" ry="${fh * 0.07}" fill="${p[4]}"/>`;
    body += `<ellipse cx="${cx + fw * 0.32}" cy="${cy - fh * rng.range(0.1, 0.28)}" rx="${fw * 0.14}" ry="${fh * 0.06}" fill="${p[4]}"/>`;
    body += `<path d="M${cx - fw * 0.06} ${cy - fh * 0.05} q ${fw * 0.16} ${fh * 0.2} ${-fw * 0.02} ${fh * 0.3}"
      stroke="${p[0]}" stroke-width="3" fill="none"/>`;
    body += `<path d="M${cx - fw * 0.28} ${cy + fh * 0.5} q ${fw * 0.3} ${fh * rng.range(-0.12, 0.22)} ${fw * 0.56} 0"
      stroke="${p[0]}" stroke-width="4" fill="none" stroke-linecap="round"/>`;
    for (let i = 0; i < rng.int(2, 6); i++) {
      body += `<path d="M${rng.range(0, w)} 0 L ${rng.range(0, w)} ${h}" stroke="${p[4]}" stroke-opacity="0.07" stroke-width="${rng.range(6, 40)}"/>`;
    }
    body += grainOverlay(w, h);
    return {
      body,
      meta: {
        subject: 'a strange half-abstract face',
        mood: rng.pick(['melancholy', 'mysterious', 'tender', 'eerie']),
        style: 'expressive',
        medium: 'painting',
        tags: ['face', 'portrait', 'figure', 'eyes', 'strange', 'abstract', 'person'],
        caption: 'An abstracted face with mismatched eyes, looking slightly past the viewer.',
        title: title(rng, 'face')
      }
    };
  },

  cosmos(rng, w, h) {
    const p = paletteOf(rng, rng.pick(['violet', 'deep'] as const));
    let body = backdrop(rng, w, h, p);
    for (let i = 0; i < 240; i++) {
      const r = rng.range(0.4, 2.2);
      body += `<circle cx="${rng.range(0, w).toFixed(1)}" cy="${rng.range(0, h).toFixed(1)}" r="${r.toFixed(1)}" fill="${p[4]}" opacity="${rng.range(0.15, 0.95).toFixed(2)}"/>`;
    }
    const px = rng.range(0.25, 0.75) * w;
    const py = rng.range(0.3, 0.7) * h;
    const pr = Math.min(w, h) * rng.range(0.1, 0.2);
    body += `<circle cx="${px}" cy="${py}" r="${pr * 1.6}" fill="${p[3]}" opacity="0.25" filter="url(#softer)"/>`;
    body += `<circle cx="${px}" cy="${py}" r="${pr}" fill="${p[3]}"/>`;
    body += `<ellipse cx="${px}" cy="${py}" rx="${pr * 1.9}" ry="${pr * 0.42}" fill="none" stroke="${p[4]}" stroke-opacity="0.5" stroke-width="${pr * 0.06}" transform="rotate(${rng.range(-30, 30)} ${px} ${py})"/>`;
    body += grainOverlay(w, h);
    return {
      body,
      meta: {
        subject: 'a planet and stars in deep space',
        mood: rng.pick(['peaceful', 'lonely', 'dreamy']),
        style: 'illustrative',
        medium: 'digital',
        tags: ['space', 'star', 'planet', 'cosmos', 'night', 'sky', 'dark', 'galaxy'],
        caption: 'A ringed planet suspended in a field of stars.',
        title: title(rng, 'cosmos')
      }
    };
  },

  botanical(rng, w, h) {
    const p = paletteOf(rng, 'moss');
    let body = backdrop(rng, w, h, p);
    const stems = rng.int(3, 7);
    for (let i = 0; i < stems; i++) {
      const x = (w / (stems + 1)) * (i + 1) + rng.range(-20, 20);
      const top = h * rng.range(0.15, 0.4);
      body += `<path d="M${x} ${h} C ${x + rng.range(-60, 60)} ${h * 0.7}, ${x + rng.range(-60, 60)} ${h * 0.45}, ${x} ${top}"
        stroke="${p[3]}" stroke-width="${rng.range(2, 5).toFixed(1)}" fill="none"/>`;
      const leaves = rng.int(3, 8);
      for (let l = 0; l < leaves; l++) {
        const t = (l + 1) / (leaves + 1);
        const ly = h - (h - top) * t;
        const side = l % 2 ? 1 : -1;
        const lw = rng.range(20, 60);
        body += `<path d="M${x} ${ly} q ${side * lw * 0.6} ${-lw * 0.5} ${side * lw} 0 q ${-side * lw * 0.6} ${lw * 0.45} ${-side * lw} 0 z"
          fill="${rng.pick(p.slice(2))}" opacity="${rng.range(0.6, 0.95).toFixed(2)}"/>`;
      }
      if (rng.chance(0.5)) {
        body += `<circle cx="${x}" cy="${top}" r="${rng.range(10, 26).toFixed(1)}" fill="${p[4]}" opacity="0.85"/>`;
      }
    }
    body += grainOverlay(w, h);
    return {
      body,
      meta: {
        subject: 'plants and leaves growing upward',
        mood: 'peaceful',
        style: 'organic',
        medium: 'print',
        tags: ['plant', 'flower', 'leaf', 'botanical', 'green', 'garden', 'growth', 'nature'],
        caption: 'Slender stems with paired leaves and small pale blossoms.',
        title: title(rng, 'botanical')
      }
    };
  },

  mountain(rng, w, h) {
    const p = paletteOf(rng, rng.pick(['deep', 'ash', 'gold'] as const));
    let body = backdrop(rng, w, h, p);
    body += `<circle cx="${w * rng.range(0.2, 0.8)}" cy="${h * rng.range(0.15, 0.32)}" r="${Math.min(w, h) * 0.07}" fill="${p[4]}" opacity="0.9" filter="url(#glow)"/>`;
    const layers = rng.int(4, 7);
    for (let i = 0; i < layers; i++) {
      const base = h * (0.45 + (i / layers) * 0.5);
      const amp = h * rng.range(0.05, 0.16) * (1 - i / (layers + 2));
      let d = `M0 ${h} L0 ${base}`;
      const steps = 8;
      for (let s = 0; s <= steps; s++) {
        const x = (w / steps) * s;
        const y = base - Math.abs(Math.sin(s * rng.range(0.7, 1.6) + i)) * amp * 2;
        d += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      d += ` L${w} ${h} Z`;
      body += `<path d="${d}" fill="${p[Math.min(4, i)] ?? p[0]}" opacity="${(0.55 + i * 0.09).toFixed(2)}"/>`;
    }
    body += grainOverlay(w, h);
    return {
      body,
      meta: {
        subject: 'layered mountain ridges at dusk',
        mood: rng.pick(['peaceful', 'solemn', 'lonely']),
        style: 'minimal',
        medium: 'print',
        tags: ['mountain', 'landscape', 'ridge', 'horizon', 'sky', 'quiet', 'distance'],
        caption: 'Receding mountain ridges fading into haze under a low sun.',
        title: title(rng, 'mountain')
      }
    };
  },

  city(rng, w, h) {
    const p = paletteOf(rng, rng.pick(['ash', 'violet', 'ember'] as const));
    let body = backdrop(rng, w, h, p);
    const base = h * rng.range(0.78, 0.9);
    let x = 0;
    while (x < w) {
      const bw = rng.range(w * 0.04, w * 0.11);
      const bh = rng.range(h * 0.12, h * 0.55);
      body += `<rect x="${x.toFixed(1)}" y="${(base - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${p[0]}" opacity="0.95"/>`;
      const cols = Math.max(1, Math.floor(bw / 14));
      const rows = Math.max(1, Math.floor(bh / 18));
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          if (!rng.chance(0.38)) continue;
          body += `<rect x="${(x + 5 + c * 14).toFixed(1)}" y="${(base - bh + 8 + r * 18).toFixed(1)}" width="6" height="9" fill="${p[4]}" opacity="${rng.range(0.3, 0.95).toFixed(2)}"/>`;
        }
      }
      x += bw + rng.range(2, 10);
    }
    body += `<rect y="${base}" width="${w}" height="${h - base}" fill="${p[0]}"/>`;
    body += grainOverlay(w, h);
    return {
      body,
      meta: {
        subject: 'a city skyline at night with lit windows',
        mood: rng.pick(['lonely', 'nostalgic', 'hopeful']),
        style: 'graphic',
        medium: 'digital',
        tags: ['city', 'architecture', 'building', 'night', 'window', 'skyline', 'urban', 'dark'],
        caption: 'A dense skyline at night, thousands of small windows still lit.',
        title: title(rng, 'city')
      }
    };
  },

  geometric(rng, w, h) {
    const p = paletteOf(rng, rng.pick(['gold', 'rose', 'ash', 'violet'] as const));
    let body = backdrop(rng, w, h, p);
    for (let i = 0; i < rng.int(5, 11); i++) {
      const kind = rng.int(0, 2);
      const cx = rng.range(0.15, 0.85) * w;
      const cy = rng.range(0.15, 0.85) * h;
      const s = rng.range(0.06, 0.22) * Math.min(w, h);
      const fill = rng.pick(p.slice(2));
      const op = rng.range(0.55, 0.95).toFixed(2);
      if (kind === 0) body += `<circle cx="${cx}" cy="${cy}" r="${s}" fill="${fill}" opacity="${op}"/>`;
      else if (kind === 1)
        body += `<rect x="${cx - s}" y="${cy - s}" width="${s * 2}" height="${s * 2}" fill="${fill}" opacity="${op}" transform="rotate(${rng.range(0, 90).toFixed(1)} ${cx} ${cy})"/>`;
      else
        body += `<polygon points="${cx},${cy - s} ${cx + s},${cy + s} ${cx - s},${cy + s}" fill="${fill}" opacity="${op}"/>`;
    }
    body += grainOverlay(w, h);
    return {
      body,
      meta: {
        subject: 'overlapping geometric shapes',
        mood: rng.pick(['playful', 'peaceful', 'energetic']),
        style: 'geometric',
        medium: 'print',
        tags: ['geometric', 'abstract', 'shapes', 'circle', 'square', 'pattern', 'balance'],
        caption: 'Flat circles, squares and triangles overlapping in a balanced arrangement.',
        title: title(rng, 'geometric')
      }
    };
  },

  wave(rng, w, h) {
    const p = paletteOf(rng, rng.pick(['deep', 'violet', 'moss'] as const));
    let body = backdrop(rng, w, h, p);
    const lines = rng.int(18, 40);
    for (let i = 0; i < lines; i++) {
      const y = (h / lines) * i + rng.range(-6, 6);
      const amp = rng.range(8, 40);
      let d = `M0 ${y.toFixed(1)}`;
      for (let x = 0; x <= w; x += w / 8) {
        d += ` Q ${(x + w / 16).toFixed(1)} ${(y + Math.sin(x / 90 + i * 0.4) * amp).toFixed(1)} ${(x + w / 8).toFixed(1)} ${y.toFixed(1)}`;
      }
      body += `<path d="${d}" stroke="${rng.pick(p.slice(2))}" stroke-opacity="${rng.range(0.25, 0.8).toFixed(2)}" stroke-width="${rng.range(1, 3.5).toFixed(1)}" fill="none"/>`;
    }
    body += grainOverlay(w, h);
    return {
      body,
      meta: {
        subject: 'flowing lines like moving water',
        mood: rng.pick(['peaceful', 'dreamy']),
        style: 'line-art',
        medium: 'ink',
        tags: ['water', 'wave', 'line', 'flow', 'abstract', 'ocean', 'calm', 'smooth'],
        caption: 'Parallel drawn lines rippling across the surface like slow water.',
        title: title(rng, 'wave')
      }
    };
  },

  lonely(rng, w, h) {
    const p = paletteOf(rng, rng.pick(['ash', 'deep'] as const));
    let body = backdrop(rng, w, h, p);
    const horizon = h * rng.range(0.62, 0.78);
    body += `<rect y="${horizon}" width="${w}" height="${h - horizon}" fill="${p[0]}" opacity="0.85"/>`;
    const fx = w * rng.range(0.2, 0.8);
    const fh = h * rng.range(0.05, 0.09);
    body += `<ellipse cx="${fx}" cy="${horizon + 4}" rx="${fh * 0.5}" ry="${fh * 0.09}" fill="${p[0]}" opacity="0.7"/>`;
    body += `<rect x="${fx - fh * 0.1}" y="${horizon - fh}" width="${fh * 0.2}" height="${fh}" rx="${fh * 0.1}" fill="${p[0]}"/>`;
    body += `<circle cx="${fx}" cy="${horizon - fh - fh * 0.12}" r="${fh * 0.13}" fill="${p[0]}"/>`;
    body += grainOverlay(w, h);
    return {
      body,
      meta: {
        subject: 'one small figure alone in a wide empty landscape',
        mood: 'lonely',
        style: 'minimal',
        medium: 'photograph',
        tags: ['figure', 'alone', 'empty', 'landscape', 'quiet', 'solitude', 'horizon', 'sad'],
        caption: 'A single small figure standing far off in an otherwise empty field.',
        title: title(rng, 'lonely')
      }
    };
  },

  bird(rng, w, h) {
    const p = paletteOf(rng, rng.pick(['gold', 'ash', 'ember'] as const));
    let body = paleBackdrop(rng, w, h, p);
    const n = rng.int(14, 40);
    for (let i = 0; i < n; i++) {
      const x = rng.range(0.05, 0.95) * w;
      const y = rng.range(0.1, 0.75) * h;
      const s = rng.range(6, 26) * (1 - y / h + 0.4);
      body += `<path d="M${x - s} ${y} q ${s * 0.5} ${-s * 0.6} ${s} 0 q ${s * 0.5} ${-s * 0.6} ${s} 0"
        stroke="${p[0]}" stroke-width="${Math.max(1.2, s * 0.12).toFixed(1)}" fill="none" stroke-linecap="round" opacity="${rng.range(0.5, 1).toFixed(2)}"/>`;
    }
    body += grainOverlay(w, h);
    return {
      body,
      meta: {
        subject: 'a flock of birds crossing an open sky',
        mood: rng.pick(['hopeful', 'nostalgic', 'peaceful']),
        style: 'minimal',
        medium: 'ink',
        tags: ['bird', 'flock', 'sky', 'flight', 'animal', 'migration', 'open'],
        caption: 'Dozens of small birds turning together across a pale sky.',
        title: title(rng, 'bird')
      }
    };
  },

  machine(rng, w, h) {
    const p = paletteOf(rng, rng.pick(['ash', 'gold', 'deep'] as const));
    let body = backdrop(rng, w, h, p);
    for (let i = 0; i < rng.int(3, 7); i++) {
      const cx = rng.range(0.15, 0.85) * w;
      const cy = rng.range(0.15, 0.85) * h;
      const r = rng.range(0.05, 0.16) * Math.min(w, h);
      const teeth = rng.int(8, 16);
      let d = '';
      for (let t = 0; t < teeth; t++) {
        const a0 = (t / teeth) * Math.PI * 2;
        const a1 = ((t + 0.5) / teeth) * Math.PI * 2;
        d += `${t === 0 ? 'M' : 'L'}${(cx + Math.cos(a0) * r * 1.18).toFixed(1)} ${(cy + Math.sin(a0) * r * 1.18).toFixed(1)} `;
        d += `L${(cx + Math.cos(a1) * r).toFixed(1)} ${(cy + Math.sin(a1) * r).toFixed(1)} `;
      }
      body += `<path d="${d}Z" fill="${rng.pick(p.slice(2))}" opacity="0.9"/>`;
      body += `<circle cx="${cx}" cy="${cy}" r="${r * 0.35}" fill="${p[0]}"/>`;
    }
    body += grainOverlay(w, h);
    return {
      body,
      meta: {
        subject: 'interlocking gears of an old machine',
        mood: rng.pick(['nostalgic', 'solemn', 'playful']),
        style: 'graphic',
        medium: 'print',
        tags: ['machine', 'gear', 'robot', 'metal', 'mechanical', 'industrial', 'pattern'],
        caption: 'Interlocking toothed gears from some patient old machine.',
        title: title(rng, 'machine')
      }
    };
  },

  insect(rng, w, h) {
    const p = paletteOf(rng, rng.pick(['rose', 'violet', 'moss'] as const));
    let body = backdrop(rng, w, h, p);
    const cx = w / 2;
    const cy = h / 2;
    const s = Math.min(w, h) * rng.range(0.2, 0.32);
    for (const side of [-1, 1]) {
      body += `<path d="M${cx} ${cy} c ${side * s * 1.2} ${-s * 1.1} ${side * s * 1.5} ${s * 0.1} ${side * s * 0.5} ${s * 0.75}
                       c ${-side * s * 0.35} ${s * 0.25} ${-side * s * 0.5} ${-s * 0.2} ${-side * s * 0.5} ${-s * 0.75} z"
        fill="${p[3]}" opacity="0.9"/>`;
      body += `<path d="M${cx} ${cy} c ${side * s * 0.8} ${s * 0.2} ${side * s * 0.75} ${s * 0.8} ${side * s * 0.2} ${s * 0.95}
                       c ${-side * s * 0.25} ${-s * 0.05} ${-side * s * 0.3} ${-s * 0.5} ${-side * s * 0.2} ${-s * 0.95} z"
        fill="${p[2]}" opacity="0.9"/>`;
      body += `<path d="M${cx} ${cy - s * 0.25} q ${side * s * 0.3} ${-s * 0.5} ${side * s * 0.45} ${-s * 0.55}"
        stroke="${p[4]}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
    }
    body += `<ellipse cx="${cx}" cy="${cy + s * 0.1}" rx="${s * 0.09}" ry="${s * 0.5}" fill="${p[0]}"/>`;
    body += grainOverlay(w, h);
    return {
      body,
      meta: {
        subject: 'a symmetrical moth with patterned wings',
        mood: rng.pick(['dreamy', 'eerie', 'tender']),
        style: 'illustrative',
        medium: 'watercolour',
        tags: ['insect', 'moth', 'butterfly', 'wing', 'symmetrical', 'pattern', 'night', 'animal'],
        caption: 'A symmetrical moth with patterned wings and feathered antennae.',
        title: title(rng, 'insect')
      }
    };
  }
};

export const THEMES = Object.keys(GENERATORS);

export function generatePiece(theme: string, seed: string): SeedPiece {
  const rng = new Rng(`${theme}:${seed}`);
  const landscape = rng.chance(0.55);
  const w = landscape ? 1100 : 820;
  const h = landscape ? 780 : 1080;
  const gen = GENERATORS[theme];
  const { body, meta } = gen(rng, w, h);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
  return { svg, meta, width: w, height: h };
}
