import type { ArtworkDetail, UniverseNode, UniverseView } from '../../shared/types.js';
import { api, hasKey, rememberedArtKey, setKeySession } from './net/api.js';
import { analytics } from './analytics.js';
import { Camera } from './universe/camera.js';
import { Scene } from './universe/scene.js';
import { UniverseRenderer } from './universe/renderer.js';
import { UniverseInput } from './universe/input.js';
import { Stage } from './ui/stage.js';
import { SearchControl } from './ui/search.js';
import { hideDetail, renderDetail } from './ui/detail.js';
import { openUpload } from './ui/upload.js';
import { openArtKeyReturn, showNewArtKey } from './ui/artkey.js';
import { announce, el, toast } from './ui/dom.js';

const canvas = document.getElementById('universe') as HTMLCanvasElement;
const detailPanel = document.getElementById('detail') as HTMLElement;
const stage = new Stage(document.getElementById('stage') as HTMLElement);
const a11yList = document.getElementById('a11y-list') as HTMLUListElement;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let reduced = reducedMotion.matches;

// A phone screen shows less area, so it opens further out — mobile is designed
// for itself rather than shrunk from the desktop layout.
const openingZoom = Math.max(0.26, Math.min(0.42, (window.innerWidth / 1400) * 0.42 + 0.16));
const camera = new Camera(window.innerWidth, window.innerHeight, reduced);
camera.zoom = openingZoom;
camera.targetZoom = openingZoom;
const scene = new Scene();
const renderer = new UniverseRenderer(canvas);
scene.setReducedMotion(reduced);
renderer.settings.reducedMotion = reduced;

let selectedRef: string | null = null;
let lastLoadedAt = 0;
let lastLoadCentre = { x: NaN, y: NaN, zoom: 0 };
let loading = false;
let inMyUniverse = false;

/* ---------------------------------------------------------------- rendering */

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.resize(width, height);
  renderer.resize(width, height, Math.min(window.devicePixelRatio || 1, 2));
}
window.addEventListener('resize', resize);
resize();

let lastFrame = performance.now();
let slowFrames = 0;
let lastSlowReport = 0;

function frame(now: number) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  camera.step(dt);
  scene.step(dt, now / 1000);
  renderer.render(scene, camera, now / 1000);

  // Anonymous performance signal, heavily throttled.
  if (renderer.lastFrameCost > 26) slowFrames++;
  if (slowFrames > 90 && now - lastSlowReport > 60_000) {
    analytics.track('render_slow', { cost: Math.round(renderer.lastFrameCost) });
    lastSlowReport = now;
    slowFrames = 0;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ------------------------------------------------------------------ loading */

/** Pull in whatever lives in the current viewport, if we have drifted enough. */
async function loadViewport(force = false) {
  if (loading || inMyUniverse) return;
  const moved =
    Math.hypot(camera.x - lastLoadCentre.x, camera.y - lastLoadCentre.y) >
      400 / Math.max(camera.zoom, 0.08) ||
    Math.abs(Math.log2(camera.zoom / (lastLoadCentre.zoom || camera.zoom))) > 0.6;
  if (!force && !moved && performance.now() - lastLoadedAt < 4000) return;

  loading = true;
  try {
    const view = await api.universe(camera.viewport(1.4));
    scene.apply(view, { mode: scene.mode === 'search' ? 'search' : 'universe', retarget: scene.mode === 'universe' });
    lastLoadedAt = performance.now();
    lastLoadCentre = { x: camera.x, y: camera.y, zoom: camera.zoom };
    refreshA11y();
  } catch {
    /* the universe simply stays as it is */
  } finally {
    loading = false;
  }
}

/* ------------------------------------------------------------------ selection */

async function select(ref: string, opts: { travel?: boolean; push?: boolean } = {}) {
  selectedRef = ref;
  scene.focusOn(ref);
  searchControl.noteSelection();
  analytics.track('artwork_selected');

  const node = scene.nodes.get(ref);
  if (node && opts.travel !== false) {
    camera.travelTo(node.homeX, node.homeY, Math.max(camera.zoom, 0.85));
  }
  if (opts.push !== false && location.pathname !== `/art/${ref}`) {
    history.pushState({ ref }, '', `/art/${ref}`);
  }

  try {
    const detail = await api.artwork(ref);
    showDetail(detail);
  } catch {
    toast('That artwork is no longer here');
    deselect();
  }

  // Selection is also an invitation to keep going outward.
  try {
    const view = await api.around(ref);
    scene.apply(view, { retarget: false });
    scene.focusOn(ref);
    refreshA11y();
  } catch {
    /* the current arrangement stands */
  }
}

function showDetail(detail: ArtworkDetail) {
  renderDetail(detailPanel, detail, {
    onReact: async (kind) => {
      try {
        await api.react(detail.ref, kind);
        analytics.track('reaction', { kind });
        showDetail({ ...detail, reacted: [...new Set([...detail.reacted, kind])] });
        announce(kind === 'inspired' ? 'Marked as inspiring.' : 'Appreciated.');
      } catch {
        toast('That did not go through');
      }
    },
    onRespond: () => {
      analytics.track('respond_started');
      openUpload({ stage, respondsTo: detail.ref, onPublished });
    },
    onExploreSimilar: () => void exploreSimilar(detail.ref),
    onReport: async (reason) => {
      try {
        await api.report(detail.ref, reason);
        toast('Thank you. Someone will look.');
      } catch {
        toast('That did not go through');
      }
    },
    onClose: deselect,
    onVisibility: async (next) => {
      try {
        await api.updateMine(detail.ref, { visibility: next });
        toast(next === 'private' ? 'Now private' : 'Back in the universe');
        void select(detail.ref, { travel: false, push: false });
      } catch {
        toast('Only your Art Key can change that');
      }
    },
    onWithdraw: async () => {
      try {
        await api.withdraw(detail.ref);
        scene.nodes.delete(detail.ref);
        deselect();
        toast('Withdrawn from the universe');
      } catch {
        toast('Only your Art Key can do that');
      }
    }
  });
}

function deselect() {
  if (!selectedRef) return;
  selectedRef = null;
  scene.release();
  hideDetail(detailPanel);
  analytics.track('artwork_deselected');
  if (location.pathname.startsWith('/art/')) history.pushState({}, '', '/');
  void loadViewport(true);
}

async function exploreSimilar(ref: string) {
  analytics.track('explore_similar');
  try {
    const view = await api.similar(ref);
    applyReorganisation(view, 'similar');
  } catch {
    toast('Nothing nearby right now');
  }
}

/* ------------------------------------------------- reorganising the universe */

/**
 * A search or an "explore similar" does not open a page. It changes what the
 * universe is doing: the relevant work travels toward you, the rest drifts off.
 */
function applyReorganisation(view: UniverseView, kind: 'search' | 'similar') {
  scene.apply(view, { retarget: false });
  const centre = view.focus ?? { x: camera.x, y: camera.y };
  scene.arrangeAroundPoint(view.nodes.map((n) => n.ref), centre, searchSpread);
  camera.travelTo(centre.x, centre.y, kind === 'search' ? 0.5 : 0.62);
  refreshA11y();
  announce(
    view.nodes.length
      ? `The universe reorganised around ${view.nodes.length} artworks.`
      : 'Nothing found. The universe is unchanged.'
  );
}

function onPublished(node: UniverseNode, artKey?: string) {
  // The publishing moment: it arrives large in front of you, then shrinks and
  // travels out to the place its own meaning gave it.
  const scene_node = scene.add(node);
  scene_node.x = camera.x;
  scene_node.y = camera.y;
  scene_node.alpha = 1;
  scene_node.scale = reduced ? 1 : 3.2;
  scene_node.targetScale = 1;
  camera.travelTo(node.x, node.y, 0.85);
  announce('Your art found its place.');
  if (!artKey) toast('Your art found its place.');
  window.setTimeout(() => void loadViewport(true), reduced ? 0 : 1600);
  window.setTimeout(() => void select(node.ref, { travel: false }), reduced ? 100 : 2400);
  // The key arrives only after the piece has settled into the universe.
  if (artKey) {
    window.setTimeout(() => showNewArtKey(stage, artKey), reduced ? 300 : 3000);
  }
}

/* ------------------------------------------------------------ my universe */

async function enterMyUniverse() {
  try {
    const mine = await api.myUniverse();
    if (!mine.nodes.length) {
      toast('Your universe is waiting for its first piece');
      return;
    }
    inMyUniverse = true;
    scene.nodes.clear();
    scene.apply({ nodes: mine.nodes, edges: mine.edges, context: 'mine' }, { mode: 'mine' });
    const cx = mine.nodes.reduce((a, n) => a + n.x, 0) / mine.nodes.length;
    const cy = mine.nodes.reduce((a, n) => a + n.y, 0) / mine.nodes.length;
    // Their own work, arranged as its own constellation.
    scene.arrangeAroundPoint(mine.nodes.map((n) => n.ref), { x: cx, y: cy }, 0.8);
    camera.travelTo(cx, cy, 0.6);
    document.getElementById('ctl-key')?.classList.add('is-active');
    refreshA11y();
    announce('Your universe.');
  } catch {
    setKeySession(null);
    openArtKeyReturn({ stage, onReturned: () => { stage.close(); void enterMyUniverse(); } });
  }
}

function leaveMyUniverse() {
  inMyUniverse = false;
  document.getElementById('ctl-key')?.classList.remove('is-active');
  scene.nodes.clear();
  scene.release();
  void loadViewport(true);
}

/* ---------------------------------------------------------------- controls */

const searchControl = new SearchControl(
  document.getElementById('search-panel') as HTMLFormElement,
  document.getElementById('search-input') as HTMLInputElement,
  document.getElementById('search-suggestions') as HTMLUListElement,
  document.getElementById('ctl-search') as HTMLButtonElement,
  {
    onSearch: async (query) => {
      try {
        const view = await api.search(query);
        if (inMyUniverse) leaveMyUniverse();
        applyReorganisation(view, 'search');
      } catch {
        toast('Search could not run just now');
      }
    },
    onOpened: () => undefined,
    onClosed: () => undefined
  }
);

let searchSpread = 1;

document.getElementById('ctl-upload')?.addEventListener('click', () => {
  openUpload({ stage, onPublished });
});

document.getElementById('ctl-home')?.addEventListener('click', () => {
  if (inMyUniverse) leaveMyUniverse();
  deselect();
  scene.release();
  camera.travelTo(0, 0, 0.42);
  void loadViewport(true);
});

document.getElementById('ctl-key')?.addEventListener('click', () => {
  if (inMyUniverse) {
    leaveMyUniverse();
    return;
  }
  if (hasKey()) {
    const remembered = rememberedArtKey();
    if (!localStorage.getItem('au.keysession') && remembered) {
      void api
        .returnWithKey(remembered)
        .then(({ session }) => {
          setKeySession(session);
          return enterMyUniverse();
        })
        .catch(() => openArtKeyReturn({ stage, onReturned: () => { stage.close(); void enterMyUniverse(); } }));
      return;
    }
    void enterMyUniverse();
    return;
  }
  openArtKeyReturn({ stage, onReturned: () => { stage.close(); void enterMyUniverse(); } });
});

/* ------------------------------------------------------------------- input */

new UniverseInput(
  canvas,
  camera,
  {
    onTap: (sx, sy) => {
      const node = renderer.pick(scene, camera, sx, sy);
      if (node) void select(node.ref);
      else deselect();
    },
    onHover: (sx, sy) => {
      const node = renderer.pick(scene, camera, sx, sy);
      renderer.hoverRef = node?.ref ?? null;
      canvas.style.cursor = node ? 'pointer' : '';
    },
    onMove: () => {
      analytics.track('camera_moved', { zoom: camera.zoom });
      void loadViewport();
    },
    onGestureFailed: () => analytics.track('gesture_failed')
  },
  reduced
);

/* Keyboard navigation over the whole surface. */
document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
  const step = 260 / camera.zoom;
  switch (event.key) {
    case 'ArrowLeft': camera.travelTo(camera.targetX - step, camera.targetY); break;
    case 'ArrowRight': camera.travelTo(camera.targetX + step, camera.targetY); break;
    case 'ArrowUp': camera.travelTo(camera.targetX, camera.targetY - step); break;
    case 'ArrowDown': camera.travelTo(camera.targetX, camera.targetY + step); break;
    case '+': case '=': camera.zoomAt(camera.width / 2, camera.height / 2, 1.3); break;
    case '-': case '_': camera.zoomAt(camera.width / 2, camera.height / 2, 1 / 1.3); break;
    case 'Escape': deselect(); return;
    default: return;
  }
  event.preventDefault();
  void loadViewport();
});

/* ----------------------------------------------- screen-reader / keyboard list */

/**
 * The canvas is unreadable to assistive technology, so the same artworks are
 * mirrored as real focusable buttons positioned over their nodes. Minimal must
 * never mean inaccessible.
 */
function refreshA11y() {
  const nodes = [...scene.nodes.values()]
    .filter((n) => n.alpha > 0.4)
    .sort(
      (a, b) =>
        Math.hypot(a.x - camera.x, a.y - camera.y) - Math.hypot(b.x - camera.x, b.y - camera.y)
    )
    .slice(0, 24);

  a11yList.replaceChildren(
    ...nodes.map((node) => {
      const button = el('button', {
        type: 'button',
        'aria-label': `${node.title ?? 'Untitled artwork'}${node.respondsTo ? ', a response to another artwork' : ''}${node.gravity > 0.35 ? ', being discovered' : ''}`
      }, [node.title ?? 'Untitled artwork']);
      button.style.left = `${camera.worldToScreenX(node.x)}px`;
      button.style.top = `${camera.worldToScreenY(node.y)}px`;
      button.addEventListener('focus', () => {
        renderer.keyboardRef = node.ref;
        camera.travelTo(node.homeX, node.homeY);
      });
      button.addEventListener('blur', () => {
        if (renderer.keyboardRef === node.ref) renderer.keyboardRef = null;
      });
      button.addEventListener('click', () => void select(node.ref));
      return el('li', {}, [button]);
    })
  );
}
setInterval(refreshA11y, 2500);

/* ------------------------------------------------------------------ routing */

window.addEventListener('popstate', () => {
  const match = /^\/art\/([A-Z0-9]+)$/i.exec(location.pathname);
  if (match) void select(match[1].toUpperCase(), { push: false });
  else deselect();
});

reducedMotion.addEventListener('change', (event) => {
  reduced = event.matches;
  camera.setReducedMotion(reduced);
  scene.setReducedMotion(reduced);
  renderer.settings.reducedMotion = reduced;
});

/* --------------------------------------------------------------------- boot */

async function boot() {
  analytics.track('universe_opened');
  analytics.track('control_shown', { control: 'search' });

  // Whatever the evolution engine is currently testing, applied here.
  try {
    const { variant } = await api.assignment();
    if (typeof variant.nodeBudget === 'number') {
      renderer.settings.nodeBudget = variant.nodeBudget;
      scene.budget = Math.max(160, variant.nodeBudget);
    }
    if (typeof variant.searchSpread === 'number') searchSpread = variant.searchSpread;
    if (variant.showSuggestions === false) searchControl.showSuggestions = false;
  } catch {
    /* defaults are fine */
  }

  await loadViewport(true);

  const match = /^\/art\/([A-Z0-9]+)$/i.exec(location.pathname);
  if (match) {
    await select(match[1].toUpperCase(), { push: false });
  } else if (scene.nodes.size) {
    // Open somewhere with something in it, rather than on empty space.
    const nodes = [...scene.nodes.values()];
    const anchor = nodes[Math.floor(Math.random() * nodes.length)];
    camera.x = anchor.x;
    camera.y = anchor.y;
    camera.targetX = anchor.x;
    camera.targetY = anchor.y;
    void loadViewport(true);
  }
  announce('A universe of art. Use the arrow keys to move, or Tab to reach the artworks near you.');
}

void boot();
