// api/packages.js — возвращает пакеты eSIM Cards
// Vercel serverless function

const ESIMCARDS_EMAIL = process.env.ESIMCARDS_EMAIL;
const ESIMCARDS_PASSWORD = process.env.ESIMCARDS_PASSWORD;
const BASE_URL = "https://portal.esimcard.com/api/developer/reseller";
const MARKUP = parseFloat(process.env.MARKUP_PERCENT || "30") / 100;

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await fetch(`${BASE_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ESIMCARDS_EMAIL, password: ESIMCARDS_PASSWORD }),
  });

  const data = await res.json();
  if (!data.status) throw new Error("Auth failed: " + data.message);

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + 50 * 60 * 1000; // 50 минут
  return cachedToken;
}

function applyMarkup(price) {
  return Math.round(price * (1 + MARKUP) * 100) / 100;
}

function flagFromCode(code) {
  if (!code || code.length !== 2) return "🌐";
  return [...code.toUpperCase()].map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join("");
}

export default async function handler(req, res) {
  // CORS — разрешаем запросы из Mini App
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const token = await getToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const type = req.query.type || "global"; // global | continents | country
    const id = req.query.id; // continent_id или country_id

    // ── Список континентов ──────────────────────────────
    if (type === "continents") {
      const r = await fetch(`${BASE_URL}/packages/continent`, { headers });
      const data = await r.json();
      return res.json({ ok: true, data: data.data || [] });
    }

    // ── Страны континента ───────────────────────────────
    if (type === "countries" && id) {
      const r = await fetch(`${BASE_URL}/packages/country`, { headers });
      const data = await r.json();
      return res.json({ ok: true, data: data.data || [] });
    }

    // ── Пакеты страны ───────────────────────────────────
    if (type === "country" && id) {
      const r = await fetch(
        `${BASE_URL}/packages/country/${id}?package_type=DATA-ONLY`,
        { headers }
      );
      const data = await r.json();
      const name = req.query.name || "Страна";
      const code = req.query.code || "XX";

      const packages = (data.data || []).map((pkg) => ({
        id: pkg.id,
        name: pkg.name,
        country: name,
        country_code: code.toUpperCase(),
        flag: flagFromCode(code),
        gb: parseFloat(pkg.data_quantity) || 0,
        days: parseInt(pkg.package_validity) || 0,
        price: applyMarkup(parseFloat(pkg.price) || 0),
        wholesale: parseFloat(pkg.price) || 0,
        unlimited: pkg.unlimited || false,
      }));

      return res.json({ ok: true, data: packages });
    }

    // ── Глобальные пакеты (по умолчанию) ────────────────
    const r = await fetch(`${BASE_URL}/packages/global/DATA-ONLY`, { headers });
    const data = await r.json();

    const packages = (data.data || []).map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      country: "Весь мир",
      country_code: "WW",
      flag: "🌍",
      gb: parseFloat(pkg.data_quantity) || 0,
      days: parseInt(pkg.package_validity) || 0,
      price: applyMarkup(parseFloat(pkg.price) || 0),
      wholesale: parseFloat(pkg.price) || 0,
      unlimited: pkg.unlimited || false,
    }));

    return res.json({ ok: true, data: packages });
  } catch (err) {
    console.error("API error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
