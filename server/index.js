import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chatRouter from "./routes/chat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const required = ["ANTHROPIC_API_KEY", "SHOPIFY_STORE_DOMAIN", "SHOPIFY_STOREFRONT_TOKEN"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(", ")}. Copy .env.example to .env and fill them in.`);
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api", chatRouter);
app.use(express.static(path.join(__dirname, "..", "widget")));
app.use("/preview", express.static(path.join(__dirname, "..", "preview")));

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`Storefront AI agent backend listening on http://localhost:${port}`);
});
