#!/usr/bin/env node
/**
 * 內容完整性驗證（第一趟）
 *
 * 問題意識：怎麼證明「沒有漏掉任何東西」？
 * 不是靠眼睛看，而是拿三個獨立來源互相對照：
 *
 *   A. 原始 HTML（raw/pages/*.html）—— 爬下來的原文
 *   B. 擷取結果（content/*.json）—— 機器解析出來的結構
 *   C. 建置產物（site/dist/**）—— 使用者真正看到的頁面
 *
 * 然後檢查：
 *   1. 每個原站文章網址都有對應的新頁面（數量 + 逐一比對）
 *   2. 每篇文章的標題一字不差地出現在新頁面
 *   3. 每篇文章的正文「字元集合」被完整覆蓋（用字元 multiset 比對，而不是字串比對，
 *      因為排版會插入空白與標點位置差異）
 *   4. 每件作品的編號都出現在對應的作品集頁面
 *   5. 每張原圖都有處理後的 WebP 變體
 *
 * 用法：node tools/verify-content.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const model = JSON.parse(fs.readFileSync(path.join(ROOT, "content", "model.json"), "utf8"));
const images = JSON.parse(fs.readFileSync(path.join(ROOT, "site", "src", "data", "images.json"), "utf8"));
const DIST = path.join(ROOT, "site", "dist");

const fail = [];
const warn = [];
const ok = [];

const pass = (m) => ok.push(m);
const bad = (m, detail) => fail.push({ m, detail });
const soft = (m, detail) => warn.push({ m, detail });

/* ------------------------------------------------------------ 讀 dist 頁面 */
const readPage = (route) => {
  const candidates = [
    path.join(DIST, route.replace(/^\//, ""), "index.html"),
    path.join(DIST, route.replace(/^\//, "") + ".html"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return fs.readFileSync(c, "utf8");
  return null;
};

// HTML → 純文字（去掉標籤、script、style，實體解碼）
const toText = (html) =>
  html
    ? html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
    : "";

/* ------------------------------------------------------------ 字元多重集比對
 * 為什麼不用 includes()：
 *   原文「一九六零年」可能在排版後被插入空格，或全形標點被轉半形。
 *   用字元計數比對可以看出「有沒有整段話不見」，而不會被排版差異干擾。 */
/* 只比對「有語意的字元」：中文、英數。
 * 標點與空白會被版面重排（例如「展覽日期：X」變成「展覽日期 X」），
 * 那不是內容遺失，不該誤判。 */
const semantic = (s) => s.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, "");

const charBag = (s) => {
  const m = new Map();
  for (const ch of semantic(s)) m.set(ch, (m.get(ch) || 0) + 1);
  return m;
};
const missingChars = (source, target) => {
  const src = charBag(source);
  const tgt = charBag(target);
  let missing = 0;
  const samples = [];
  for (const [ch, n] of src) {
    const have = tgt.get(ch) || 0;
    if (have < n) {
      missing += n - have;
      if (samples.length < 6 && /[\u4e00-\u9fff]/.test(ch)) samples.push(ch);
    }
  }
  return { missing, samples };
};

/* ══════════════════════════════════════ 1. 文章覆蓋率 */
const allArticles = [...model.articles, ...model.artistArticles];
const articleProblems = [];

for (const a of allArticles) {
  const html = readPage(a.route);
  if (!html) {
    articleProblems.push({ route: a.route, reason: "頁面不存在" });
    continue;
  }
  const text = toText(html);

  // 標題
  const normTitle = a.title.replace(/\s+/g, "");
  if (!text.replace(/\s+/g, "").includes(normTitle)) {
    articleProblems.push({ route: a.route, reason: "標題未出現", title: a.title });
    continue;
  }

  // 正文
  // 有些文章的「正文」其實是 issuu 嵌入器的介面文案（"Open publication - Free publishing"），
  // 那不是館方內容，本來就不該出現在頁面上。比對前先剔除。
  const body = (a.bodyText || "")
    .replace(/Open publication[^\n]*/gi, "")
    .replace(/Free publishing/gi, "")
    .replace(/More art/gi, "")
    .trim();

  if (body.length >= 40) {
    const { missing, samples } = missingChars(body, text);
    const ratio = missing / Math.max(1, semantic(body).length);
    // 允許 0.5% 的損失（HTML 實體、異體字轉換）
    if (ratio > 0.005) {
      articleProblems.push({
        route: a.route,
        reason: `正文缺 ${missing} 字（${(ratio * 100).toFixed(1)}%）`,
        samples,
      });
    }
  }
}

if (articleProblems.length === 0) {
  pass(`文章 ${allArticles.length} 篇：全部有頁面、標題與正文完整`);
} else {
  bad(`文章有 ${articleProblems.length} 篇不完整`, articleProblems.slice(0, 12));
  // 分類統計
  const byReason = {};
  for (const p of articleProblems) {
    const k = p.reason.split("（")[0];
    byReason[k] = (byReason[k] || 0) + 1;
  }
  soft("原因分布", byReason);
}

/* ══════════════════════════════════════ 2. 作品覆蓋率 */
const galleryProblems = [];

for (const g of model.galleries) {
  const html = readPage(g.route);
  if (!html) {
    galleryProblems.push({ album: g.slug, reason: "頁面不存在" });
    continue;
  }
  const text = toText(html).replace(/\s+/g, "");
  const missing = [];
  for (const item of g.items) {
    // 作品用編號比對（編號一定顯示）；照片用 caption 前 8 字
    if (item.code) {
      if (!text.includes(item.code)) missing.push(item.code);
    } else if (item.caption) {
      const probe = item.caption.replace(/\s+/g, "").slice(0, 8);
      if (!text.includes(probe)) missing.push(probe);
    }
  }
  if (missing.length) {
    galleryProblems.push({ album: g.slug, total: g.items.length, missing: missing.length, samples: missing.slice(0, 8) });
  }
}

if (galleryProblems.length === 0) {
  const totalItems = model.galleries.reduce((s, g) => s + g.items.length, 0);
  pass(`相簿 ${model.galleries.length} 本、條目 ${totalItems} 件：編號全部出現`);
} else {
  bad(`相簿有 ${galleryProblems.length} 本條目缺失`, galleryProblems);
}

/* ══════════════════════════════════════ 3. 年譜覆蓋率 */
{
  const html = readPage("/about/chronology");
  if (!html) {
    bad("年譜頁不存在");
  } else {
    const text = toText(html).replace(/\s+/g, "");
    const missingYears = [];
    const missingEvents = [];
    for (const t of model.timeline) {
      if (!text.includes(String(t.year))) missingYears.push(t.year);
      for (const e of t.events) {
        // 每條事件取前 12 字當指紋
        const probe = e.replace(/\s+/g, "").slice(0, 12);
        if (probe.length >= 8 && !text.includes(probe)) missingEvents.push({ year: t.year, probe });
      }
    }
    if (missingYears.length === 0 && missingEvents.length === 0) {
      const totalEvents = model.timeline.reduce((s, t) => s + t.events.length, 0);
      pass(`年譜 ${model.timeline.length} 個年份、${totalEvents} 條事件：全部出現`);
    } else {
      bad("年譜有缺", { missingYears: missingYears.slice(0, 10), missingEvents: missingEvents.slice(0, 8) });
    }
  }
}

/* ══════════════════════════════════════ 4. 圖片管線 */
{
  const allSrc = new Set();
  for (const g of model.galleries) for (const i of g.items) allSrc.add(i.src);
  for (const a of allArticles) if (a.hero) allSrc.add(a.hero);

  const notProcessed = [];
  const filesMissing = [];

  for (const src of allSrc) {
    const entry = images[src];
    if (!entry || !entry.variants?.length) {
      notProcessed.push(src);
      continue;
    }
    for (const v of entry.variants) {
      const abs = path.join(DIST, v.file.replace(/^\//, ""));
      if (!fs.existsSync(abs)) filesMissing.push(v.file);
    }
  }

  if (notProcessed.length === 0 && filesMissing.length === 0) {
    const totalVariants = Object.values(images).reduce((s, e) => s + e.variants.length, 0);
    pass(`圖片 ${allSrc.size} 張 → ${totalVariants} 個 WebP 變體：全部存在`);
  } else {
    bad("圖片管線有缺", { notProcessed: notProcessed.slice(0, 8), filesMissing: filesMissing.slice(0, 8) });
  }
}

/* ══════════════════════════════════════ 5. 原圖是否存在（防呆） */
{
  // 抽查：每本相簿的第一件，原圖必須在 raw/ 裡
  const missingRaw = [];
  for (const g of model.galleries) {
    const first = g.items[0];
    if (!first) continue;
    const abs = path.join(ROOT, "raw", "assets", first.src.replace(/^\//, ""));
    if (!fs.existsSync(abs)) missingRaw.push(first.src);
  }
  if (missingRaw.length === 0) pass("每本相簿的首件原圖都在 raw/ 中（可回溯）");
  else soft("部分原圖不在 raw/", missingRaw.slice(0, 5));
}

/* ══════════════════════════════════════ 6. 首頁區塊 */
{
  const html = readPage("/");
  const text = toText(html);
  const checks = [
    ["黃磊生", "館名"],
    ["山水", "山水類"],
    ["花鳥", "花鳥類"],
    ["書法", "書法類"],
    ["年譜", "年譜入口"],
    ["聯絡", "聯絡入口"],
  ];
  const missing = checks.filter(([k]) => !text.includes(k)).map(([, m]) => m);
  if (missing.length === 0) pass("首頁六大區塊齊備");
  else bad("首頁缺少區塊", missing);
}

/* ══════════════════════════════════════ 報告 */
console.log(`\n════ 內容完整性驗證 ════\n`);
for (const o of ok) console.log(`  ✓ ${o}`);
for (const w of warn) console.log(`  ⚠ ${w.m}${w.detail ? "：" + JSON.stringify(w.detail).slice(0, 300) : ""}`);
for (const f of fail) {
  console.log(`  ✗ ${f.m}`);
  if (f.detail) console.log(`     ${JSON.stringify(f.detail).slice(0, 700)}`);
}

console.log(`\n通過 ${ok.length}　警告 ${warn.length}　失敗 ${fail.length}`);

fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
fs.writeFileSync(path.join(ROOT, ".cache", "verify-content.json"), JSON.stringify({ ok, warn, fail }, null, 1));

process.exit(fail.length ? 1 : 0);
