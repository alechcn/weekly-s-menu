// Weekly Menu shared backend: one small document store in D1, guarded by a household code.
// GET  /api/state[?v=N]        -> { version, docs: { col: { id: data } } }  (only { version } when unchanged)
// PUT  /api/doc/:col/:id       body: JSON doc   -> replace
// PATCH /api/doc/:col/:id      body: JSON doc   -> shallow merge
// DELETE /api/doc/:col/:id
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

async function bump(db) {
  const r = await db.prepare("UPDATE meta SET v = v + 1 WHERE k = 'version' RETURNING v").first();
  return r ? r.v : 0;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    const db = env.DB;
    await init(db);
    if (!(await codeOk(db, env, req.headers.get("x-household") || ""))) return json({ error: "code" }, 401);

    if (url.pathname === "/api/state" && req.method === "GET") {
      const v = (await db.prepare("SELECT v FROM meta WHERE k = 'version'").first())?.v || 0;
      if (url.searchParams.get("v") === String(v)) return json({ version: v });
      const { results } = await db.prepare("SELECT col, id, data FROM docs").all();
      const docs = {};
      for (const r of results) { (docs[r.col] ||= {})[r.id] = JSON.parse(r.data); }
      return json({ version: v, docs });
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
