// api/status.js — на связи ли бот. Мини-приложение спрашивает это перед оплатой.
// Бот раз в минуту отмечается через /api/pending?hb=1 (см. pending.js).

const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "").trim().replace(/\/+$/, "");
const REDIS_TOKEN = (process.env.UPSTASH_REDIS_REST_URL
  ? process.env.UPSTASH_REDIS_REST_TOKEN
  : process.env.KV_REST_API_TOKEN || "").trim();

const ALIVE_KEY = "bot_alive";
const ALIVE_MS = 150 * 1000; // как в pending.js

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).end();

  try {
    const r = await fetch(REDIS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(["GET", ALIVE_KEY]),
    });
    if (!r.ok) throw new Error(`Redis ${r.status}`);
    const seen = (await r.json()).result;
    // сигналов не было никогда — бот старой версии, считаем, что он на связи
    const online = seen === null || seen === undefined || Date.now() - Number(seen) <= ALIVE_MS;
    // Ответ минуту хранится на серверах Vercel, чтобы не тратить лимит Redis на каждое открытие каталога
    res.setHeader("Cache-Control", "public, s-maxage=60");
    return res.json({ ok: true, online });
  } catch (e) {
    console.error("status error:", e.message);
    // статус узнать не удалось: не мешаем покупке, оплата сама сообщит об ошибке
    return res.json({ ok: true, online: true, unknown: true });
  }
};
