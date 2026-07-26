import { Router } from "express";
import { randomUUID } from "node:crypto";
import { runChatTurn } from "../claude.js";
import { getSession, saveSession } from "../store.js";

const router = Router();

router.post("/chat", async (req, res) => {
  const { message } = req.body;
  const sessionId = req.body.sessionId || randomUUID();

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    const session = getSession(sessionId);

    // Record the shopper's message in the widget transcript.
    session.widgetMessages.push({ role: "user", text: message });

    const result = await runChatTurn(session, message);

    // Record what the assistant produced so it can be replayed on reload.
    if (result.reply) session.widgetMessages.push({ role: "assistant", text: result.reply });
    if (result.products?.length)
      session.widgetMessages.push({ role: "products", products: result.products });
    if (result.cart) session.widgetCart = result.cart;

    saveSession(sessionId, session);
    res.json({ sessionId, ...result });
  } catch (err) {
    console.error("chat error:", err);
    res.status(500).json({ error: "Something went wrong talking to the assistant." });
  }
});

// Lets the widget rehydrate the full transcript + cart after a refresh or
// re-open, even on a device/browser that lost its local copy.
router.get("/history", (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
  const session = getSession(sessionId);
  res.json({
    sessionId,
    messages: session.widgetMessages ?? [],
    cart: session.widgetCart ?? null,
  });
});

export default router;
