import Anthropic from "@anthropic-ai/sdk";
import { searchProducts, getProduct, createCart, addToCart, getCart } from "./shopify.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: globalThis.fetch });

const MODEL = "claude-sonnet-5";

const SYSTEM_PROMPT = `You are the shopping assistant for Steady Decker's online store.
Help shoppers find products, answer questions about them, and build a cart.
Always use tools to look up real product and price data — never invent products, prices, or availability.
When a shopper wants to buy something, add it to their cart with add_to_cart, then let them know they can check out.
Keep replies short and conversational. Prices are already formatted with currency by the tools — don't reformat them.
When you are done taking actions for this turn, give a brief natural-language reply summarizing what happened.`;

const TOOLS = [
  {
    name: "search_products",
    description: "Search the store catalog by keyword (product name, type, or description terms).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords, e.g. 'running shoes' or 'blue jacket'" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_product",
    description: "Get full details for a single product by its handle (slug).",
    input_schema: {
      type: "object",
      properties: {
        handle: { type: "string", description: "Product handle/slug" },
      },
      required: ["handle"],
    },
  },
  {
    name: "add_to_cart",
    description: "Add a product variant to the shopper's cart. Creates a cart if one doesn't exist yet.",
    input_schema: {
      type: "object",
      properties: {
        variantId: { type: "string", description: "The ProductVariant GID from a prior search_products/get_product call" },
        quantity: { type: "integer", description: "Quantity to add", default: 1 },
      },
      required: ["variantId"],
    },
  },
  {
    name: "get_cart",
    description: "Get the shopper's current cart contents and checkout URL.",
    input_schema: { type: "object", properties: {} },
  },
];

function summarizeProducts(products) {
  return products.map((p) => ({
    id: p.id,
    title: p.title,
    handle: p.handle,
    image: p.featuredImage?.url ?? null,
    price: p.priceRange?.minVariantPrice,
    variants: (p.variants?.edges ?? []).map((e) => ({
      id: e.node.id,
      title: e.node.title,
      price: e.node.price,
      availableForSale: e.node.availableForSale,
    })),
  }));
}

function summarizeCart(cart) {
  if (!cart) return null;
  return {
    id: cart.id,
    checkoutUrl: cart.checkoutUrl,
    subtotal: cart.cost?.subtotalAmount,
    total: cart.cost?.totalAmount,
    lines: (cart.lines?.edges ?? []).map((e) => ({
      id: e.node.id,
      quantity: e.node.quantity,
      title: e.node.merchandise?.product?.title,
      variantTitle: e.node.merchandise?.title,
      image: e.node.merchandise?.product?.featuredImage?.url ?? null,
      price: e.node.merchandise?.price,
    })),
  };
}

// session: { history: Anthropic.MessageParam[], cartId: string | null }
export async function runChatTurn(session, userMessage) {
  session.history.push({ role: "user", content: userMessage });

  const widgetData = { products: null, cart: null };

  for (let iteration = 0; iteration < 6; iteration++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: session.history,
    });

    session.history.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { reply: text, ...widgetData };
    }

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      let result;
      try {
        result = await executeTool(session, block.name, block.input, widgetData);
      } catch (err) {
        result = { error: err.message };
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    session.history.push({ role: "user", content: toolResults });
  }

  return { reply: "Sorry, that took too many steps — could you rephrase?", ...widgetData };
}

// Return a live cart ID for this session, creating a new cart if none exists
// or if the stored one is gone. Storefront carts expire after ~10 days of
// inactivity and become unresolvable once checkout completes — in both cases
// getCart returns null, and reusing that stale ID is what made items "vanish."
// Recreating transparently keeps the shopper's session working.
async function ensureCartId(session) {
  if (session.cartId) {
    const existing = await getCart(session.cartId);
    if (existing) return session.cartId;
  }
  const cart = await createCart();
  session.cartId = cart.id;
  return session.cartId;
}

async function executeTool(session, name, input, widgetData) {
  switch (name) {
    case "search_products": {
      const products = await searchProducts(input.query);
      widgetData.products = summarizeProducts(products);
      return widgetData.products;
    }
    case "get_product": {
      const product = await getProduct(input.handle);
      if (product) widgetData.products = summarizeProducts([product]);
      return product ? summarizeProducts([product])[0] : null;
    }
    case "add_to_cart": {
      const cartId = await ensureCartId(session);
      const cart = await addToCart(cartId, input.variantId, input.quantity ?? 1);
      widgetData.cart = summarizeCart(cart);
      return widgetData.cart;
    }
    case "get_cart": {
      if (!session.cartId) return null;
      const cart = await getCart(session.cartId);
      // Cart expired/completed — clear the dead ID so the next add starts clean.
      if (!cart) {
        session.cartId = null;
        return null;
      }
      widgetData.cart = summarizeCart(cart);
      return widgetData.cart;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
