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
window.STANDALONE = true; window.CLOUD = true;
(() => {
  const KEY = "wm-household";
  let code = ""; try { code = localStorage.getItem(KEY) || ""; } catch {}
  let st = {}, version = 0, pending = 0, ready = false;
  const subs = new Set();
  const notify = () => subs.forEach((f) => { try { f(); } catch {} });
  const clone = (d) => JSON.parse(JSON.stringify(d));
  function askCode(msg) {
    if (document.getElementById("hh")) return;
    const box = document.createElement("form"); box.id = "hh";
    box.style.cssText = "position:fixed;inset:0;z-index:99;display:grid;place-items:center;background:rgba(23,22,20,.55);padding:16px";
    box.innerHTML = '<div style="background:#F7F0E6;border-radius:24px;padding:24px;max-width:360px;width:100%;font-family:Roboto,system-ui,sans-serif;color:#171614">'
      + '<h3 style="margin:0 0 8px;font-size:20px">Household code</h3><p style="margin:0 0 16px;font-size:15px;opacity:.75"></p>'
      + '<input type="password" autocomplete="current-password" style="width:100%;box-sizing:border-box;min-height:48px;border-radius:14px;border:1.5px solid #171614;padding:0 14px;font-size:16px;background:#fff">'
      + '<button style="margin-top:12px;width:100%;min-height:48px;border:0;border-radius:999px;background:#171614;color:#fff;font-size:16px;font-weight:600">Open the menu</button></div>';
    box.querySelector("p").textContent = msg || "First time? Choose a code (4+ characters) and share it with each other. This phone remembers it.";
    box.onsubmit = (e) => { e.preventDefault(); code = box.querySelector("input").value.trim(); try { localStorage.setItem(KEY, code); } catch {} box.remove(); pull(true); };
    document.body.appendChild(box); setTimeout(() => box.querySelector("input").focus(), 50);
  }
  async function api(method, path, body) {
    const r = await fetch("/api/" + path, { method, headers: { "x-household": code, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { askCode(code ? "That code didn't work. Try again." : ""); throw Object.assign(new Error("code"), { code: "code" }); }
    if (!r.ok) throw new Error("http " + r.status);
    return r.json();
  }
  async function pull(force) {
    if (!code) { askCode(); return; }
    if (pending) return;
    try {
      const res = await api("GET", "state" + (force || !ready ? "" : "?v=" + version));
      if (res.docs && !pending) { st = res.docs; version = res.version; ready = true; notify(); }
    } catch {}
  }
  const write = async (method, col, id, d) => {
    pending++;
    try { await api(method, "doc/" + encodeURIComponent(col) + "/" + encodeURIComponent(id), d); }
    finally { pending--; }
  };
  const snapOf = (col) => ({ docs: Object.entries(st[col] || {}).map(([id, d]) => ({ id, data: () => clone(d) })) });
  const docRef = (col, id) => ({
    set: async (d) => { (st[col] ||= {})[id] = clone(d); notify(); await write("PUT", col, id, d); },
    update: async (d) => { (st[col] ||= {})[id] = { ...(st[col][id] || {}), ...clone(d) }; notify(); await write("PATCH", col, id, d); },
    delete: async () => { if (st[col]) delete st[col][id]; notify(); await write("DELETE", col, id); },
    onSnapshot: (cb) => { const f = () => { if (!ready) return; const d = (st[col] || {})[id]; cb({ exists: !!d, data: () => clone(d || {}), metadata: { hasPendingWrites: pending > 0 } }); }; subs.add(f); f(); return () => subs.delete(f); },
  });
  const db = {
    collection: (col) => ({ doc: (id) => docRef(col, id), onSnapshot: (cb) => { const f = () => { if (ready) cb(snapOf(col)); }; subs.add(f); f(); return () => subs.delete(f); } }),
    doc: (path) => { const [c, i] = path.split("/"); return docRef(c, i); },
  };
  window.claude = { use: async (name) => name === "db" ? db : name === "user" ? { can: async () => true } : null };
  const tick = () => { if (document.visibilityState === "visible") pull(false); };
  setInterval(tick, 3000);
  document.addEventListener("visibilitychange", tick);
  window.addEventListener("DOMContentLoaded", () => pull(true));
})();
</script>
'''
i = s.index("<script"); s = s[:i] + shim + s[i:]
s = s.replace('<link rel="apple-touch-icon" href="', '<link rel="manifest" href="manifest.json">\n<meta name="apple-mobile-web-app-title" content="Weekly Menu">\n<meta name="theme-color" content="#86B8B8">\n<link rel="apple-touch-icon" href="apple-touch-icon.png"><link rel="x-old-touch" href="', 1)
if not s.lstrip().lower().startswith("<!doctype"):
    s = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' + s
open(os.path.join(pub, "index.html"), "w").write(s)
root = os.path.dirname(here)
for f in ("apple-touch-icon.png", "icon-192.png", "icon-512.png", "manifest.json"):
    if os.path.exists(os.path.join(root, f)): shutil.copy(os.path.join(root, f), pub)
seed = {}
for f in sorted(glob.glob(os.path.join(export, "recipes", "*.json"))):
    d = json.load(open(f)); data = d.get("data", d); rid = d.get("id") or os.path.basename(f)[:-5]
    seed[rid] = data
json.dump(seed, open(os.path.join(here, "src", "seed.json"), "w"), ensure_ascii=False)
print(len(s), len(seed))
