// api/pending.js — хранит выборы пользователей пока бот не заберёт

// В памяти (сбрасывается при рестарте Vercel, но этого достаточно)
const pending = new Map();

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Mini App сохраняет выбор
  if (req.method === "POST") {
    try {
      const { telegram_id, pkg } = req.body;
      if (!telegram_id || !pkg) return res.status(400).json({ ok: false });
      pending.set(String(telegram_id), { pkg, ts: Date.now() });
      return res.json({ ok: true });
    } catch(e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // Бот забирает все ожидающие заказы
  if (req.method === "GET") {
    const orders = [];
    const now = Date.now();
    for (const [telegram_id, data] of pending.entries()) {
      // Отдаём только свежие (до 5 минут)
      if (now - data.ts < 5 * 60 * 1000) {
        orders.push({ telegram_id: Number(telegram_id), pkg: data.pkg });
      }
      pending.delete(telegram_id);
    }
    return res.json({ ok: true, orders });
  }

  return res.status(405).end();
};
