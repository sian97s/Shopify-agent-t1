(function () {
  const SCRIPT_SRC = document.currentScript ? document.currentScript.src : "";
  const API_BASE = SCRIPT_SRC ? new URL(SCRIPT_SRC).origin : "";
  const SESSION_KEY = "storefront-ai-session-id";
  const STATE_KEY = "storefront-ai-state"; // persisted { messages, cart }

  if (SCRIPT_SRC) {
    const cssHref = new URL("widget.css", SCRIPT_SRC).href;
    if (!document.querySelector(`link[href="${cssHref}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = cssHref;
      document.head.appendChild(link);
    }
  }

  function getSessionId() {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return { messages: null, cart: null };
      const parsed = JSON.parse(raw);
      return { messages: parsed.messages ?? null, cart: parsed.cart ?? null };
    } catch {
      return { messages: null, cart: null };
    }
  }

  function saveState(messages, cart) {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ messages, cart }));
    } catch {
      // storage full / disabled — non-fatal, session store on the server still has it
    }
  }

  // Storefront variant GIDs look like "gid://shopify/ProductVariant/44123".
  // The Ajax Cart API needs the bare numeric id.
  function numericVariantId(gid) {
    if (typeof gid !== "string") return null;
    const tail = gid.split("/").pop();
    return /^\d+$/.test(tail) ? tail : null;
  }

  function formatMoney(money) {
    if (!money) return "";
    const amount = Number(money.amount);
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: money.currencyCode }).format(amount);
    } catch {
      return `${amount} ${money.currencyCode}`;
    }
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of [].concat(children)) {
      if (child) node.appendChild(child);
    }
    return node;
  }

  class StorefrontAIWidget {
    constructor() {
      this.sessionId = getSessionId();
      const saved = loadState();
      this.messages = saved.messages; // null -> greeting added on first render
      this.cart = saved.cart;
      this.open = false;
      this.sending = false;
      this.root = el("div", { class: "sfai-root" });
      document.body.appendChild(this.root);
      this.render();
      // Reconcile with the server's copy (covers cleared local storage or a
      // different browser that shares the same session id).
      this.rehydrateFromServer();
    }

    persist() {
      saveState(this.messages, this.cart);
    }

    async rehydrateFromServer() {
      try {
        const res = await fetch(`${API_BASE}/api/history?sessionId=${encodeURIComponent(this.sessionId)}`);
        if (!res.ok) return;
        const data = await res.json();
        const serverMsgs = data.messages ?? [];
        // Prefer the server transcript when it has more than the local copy.
        const localCount = this.messages ? this.messages.length : 0;
        if (serverMsgs.length > localCount) {
          this.messages = serverMsgs;
          if (data.cart) this.cart = data.cart;
          this.persist();
          if (this.open) this.render();
        }
      } catch {
        // offline / server down — keep the local copy, no action needed
      }
      // Always reflect the shopper's real store cart on open.
      this.refreshStoreCart();
    }

    // Add items to the shopper's NATIVE store cart via Shopify's Ajax Cart API.
    // These are same-origin calls to the storefront (NOT the agent backend), so
    // the item lands in the exact cart the store's cart icon / /cart page show.
    async performCartActions(actions) {
      let anyOk = false;
      for (const a of actions) {
        try {
          const res = await fetch("/cart/add.js", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              items: [{ id: Number(a.variantId), quantity: a.quantity ?? 1 }],
              // Ask Shopify to re-render the theme's cart sections so the header
              // cart icon/drawer update without a page reload (Dawn convention).
              sections: "cart-icon-bubble,cart-drawer,cart-live-region-text,cart-notification-product,cart-count-bubble,main-cart-items,main-cart-footer",
              sections_url: window.location.pathname,
            }),
          });
          const ct = res.headers.get("content-type") || "";
          const body = ct.includes("json") ? await res.json().catch(() => null) : null;
          if (!res.ok) {
            // Surface the REAL reason instead of the model's optimistic "added".
            let reason;
            if (res.status === 404 || !ct.includes("json")) {
              reason =
                "this page isn't a Shopify storefront (looks like the preview page). Cart adds only work on your live store.";
            } else {
              reason = (body && (body.description || body.message)) || `store returned HTTP ${res.status}`;
            }
            console.warn("[sfai] cart/add.js failed", res.status, body);
            this.messages.push({ role: "assistant", text: `⚠️ That didn't actually add to the cart — ${reason}` });
            continue;
          }
          anyOk = true;
          if (body && body.sections) this.renderThemeSections(body.sections);
        } catch (err) {
          console.warn("[sfai] cart/add.js error", err);
          this.messages.push({
            role: "assistant",
            text: "⚠️ That didn't actually add to the cart — the store's cart couldn't be reached from this page.",
          });
        }
      }
      await this.refreshStoreCart();
      if (anyOk) {
        this.notifyThemeCartUpdated();
        const n = this.cart?.count ?? 0;
        this.messages.push({
          role: "assistant",
          text: `✓ Confirmed in your store cart — ${n} item${n === 1 ? "" : "s"} now. Use the Checkout button below when ready.`,
        });
        this.persist();
        this.render();
      }
    }

    // Read the native cart (/cart.js) and mirror it in the widget's cart bar.
    async refreshStoreCart() {
      try {
        const res = await fetch("/cart.js", { headers: { Accept: "application/json" } });
        if (!res.ok) return; // not on a Shopify storefront (e.g. preview page)
        const c = await res.json();
        this.cart = {
          count: c.item_count,
          total: { amount: String((c.total_price ?? 0) / 100), currencyCode: c.currency },
          checkoutUrl: "/checkout",
        };
        this.persist();
        if (this.open) this.render();
      } catch {
        // ignore — leave whatever cart state we had
      }
    }

    // Inject Shopify's re-rendered cart sections into the live page so the
    // theme's header cart icon / drawer reflect the new cart without a reload.
    // Works for Dawn and Dawn-derived custom themes (like this store's JULY13).
    renderThemeSections(sections) {
      for (const [name, html] of Object.entries(sections)) {
        if (!html) continue;
        try {
          const parsed = new DOMParser().parseFromString(html, "text/html");
          // The section id in the live DOM usually matches the section name.
          const source = parsed.getElementById(name) || parsed.body.firstElementChild;
          const targets = [
            document.getElementById(name),
            document.getElementById(`shopify-section-${name}`),
            ...document.querySelectorAll(`[id^="shopify-section-"] #${CSS.escape(name)}`),
          ].filter(Boolean);
          for (const t of targets) {
            t.innerHTML = source ? source.innerHTML : html;
          }
        } catch (e) {
          console.warn("[sfai] section render failed for", name, e);
        }
      }
    }

    // Notify the theme so its header cart icon / drawer re-render without a
    // reload. Shopify's Horizon theme (this store's JULY13) listens on document
    // for `cart:update` and sets the badge from detail.data.itemCount — so we
    // pass the real total from /cart.js. Older themes get the generic events.
    notifyThemeCartUpdated() {
      const count = this.cart?.count ?? 0;
      try {
        // Horizon / newer themes (ThemeEvents.cartUpdate === "cart:update").
        // source !== "product-form-component" makes the icon SET (not add) count.
        document.dispatchEvent(
          new CustomEvent("cart:update", {
            bubbles: true,
            detail: { data: { itemCount: count, source: "storefront-ai-widget" } },
          })
        );
        // Legacy / Dawn-style fallbacks — harmless if unhandled.
        document.dispatchEvent(new CustomEvent("cart:refresh", { bubbles: true }));
        document.dispatchEvent(new CustomEvent("cart:build"));
        if (window.Shopify && typeof window.Shopify.onCartUpdate === "function") {
          fetch("/cart.js").then((r) => r.json()).then((c) => window.Shopify.onCartUpdate(c)).catch(() => {});
        }
      } catch {
        // non-fatal
      }
    }

    render() {
      this.root.innerHTML = "";

      const bubble = el("button", {
        class: "sfai-bubble",
        "aria-label": "Open shopping assistant",
        onclick: () => {
          this.open = !this.open;
          this.render();
        },
        text: this.open ? "✕" : "💬",
      });
      this.root.appendChild(bubble);

      if (!this.open) return;

      this.messagesEl = el("div", { class: "sfai-messages" });
      this.messages ??= [
        { role: "assistant", text: "Hi! I can help you find products and build your cart. What are you looking for?" },
      ];
      for (const m of this.messages) this.messagesEl.appendChild(this.renderMessage(m));

      const form = el("form", { class: "sfai-input-row", onsubmit: (e) => this.handleSubmit(e) });
      this.inputEl = el("input", { type: "text", placeholder: "Ask about products...", class: "sfai-input" });
      form.appendChild(this.inputEl);
      form.appendChild(el("button", { type: "submit", class: "sfai-send", text: "Send" }));

      const panel = el("div", { class: "sfai-panel" }, [
        el("div", { class: "sfai-header", text: "Steady Decker Assistant" }),
        this.messagesEl,
        this.cart && (this.cart.count || this.cart.lines?.length) ? this.renderCartBar() : null,
        form,
      ]);
      this.root.appendChild(panel);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      this.inputEl.focus();
    }

    renderCartBar() {
      const count = this.cart.count ?? this.cart.lines.reduce((n, l) => n + l.quantity, 0);
      return el("div", { class: "sfai-cart-bar" }, [
        el("span", { text: `${count} item${count === 1 ? "" : "s"} · ${formatMoney(this.cart.total)}` }),
        el("a", { href: this.cart.checkoutUrl || "/checkout", class: "sfai-checkout-btn", text: "Checkout" }),
      ]);
    }

    renderMessage(m) {
      if (m.role === "products") {
        const grid = el("div", { class: "sfai-product-grid" });
        for (const p of m.products) grid.appendChild(this.renderProductCard(p));
        return el("div", { class: "sfai-msg sfai-msg-assistant" }, [grid]);
      }
      if (m.role === "materials") {
        return el("div", { class: "sfai-msg sfai-msg-assistant" }, [this.renderMaterialsReport(m.report)]);
      }
      return el("div", { class: `sfai-msg sfai-msg-${m.role}`, text: m.text });
    }

    // Match table for a pasted list. High-confidence lines are already in the
    // cart (auto-added). Low-confidence lines offer alternatives to pick from;
    // unmatched lines are flagged.
    renderMaterialsReport(report) {
      const c = report.counts || { high: 0, low: 0, none: 0 };
      const summary = el("div", { class: "sfai-mat-summary", text:
        `${report.totalLines} item${report.totalLines === 1 ? "" : "s"} · ` +
        `${c.high} added · ${c.low} to review · ${c.none} not found` });

      const rows = el("div", { class: "sfai-mat-rows" });
      for (const line of report.lines || []) rows.appendChild(this.renderMaterialsRow(line));

      return el("div", { class: "sfai-mat" }, [summary, rows]);
    }

    renderMaterialsRow(line) {
      const qtyName = `${line.quantity}× ${line.request}`;
      const head = el("div", { class: "sfai-mat-head" }, [
        el("span", { class: `sfai-mat-dot sfai-mat-${line.confidence}` }),
        el("span", { class: "sfai-mat-req", text: qtyName }),
      ]);

      const body = el("div", { class: "sfai-mat-body" });

      if (line.confidence === "high" && line.match) {
        body.appendChild(el("div", { class: "sfai-mat-note sfai-mat-ok",
          text: `Added: ${line.match.title} · ${formatMoney(line.match.price)}` }));
      } else if (line.confidence === "low") {
        body.appendChild(el("div", { class: "sfai-mat-note",
          text: "Not sure — pick the right one:" }));
        const alts = el("div", { class: "sfai-mat-alts" });
        for (const alt of line.alternatives || []) {
          alts.appendChild(this.renderMatAlt(alt, line.quantity));
        }
        body.appendChild(alts);
      } else {
        body.appendChild(el("div", { class: "sfai-mat-note sfai-mat-miss",
          text: "No match found in the catalog." }));
      }

      return el("div", { class: "sfai-mat-row" }, [head, body]);
    }

    renderMatAlt(alt, quantity) {
      const label = `${alt.title} · ${formatMoney(alt.price)}`;
      const btn = el("button", {
        class: "sfai-mat-alt",
        text: alt.availableForSale ? `+ ${label}` : `${label} (out of stock)`,
      });
      if (alt.availableForSale && numericVariantId(alt.variantId)) {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          btn.textContent = `Adding ${alt.title}…`;
          await this.performCartActions([{ variantId: numericVariantId(alt.variantId), quantity }]);
        });
      } else {
        btn.disabled = true;
      }
      return btn;
    }

    renderProductCard(p) {
      const variant = p.variants?.[0];
      const card = el("div", { class: "sfai-card" }, [
        p.image ? el("img", { src: p.image, alt: p.title, class: "sfai-card-img" }) : null,
        el("div", { class: "sfai-card-title", text: p.title }),
        el("div", { class: "sfai-card-price", text: formatMoney(p.price) }),
      ]);
      if (variant && variant.availableForSale) {
        card.appendChild(
          el("button", {
            class: "sfai-card-add",
            text: "Add to cart",
            onclick: () => this.sendMessage(`Add "${p.title}" to my cart`, { silent: false }),
          })
        );
      } else if (variant) {
        card.appendChild(el("div", { class: "sfai-card-oos", text: "Out of stock" }));
      }
      return card;
    }

    async handleSubmit(e) {
      e.preventDefault();
      const text = this.inputEl.value.trim();
      if (!text || this.sending) return;
      this.inputEl.value = "";
      await this.sendMessage(text);
    }

    async sendMessage(text) {
      this.messages ??= [];
      this.messages.push({ role: "user", text });
      this.sending = true;
      this.persist();
      this.render();

      try {
        const res = await fetch(`${API_BASE}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: this.sessionId, message: text }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Request failed");

        if (data.reply) this.messages.push({ role: "assistant", text: data.reply });
        if (data.products?.length) this.messages.push({ role: "products", products: data.products });
        if (data.materialsReport) this.messages.push({ role: "materials", report: data.materialsReport });
        if (data.cartActions?.length) await this.performCartActions(data.cartActions);
      } catch (err) {
        this.messages.push({ role: "assistant", text: "Sorry, something went wrong. Please try again." });
      } finally {
        this.sending = false;
        this.persist();
        this.render();
      }
    }
  }

  function init() {
    new StorefrontAIWidget();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
