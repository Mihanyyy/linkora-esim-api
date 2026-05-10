// api/packages.js — Vercel serverless function

const ESIMCARDS_EMAIL = process.env.ESIMCARDS_EMAIL;
const ESIMCARDS_PASSWORD = process.env.ESIMCARDS_PASSWORD;
const BASE_URL = "https://portal.esimcard.com/api/developer/reseller";
const MARKUP = parseFloat(process.env.MARKUP_PERCENT || "30") / 100;

let cachedToken = null;
let tokenExpiry = 0;
let cachedCountries = null;
let cachedContinents = null;

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
  tokenExpiry = Date.now() + 50 * 60 * 1000;
  return cachedToken;
}

function applyMarkup(price) {
  return Math.round(price * (1 + MARKUP) * 100) / 100;
}

function flagFromUrl(imageUrl) {
  if (!imageUrl) return "🌐";
  const code = imageUrl.split("/").pop().replace(".png", "").replace(".svg", "").toUpperCase();
  if (code.length !== 2) return "🌐";
  return [...code].map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join("");
}

function codeFromUrl(imageUrl) {
  if (!imageUrl) return "XX";
  return imageUrl.split("/").pop().replace(".png", "").replace(".svg", "").toUpperCase();
}

module.exports = async function handler(req, res) {
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

    const type = req.query.type || "global";
    const id = req.query.id;

    // ── Список континентов ──────────────────────────────
    if (type === "continents") {
      if (!cachedContinents) {
        const r = await fetch(`${BASE_URL}/packages/continent`, { headers });
        const data = await r.json();
        cachedContinents = data.data || [];
      }
      return res.json({ ok: true, data: cachedContinents });
    }

    // ── Страны континента ───────────────────────────────
    if (type === "countries" && id) {
      // Получаем пакеты континента — они содержат страны
      const r = await fetch(
        `${BASE_URL}/packages/continent/${id}?package_type=DATA-ONLY`,
        { headers }
      );
      const data = await r.json();
      const pkgs = data.data || [];

      // Извлекаем уникальные страны из пакетов
      const countriesMap = new Map();
      for (const pkg of pkgs) {
        const countries = pkg.countries || pkg.country_list || [];
        for (const c of countries) {
          if (!countriesMap.has(c.id)) {
            countriesMap.set(c.id, c);
          }
        }
      }

      // Если пакеты не содержат стран — получаем список стран отдельно
      if (countriesMap.size === 0) {
        if (!cachedCountries) {
          const r2 = await fetch(`${BASE_URL}/packages/country`, { headers });
          const d2 = await r2.json();
          cachedCountries = d2.data || [];
        }
        return res.json({ ok: true, data: cachedCountries, continent_id: id });
      }

      return res.json({ ok: true, data: Array.from(countriesMap.values()) });
    }

    // ── Пакеты страны ───────────────────────────────────
    if (type === "country" && id) {
      const r = await fetch(
        `${BASE_URL}/packages/country/${id}?package_type=DATA-ONLY`,
        { headers }
      );
      const data = await r.json();
      const name = decodeURIComponent(req.query.name || "Страна");
      const code = req.query.code || "XX";

      const packages = (data.data || []).map(pkg => ({
        id: pkg.id,
        name: pkg.name,
        country: name,
        country_code: code.toUpperCase(),
        flag: code.length === 2
          ? [...code.toUpperCase()].map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join("")
          : "🌐",
        gb: parseFloat(pkg.data_quantity) || 0,
        days: parseInt(pkg.package_validity) || 0,
        price: applyMarkup(parseFloat(pkg.price) || 0),
        unlimited: pkg.unlimited || false,
      }));

      return res.json({ ok: true, data: packages });
    }

    // ── Глобальные пакеты ───────────────────────────────
    const r = await fetch(`${BASE_URL}/packages/global/DATA-ONLY`, { headers });
    const data = await r.json();

    const packages = (data.data || []).map(pkg => ({
      id: pkg.id,
      name: pkg.name,
      country: "Весь мир",
      country_code: "WW",
      flag: "🌍",
      gb: parseFloat(pkg.data_quantity) || 0,
      days: parseInt(pkg.package_validity) || 0,
      price: applyMarkup(parseFloat(pkg.price) || 0),
      unlimited: pkg.unlimited || false,
    }));

    return res.json({ ok: true, data: packages });

  } catch (err) {
    console.error("API error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
