#!/usr/bin/env node
/**
 * 本機預覽伺服器（不需要 Docker、不需要 wrangler、不需要 nginx）
 *
 * 為什麼要有這一支：
 *   `astro dev` 是「開發模式」—— 有熱更新，但它跑的是原始碼，不是最終產物。
 *   `_redirects`、`_headers`、`sitemap.xml` 這些東西只有 build 之後才存在，
 *   在 dev 模式下看不到。要驗證「部署後長什麼樣」，得有一個能服務 dist/ 的東西。
 *
 *   wrangler dev 可以，但要裝 wrangler、要登入、要佔一個 port；
 *   Docker 可以，但要 Docker。這一支只用 Node 內建模組，零依賴。
 *
 * 它刻意**模擬 Cloudflare Workers 的行為**，不是模擬 nginx：
 *   - 解析 dist/_redirects（含 * 與 :param 語法）
 *   - 套用 dist/_headers（安全性與快取標頭）
 *   - 乾淨網址（/about → /about/index.html，並 308 補斜線）
 *   - 404 回 dist/404.html
 *
 * 用法：
 *   node tools/serve.mjs                 # http://localhost:4321
 *   node tools/serve.mjs --port 8080
 *   node tools/serve.mjs --host           # 讓同網段的手機也能看
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "site", "dist");

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf("--" + k);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : d;
};
const PORT = Number(arg("port", process.env.PORT || 4321));
const HOST = arg("host", false) ? "0.0.0.0" : "127.0.0.1";

if (!fs.existsSync(DIST)) {
  console.error(`\n找不到 ${DIST}\n`);
  console.error("先建置：");
  console.error("  cd site && npm run build\n");
  process.exit(1);
}

/* ══════════════════════════════════════ 讀 _redirects */
function parseRedirects() {
  const file = path.join(DIST, "_redirects");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [from, to, code] = l.split(/\s+/);
      return { from, to, code: Number(code || 301) };
    })
    .filter((r) => r.from && r.to);
}

// _redirects 的 pattern → 正規式（支援 * 與 :param，這是 Cloudflare 的語法）
function patternToRe(pattern) {
  let re = "";
  const parts = pattern.split("/").filter(Boolean);
  for (const part of parts) {
    re += "/";
    if (part === "*") {
      re += "(.*)";
    } else if (part.startsWith(":")) {
      re += "([^/]+)";
    } else {
      re += part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "(.*)");
    }
  }
  return new RegExp("^" + (re || "/") + "$");
}

const RULES = parseRedirects().map((r) => ({
  ...r,
  re: r.from.includes("*") || r.from.includes(":") ? patternToRe(r.from) : null,
  exact: !(r.from.includes("*") || r.from.includes(":")),
}));

const matchRedirect = (pathname) => {
  // Cloudflare 的順序：先比對靜態資產，找不到才套轉址。
  // 這裡先檢查檔案存不存在（下面），所以只有在「沒有對應檔案」時才呼叫這個。
  for (const r of RULES) {
    // 精確規則：目標是字面值，不要做任何捕獲組替換
    // （做了的話 $1 會變成 undefined —— 這是實際踩到的 bug）
    if (r.exact) {
      if (r.from === pathname) return r;
      continue;
    }
    // 樣式規則：替換 $1..$9 與 :splat
    if (r.re && r.re.test(pathname)) {
      const m = r.re.exec(pathname);
      let to = r.to;
      to = to.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? "");
      to = to.replace(/:splat/g, m[1] ?? "");
      return { ...r, to };
    }
  }
  return null;
};

/* ══════════════════════════════════════ 讀 _headers */
function parseHeaders() {
  const file = path.join(DIST, "_headers");
  if (!fs.existsSync(file)) return [];
  const blocks = [];
  let cur = null;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      cur = { pattern: line.trim(), headers: {}, detach: [] };
      blocks.push(cur);
    } else if (cur && line.trim().startsWith("!")) {
      // 「! Header-Name」：拆掉先前規則加上的同名標頭（Cloudflare _headers 語法）
      cur.detach.push(line.trim().slice(1).trim().toLowerCase());
    } else if (cur) {
      const i = line.indexOf(":");
      if (i > 0) cur.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return blocks.map((b) => ({
    ...b,
    re: b.pattern.includes("*") || b.pattern.includes(":") ? patternToRe(b.pattern) : null,
    exact: !(b.pattern.includes("*") || b.pattern.includes(":")),
  }));
}

const HEADER_RULES = parseHeaders();

// Cloudflare 的行為：**所有**命中規則的標頭會合併，後面的覆蓋前面的同名標頭。
// 這一點很重要 —— 我們的 _headers 就是照這個行為設計的（見 tools/redirects.mjs）。
const headersFor = (pathname) => {
  const out = {};
  for (const r of HEADER_RULES) {
    const hit = r.exact ? r.pattern === pathname : r.re?.test(pathname);
    if (hit) Object.assign(out, r.headers);
  }
  // 拆除放在最後做：Cloudflare 的「!」不受規則先後影響
  for (const r of HEADER_RULES) {
    const hit = r.exact ? r.pattern === pathname : r.re?.test(pathname);
    if (!hit || !r.detach.length) continue;
    for (const k of Object.keys(out)) if (r.detach.includes(k.toLowerCase())) delete out[k];
  }
  return out;
};

/* ══════════════════════════════════════ MIME */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".pdf": "application/pdf",
};
const mime = (p) => MIME[path.extname(p).toLowerCase()] || "application/octet-stream";

// 可壓縮的型別（與 nginx.conf 的 gzip_types 對齊）
const COMPRESSIBLE = /^(text\/|application\/(?:json|xml|javascript|manifest\+json)|image\/svg)/;

// 快取壓縮結果：同一個檔案重複請求不要一直重壓
const zlibCache = new Map();
function compress(file, body, accept) {
  const type = mime(file);
  if (!COMPRESSIBLE.test(type) || body.length < 1024) return null;

  const wants = (accept || "").trim().toLowerCase();
  // 完全沒帶 Accept-Encoding（或只帶 identity）就不要壓 ——
  // 這是 HTTP 語意，壓了反而會讓某些用戶端收到看不懂的位元組。
  if (!wants || wants === "identity") return null;
  if (!wants.includes("gzip") && !wants.includes("br") && !wants.includes("*")) return null;

  const key = file + ":" + (wants.includes("br") ? "br" : "gzip");
  if (zlibCache.has(key)) return zlibCache.get(key);

  const out =
    wants.includes("br")
      ? { enc: "br", body: zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) }
      : { enc: "gzip", body: zlib.gzipSync(body, { level: 6 }) };

  // 只留最近 300 個，避免長時間跑下來吃記憶體
  if (zlibCache.size > 300) zlibCache.clear();
  zlibCache.set(key, out);
  return out;
}

/* ══════════════════════════════════════ 解析路徑 */
const inside = (p) => {
  const resolved = path.resolve(DIST, "." + p);
  return resolved === DIST || resolved.startsWith(DIST + path.sep);
};

// Cloudflare 把 _headers / _redirects 當「設定檔」，不會當資產對外服務。
// 本機若照檔案系統直接回，就會多出兩條部署後不存在的路徑 ——
// 而且把轉址表整個公開出去（雖然不是機密，但行為不一致就是不一致）。
const CONFIG_FILES = new Set(["/_headers", "/_redirects", "/_routes.json"]);

// 回傳 { file } 或 { redirect } 或 { notFound }
function resolve(pathname) {
  if (CONFIG_FILES.has(pathname)) return { notFound: true };
  if (!inside(pathname)) return { notFound: true };
  const candidates = [];

  if (pathname === "/") candidates.push("/index.html");
  else {
    candidates.push(pathname); // 靜態資產（.css/.webp/.xml…）
    if (!pathname.endsWith("/")) {
      candidates.push(pathname + ".html");
      candidates.push(pathname + "/index.html");
    } else {
      candidates.push(pathname + "index.html");
    }
  }

  for (const c of candidates) {
    const abs = path.join(DIST, c);
    try {
      if (fs.statSync(abs).isFile()) {
        // 目錄形式的路徑卻沒有結尾斜線 → 補斜線。
        // Cloudflare Static Assets 用的是 **307**，不是 308 ——
        // 我原本寫 308，跟 wrangler dev 一比就露出來了。
        // 307/308 的差別在「方法是否保留」：307 保留 POST，308 也保留但允許快取。
        // 對 SEO 與瀏覽器行為影響很小，但預覽要跟部署一致才有意義。
        const isDirIndex = c.endsWith("/index.html") && c !== "/index.html";
        if (isDirIndex && !pathname.endsWith("/")) {
          return { redirect: pathname + "/", code: 307 };
        }
        return { file: abs, rel: c };
      }
    } catch {}
  }

  // 沒有對應檔案 → 套轉址規則
  const r = matchRedirect(pathname);
  if (r) return { redirect: r.to, code: r.code };

  return { notFound: true };
}

/* ══════════════════════════════════════ 伺服器 */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }

  const r = resolve(pathname);

  if (r.redirect) {
    const h = headersFor(pathname);
    // 轉址不該被快取太久（改規則後才不會卡住）
    // 注意：resolve() 回傳的是 { redirect, code }，不是 { to }。
    // 這裡曾經寫成 r.to，結果 Location 變成 "undefined"。
    res.writeHead(r.code, { Location: r.redirect + url.search, "Cache-Control": "no-store", ...h });
    res.end();
    return;
  }

  if (r.notFound) {
    const nf = path.join(DIST, "404.html");
    const h = headersFor(pathname);
    if (fs.existsSync(nf)) {
      const body = fs.readFileSync(nf);
      res.writeHead(404, {
        "Content-Type": MIME[".html"],
        "Cache-Control": "public, max-age=0, must-revalidate",
        ...h,
        "Content-Length": body.length,
      });
      res.end(body);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...h });
      res.end("404 Not Found");
    }
    return;
  }

  const body = fs.readFileSync(r.file);
  const h = headersFor(pathname);
  const out = { "Content-Type": mime(r.file), "Content-Length": body.length, ...h };

  // 沒有明確快取規則的資產，Cloudflare 一律給
  // "public, max-age=0, must-revalidate"（HTML、robots.txt、favicon…都一樣）。
  // 這裡刻意寫成與 wrangler 一字不差的值 ——
  // 本機預覽的意義就是「看到部署後的樣子」，標頭也該一致。
  if (!out["Cache-Control"]) {
    out["Cache-Control"] = "public, max-age=0, must-revalidate";
  }

  // 壓縮（與 Cloudflare / nginx 一致；不壓的話效能量測會失真）
  const z = compress(r.file, body, req.headers["accept-encoding"]);
  if (z) {
    out["Content-Encoding"] = z.enc;
    out["Vary"] = "Accept-Encoding";
    out["Content-Length"] = z.body.length;
  }

  res.writeHead(200, out);
  // HEAD 只要標頭
  res.end(req.method === "HEAD" ? undefined : z ? z.body : body);
});

server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`
  黃磊生官方網站 — 本機預覽
  ────────────────────────────────────────
  網址    http://${shown}:${PORT}/
  來源    site/dist/（已建置的靜態檔）
  轉址    ${RULES.length} 條（來自 dist/_redirects）
  標頭    ${HEADER_RULES.length} 組（來自 dist/_headers）

  ${HOST === "0.0.0.0" ? "同網段的手機／平板可以用你的內網 IP 連進來。\n" : ""}  這是「建置後」的預覽，改原始碼要用 npm run dev。
  按 Ctrl+C 結束。
`);
});

process.on("SIGINT", () => {
  console.log("\n已停止。");
  process.exit(0);
});
