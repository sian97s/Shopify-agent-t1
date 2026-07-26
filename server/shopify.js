const API_VERSION = "2024-10";

const endpoint = () =>
  `https://${process.env.SHOPIFY_STORE_DOMAIN}/api/${API_VERSION}/graphql.json`;

async function storefrontRequest(query, variables = {}) {
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": process.env.SHOPIFY_STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (json.errors) {
    throw new Error(`Storefront API error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

const MONEY_FIELDS = `amount currencyCode`;

const PRODUCT_CARD_FIELDS = `
  id
  title
  handle
  description
  featuredImage { url altText }
  priceRange { minVariantPrice { ${MONEY_FIELDS} } }
  variants(first: 10) {
    edges {
      node {
        id
        title
        availableForSale
        price { ${MONEY_FIELDS} }
        selectedOptions { name value }
      }
    }
  }
`;

export async function searchProducts(query, first = 6) {
  const data = await storefrontRequest(
    `query SearchProducts($query: String!, $first: Int!) {
      products(first: $first, query: $query) {
        edges { node { ${PRODUCT_CARD_FIELDS} } }
      }
    }`,
    { query, first }
  );
  return data.products.edges.map((e) => e.node);
}

export async function getProduct(handle) {
  const data = await storefrontRequest(
    `query GetProduct($handle: String!) {
      product(handle: $handle) { ${PRODUCT_CARD_FIELDS} }
    }`,
    { handle }
  );
  return data.product;
}

const CART_FIELDS = `
  id
  checkoutUrl
  cost {
    subtotalAmount { ${MONEY_FIELDS} }
    totalAmount { ${MONEY_FIELDS} }
  }
  lines(first: 50) {
    edges {
      node {
        id
        quantity
        merchandise {
          ... on ProductVariant {
            id
            title
            price { ${MONEY_FIELDS} }
            product { title featuredImage { url altText } }
          }
        }
      }
    }
  }
`;

export async function createCart() {
  const data = await storefrontRequest(
    `mutation CreateCart {
      cartCreate {
        cart { ${CART_FIELDS} }
        userErrors { field message }
      }
    }`
  );
  const { cart, userErrors } = data.cartCreate;
  if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join("; "));
  return cart;
}

export async function addToCart(cartId, merchandiseId, quantity = 1) {
  const data = await storefrontRequest(
    `mutation AddToCart($cartId: ID!, $lines: [CartLineInput!]!) {
      cartLinesAdd(cartId: $cartId, lines: $lines) {
        cart { ${CART_FIELDS} }
        userErrors { field message }
      }
    }`,
    { cartId, lines: [{ merchandiseId, quantity }] }
  );
  const { cart, userErrors } = data.cartLinesAdd;
  if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join("; "));
  return cart;
}

export async function getCart(cartId) {
  const data = await storefrontRequest(
    `query GetCart($cartId: ID!) {
      cart(id: $cartId) { ${CART_FIELDS} }
    }`,
    { cartId }
  );
  return data.cart;
}
