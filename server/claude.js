import Anthropic from "@anthropic-ai/sdk";
import { searchProducts, getProduct } from "./shopify.js";

// Storefront API GIDs look like "gid://shopify/ProductVariant/44123456789".
// The Ajax Cart API (/cart/add.js) needs the bare numeric id at the end.
function numericVariantId(gid) {
  if (typeof gid !== "string") return null;
  const tail = gid.split("/").pop();
  return /^\d+$/.test(tail) ? tail : null;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: globalThis.fetch });

const MODEL = "claude-sonnet-5";

const SYSTEM_PROMPT = `You are the shopping assistant for Steady Decker's online store.
Help shoppers find products, answer questions about them, and build a cart.
Always use tools to look up real product and price data — never invent products, prices, or availability.
When a shopper wants to buy something, add it to their cart with add_to_cart. This adds it to their real store cart, so tell them it's in their cart and they can check out from the cart when ready.
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
    description:
      "Add a product variant to the shopper's real store cart. Use the ProductVariant GID from a prior search_products/get_product result.",
    input_schema: {
      type: "object",
      properties: {
        variantId: { type: "string", description: "The ProductVariant GID from a prior search_products/get_product call" },
        quantity: { type: "integer", description: "Quantity to add", default: 1 },
      },
      required: ["variantId"],
    },
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

  // products: cards to render. cartActions: adds the widget performs against the
  // shopper's native store cart (via /cart/add.js in the browser).
  const widgetData = { products: null, cartActions: [] };

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
      // The server can't touch the browser's cart cookie, so it emits an action
      // the widget executes against the native cart. We just validate the id.
      const id = numericVariantId(input.variantId);
      if (!id) return { error: "Invalid variantId — expected a ProductVariant GID from a search result." };
      const quantity = input.quantity ?? 1;
      widgetData.cartActions.push({ variantId: id, quantity });
      return { added: true, variantId: id, quantity };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
