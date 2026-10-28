#!/usr/bin/env node
/**
 * Phase 1 — mirror luisang.rumotan.com (Joomla 4/5 + Helix Ultimate + SP Page Builder
 * + SP Easy Image Gallery) into raw/ so that nothing has to be re-fetched later.
 *
 *  raw/pages/<slug>.html     原始 HTML（原樣保存，bytes 一律保留）
 *  raw/pages/<slug>.json     抽取後的結構化資料
 *  raw/assets/...            所有靜態資產（圖片 / css / js / 字型）
 *  raw/manifest.json         全站清單與抓取狀態
 *
 * 用法：node tools/crawl.mjs [--concurrency 6] [--max-pages 400]
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const ORIGIN = "https://luisang.rumotan.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const RAW = path.join(ROOT, "raw");
const PAGES = path.join(RAW, "pages");
const ASSETS = path.join(RAW, "assets");

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const CONCURRENCY = Number(argOf("concurrency", 6));
const MAX_PAGES = Number(argOf("max-pages", 400));

// 分類樹（由主選單 + 分類頁的「下級分類」推得，見 docs/crawl-notes.md）
const CATEGORIES = [
  { id: "news", path: "/index.php/news", title: "本站新聞", parent: null },
  { id: "memorial", path: "/index.php/news/memorial-exhibition", title: "紀念展", parent: "news" },
  { id: "auction", path: "/index.php/news/auction-news", title: "拍賣新聞", parent: "news" },
  { id: "media", path: "/index.php/news/media-coverage", title: "媒體報導", parent: "news" },
  { id: "official", path: "/index.php/news/official-reports", title: "官方報導", parent: "news" },
  { id: "exhibition", path: "/index.php/news/exhibition-news", title: "展覽新聞", parent: "news" },
  { id: "reviews", path: "/index.php/art-reviews", title: "藝術評論", parent: null },
  { id: "artist", path: "/index.php/artist-luisang", title: "關於黃磊生", parent: null },
  { id: "landscape", path: "/index.php/landscape/landscape", title: "山水", parent: null },
  { id: "flowers", path: "/index.php/flowers-birds-insects-fish/flowers-birds-insects-fish", title: "花鳥蟲魚", parent: null },
  { id: "calligraphy", path: "/index.php/calligraphy/calligraphy", title: "書法", parent: null },
  { id: "artlife", path: "/index.php/art-life", title: "藝術生活", parent: null },
  { id: "contact", path: "/index.php/contact", title: "收藏", parent: null },
];

const OTHER_PAGES = [
  "/index.php",
  "/index.php/artist-luisang/huang-leisheng",
  "/index.php/artist-luisang/spectral",
  "/index.php/landscape/exhibition-exchange",
  "/index.php/landscape/life-footprint",
  "/index.php/landscape/art-exchange",
  "/index.php/landscape/flowers-birds-insects-fish",
  "/index.php/landscape/calligraphy",
  "/index.php/art-life?catid=25",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBuf(url, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "*/*", "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8" },
        redirect: "follow",
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        if (res.status >= 500 && attempt < retries) {
          lastErr = err;
          await sleep(400 * 2 ** attempt);
          continue;
        }
        throw err;
      }
      return { buf: Buffer.from(await res.arrayBuffer()), headers: res.headers, finalUrl: res.url, status: res.status };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(400 * 2 ** attempt);
    }
  }
  throw lastErr;
}

function slugFromUrl(u) {
  const url = new URL(u, ORIGIN);
  let p = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  p = p.replace(/^index\.php\/?/, "");
  if (!p) p = "home";
  const q = url.search ? "-" + url.search.slice(1).replace(/[^a-z0-9]+/gi, "-") : "";
  return (p + q)
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 120);
}

function assetPathFor(u) {
  const url = new URL(u, ORIGIN);
  const clean = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  return clean || "index";
}

async function writeIfChanged(file, buf) {
  try {
    const old = await fsp.readFile(file);
    if (old.equals(buf)) return false;
  } catch {}
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, buf);
  return true;
}

const seenAssets = new Map(); // url -> {file, bytes, type}
const assetQueue = new Set();
const pages = new Map(); // slug -> record

function queueAsset(u) {
  if (!u) return;
  let abs;
  try {
    abs = new URL(u, ORIGIN).toString();
  } catch {
    return;
  }
  if (!abs.startsWith(ORIGIN) && !abs.startsWith("https://fonts.g")) return;
  if (abs.includes("?")) {
    // 保留 query 會讓檔名亂，去掉 query（Joomla 的 ?hash 只是 cache buster）
  }
  const key = abs.split("?")[0];
  if (seenAssets.has(key)) return;
  seenAssets.set(key, { url: key, file: assetPathFor(key), bytes: 0, status: "pending" });
  if (key.startsWith(ORIGIN)) assetQueue.add(key);
}

async function downloadAssets() {
  const jobs = [...assetQueue];
  let done = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (jobs.length) {
      const u = jobs.shift();
      const rec = seenAssets.get(u);
      const file = path.join(ASSETS, rec.file);
      try {
        const { buf, headers } = await fetchBuf(u);
        await writeIfChanged(file, buf);
        rec.bytes = buf.length;
        rec.type = headers.get("content-type") || "";
        rec.status = "ok";
      } catch (e) {
        rec.status = `error:${e.status || e.message}`;
      }
      if (++done % 25 === 0) console.log(`  assets ${done}/${seenAssets.size}`);
    }
  });
  await Promise.all(workers);
}

async function crawlPage(pageUrl, kind = "page") {
  const slug = slugFromUrl(pageUrl);
  if (pages.has(slug)) return pages.get(slug);
  const rec = { slug, url: new URL(pageUrl, ORIGIN).toString(), kind, status: "pending" };
  pages.set(slug, rec);
  try {
    const { buf, status } = await fetchBuf(rec.url);
    const html = buf.toString("utf8");
    await fsp.mkdir(PAGES, { recursive: true });
    await fsp.writeFile(path.join(PAGES, `${slug}.html`), buf);
    rec.status = `ok:${status}`;
    rec.bytes = buf.length;
    const found = extractAssetRefs(html);
    found.forEach(queueAsset);
    rec.assets = found.length;
  } catch (e) {
    rec.status = `error:${e.status || e.message}`;
  }
  return rec;
}

function extractAssetRefs(html) {
  const out = new Set();
  const re = /(?:src|href|data-src|data-original|content|srcset|poster)\s*=\s*["']([^"']+)["']/gi;
  let m;
  const push = (v) => {
    if (!v) return;
    v = v.trim().replace(/^["']|["']$/g, "");
    if (!v || v.startsWith("#") || v.startsWith("data:") || v.startsWith("mailto:") || v.startsWith("tel:")) return;
    if (v.startsWith("//")) v = "https:" + v;
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(v)) {
      out.add(v);
      return;
    }
    if (/\.(css|js|jpg|jpeg|png|gif|webp|svg|woff2?|ttf|eot|ico|pdf|mp4|webm)(\?|$)/i.test(v)) {
      try {
        out.add(new URL(v, ORIGIN).toString().split("?")[0]);
      } catch {}
    }
  };
  while ((m = re.exec(html))) push(m[1]);
  // 行內樣式與 <style> 裡的 background-image: url(...) —— 首頁 slider 與版面底色都靠這個
  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  while ((m = urlRe.exec(html))) push(m[2]);
  return [...out];
}

// Joomla 分類頁固定 4~10 篇/頁，limit 參數被模板覆寫無效，只能用 ?start=N 逐頁翻。
const CATEGORY_LISTING = [
  "/index.php/news/memorial-exhibition",
  "/index.php/news/auction-news",
  "/index.php/news/media-coverage",
  "/index.php/news/official-reports",
  "/index.php/news/exhibition-news",
  "/index.php/art-reviews",
  "/index.php/artist-luisang",
];

const CATEGORY_PATHS = new Set(CATEGORIES.map((c) => c.path));

async function discoverArticleLinks() {
  // 1) 分類頁逐頁翻（?start=0,4,8…）直到沒有新文章
  // 2) 文章的 prev/next 鏈（後面 crawl 時會蔓延）
  // 3) 首頁與側欄的 related / 精選連結
  const found = new Set();
  for (const c of CATEGORY_LISTING) {
    let emptyStreak = 0;
    for (let start = 0; start <= 200; start += 4) {
      let html;
      try {
        const { buf } = await fetchBuf(`${ORIGIN}${c}?start=${start}`);
        html = buf.toString("utf8");
      } catch {
        break;
      }
      const re = /<h2>\s*<a href="(\/index\.php\/[^"]+)"/gi;
      let m;
      let added = 0;
      while ((m = re.exec(html))) {
        const p = m[1].split("?")[0];
        if (CATEGORY_PATHS.has(p)) continue;
        if (!found.has(p)) {
          found.add(p);
          added++;
        }
      }
      if (added === 0) {
        if (++emptyStreak >= 2) break;
      } else emptyStreak = 0;
    }
    console.log(`  ${c} → ${found.size} cumulative`);
  }
  // 首頁與側欄 inline 連結（例如關於藝術家的兩篇文章）
  for (const p of ["/index.php", "/index.php/news", "/index.php/art-reviews"]) {
    try {
      const { buf } = await fetchBuf(ORIGIN + p);
      const html = buf.toString("utf8");
      const re = /href="(\/index\.php\/(?:art-reviews|artist-luisang|news\/[a-z-]+)\/[^"#?]+)"/gi;
      let m;
      while ((m = re.exec(html))) {
        const path = m[1];
        if (!CATEGORY_PATHS.has(path)) found.add(path);
      }
    } catch {}
  }
  return [...found];
}

async function main() {
  await fsp.mkdir(PAGES, { recursive: true });
  await fsp.mkdir(ASSETS, { recursive: true });
  const t0 = Date.now();

  // 1) 首頁 + 分類 + 其它固定頁
  const seed = ["/index.php", ...CATEGORIES.map((c) => c.path), ...OTHER_PAGES];
  console.log(`[1/5] seed pages: ${seed.length}`);
  for (const p of seed) await crawlPage(p, "seed");

  // 2) 探索文章
  console.log("[2/5] discovering articles…");
  const artLinks = await discoverArticleLinks();
  console.log(`  found ${artLinks.length} candidate article urls`);

  // 3) 抓文章，並沿著 prev/next 蔓延（Joomla pagenavigation 會串起同分類全部文章）
  const queue = [...artLinks.map((u) => ({ u, kind: "article" }))];
  const visited = new Set(queue.map((q) => q.u));
  let pageCount = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length && pages.size < MAX_PAGES) {
      const job = queue.shift();
      if (!job) break;
      const rec = await crawlPage(job.u, job.kind);
      pageCount++;
      if (pageCount % 10 === 0) console.log(`  pages ${pageCount} (total ${pages.size})`);
      // prev / next
      try {
        const html = await fsp.readFile(path.join(PAGES, `${rec.slug}.html`), "utf8");
        const nav = /class="[^"]*pagination[^"]*"[\s\S]*?<\/nav>/i.exec(html);
        if (nav) {
          const re = /href="([^"]+)"\s+rel="(prev|next)"/g;
          let m;
          while ((m = re.exec(nav[0]))) {
            const abs = new URL(m[1], ORIGIN).pathname;
            if (!visited.has(abs)) {
              visited.add(abs);
              queue.push({ u: abs, kind: "article" });
            }
          }
        }
      } catch {}
    }
  });
  await Promise.all(workers);

  // 4) 圖庫 album 頁（?album= 或 gallery 分頁）
  console.log("[3/5] gallery albums…");
  const albumPages = new Set();
  for (const p of [...pages.values()]) {
    if (!/landscape|flowers|calligraphy|art-life|artist/.test(p.url)) continue;
    try {
      const html = await fsp.readFile(path.join(PAGES, `${p.slug}.html`), "utf8");
      const re = /href="([^"]*(?:album|gallery|speasyimagegallery)[^"]*)"/gi;
      let m;
      while ((m = re.exec(html))) {
        const v = new URL(m[1], ORIGIN);
        if (v.origin === ORIGIN && !/\.(css|js|jpg|png)$/i.test(v.pathname)) {
          albumPages.add(v.pathname + (v.search || ""));
        }
      }
    } catch {}
  }
  for (const u of albumPages) {
    if (!pages.has(slugFromUrl(u))) await crawlPage(u, "album");
  }
  console.log(`  album candidates: ${albumPages.size}`);

  // 5) 抓資產
  console.log(`[4/5] downloading ${seenAssets.size} assets…`);
  await downloadAssets();

  // 6) 寫 manifest
  const manifest = {
    origin: ORIGIN,
    crawledAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    categories: CATEGORIES,
    pages: [...pages.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    assets: [...seenAssets.values()].sort((a, b) => a.file.localeCompare(b.file)),
    stats: {
      pages: pages.size,
      pagesOk: [...pages.values()].filter((p) => p.status.startsWith("ok")).length,
      assets: seenAssets.size,
      assetsOk: [...seenAssets.values()].filter((a) => a.status === "ok").length,
      assetBytes: [...seenAssets.values()].reduce((s, a) => s + (a.bytes || 0), 0),
    },
  };
  await fsp.writeFile(path.join(RAW, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("[5/5] done", manifest.stats, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
