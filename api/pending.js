// api/pending.js — очередь заказов Mini App в Upstash Redis
// Переживает рестарты Vercel и работает корректно при нескольких копиях функции.
// Без npm-зависимостей: общаемся с Redis через REST API обычным fetch.

const crypto = require("crypto");

// Vercel сам добавит эти переменные при подключении Upstash Redis в Storage
const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const KEY = "pending_orders";
const FRESH_MS = 5 * 60 * 1000; // отдаём боту только заказы свежее 5 минут

// Выполняет несколько Redis-команд атомарно (транзакция MULTI/EXEC)
async function redis(commands) {
  const r = await fetch(`${REDIS_URL}/multi-exec`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`Redis ${r.status}: ${await r.text()}`);
  return r.json(); // массив [{result: ...}, ...]
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: "Redis не настроен: подключи Upstash Redis во вкладке Storage проекта на Vercel",
    });
  }

  // ── Mini App сохраняет выбор ──────────────────────────
  if (req.method === "POST") {
    try {
      const { telegram_id, pkg } = req.body;
      if (!telegram_id || !pkg) return res.status(400).json({ ok: false });

      const order = JSON.stringify({
        pkg,
        ts: Date.now(),
        id: crypto.randomUUID(), // уникальный id — для дедупликации на стороне бота
      });

      // HSET: одна ожидающая покупка на пользователя —
      // повторный клик «Купить» заменяет предыдущий выбор (как было раньше)
      await redis([["HSET", KEY, String(telegram_id), order]]);
      return res.json({ ok: true });
    } catch (e) {
      console.error("pending POST error:", e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── Бот забирает все ожидающие заказы ────────────────
  if (req.method === "GET") {
    try {
      // Атомарно: читаем все заказы и тут же удаляем ключ.
      // Даже если бот опросит другую копию функции — повторно эти заказы никто не отдаст.
      const results = await redis([
        ["HGETALL", KEY],
        ["DEL", KEY],
      ]);

      const flat = (results[0] && results[0].result) || [];
      const orders = [];
      const now = Date.now();

      // HGETALL возвращает плоский массив: [telegram_id, json, telegram_id, json, ...]
      for (let i = 0; i + 1 < flat.length; i += 2) {
        try {
          const data = JSON.parse(flat[i + 1]);
          if (now - data.ts < FRESH_MS) {
            orders.push({
              telegram_id: Number(flat[i]),
              pkg: data.pkg,
              ts: data.ts,
              id: data.id,
            });
          }
        } catch (_) {
          // битая запись — пропускаем
        }
      }

      return res.json({ ok: true, orders });
    } catch (e) {
      console.error("pending GET error:", e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  return res.status(405).end();
};
