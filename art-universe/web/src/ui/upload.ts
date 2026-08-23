import type { PublicRejectionReason, UniverseNode, Visibility } from '../../../shared/types.js';
import { api, ApiError } from '../net/api.js';
import { LiveUploadSession } from '../net/uploadSession.js';
import { analytics } from '../analytics.js';
import { announce, el, icon, toast } from './dom.js';
import type { Stage } from './stage.js';

const CAMERA_ICON =
  '<path d="M4 8h3l2-2h6l2 2h3v11H4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/>';
const IMAGE_ICON =
  '<rect x="3.5" y="5.5" width="17" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><path d="M5 17l4.5-5 3.5 3.5 2.5-2 3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>';

/** One broad reason, in plain words. No legalistic wall of text. */
const WHY: Record<PublicRejectionReason, string> = {
  unsafe_content: 'It looked unsafe for a shared space.',
  personal_information: 'Personal or contact information was visible in it.',
  unsupported_image: 'That image could not be read.',
  could_not_verify: 'It could not be checked right now.'
};

export interface UploadOptions {
  stage: Stage;
  respondsTo?: string | null;
  onPublished(node: UniverseNode, artKey?: string): void;
}

/**
 * Anonymous upload in a single gesture, with live moderation.
 *
 * Choose artwork -> local preview -> moderation starts -> the session stays
 * alive -> approved or rejected -> published only on approval. Leaving at any
 * point cancels the submission entirely.
 */
export function openUpload(opts: UploadOptions) {
  let live: LiveUploadSession | null = null;
  let finished = false;
  let visibility: Visibility = 'universe';
  let title = '';

  const stop = (cancel: boolean) => {
    live?.close(cancel);
    live = null;
  };

  const closeAll = () => {
    if (!finished) {
      analytics.track('upload_abandoned');
      stop(true);
    }
    opts.stage.close();
  };

  analytics.track('upload_opened');

  // -- step 1: exactly two ways in ------------------------------------------
  const chooser = () => {
    const fileInput = el('input', { type: 'file', accept: 'image/*', class: 'sr-only' }) as HTMLInputElement;
    const cameraInput = el('input', {
      type: 'file', accept: 'image/*', capture: 'environment', class: 'sr-only'
    }) as HTMLInputElement;

    const onPick = (input: HTMLInputElement) => () => {
      const file = input.files?.[0];
      if (file) void beginSubmission(file);
    };
    fileInput.addEventListener('change', onPick(fileInput));
    cameraInput.addEventListener('change', onPick(cameraInput));

    const takePhoto = el('button', { class: 'choice', type: 'button' }, [
      icon(CAMERA_ICON),
      'Take photo'
    ]);
    const chooseImage = el('button', { class: 'choice', type: 'button' }, [
      icon(IMAGE_ICON),
      'Choose image'
    ]);
    takePhoto.addEventListener('click', () => cameraInput.click());
    chooseImage.addEventListener('click', () => fileInput.click());

    return el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Add your art' }, [
      el('div', { class: 'choices' }, [takePhoto, chooseImage]),
      opts.respondsTo
        ? el('p', { class: 'quiet' }, ['Your art will be connected to the piece you are answering.'])
        : null,
      fileInput,
      cameraInput,
      el('div', { class: 'row end' }, [closeButton()])
    ]);
  };

  const closeButton = (label = 'Not now') => {
    const button = el('button', { class: 'btn btn-quiet', type: 'button' }, [label]);
    button.addEventListener('click', closeAll);
    return button;
  };

  // -- step 2: the artwork, large, with two optional decisions ---------------
  const preview = (file: File, objectUrl: string) => {
    const image = el('img', { src: objectUrl, alt: 'The artwork you chose' });
    const titleField = el('input', {
      class: 'field', type: 'text', maxlength: '80',
      placeholder: 'Title, if you want one', 'aria-label': 'Optional title'
    }) as HTMLInputElement;
    titleField.addEventListener('input', () => {
      title = titleField.value;
    });

    const universeBtn = el('button', { type: 'button', 'aria-pressed': 'true' }, ['🌎 Universe']);
    const privateBtn = el('button', { type: 'button', 'aria-pressed': 'false' }, ['🔒 Private']);
    const setVisibility = (next: Visibility) => {
      visibility = next;
      universeBtn.setAttribute('aria-pressed', String(next === 'universe'));
      privateBtn.setAttribute('aria-pressed', String(next === 'private'));
    };
    universeBtn.addEventListener('click', () => setVisibility('universe'));
    privateBtn.addEventListener('click', () => setVisibility('private'));

    const send = el('button', { class: 'btn btn-primary', type: 'button' }, ['Add to the universe']);
    send.addEventListener('click', () => void submit(file, objectUrl));

    return el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Your artwork' }, [
      el('div', { class: 'preview' }, [image]),
      el('div', { class: 'row' }, [titleField]),
      el('div', { class: 'row' }, [
        el('div', { class: 'toggle', role: 'group', 'aria-label': 'Where this artwork lives' }, [
          universeBtn, privateBtn
        ])
      ]),
      el('div', { class: 'row end' }, [closeButton(), send])
    ]);
  };

  // -- step 3: the quiet wait -----------------------------------------------
  const checking = (objectUrl: string) =>
    el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Checking your art' }, [
      el('div', { class: 'preview checking' }, [
        el('img', { src: objectUrl, alt: 'Your artwork, being checked' })
      ]),
      el('div', { class: 'checking-line' }, [el('span', { class: 'pulse' }), 'Checking your art…'])
    ]);

  const rejected = (reason: PublicRejectionReason) => {
    const why = el('button', { class: 'btn btn-quiet', type: 'button' }, ['Why?']);
    const explanation = el('p', { class: 'quiet' }, [WHY[reason]]);
    explanation.hidden = true;
    why.addEventListener('click', () => {
      explanation.hidden = false;
      why.hidden = true;
    });
    return el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, [
      el('h2', {}, ["This artwork can't enter the Universe."]),
      explanation,
      el('div', { class: 'row end' }, [why, closeButton('Close')])
    ]);
  };

  const ready = (objectUrl: string) =>
    el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { class: 'preview' }, [el('img', { src: objectUrl, alt: 'Your artwork' })]),
      el('div', { class: 'checking-line' }, ['Ready'])
    ]);

  // -- flow ------------------------------------------------------------------
  async function beginSubmission(file: File) {
    analytics.track('upload_chosen', { bytes: Math.round(file.size / 1024) });
    const objectUrl = URL.createObjectURL(file);
    opts.stage.replace(preview(file, objectUrl));
  }

  async function submit(file: File, objectUrl: string) {
    opts.stage.replace(checking(objectUrl));
    announce('Checking your art.');
    try {
      const started = await api.startUpload({
        visibility,
        respondsTo: opts.respondsTo ?? null,
        title: title.trim() || null
      });
      live = new LiveUploadSession(started.sessionId, started.token, started.heartbeatIntervalMs, {
        onState: (state) => {
          if (state === 'cancelled' && !finished) {
            stop(false);
            toast('That upload ended. Nothing was added.');
            opts.stage.close();
          }
        }
      });
      if (title.trim()) await api.updateUpload(started.sessionId, started.token, { title: title.trim() });

      const result = await api.sendArtwork(started.sessionId, started.token, file);

      if (result.state === 'approved' && result.artwork) {
        finished = true;
        stop(false);
        analytics.track('upload_published', { private: visibility === 'private' });
        opts.stage.replace(ready(objectUrl));
        announce('Your art was approved.');
        // The publishing moment: hold it large for a beat, then let it travel.
        window.setTimeout(() => {
          opts.stage.close();
          opts.onPublished(result.artwork!, result.artKey);
          URL.revokeObjectURL(objectUrl);
        }, 1100);
        return;
      }

      if (result.state === 'needs_review') {
        // Still live, still waiting, still the creator's decision to stay.
        opts.stage.replace(
          el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, [
            el('div', { class: 'preview checking' }, [
              el('img', { src: objectUrl, alt: 'Your artwork, still being checked' })
            ]),
            el('div', { class: 'checking-line' }, [el('span', { class: 'pulse' }), 'Still looking…']),
            el('p', { class: 'quiet' }, ['Stay here a moment. Leaving now cancels it.']),
            el('div', { class: 'row end' }, [closeButton('Leave')])
          ])
        );
        return;
      }

      finished = result.state === 'rejected';
      stop(false);
      URL.revokeObjectURL(objectUrl);
      if (result.state === 'rejected' && result.reason) opts.stage.replace(rejected(result.reason));
      else {
        toast('That upload ended. Nothing was added.');
        opts.stage.close();
      }
    } catch (err) {
      stop(true);
      URL.revokeObjectURL(objectUrl);
      if (err instanceof ApiError && err.status === 409) {
        toast('That upload ended. Nothing was added.');
        opts.stage.close();
        return;
      }
      opts.stage.replace(rejected('could_not_verify'));
    }
  }

  opts.stage.open(chooser(), { onClose: () => stop(true), translucent: true });
}
