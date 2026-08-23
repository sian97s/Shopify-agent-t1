import type { ArtworkDetail, QualitativeSignal, ReactionKind } from '../../../shared/types.js';
import { REPORT_REASON_LABELS } from './reasons.js';
import { clear, el } from './dom.js';

/** Qualitative, private, and never a number. */
const SIGNAL_LABELS: Record<QualitativeSignal, string> = {
  being_discovered: 'Being discovered',
  traveling: 'Traveling',
  lighting_up: 'Lighting up',
  inspiring_others: 'Inspiring others',
  resting: 'Resting'
};

export interface DetailHandlers {
  onReact(kind: ReactionKind): void;
  onRespond(): void;
  onExploreSimilar(): void;
  onReport(reason: string): void;
  onClose(): void;
  onVisibility(next: 'universe' | 'private'): void;
  onWithdraw(): void;
}

/**
 * The selected artwork. Five interactions, exactly as constrained: appreciate,
 * inspired me, respond with art, explore similar, and a quiet report menu.
 * No comments, no messages, no counts.
 */
export function renderDetail(panel: HTMLElement, detail: ArtworkDetail, handlers: DetailHandlers) {
  clear(panel);
  panel.hidden = false;

  const action = (label: string, glyph: string, on: boolean, fn: () => void) => {
    const button = el(
      'button',
      { class: `action${on ? ' is-on' : ''}`, type: 'button', 'aria-label': label, title: label },
      [glyph]
    );
    button.addEventListener('click', fn);
    return button;
  };

  const menuList = el('ul', { class: 'menu-list', role: 'menu' }, [
    ...Object.entries(REPORT_REASON_LABELS).map(([value, label]) => {
      const item = el('button', { type: 'button', role: 'menuitem' }, [label]);
      item.addEventListener('click', () => {
        handlers.onReport(value);
        menuList.hidden = true;
      });
      return el('li', {}, [item]);
    }),
    ...(detail.owned
      ? [
          el('li', {}, [
            (() => {
              const next = detail.visibility === 'universe' ? 'private' : 'universe';
              const item = el('button', { type: 'button', role: 'menuitem' }, [
                next === 'private' ? 'Make private' : 'Return to the universe'
              ]);
              item.addEventListener('click', () => {
                handlers.onVisibility(next);
                menuList.hidden = true;
              });
              return item;
            })()
          ]),
          el('li', {}, [
            (() => {
              const item = el('button', { type: 'button', role: 'menuitem' }, ['Withdraw this artwork']);
              item.addEventListener('click', () => {
                handlers.onWithdraw();
                menuList.hidden = true;
              });
              return item;
            })()
          ])
        ]
      : [])
  ]);
  menuList.hidden = true;

  const more = el('button', {
    class: 'action', type: 'button', 'aria-label': 'More options', 'aria-haspopup': 'menu', 'aria-expanded': 'false'
  }, ['•••']);
  more.addEventListener('click', () => {
    menuList.hidden = !menuList.hidden;
    more.setAttribute('aria-expanded', String(!menuList.hidden));
  });

  const close = el('button', { class: 'ghost', type: 'button', 'aria-label': 'Close' }, ['×']);
  close.addEventListener('click', handlers.onClose);

  const parts: (Node | null)[] = [
    el('div', { class: 'row' }, [
      el('div', { style: 'flex:1; min-width:0' }, [
        detail.title ? el('p', { class: 'title' }, [detail.title]) : null,
        el('p', { class: 'ref' }, [`/art/${detail.ref}`])
      ]),
      close
    ]),
    detail.owned && detail.signals?.length
      ? el(
          'div',
          { class: 'signals', 'aria-label': 'What has happened to your art' },
          detail.signals.map((s) => el('span', { class: 'signal' }, [SIGNAL_LABELS[s]]))
        )
      : null,
    el('div', { class: 'actions' }, [
      action('Appreciate', '♡', detail.reacted.includes('appreciate'), () => handlers.onReact('appreciate')),
      action('Inspired me', '✨', detail.reacted.includes('inspired'), () => handlers.onReact('inspired')),
      action('Respond with art', '🎨', false, handlers.onRespond),
      action('Explore similar', '↗', false, handlers.onExploreSimilar),
      el('div', { class: 'menu' }, [more, menuList])
    ])
  ];
  panel.append(...parts.filter((n): n is Node => n !== null));
}

export function hideDetail(panel: HTMLElement) {
  panel.hidden = true;
  clear(panel);
}
