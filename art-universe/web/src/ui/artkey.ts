import QRCode from 'qrcode';
import { api, rememberArtKey, rememberedArtKey, setKeySession } from '../net/api.js';
import { analytics } from '../analytics.js';
import { announce, el, toast } from './dom.js';
import type { Stage } from './stage.js';

/**
 * The Art Key: anonymous ownership, shown exactly once.
 *
 * It is never called a token, never appears in a URL, and the server holds only
 * a slow hash of it. If it is lost, it is lost — so this screen makes keeping
 * it easy: copy, save, a QR code, or remember it on this device.
 */
export function showNewArtKey(stage: Stage, key: string) {
  const qrCanvas = el('canvas', { 'aria-label': 'Your Art Key as a QR code' }) as HTMLCanvasElement;
  void QRCode.toCanvas(qrCanvas, key, {
    width: 168,
    margin: 1,
    color: { dark: '#0a0d18', light: '#ffffff' }
  });

  const copy = el('button', { class: 'btn', type: 'button' }, ['Copy']);
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(key);
      toast('Art Key copied');
    } catch {
      toast('Select the key and copy it');
    }
  });

  const save = el('button', { class: 'btn', type: 'button' }, ['Save']);
  save.addEventListener('click', () => downloadKeyCard(key, qrCanvas));

  const remember = el('button', { class: 'btn', type: 'button' }, ['Remember on this device']);
  remember.addEventListener('click', () => {
    rememberArtKey(key);
    remember.textContent = 'Remembered here';
    remember.setAttribute('disabled', '');
    toast('This device will bring you back automatically');
  });

  const done = el('button', { class: 'btn btn-primary', type: 'button' }, ['I have kept it']);
  done.addEventListener('click', () => stage.close());

  announce('Your Art Key was created. Keep it to return to your artwork.');

  stage.open(
    el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Your Art Key' }, [
      el('h2', {}, ['Your art found its place.']),
      el('div', { class: 'artkey' }, [
        el('code', { tabindex: '0' }, [key]),
        qrCanvas
      ]),
      el('p', {}, ['Keep your Art Key. It lets you return to your artwork.']),
      el('p', { class: 'quiet' }, ['It is shown once, and nobody else ever sees it — not even us.']),
      el('div', { class: 'row' }, [copy, save, remember]),
      el('div', { class: 'row end' }, [done])
    ]),
    { dismissable: false }
  );
}

/** A small card with the key and its QR, so it can live on paper. */
function downloadKeyCard(key: string, qr: HTMLCanvasElement) {
  const card = document.createElement('canvas');
  card.width = 640;
  card.height = 420;
  const ctx = card.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#070b16';
  ctx.fillRect(0, 0, card.width, card.height);
  ctx.drawImage(qr, (card.width - 220) / 2, 44, 220, 220);
  ctx.fillStyle = '#e8ecf7';
  ctx.textAlign = 'center';
  ctx.font = '500 26px ui-monospace, Menlo, monospace';
  ctx.fillText(key, card.width / 2, 320);
  ctx.font = '400 15px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(232,236,247,0.6)';
  ctx.fillText('Art Key — it lets you return to your artwork', card.width / 2, 356);
  const link = document.createElement('a');
  link.download = 'art-key.png';
  link.href = card.toDataURL('image/png');
  link.click();
}

export interface ReturnOptions {
  stage: Stage;
  onReturned(): void;
}

/** Returning: type it, scan it, or let the device do it. No login screen. */
export function openArtKeyReturn(opts: ReturnOptions) {
  const field = el('input', {
    class: 'field',
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    placeholder: 'MOON-WHALE-73-KITE-K7QF9M',
    'aria-label': 'Your Art Key'
  }) as HTMLInputElement;

  const status = el('p', { class: 'quiet' }, []);
  const enter = el('button', { class: 'btn btn-primary', type: 'button' }, ['Return']);

  const attempt = async (key: string, remember: boolean) => {
    if (!key.trim()) return;
    enter.setAttribute('disabled', '');
    status.textContent = '';
    try {
      const { session } = await api.returnWithKey(key.trim());
      setKeySession(session);
      if (remember) rememberArtKey(key.trim());
      analytics.track('key_returned');
      announce('Welcome back.');
      opts.onReturned();
    } catch {
      status.textContent = 'That key did not open anything.';
      enter.removeAttribute('disabled');
    }
  };

  enter.addEventListener('click', () => void attempt(field.value, true));
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void attempt(field.value, true);
  });

  const rows: HTMLElement[] = [el('div', { class: 'row' }, [field, enter])];

  const remembered = rememberedArtKey();
  if (remembered) {
    const useSaved = el('button', { class: 'btn btn-primary', type: 'button' }, ['Continue as you']);
    useSaved.addEventListener('click', () => void attempt(remembered, false));
    const forget = el('button', { class: 'btn btn-quiet', type: 'button' }, ['Forget this device']);
    forget.addEventListener('click', () => {
      rememberArtKey(null);
      setKeySession(null);
      toast('This device no longer remembers your key');
      opts.stage.close();
    });
    rows.unshift(el('div', { class: 'row' }, [useSaved, forget]));
  }

  if ('BarcodeDetector' in window) {
    const scan = el('button', { class: 'btn', type: 'button' }, ['Scan the QR code']);
    scan.addEventListener('click', () => void scanQr(opts.stage, (key) => void attempt(key, true)));
    rows.push(el('div', { class: 'row' }, [scan]));
  }

  opts.stage.open(
    el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Return with your Art Key' }, [
      el('h2', {}, ['Welcome back.']),
      el('p', { class: 'quiet' }, ['Your Art Key opens your own universe. There is nothing else to sign in to.']),
      ...rows,
      status
    ])
  );
}

/** Camera QR scanning where the browser supports it, skipped silently where it does not. */
async function scanQr(stage: Stage, onKey: (key: string) => void) {
  const video = el('video', { playsinline: '', muted: '', 'aria-label': 'Camera' }) as HTMLVideoElement;
  const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, [
    el('h2', {}, ['Point the camera at your Art Key']),
    el('div', { class: 'preview' }, [video])
  ]);
  stage.replace(sheet);

  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    toast('The camera is not available');
    return;
  }
  video.srcObject = stream;
  video.style.width = '100%';
  await video.play().catch(() => undefined);

  const Detector = (window as unknown as {
    BarcodeDetector: new (opts: { formats: string[] }) => { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };
  }).BarcodeDetector;
  const detector = new Detector({ formats: ['qr_code'] });

  const tick = async () => {
    if (!stream) return;
    try {
      const codes = await detector.detect(video);
      if (codes.length && codes[0].rawValue) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
        onKey(codes[0].rawValue);
        return;
      }
    } catch {
      /* keep looking */
    }
    requestAnimationFrame(() => void tick());
  };
  void tick();
}
