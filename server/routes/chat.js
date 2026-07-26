import { Router } from "express";
import { randomUUID } from "node:crypto";
import { runChatTurn } from "../claude.js";

const router = Router();

// In-memory session store: sessionId -> { history, cartId }
// Resets on server restart. Fine for a prototype; swap for Redis/db before scaling.
const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { history: [], cartId: null });
  }
  return sessions.get(sessionId);
}

router.post("/chat", async (req, res) => {
  const { message } = req.body;
  const sessionId = req.body.sessionId || randomUUID();

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    const session = getSession(sessionId);
    const result = await runChatTurn(session, message);
    res.json({ sessionId, ...result });
  } catch (err) {
    console.error("chat error:", err);
    res.status(500).json({ error: "Something went wrong talking to the assistant." });
  }
});

export default router;
