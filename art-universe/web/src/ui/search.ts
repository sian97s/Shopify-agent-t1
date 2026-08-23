import { analytics } from '../analytics.js';
import { clear, el } from './dom.js';

/** Ways in, for someone who does not yet know what to ask for. */
const DEFAULT_SUGGESTIONS = [
  'something peaceful',
  'strange faces',
  'underwater worlds',
  'funny monsters',
  'art that feels lonely',
  'show me something completely different'
];

export interface SearchHandlers {
  onSearch(query: string): void;
  onOpened(): void;
  onClosed(): void;
}

/**
 * One field. There is no results page — searching changes what the universe is
 * doing, so this control's whole job is to take a sentence and get out of the way.
 */
export class SearchControl {
  private lastQuery = '';
  private searchCount = 0;
  private selectedSince = true;
  showSuggestions = true;

  constructor(
    private form: HTMLFormElement,
    private input: HTMLInputElement,
    private suggestionList: HTMLUListElement,
    private trigger: HTMLButtonElement,
    private handlers: SearchHandlers
  ) {
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit(this.input.value);
    });
    this.trigger.addEventListener('click', () => this.toggle());
    this.input.addEventListener('focus', () => analytics.track('search_started'));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen) this.close();
      // "/" is the search key everywhere else; it may as well be here too.
      if (event.key === '/' && !this.isOpen && !isTyping(event.target)) {
        event.preventDefault();
        this.open();
      }
    });
  }

  get isOpen() {
    return !this.form.hidden;
  }

  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  open() {
    this.form.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.renderSuggestions();
    this.input.focus();
    this.input.select();
    this.handlers.onOpened();
  }

  close() {
    if (!this.isOpen) return;
    this.form.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    // A search nobody followed anywhere is a search that did not work.
    if (this.lastQuery && !this.selectedSince) analytics.track('search_abandoned');
    this.handlers.onClosed();
  }

  /** Called when an artwork is selected, so we can tell searches apart. */
  noteSelection() {
    this.selectedSince = true;
  }

  private submit(raw: string) {
    const query = raw.trim();
    if (!query) return;
    if (this.lastQuery && query !== this.lastQuery) analytics.track('search_refined');
    if (this.lastQuery && !this.selectedSince) analytics.track('search_abandoned');
    this.lastQuery = query;
    this.selectedSince = false;
    this.searchCount++;
    analytics.track('search_submitted', { length: query.length, nth: this.searchCount });
    this.handlers.onSearch(query);
  }

  private renderSuggestions() {
    clear(this.suggestionList);
    if (!this.showSuggestions || this.searchCount > 1) return;
    for (const suggestion of DEFAULT_SUGGESTIONS.slice(0, 4)) {
      const button = el('button', { type: 'button' }, [suggestion]);
      button.addEventListener('click', () => {
        this.input.value = suggestion;
        this.submit(suggestion);
      });
      this.suggestionList.append(el('li', {}, [button]));
    }
  }
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
