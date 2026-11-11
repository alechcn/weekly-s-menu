// Weekly Menu shared backend: one small document store in D1, guarded by a household code.
// GET  /api/state[?v=N]        -> { version, docs: { col: { id: data } } }  (only { version } when unchanged)
// PUT  /api/doc/:col/:id       body: JSON doc   -> replace
// PATCH /api/doc/:col/:id      body: JSON doc   -> shallow merge
// DELETE /api/doc/:col/:id
// POST /api/ai    { prompt, images?: [dataURL] } -> { result }   (recipe reading and translation, Workers AI)
// POST /api/page  { url }                        -> { site, title, recipe, text }   (a recipe web page, cleaned up)
// GET  /api/export                               -> every document, as a backup file
// Every Monday 03:00 UTC a copy of everything is kept in the backups table (last 12).
import SEED from "./seed.json";
const COLS = new Set(["recipes", "inbox", "plan", "cart", "meta"]);
const ID = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_DOC = 256 * 1024;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function sameCode(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// First request on a fresh database: create the tables and load the catalog recipes.
let ready = null;
function init(db) {
  return ready ||= (async () => {
    await db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (col, id))"),
      db.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)"),
      db.prepare("CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, s TEXT NOT NULL)"),
      db.prepare("CREATE TABLE IF NOT EXISTS backups (at TEXT PRIMARY KEY, data TEXT NOT NULL)"),
      db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('version', 1)"),
    ]);
    const seeded = await db.prepare("SELECT s FROM settings WHERE k = 'seeded'").first();
    if (!seeded) {
      const stmts = Object.entries(SEED).map(([id, d]) => db.prepare("INSERT OR IGNORE INTO docs (col, id, data) VALUES ('recipes', ?, ?)").bind(id, JSON.stringify(d)));
      stmts.push(db.prepare("INSERT OR IGNORE INTO settings (k, s) VALUES ('seeded', '1')"));
      await db.batch(stmts);
    }
  })().catch((e) => { ready = null; throw e; });
}

// The household code: a HOUSEHOLD_CODE secret if one is set, otherwise the first code typed in is kept.
async function codeOk(db, env, given) {
  if (env.HOUSEHOLD_CODE) return sameCode(given, env.HOUSEHOLD_CODE);
  const row = await db.prepare("SELECT s FROM settings WHERE k = 'code'").first();
  if (row) return sameCode(given, row.s);
  if (given.length < 4) return false;
  await db.prepare("INSERT OR IGNORE INTO settings (k, s) VALUES ('code', ?)").bind(given).run();
  const now = await db.prepare("SELECT s FROM settings WHERE k = 'code'").first();
  return !!now && sameCode(given, now.s);
}

async function allDocs(db) {
  const { results } = await db.prepare("SELECT col, id, data FROM docs").all();
  const docs = {};
  for (const r of results) { (docs[r.col] ||= {})[r.id] = JSON.parse(r.data); }
  return docs;
}

async function backup(db) {
  await init(db);
  const at = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO backups (at, data) VALUES (?, ?)").bind(at, JSON.stringify(await allDocs(db))),
    db.prepare("DELETE FROM backups WHERE at NOT IN (SELECT at FROM backups ORDER BY at DESC LIMIT 12)"),
  ]);
}

// ---- recipe reading
const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
function firstJson(t) {
  if (t && typeof t === "object") return t;
  t = String(t || "").replace(/```(?:json)?/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}
async function ai(env, prompt, images) {
  const content = [{ type: "text", text: prompt }];
  for (const url of images) content.push({ type: "image_url", image_url: { url } });
  const out = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: "You turn recipes into clean JSON for a family meal-planning app. Reply with JSON only, no comments." },
      { role: "user", content: images.length ? content : prompt },
    ],
    max_tokens: 3000, temperature: 0.2,
  });
  return firstJson(out && out.response !== undefined ? out.response : out);
}

const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
function findRecipe(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipe(n); if (r) return r; } return null; }
  const t = node["@type"];
  if (t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"))) return node;
  return findRecipe(node["@graph"]) || null;
}
function slimRecipe(r) {
  const steps = [];
  const walk = (x) => { if (!x) return; if (typeof x === "string") steps.push(x); else if (Array.isArray(x)) x.forEach(walk); else if (x.itemListElement) walk(x.itemListElement); else if (x.text) steps.push(x.text); };
  walk(r.recipeInstructions);
  return { name: r.name, yield: r.recipeYield, totalTime: r.totalTime, cookTime: r.cookTime, prepTime: r.prepTime,
    ingredients: r.recipeIngredient || r.ingredients, steps: steps.map((s) => decode(String(s)).trim()).filter(Boolean), category: r.recipeCategory, cuisine: r.recipeCuisine };
}
async function readPage(raw) {
  let url; try { url = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const res = await fetch(url.href, { redirect: "follow", headers: {
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "accept": "text/html,application/xhtml+xml", "accept-language": "en,fr;q=0.8,es;q=0.6" } });
  if (!res.ok) return null;
  const html = (await res.text()).slice(0, 3_000_000);
  let recipe = null;
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { recipe = findRecipe(JSON.parse(m[1].trim())); } catch {}
    if (recipe) break;
  }
  const meta = (p) => { const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + p + '["\'][^>]+content=["\']([^"\']*)', "i")); return m ? decode(m[1]) : ""; };
  const title = meta("og:title") || decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").trim();
  const text = decode(html.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return { site: meta("og:site_name") || url.hostname.replace(/^www\./, ""), title, recipe: recipe ? slimRecipe(recipe) : null, text: recipe ? text.slice(0, 4000) : text.slice(0, 16000) };
}

async function bump(db) {
  const r = await db.prepare("UPDATE meta SET v = v + 1 WHERE k = 'version' RETURNING v").first();
  return r ? r.v : 0;
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(backup(env.DB)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    const db = env.DB;
    await init(db);
    if (!(await codeOk(db, env, req.headers.get("x-household") || ""))) return json({ error: "code" }, 401);

    if (url.pathname === "/api/state" && req.method === "GET") {
      const v = (await db.prepare("SELECT v FROM meta WHERE k = 'version'").first())?.v || 0;
      if (url.searchParams.get("v") === String(v)) return json({ version: v });
      return json({ version: v, docs: await allDocs(db) });
    }
    if (url.pathname === "/api/export" && req.method === "GET") {
      const body = JSON.stringify({ exportedAt: new Date().toISOString(), docs: await allDocs(db) }, null, 1);
      return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
        "content-disposition": 'attachment; filename="weekly-menu-backup.json"' } });
    }
    if (url.pathname === "/api/page" && req.method === "POST") {
      let b; try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
      try { const page = await readPage(String(b.url || "")); return page ? json(page) : json({ error: "fetch" }, 422); }
      catch { return json({ error: "fetch" }, 422); }
    }
    if (url.pathname === "/api/ai" && req.method === "POST") {
      const text = await req.text();
      if (text.length > 8 * 1024 * 1024) return json({ error: "too_big" }, 413);
      let b; try { b = JSON.parse(text); } catch { return json({ error: "bad_json" }, 400); }
      const images = (Array.isArray(b.images) ? b.images : []).filter((u) => typeof u === "string" && u.startsWith("data:image/")).slice(0, 4);
      if (typeof b.prompt !== "string" || !b.prompt) return json({ error: "bad_json" }, 400);
      if (!env.AI) return json({ error: "no_ai" }, 503);
      try { return json({ result: await ai(env, b.prompt.slice(0, 60000), images) }); }
      catch (e) { return json({ error: /rate|limit|capacity|429/i.test(String(e && e.message)) ? "rate_limited" : "ai" }, 502); }
    }

    const m = url.pathname.match(/^\/api\/doc\/([^/]+)\/([^/]+)$/);
    if (!m) return json({ error: "not_found" }, 404);
    const col = decodeURIComponent(m[1]), id = decodeURIComponent(m[2]);
    if (!COLS.has(col) || !ID.test(id)) return json({ error: "bad_path" }, 400);

    if (req.method === "DELETE") {
      await db.prepare("DELETE FROM docs WHERE col = ? AND id = ?").bind(col, id).run();
      return json({ version: await bump(db) });
    }
    if (req.method !== "PUT" && req.method !== "PATCH") return json({ error: "method" }, 405);
    const text = await req.text();
    if (text.length > MAX_DOC) return json({ error: "too_big" }, 413);
    let body; try { body = JSON.parse(text); } catch { return json({ error: "bad_json" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad_json" }, 400);
    if (req.method === "PATCH") {
      const cur = await db.prepare("SELECT data FROM docs WHERE col = ? AND id = ?").bind(col, id).first();
      body = { ...(cur ? JSON.parse(cur.data) : {}), ...body };
    }
    await db.prepare("INSERT INTO docs (col, id, data) VALUES (?, ?, ?) ON CONFLICT (col, id) DO UPDATE SET data = excluded.data")
      .bind(col, id, JSON.stringify(body)).run();
    return json({ version: await bump(db) });
  },
};
