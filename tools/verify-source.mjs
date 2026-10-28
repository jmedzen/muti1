#!/usr/bin/env node
/**
 * 獨立站點列舉（第六趟驗證：source → model）
 *
 * 為什麼需要這一支：
 *
 *   前面五趟驗證的是「model.json → dist」—— 資料有沒有正確變成頁面。
 *   但沒有人驗證「source → model」—— 原站有的東西，有沒有全部進到 model。
 *
 *   如果 crawl.mjs 的種子清單本身就漏了一整個區塊（例如某個沒連進選單的分類），
 *   後面五趟全部會通過，因為它們都只信任 model.json。
 *
 * 做法：
 *   不看 raw/manifest.json，也不看 crawl.mjs 的種子。
 *   直接從 https://luisang.rumotan.com/ 出發，廣度優先抓「頁面上所有站內連結」，
 *   一路走到沒東西為止。這是不帶任何假設的列舉。
 *
 *   然後把這個「獨立列舉結果」與「raw/manifest.json 實際抓到的」對比。
 *
 * 用法：node tools/verify-source.mjs [--limit 400]
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = "https://luisang.rumotan.com";
const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf("--" + k);
  return i >= 0 ? args[i + 1] : d;
};
const LIMIT = Number(arg("limit", 400));

/* ---------------------------------------------------------------- 工具 */
const norm = (u) => {
  try {
    const url = new URL(u, BASE);
    if (url.origin !== BASE) return null;
    url.hash = "";
    url.search = "";
    let p = url.pathname;
    // index.php 與 / 等價
    if (p === "/index.php") p = "/";
    return p;
  } catch {
    return null;
  }
};

// 這些不是內容頁，不用遞迴進去
const SKIP = [
  /^\/administrator/,
  /^\/components\//,
  /^\/modules\//,
  /^\/plugins\//,
  /^\/libraries\//,
  /^\/templates\//,
  /^\/media\//, // Joomla 素材目錄，不是頁面
  /^\/images\//,
  /^\/cache\//,
  /^\/tmp\//,
  /^\/logs\//,
  /^\/language\//,
  /^\/layouts\//,
  /^\/includes\//,
  /^\/cli\//,
  /^\/bin\//,
  /^\/installation\//,
  /\.(?:jpe?g|png|gif|webp|svg|ico|pdf|zip|css|js|woff2?|ttf|eot|mp4|xml|txt)$/i,
];

// 「功能頁」不是內容頁：它們是 Joomla 元件的操作介面，
// 抓下來也沒有文章可存，新站用自己的一頁取代即可。
// 這些不算漏抓，但必須有對應的新頁（由轉址覆蓋率那一項把關）。
const FUNCTIONAL = [
  /^\/index\.php\/component\/finder\/search$/,
  /^\/index\.php\/component\/users/,
  /^\/index\.php\/search/,
];

const isContent = (p) => p && !SKIP.some((re) => re.test(p));

const fetchPage = async (p) => {
  const res = await fetch(BASE + p, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; luisang-archive-verify/1.0)",
      "Accept-Language": "zh-TW,zh;q=0.9",
    },
    redirect: "follow",
    // 原站不穩或網路慢時，沒有 timeout 會讓整個列舉卡死（CI 上尤其致命）
    signal: AbortSignal.timeout(20000),
  });
  const html = res.ok ? await res.text() : "";
  return { status: res.status, html, finalUrl: res.url };
};

const extractLinks = (html) => {
  const out = new Set();
  // href
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const p = norm(m[1]);
    if (isContent(p)) out.add(p);
  }
  // 有些樣板用 data-href / onclick location
  for (const m of html.matchAll(/location\.href\s*=\s*["']([^"']+)["']/gi)) {
    const p = norm(m[1]);
    if (isContent(p)) out.add(p);
  }
  return out;
};

/* ---------------------------------------------------------------- 廣度優先列舉 */
console.log(`從 ${BASE} 廣度優先列舉（上限 ${LIMIT} 頁）…\n`);

const seen = new Map(); // path -> {status, depth, from}
const queue = [{ p: "/", depth: 0 }];
seen.set("/", { status: 0, depth: 0, from: "(root)" });

let visited = 0;
const started = Date.now();

while (queue.length && visited < LIMIT) {
  const { p, depth } = queue.shift();
  const rec = seen.get(p);
  if (rec && rec.done) continue;

  let r;
  try {
    r = await fetchPage(p);
  } catch (e) {
    seen.set(p, { ...rec, status: -1, done: true, error: e.message });
    continue;
  }
  visited++;
  seen.set(p, { ...rec, status: r.status, done: true });

  if (r.status !== 200 || !r.html) continue;

  // 如果被轉址到別的頁（例如缺結尾斜線），把終點也記下來
  const finalPath = norm(r.finalUrl);
  if (finalPath && finalPath !== p && !seen.has(finalPath)) {
    seen.set(finalPath, { status: 200, depth, from: p, done: true });
  }

  for (const next of extractLinks(r.html)) {
    if (!seen.has(next)) {
      seen.set(next, { status: 0, depth: depth + 1, from: p });
      // 只遞迴「看起來像頁面」的，避免把素材當頁面排隊
      queue.push({ p: next, depth: depth + 1 });
    }
  }

  if (visited % 10 === 0) process.stdout.write(`  ${visited} 頁…（待抓 ${queue.length}）\r`);
}

process.stdout.write(" ".repeat(60) + "\r");
console.log(`列舉完成：${visited} 次請求、${seen.size} 個相異路徑、耗時 ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

/* ---------------------------------------------------------------- 對照 raw/ */
const model = JSON.parse(fs.readFileSync(path.join(ROOT, "content", "model.json"), "utf8"));
const manifestPath = path.join(ROOT, "raw", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const crawled = new Set(manifest.pages.map((p) => norm(p.url)).filter(Boolean));

// 只比「200 且有實際內容」的頁面
const livePages = new Set(
  [...seen.entries()].filter(([, v]) => v.status === 200).map(([p]) => p)
);

/* ---------------------------------------------------------------- 轉址覆蓋率
 * 列舉出來的每一條舊網址，都必須有「明確」的轉址規則。
 * 只靠 `/index.php/* → /search 302` 這種降落傘不算 —— 頁面會活著，
 * 但訪客被丟到搜尋頁而不是他要看的那本相簿。
 * 這一段就是抓這種「活著但走錯門」的情況。 */
const redirectsPath = path.join(ROOT, "site", "public", "_redirects");
const redirectLines = fs.readFileSync(redirectsPath, "utf8")
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("#"));
const redirectMap = new Map();
for (const l of redirectLines) {
  const [from, to] = l.trim().split(/\s+/);
  if (from && to && !redirectMap.has(from)) redirectMap.set(from, to);
}
const uncovered = [...livePages].filter((p) => p !== "/" && !redirectMap.has(p));

/* ---------------------------------------------------------------- 分類 */
// raw/ 有抓到的
// 注意：新站的網址是重寫過的（/news/... 對應 /index.php/news/...），
// 所以這裡用「原站路徑」比對，而不是新站路徑。
// 已知的「別名路徑」：內容與 canonical 路徑完全相同，只是入口不同。
// 這些不算漏抓（同一份內容只留一份 raw/），但要能說清楚為什麼不算。
const aliasMap = new Map(
  (model?.meta?.sourceAliases?.artLifeAliases ?? []).map((a) => [a.alias, a])
);

const missed = [];   // 來源有、我們沒抓，且不是已知別名 → 真的漏
const aliases = [];  // 來源有、我們沒抓，但是已記錄的別名 → 正常
const extra = [];    // 我們有抓、來源列舉沒走到（可能是種子直接指定）
const same = [];

const functional = []; // 來源有、但是功能頁（無內容可存）

for (const p of livePages) {
  if (crawled.has(p)) same.push(p);
  else if (aliasMap.has(p)) aliases.push(p);
  else if (FUNCTIONAL.some((re) => re.test(p))) functional.push(p);
  else missed.push(p);
}
for (const p of crawled) {
  if (!livePages.has(p) && p !== "/") extra.push(p);
}

/* ---------------------------------------------------------------- 報告 */
const byDepth = {};
for (const [p, v] of seen) {
  if (v.status !== 200) continue;
  byDepth[v.depth] = (byDepth[v.depth] || 0) + 1;
}

console.log("══════════ 來源站點列舉 vs 實際爬取 ══════════\n");
console.log(`來源可達頁面（HTTP 200）：${livePages.size}`);
console.log(`raw/manifest.json 記錄：  ${crawled.size}`);
console.log(`兩邊都有：                ${same.length}`);
console.log(`來源有、我們沒抓：        ${missed.length}  ← 這個必須是 0`);
console.log(`其中是已記錄的別名：      ${aliases.length}  ← 同內容多入口，不算漏`);
console.log(`其中是 Joomla 功能頁：     ${functional.length}  ← 無內容可存，由新站對應頁取代`);
console.log(`我們有抓、列舉沒走到：    ${extra.length}  ← 通常是種子直接指定，正常`);
console.log(`舊網址沒有明確轉址規則：  ${uncovered.length}  ← 這個也必須是 0`);

if (uncovered.length) {
  console.log(`\n─── 沒有明確轉址的舊網址（會掉進 /search 降落傘）───`);
  for (const p of uncovered) console.log(`  ${p}`);
}
console.log(`\n按連結深度分布：${JSON.stringify(byDepth)}`);

if (missed.length) {
  console.log(`\n─── 漏抓的頁面 ───`);
  for (const p of missed.slice(0, 40)) {
    const v = seen.get(p);
    console.log(`  ${p}  (深度 ${v.depth}, 從 ${v.from})`);
  }
}

if (aliases.length) {
  console.log(`\n─── 已記錄的別名（同內容、不同入口，只留一份 raw/）───`);
  for (const p of aliases) {
    const a = aliasMap.get(p);
    console.log(`  ${p}  ≡  ${a.canonical}${a.albumId ? ` (albums/${a.albumId})` : ""}`);
  }
}

if (extra.length) {
  console.log(`\n─── 種子直接指定、但廣度優先沒走到的 ───`);
  for (const p of extra.slice(0, 40)) console.log(`  ${p}`);
}

// 非 200 的也列出來，確認不是「有頁面但壞掉」
const broken = [...seen.entries()].filter(([, v]) => v.status !== 200 && v.status !== 0);
if (broken.length) {
  console.log(`\n─── 來源端非 200（${broken.length}）───`);
  for (const [p, v] of broken.slice(0, 25)) console.log(`  ${v.status}  ${p}`);
}

fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, ".cache", "verify-source.json"),
  JSON.stringify(
    {
      enumerated: [...seen.entries()].map(([p, v]) => ({ path: p, ...v })),
      livePages: [...livePages],
      crawled: [...crawled],
      missed,
      aliases,
      functional,
      extra,
      uncovered,
      broken: broken.map(([p, v]) => ({ path: p, status: v.status })),
    },
    null,
    1
  )
);

console.log(`\n結果寫入 .cache/verify-source.json`);
process.exit(missed.length || uncovered.length ? 1 : 0);
