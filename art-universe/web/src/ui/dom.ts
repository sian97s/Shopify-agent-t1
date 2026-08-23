export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | number | null> = {},
  children: (Node | string | null | false)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export const icon = (paths: string, label?: string) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  if (label) svg.setAttribute('aria-label', label);
  return svg;
};

export const clear = (node: Element) => {
  while (node.firstChild) node.firstChild.remove();
};

/** Short, quiet, and gone. The interface says as little as it can. */
export function toast(message: string, ms = 2600) {
  document.querySelector('.toast')?.remove();
  const node = el('div', { class: 'toast', role: 'status' }, [message]);
  document.body.append(node);
  setTimeout(() => node.remove(), ms);
}

export function announce(message: string) {
  const region = document.getElementById('live-region');
  if (region) region.textContent = message;
}

/** Keep the keyboard inside an open sheet, and give it back on close. */
export function trapFocus(container: HTMLElement): () => void {
  const previous = document.activeElement as HTMLElement | null;
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const items = [...container.querySelectorAll<HTMLElement>(selector)].filter(
      (n) => n.offsetParent !== null
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', onKey);
  requestAnimationFrame(() => {
    container.querySelector<HTMLElement>(selector)?.focus();
  });
  return () => {
    container.removeEventListener('keydown', onKey);
    previous?.focus?.();
  };
}
