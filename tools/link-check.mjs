#!/usr/bin/env node
/**
 * 連結與資源完整性檢查
 *
 * 這是「第五趟驗證」的第一關：靜態掃描 dist/，不用開瀏覽器就能抓出
 *   - 站內連結指向不存在的頁面（真正會 404 的那種）
 *   - <img src/srcset> 指向不存在的檔案
 *   - CSS 裡 url() 指到不存在的字型/圖
 *   - canonical / og:image 寫錯
 *   - 標題重複（SEO 問題）
 *   - 沒有 h1／多個 h1
 *
 * 用法：node tools/link-check.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "site", "dist");

/* ---------------------------------------------------------------- 建立索引 */
const files = new Set();
const htmlFiles = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else {
      const rel = "/" + path.relative(DIST, p).split(path.sep).join("/");
      files.add(rel);
      if (e.name.endsWith(".html")) htmlFiles.push({ rel, abs: p });
    }
  }
}
walk(DIST);

// 網址 → 是否有對應檔案
const resolves = (urlPath) => {
  const clean = urlPath.split("#")[0].split("?")[0];
  if (!clean || clean === "/") return files.has("/index.html");
  const candidates = [
    clean,
    clean.replace(/\/$/, "") + "/index.html",
    clean + ".html",
    clean + "/index.html",
    decodeURIComponent(clean),
    decodeURIComponent(clean) + "/index.html",
  ];
  return candidates.some((c) => files.has(c));
};

const pageUrlOf = (rel) =>
  rel === "/index.html" ? "/" : rel.endsWith("/index.html") ? rel.slice(0, -"index.html".length) : rel;

/* ---------------------------------------------------------------- 掃描 */
const problems = [];
const titles = new Map();
const descs = new Map();
const allTargets = new Set();

for (const { rel, abs } of htmlFiles) {
  const html = fs.readFileSync(abs, "utf8");
  const page = pageUrlOf(rel);

  /**
   * 非公開頁面（`<meta name="robots" content="noindex…">`）不做 SEO 檢查。
   *
   * 為什麼：/admin/ 是 Sveltia CMS 後台，它本來就不該有 description、
   * canonical、og:image，也沒有語意上的 h1 —— 那些標籤對一個要求
   * 「不要被搜尋引擎索引」的頁面沒有意義。用同一套標準去審它只會
   * 產生四個永遠不會修的假警報，然後大家就開始忽略這個檢查。
   *
   * 但**連結與資源檢查照做** —— 後台指到的檔案一樣不能 404。
   */
  const noindex = /<meta\s+name="robots"\s+content="[^"]*noindex/i.test(html);

  // ── title / description / canonical
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
  const desc = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? "";
  const canonical = /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1] ?? "";

  if (!noindex) {
    if (!title) problems.push({ page, type: "missing-title" });
    else {
      if (!titles.has(title)) titles.set(title, []);
      titles.get(title).push(page);
    }
    if (!desc) problems.push({ page, type: "missing-description" });
    else {
      if (!descs.has(desc)) descs.set(desc, []);
      descs.get(desc).push(page);
    }
    if (!canonical) problems.push({ page, type: "missing-canonical" });

    // ── h1 數量
    const h1s = [...html.matchAll(/<h1[\s>]/g)].length;
    if (h1s === 0) problems.push({ page, type: "no-h1" });
    if (h1s > 1) problems.push({ page, type: "multiple-h1", detail: h1s });
  }

  // ── 站內連結
  for (const m of html.matchAll(/href="(\/[^"]*)"/g)) {
    const href = m[1];
    if (href.startsWith("//")) continue;
    if (/\.(png|jpe?g|webp|svg|ico|xml|txt|webmanifest|pdf|woff2?)$/i.test(href)) continue;
    allTargets.add(href);
    if (href.startsWith("/_astro/")) continue;
    if (!resolves(href)) problems.push({ page, type: "broken-link", target: href });
  }

  // ── 圖片（src + srcset）
  for (const m of html.matchAll(/<img[^>]*>/g)) {
    const tag = m[0];
    const src = /src="([^"]*)"/.exec(tag)?.[1];
    const srcset = /srcset="([^"]*)"/.exec(tag)?.[1];
    const alts = /alt="([^"]*)"/.exec(tag);
    if (alts === undefined) problems.push({ page, type: "img-no-alt-attr", target: src });
    if (src && src.startsWith("/") && !files.has(src.split("?")[0])) {
      problems.push({ page, type: "broken-img", target: src });
    }
    if (srcset) {
      for (const part of srcset.split(",")) {
        const url = part.trim().split(/\s+/)[0];
        if (url.startsWith("/") && !files.has(url)) {
          problems.push({ page, type: "broken-srcset", target: url });
        }
      }
    }
    // 有 width 卻沒 height（會造成 CLS）
    if (/\swidth="/.test(tag) && !/\sheight="/.test(tag) && !/logo|icon/i.test(tag)) {
      problems.push({ page, type: "img-no-height", target: src });
    }
  }

  // ── og:image 要存在
  const ogImage = /<meta property="og:image" content="([^"]*)"/.exec(html)?.[1];
  if (ogImage) {
    if (ogImage.startsWith("https://luisang.rumotan.com")) {
      const p = ogImage.replace("https://luisang.rumotan.com", "");
      if (!files.has(p)) problems.push({ page, type: "broken-og-image", target: p });
    }
  } else if (!noindex) {
    // 同上：noindex 的頁面（/admin/）不需要分享預覽圖
    problems.push({ page, type: "missing-og-image" });
  }
}

/* ---------------------------------------------------------------- CSS 資源 */
const cssFiles = [...files].filter((f) => f.endsWith(".css"));
for (const css of cssFiles) {
  const text = fs.readFileSync(path.join(DIST, css), "utf8");
  for (const m of text.matchAll(/url\((["']?)(\/[^)"']+)\1\)/g)) {
    const url = m[2];
    if (!files.has(url)) problems.push({ page: css, type: "broken-css-url", target: url });
  }
}

/* ---------------------------------------------------------------- 報告 */
const byType = {};
for (const p of problems) byType[p.type] = (byType[p.type] || 0) + 1;

console.log(`掃描 ${htmlFiles.length} 個頁面、${files.size} 個檔案`);
console.log(`問題總數：${problems.length}`);
console.log(JSON.stringify(byType, null, 1));

if (problems.length) {
  console.log("\n─── 明細（最多 60 筆）───");
  for (const p of problems.slice(0, 60)) {
    console.log(`[${p.type}] ${p.page}${p.target ? " → " + p.target : ""}${p.detail ? " " + p.detail : ""}`);
  }
}

// 重複標題 / 描述
const dupTitles = [...titles.entries()].filter(([, v]) => v.length > 1);
const dupDescs = [...descs.entries()].filter(([, v]) => v.length > 1);
if (dupTitles.length) {
  console.log(`\n重複的 <title>：${dupTitles.length} 組`);
  for (const [t, ps] of dupTitles.slice(0, 8)) console.log(`  "${t.slice(0, 40)}" ← ${ps.join(", ")}`);
}
if (dupDescs.length) {
  console.log(`重複的 description：${dupDescs.length} 組`);
  for (const [, ps] of dupDescs.slice(0, 8)) console.log(`  ← ${ps.join(", ")}`);
}

fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
fs.writeFileSync(path.join(ROOT, ".cache", "link-report.json"), JSON.stringify({ problems, byType }, null, 1));

process.exit(problems.length ? 1 : 0);
