"""Build the Cloudflare copy of Weekly Menu.
Usage: python3 build.py <weekly-menu.html> <recipes-export-dir>
Writes public/ (page + icons) and src/seed.json (catalog recipes loaded on the first visit)."""
import json, glob, os, sys, shutil
src, export = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
pub = os.path.join(here, "public"); os.makedirs(pub, exist_ok=True)
s = open(src).read()
shim = r'''<script>
// Cloudflare build: shared by both phones through /api, behind a household code.
// Works offline: the last state is kept on the phone and changes wait in an outbox until the network is back.
window.STANDALONE = true; window.CLOUD = true;
(() => {
  const KEY = "wm-household", CACHE = "wm-cache", OUTBOX = "wm-outbox";
  const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const qs = new URLSearchParams(location.search);
  let code = (qs.get("k") || ls.get(KEY) || "").trim();
  if (code) ls.set(KEY, code);
  let st = {}, version = 0, pending = 0, ready = false, flushing = false;
  let outbox = []; try { outbox = JSON.parse(ls.get(OUTBOX) || "[]"); } catch {}
  try { const c = JSON.parse(ls.get(CACHE) || "null"); if (c && c.docs) { st = c.docs; version = 0; ready = true; } } catch {}
  const subs = new Set();
  const notify = () => subs.forEach((f) => { try { f(); } catch {} });
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const saveCache = () => ls.set(CACHE, JSON.stringify({ docs: st }));
  const saveOutbox = () => ls.set(OUTBOX, JSON.stringify(outbox));
  // Keep who you are and the household code in the address, so an icon added to the home screen opens straight in.
  function keepAddress() {
    try {
      const q = new URLSearchParams(location.search);
      const me = ls.get("wm-me"); if (me) q.set("me", me);
      if (code) q.set("k", code);
      const next = "?" + q.toString();
      if (next !== location.search) history.replaceState(null, "", location.pathname + next + location.hash);
    } catch {}
  }
  function askCode(msg) {
    if (document.getElementById("hh")) return;
    const box = document.createElement("form"); box.id = "hh";
    box.style.cssText = "position:fixed;inset:0;z-index:99;display:grid;place-items:center;background:rgba(23,22,20,.55);padding:16px";
    box.innerHTML = '<div style="background:#F7F0E6;border-radius:24px;padding:24px;max-width:360px;width:100%;font-family:Roboto,system-ui,sans-serif;color:#171614">'
      + '<h3 style="margin:0 0 8px;font-size:20px">Household code</h3><p style="margin:0 0 16px;font-size:15px;opacity:.75"></p>'
      + '<input type="password" autocomplete="current-password" style="width:100%;box-sizing:border-box;min-height:48px;border-radius:14px;border:1.5px solid #171614;padding:0 14px;font-size:16px;background:#fff">'
      + '<button style="margin-top:12px;width:100%;min-height:48px;border:0;border-radius:999px;background:#171614;color:#fff;font-size:16px;font-weight:600">Open the menu</button></div>';
    box.querySelector("p").textContent = msg || "First time? Choose a code (4+ characters) and share it with each other. This phone remembers it.";
    box.onsubmit = (e) => { e.preventDefault(); code = box.querySelector("input").value.trim(); ls.set(KEY, code); box.remove(); pull(true); };
    document.body.appendChild(box); setTimeout(() => box.querySelector("input").focus(), 50);
  }
  async function api(method, path, body) {
    const r = await fetch("/api/" + path, { method, headers: { "x-household": code, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { askCode(code ? "That code didn't work. Try again." : ""); throw Object.assign(new Error("code"), { code: "code" }); }
    if (!r.ok) { let j = {}; try { j = await r.json(); } catch {} throw Object.assign(new Error("http " + r.status), { code: j.error || "http", status: r.status }); }
    return r.json();
  }
  const apply = (o) => {
    if (o.method === "DELETE") { if (st[o.col]) delete st[o.col][o.id]; }
    else if (o.method === "PATCH") (st[o.col] ||= {})[o.id] = { ...((st[o.col] || {})[o.id] || {}), ...clone(o.d) };
    else (st[o.col] ||= {})[o.id] = clone(o.d);
  };
  async function flush() {
    if (flushing || !outbox.length || !code) return;
    flushing = true;
    try {
      while (outbox.length) {
        const o = outbox[0];
        try { await api(o.method, "doc/" + encodeURIComponent(o.col) + "/" + encodeURIComponent(o.id), o.method === "DELETE" ? undefined : o.d); }
        catch (e) { if (e.status >= 400 && e.status < 500 && e.status !== 401) { outbox.shift(); saveOutbox(); continue; } throw e; }
        outbox.shift(); saveOutbox();
      }
    } catch {} finally { flushing = false; }
  }
  async function pull(force) {
    if (!code) { askCode(); return; }
    if (pending) return;
    await flush();
    try {
      const res = await api("GET", "state" + (force || !version ? "" : "?v=" + version));
      if (res.docs && !pending) {
        st = res.docs; version = res.version; outbox.forEach(apply); ready = true; saveCache(); notify();
      }
      keepAddress();
    } catch {}
  }
  const write = async (method, col, id, d) => {
    const o = { method, col, id, d: d === undefined ? undefined : clone(d) };
    apply(o); saveCache(); notify();
    outbox.push(o); saveOutbox();
    pending++;
    try { await flush(); } finally { pending--; }
    notify();
  };
  const snapOf = (col) => ({ docs: Object.entries(st[col] || {}).map(([id, d]) => ({ id, data: () => clone(d) })) });
  const docRef = (col, id) => ({
    set: (d) => write("PUT", col, id, d),
    update: (d) => write("PATCH", col, id, d),
    delete: () => write("DELETE", col, id),
    onSnapshot: (cb) => { const f = () => { if (!ready) return; const d = (st[col] || {})[id]; cb({ exists: !!d, data: () => clone(d || {}), metadata: { hasPendingWrites: pending > 0 } }); }; subs.add(f); f(); return () => subs.delete(f); },
  });
  const db = {
    collection: (col) => ({ doc: (id) => docRef(col, id), onSnapshot: (cb) => { const f = () => { if (ready) cb(snapOf(col)); }; subs.add(f); f(); return () => subs.delete(f); } }),
    doc: (path) => { const [c, i] = path.split("/"); return docRef(c, i); },
  };
  // Recipe reading (links, screenshots, translations) runs on Cloudflare Workers AI.
  const shrink = (file) => new Promise((ok, bad) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 1400 / Math.max(img.width, img.height)), c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      ok(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => bad(Object.assign(new Error("image"), { code: "image_rejected" }));
    img.src = url;
  });
  const sample = {
    limits: async () => ({ images: { maxCount: 4 } }),
    json: async (prompt, opts = {}) => {
      const images = await Promise.all((opts.images || []).slice(0, 4).map(shrink));
      const r = await api("POST", "ai", { prompt, images });
      if (r.result == null) throw Object.assign(new Error("json"), { code: "invalid_json" });
      return r.result;
    },
    page: async (url) => { try { return await api("POST", "page", { url }); } catch (e) { throw Object.assign(new Error("fetch"), { code: e.code === "code" ? "code" : "fetch" }); } },
  };
  window.cloudBackup = async () => {
    try {
      const r = await fetch("/api/export", { headers: { "x-household": code } });
      if (!r.ok) throw 0;
      const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob());
      a.download = "weekly-menu-backup-" + new Date().toISOString().slice(0, 10) + ".json"; document.body.appendChild(a); a.click(); a.remove();
    } catch { if (typeof toast === "function") toast("Couldn't download the backup. Check your connection."); }
  };
  window.claude = { use: async (name) => name === "db" ? db : name === "sample" ? sample : name === "user" ? { can: async () => true } : null };
  const tick = () => { if (document.visibilityState === "visible") pull(false); };
  setInterval(tick, 3000);
  document.addEventListener("visibilitychange", tick);
  window.addEventListener("online", () => pull(true));
  window.addEventListener("DOMContentLoaded", () => { keepAddress(); pull(true); });
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
})();
</script>
'''
i = s.index("<script"); s = s[:i] + shim + s[i:]
s = s.replace('<link rel="apple-touch-icon" href="', '<link rel="manifest" href="manifest.json">\n<meta name="apple-mobile-web-app-title" content="Weekly Menu">\n<meta name="theme-color" content="#86B8B8">\n<link rel="apple-touch-icon" href="apple-touch-icon.png"><link rel="x-old-touch" href="', 1)
if not s.lstrip().lower().startswith("<!doctype"):
    s = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' + s
open(os.path.join(pub, "index.html"), "w").write(s)
root = os.path.dirname(here)
for f in ("apple-touch-icon.png", "icon-192.png", "icon-512.png"):
    if os.path.exists(os.path.join(root, f)): shutil.copy(os.path.join(root, f), pub)
m = json.load(open(os.path.join(root, "manifest.json"))); m.pop("start_url", None); m["scope"] = "/"
json.dump(m, open(os.path.join(pub, "manifest.json"), "w"), indent=2)
shutil.copy(os.path.join(here, "sw.js"), pub)
seed = {}
for f in sorted(glob.glob(os.path.join(export, "recipes", "*.json"))):
    d = json.load(open(f)); data = d.get("data", d); rid = d.get("id") or os.path.basename(f)[:-5]
    seed[rid] = data
json.dump(seed, open(os.path.join(here, "src", "seed.json"), "w"), ensure_ascii=False)
print(len(s), len(seed))
