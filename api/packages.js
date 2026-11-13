// api/packages.js — Vercel serverless function: каталог eSIM для мини-приложения
//
//   ?type=continents            список регионов
//   ?type=all                   все страны (для поиска и общего списка)
//   ?type=countries&id=2        страны региона
//   ?type=regional&id=2         тарифы на весь регион (+ какие страны входят в каждый)
//   ?type=country&id=134        тарифы страны
//   ?type=global                тарифы «весь мир»

const ESIMCARDS_EMAIL = process.env.ESIMCARDS_EMAIL;
const ESIMCARDS_PASSWORD = process.env.ESIMCARDS_PASSWORD;
const BASE_URL = "https://portal.esimcard.com/api/developer/reseller";
const MARKUP = parseFloat(process.env.MARKUP_PERCENT || "30") / 100;

let cachedToken = null;
let tokenExpiry = 0;

// Память функции живёт недолго, но этого хватает, чтобы не дёргать eSIMCard на каждый запрос
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.data;
  const data = await loader();
  cache.set(key, { ts: Date.now(), data });
  return data;
}

async function getToken(force) {
  if (!force && cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(`${BASE_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: ESIMCARDS_EMAIL, password: ESIMCARDS_PASSWORD }),
  });
  const data = await res.json();
  if (!data.status) throw new Error("Auth failed: " + data.message);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + 50 * 60 * 1000;
  return cachedToken;
}

async function getJson(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt > 0);
    const r = await fetch(`${BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    if (r.status === 401 && attempt === 0) continue; // токен устарел: входим заново
    if (!r.ok) throw new Error(`eSIMCard ${path}: HTTP ${r.status}`);
    return r.json();
  }
  throw new Error(`eSIMCard ${path}: не удалось войти`);
}

function listOf(body) {
  if (body && Array.isArray(body.data)) return body.data;
  if (body && body.data && Array.isArray(body.data.data)) return body.data.data;
  return [];
}

function lastPageOf(body) {
  const metas = [body && body.meta, body && body.pagination, body && body.data, body];
  for (const m of metas) {
    if (!m || Array.isArray(m)) continue;
    const n = Number(m.last_page || m.lastPage || m.total_pages || m.totalPages || 0);
    if (n > 0) return n;
  }
  return 0;
}

// Список целиком. eSIMCard часть списков отдаёт страницами (по 15 штук),
// поэтому дочитываем следующие страницы, пока появляются новые тарифы.
async function getList(path) {
  const first = await getJson(path);
  let items = listOf(first);
  const lastPage = lastPageOf(first);
  const looksPaged = items.length >= 10 && items.length % 5 === 0;
  if (lastPage <= 1 && !looksPaged) return items;

  const sep = path.includes("?") ? "&" : "?";
  const seen = new Set(items.map(i => String(i.id)));
  const pageSize = items.length;
  for (let page = 2; page <= (lastPage || 20); page++) {
    let next;
    try {
      next = listOf(await getJson(`${path}${sep}page=${page}`));
    } catch (e) {
      break;
    }
    const fresh = next.filter(i => !seen.has(String(i.id)));
    if (!fresh.length) break; // страниц нет или сервер не понимает ?page
    fresh.forEach(i => seen.add(String(i.id)));
    items = items.concat(fresh);
    if (!lastPage && next.length < pageSize) break;
  }
  return items;
}

function applyMarkup(price) {
  return Math.round(price * (1 + MARKUP) * 100) / 100;
}

function flagOf(code) {
  const c = String(code || "").toUpperCase();
  return /^[A-Z]{2}$/.test(c)
    ? [...c].map(ch => String.fromCodePoint(0x1f1e6 + ch.charCodeAt(0) - 65)).join("")
    : "🌐";
}

const CONTINENT_FLAGS = {
  1: "🌏", 2: "🇪🇺", 3: "🌍", 4: "🌏", 6: "🌎", 7: "🌎",
  8: "🕌", 9: "🏝", 10: "🕌", 11: "🌎", 12: "🇪🇺", 13: "🇪🇺",
};

const CONTINENT_NAMES_RU = {
  "Asia": "Азия",
  "Europe": "Европа",
  "Africa": "Африка",
  "Oceania": "Океания",
  "North America": "Северная Америка",
  "South America": "Южная Америка",
  "Middle East": "Ближний Восток",
  "Caribbean": "Карибский бассейн",
  "GCC Middle East": "Страны Залива",
  "Latin America": "Латинская Америка",
  "Balkans": "Балканы",
  "Europe + Balkans": "Европа + Балканы",
};

function getContinents() {
  return cached("continents", async () =>
    (await getList("/packages/continent")).map(c => ({
      id: c.id,
      name: c.name,
      code: c.code,
      name_ru: CONTINENT_NAMES_RU[c.name] || c.name,
      flag: CONTINENT_FLAGS[c.id] || "🌐",
    }))
  );
}

function slimCountry(c) {
  return { id: c.id, code: c.code, name: c.name, image_url: c.image_url };
}

function countriesOf(pkg) {
  const list = pkg.countries || pkg.country_list || [];
  return Array.isArray(list) ? list.filter(c => c && c.id != null) : [];
}

// Общие поля тарифа. coverage — общий список наборов стран; у тарифа в cv лежит номер набора.
function mapPackage(pkg, extra, coverage) {
  const out = {
    id: pkg.id,
    name: pkg.name,
    gb: parseFloat(pkg.data_quantity) || 0,
    days: parseInt(pkg.package_validity) || 0,
    price: applyMarkup(parseFloat(pkg.price) || 0),
    unlimited: Boolean(pkg.unlimited),
    ...extra,
  };
  if (coverage) {
    const codes = [...new Set(
      countriesOf(pkg).map(c => String(c.code || "").toLowerCase()).filter(Boolean)
    )].sort();
    if (codes.length) {
      const key = codes.join(",");
      let index = coverage.keys.indexOf(key);
      if (index < 0) {
        coverage.keys.push(key);
        coverage.list.push(codes);
        index = coverage.keys.length - 1;
      }
      out.cv = index;
    }
  }
  return out;
}

function continentPackages(id) {
  return cached("continent:" + id, () =>
    getList(`/packages/continent/${encodeURIComponent(id)}?package_type=DATA-ONLY`)
  );
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const send = body => {
    // Ответ 5 минут хранится на серверах Vercel: каталог открывается быстрее.
    // Цену перед оплатой бот всё равно считает сам.
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    return res.json(body);
  };

  try {
    const type = String(req.query.type || "global");
    const id = req.query.id;

    // ── Список регионов ─────────────────────────────────
    if (type === "continents") {
      return send({ ok: true, data: await getContinents() });
    }

    // ── Все страны ──────────────────────────────────────
    if (type === "all") {
      const countries = await cached("countries", async () =>
        (await getList("/packages/country")).map(slimCountry)
      );
      return send({ ok: true, data: countries });
    }

    // ── Тарифы на весь регион ───────────────────────────
    if (type === "regional" && id) {
      const [raw, continents] = await Promise.all([continentPackages(id), getContinents()]);
      const continent = continents.find(c => String(c.id) === String(id));
      const coverage = { keys: [], list: [] };
      const packages = raw.map(pkg => mapPackage(pkg, {
        country: continent ? continent.name_ru : "Регион",
        country_code: "REG",
        flag: continent ? continent.flag : "🌐",
        is_regional: true,
        continent_id: String(id),
      }, coverage));
      return send({ ok: true, data: packages, coverage: coverage.list });
    }

    // ── Страны региона ──────────────────────────────────
    if (type === "countries" && id) {
      const raw = await continentPackages(id);
      const map = new Map();
      const sets = new Map();   // разные списки стран у тарифов региона
      for (const pkg of raw) {
        const list = countriesOf(pkg);
        const key = list.map(c => c.id).sort().join(",");
        if (key && !sets.has(key)) sets.set(key, list);
      }
      // n — в скольких списках есть страна. Если n меньше sets, страна входит не во все тарифы региона.
      for (const list of sets.values()) {
        for (const c of list) {
          if (!map.has(c.id)) map.set(c.id, { ...slimCountry(c), n: 0 });
          map.get(c.id).n += 1;
        }
      }
      if (map.size === 0) {
        const all = await cached("countries", async () =>
          (await getList("/packages/country")).map(slimCountry)
        );
        return send({ ok: true, data: all, continent_id: String(id) });
      }
      return send({ ok: true, data: Array.from(map.values()), sets: sets.size });
    }

    // ── Тарифы страны ───────────────────────────────────
    if (type === "country" && id) {
      const raw = await cached("country:" + id, () =>
        getList(`/packages/country/${encodeURIComponent(id)}?package_type=DATA-ONLY`)
      );
      const name = String(req.query.name || "Страна");
      const code = String(req.query.code || "XX");
      const packages = raw.map(pkg => mapPackage(pkg, {
        country: name,
        country_code: code.toUpperCase(),
        flag: flagOf(code),
      }, null));
      return send({ ok: true, data: packages });
    }

    // ── Тарифы «весь мир» ───────────────────────────────
    const raw = await cached("global", () => getList("/packages/global/DATA-ONLY"));
    const coverage = { keys: [], list: [] };
    const packages = raw.map(pkg => mapPackage(pkg, {
      country: "Весь мир",
      country_code: "WW",
      flag: "🌍",
    }, coverage));
    return send({ ok: true, data: packages, coverage: coverage.list });

  } catch (err) {
    console.error("API error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
