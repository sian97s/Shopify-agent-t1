(function () {
  const SCRIPT_SRC = document.currentScript ? document.currentScript.src : "";
  const API_BASE = SCRIPT_SRC ? new URL(SCRIPT_SRC).origin : "";
  const SESSION_KEY = "storefront-ai-session-id";

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
      this.cart = null;
      this.open = false;
      this.sending = false;
      this.root = el("div", { class: "sfai-root" });
      document.body.appendChild(this.root);
      this.render();
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
        this.cart && this.cart.lines?.length ? this.renderCartBar() : null,
        form,
      ]);
      this.root.appendChild(panel);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      this.inputEl.focus();
    }

    renderCartBar() {
      const count = this.cart.lines.reduce((n, l) => n + l.quantity, 0);
      return el("div", { class: "sfai-cart-bar" }, [
        el("span", { text: `${count} item${count === 1 ? "" : "s"} · ${formatMoney(this.cart.total)}` }),
        el("a", { href: this.cart.checkoutUrl, target: "_blank", rel: "noopener", class: "sfai-checkout-btn", text: "Checkout" }),
      ]);
    }

    renderMessage(m) {
      if (m.role === "products") {
        const grid = el("div", { class: "sfai-product-grid" });
        for (const p of m.products) grid.appendChild(this.renderProductCard(p));
        return el("div", { class: "sfai-msg sfai-msg-assistant" }, [grid]);
      }
      return el("div", { class: `sfai-msg sfai-msg-${m.role}`, text: m.text });
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
      this.messages.push({ role: "user", text });
      this.sending = true;
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
        if (data.cart) this.cart = data.cart;
      } catch (err) {
        this.messages.push({ role: "assistant", text: "Sorry, something went wrong. Please try again." });
      } finally {
        this.sending = false;
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
