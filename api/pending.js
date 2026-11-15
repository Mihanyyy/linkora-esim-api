// api/pending.js — очередь заказов Mini App в Upstash Redis
// Переживает рестарты Vercel и работает корректно при нескольких копиях функции.
// Без npm-зависимостей: общаемся с Redis через REST API обычным fetch.

const crypto = require("crypto");

// Vercel сам добавит эти переменные при подключении Upstash Redis в Storage
const URL_VAR = process.env.UPSTASH_REDIS_REST_URL
  ? "UPSTASH_REDIS_REST_URL"
  : "KV_REST_API_URL";
const TOKEN_VAR = process.env.UPSTASH_REDIS_REST_TOKEN
  ? "UPSTASH_REDIS_REST_TOKEN"
  : "KV_REST_API_TOKEN";
const REDIS_URL = (process.env[URL_VAR] || "").trim().replace(/\/+$/, "");
const REDIS_TOKEN = (process.env[TOKEN_VAR] || "").trim();

// ── Защита очереди ──────────────────────────────────────────────────────
// Включается, когда в настройках Vercel есть переменная BOT_TOKEN (токен бота от @BotFather).
// Пока её нет, всё работает как раньше, без проверок.
//   • Заказ (POST) принимается только с подписью Telegram: мини-приложение присылает строку
//     initData, её подлинность проверяется токеном бота. Номер клиента берётся из этой строки,
//     а не из того, что написано в запросе, поэтому оформить заказ на чужой аккаунт нельзя.
//   • Очередь (GET) отдаётся только боту: он присылает ключ, вычисленный из того же токена.
//     Сам токен по сети не передаётся.
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const INIT_MAX_AGE_SEC = 24 * 60 * 60;   // каталог, открытый больше суток назад, просим открыть заново

function sameText(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Ключ, по которому бот получает очередь
function queueKey() {
  return crypto.createHmac("sha256", BOT_TOKEN).update("linkora-queue").digest("hex");
}

// Проверка строки initData из мини-приложения (алгоритм из документации Telegram).
// Возвращает { ok: true, userId } или { ok: false, error: "auth" | "stale" }.
function checkInitData(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 8192) return { ok: false, error: "auth" };
  const fields = new URLSearchParams(raw);
  const hash = fields.get("hash");
  if (!hash) return { ok: false, error: "auth" };
  fields.delete("hash");
  const lines = [...fields.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`);
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const expected = crypto.createHmac("sha256", secret).update(lines.join("\n")).digest("hex");
  if (!sameText(hash.toLowerCase(), expected)) return { ok: false, error: "auth" };

  const age = Math.floor(Date.now() / 1000) - Number(fields.get("auth_date"));
  if (!Number.isFinite(age) || age > INIT_MAX_AGE_SEC || age < -300) return { ok: false, error: "stale" };

  let userId = 0;
  try { userId = Number(JSON.parse(fields.get("user") || "{}").id); } catch (_) {}
  if (!Number.isSafeInteger(userId) || userId <= 0) return { ok: false, error: "auth" };
  return { ok: true, userId };
}

// Понятная подсказка, если переменные заполнены неверно. Сами значения не показываем.
function configProblem() {
  if (!REDIS_URL || !REDIS_TOKEN) {
    return "Redis не настроен: в Vercel нет переменных UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN";
  }
  if (/["'\s]/.test(REDIS_URL)) {
    return `В переменной ${URL_VAR} есть кавычки или пробелы: вставь только адрес https://...upstash.io`;
  }
  if (!/^https:\/\//i.test(REDIS_URL)) {
    return `Переменная ${URL_VAR} должна начинаться с https:// (сейчас начинается с «${REDIS_URL.slice(0, 8)}»). Нужен адрес из блока REST API в Upstash, а не redis:// или rediss://`;
  }
  if (/["'\s]/.test(REDIS_TOKEN)) {
    return `В переменной ${TOKEN_VAR} есть кавычки или пробелы: вставь только сам токен`;
  }
  if (BOT_TOKEN && !/^\d+:[\w-]{20,}$/.test(BOT_TOKEN)) {
    return "Переменная BOT_TOKEN в Vercel не похожа на токен бота: вставь токен из @BotFather целиком, без кавычек и пробелов (вид 1234567890:AAH...), и сделай Redeploy";
  }
  return null;
}

// Что именно сломалось при обращении к Redis (без секретов)
function explain(e) {
  const code = (e && e.cause && (e.cause.code || e.cause.message)) || "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `Адрес базы из переменной ${URL_VAR} не существует (${code}): база удалена или адрес скопирован с ошибкой. Вставь адрес новой базы и сделай Redeploy`;
  }
  if (/Redis 401|Unauthorized|WRONGPASS/i.test(e.message)) {
    return `Upstash не принял токен из переменной ${TOKEN_VAR}: вставь обычный токен (не Read-only) от новой базы и сделай Redeploy`;
  }
  return `${e.message}${code ? " (" + code + ")" : ""} [адрес из ${URL_VAR}]`;
}

const KEY = "pending_orders";
const FRESH_MS = 5 * 60 * 1000; // отдаём боту только заказы свежее 5 минут

// Бот раз в минуту добавляет к запросу ?hb=1 — так API знает, что он на связи.
// Если сигнала не было дольше ALIVE_MS, заказы не принимаем: счёт клиенту всё равно не придёт.
const ALIVE_KEY = "bot_alive";
const ALIVE_MS = 150 * 1000;

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

// Одна Redis-команда (без транзакции)
async function redisOne(command) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`Redis ${r.status}: ${await r.text()}`);
  const data = await r.json();
  if (data.error) throw new Error(`Redis: ${data.error}`);
  return data.result;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const problem = configProblem();
  if (problem) return res.status(500).json({ ok: false, error: problem });

  // ── Mini App сохраняет выбор ──────────────────────────
  if (req.method === "POST") {
    try {
      const { pkg, init_data } = req.body || {};
      let telegram_id = (req.body || {}).telegram_id;
      if (BOT_TOKEN) {
        // защита включена: клиент — тот, чью подпись подтвердил Telegram
        const who = checkInitData(init_data);
        if (!who.ok) return res.status(401).json({ ok: false, error: who.error });
        telegram_id = who.userId;
      }
      if (!telegram_id || !pkg || typeof pkg !== "object" || JSON.stringify(pkg).length > 2000) {
        return res.status(400).json({ ok: false });
      }

      // Бот выключен (компьютер спит, нет интернета): честно говорим об этом,
      // а не принимаем заказ, по которому никто не выставит счёт.
      // Если сигналов не было никогда, бот старой версии — работаем как раньше.
      const seen = await redisOne(["GET", ALIVE_KEY]);
      if (seen !== null && Date.now() - Number(seen) > ALIVE_MS) {
        return res.status(503).json({ ok: false, error: "bot_offline" });
      }

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
      return res.status(500).json({ ok: false, error: explain(e) });
    }
  }

  // ── Бот забирает все ожидающие заказы ────────────────
  if (req.method === "GET") {
    // защита включена: очередь получает только бот, по ключу из токена
    if (BOT_TOKEN && !sameText(req.headers["x-queue-key"], queueKey())) {
      return res.status(401).json({ ok: false, error: "forbidden" });
    }
    try {
      // Сначала дешёвая проверка: пустая очередь = 1 команда Redis вместо 2.
      // Бот спрашивает очередь каждые несколько секунд, а бесплатный Upstash
      // даёт 500 тысяч команд в месяц — так лимит не кончится.
      let count;
      if (req.query && req.query.hb) {
        // тот же запрос заодно отмечает, что бот на связи
        [count] = await Promise.all([
          redisOne(["HLEN", KEY]),
          redisOne(["SET", ALIVE_KEY, String(Date.now())]),
        ]);
      } else {
        count = await redisOne(["HLEN", KEY]);
      }
      if (!Number(count)) return res.json({ ok: true, orders: [] });

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
      return res.status(500).json({ ok: false, error: explain(e) });
    }
  }

  return res.status(405).end();
};
