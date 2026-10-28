#!/usr/bin/env node
/**
 * Phase 3 — 把 extract.mjs 的粗抽取結果整成「可直接餵給 Astro」的內容模型。
 *
 * 設計原則：
 *  1. 原文一個字都不改。所有清理只針對版面（空白、標籤），不動文字。
 *  2. 原始欄位一律保留（title/raw caption/CMS 發佈時間），推導欄位另存並標明來源。
 *  3. CMS 遷站時間（2026-07-16）不是事件時間；事件時間從標題抽取，兩者分開存。
 *
 * 輸出 content/model.json（單一檔，Astro 直接 import）
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { norm, parseEventDate, parseArtworkTitle } from "./lib/derive.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const C = path.join(ROOT, "content");

const site = JSON.parse(await fsp.readFile(path.join(C, "site.json"), "utf8"));
const articlesRaw = JSON.parse(await fsp.readFile(path.join(C, "articles.json"), "utf8"));
const galleriesRaw = JSON.parse(await fsp.readFile(path.join(C, "galleries.json"), "utf8"));
const pagesRaw = JSON.parse(await fsp.readFile(path.join(C, "pages.json"), "utf8"));


/* ------------------------------------------------------------------ 分類 */
const CATEGORIES = [
  { id: "memorial", name: "紀念展", en: "Memorial Exhibitions", route: "/news/memorial-exhibition", order: 1 },
  { id: "exhibition", name: "展覽新聞", en: "Exhibition News", route: "/news/exhibition-news", order: 2 },
  { id: "auction", name: "拍賣新聞", en: "Auction Records", route: "/news/auction-news", order: 3 },
  { id: "media", name: "媒體報導", en: "Press Coverage", route: "/news/media-coverage", order: 4 },
  { id: "official", name: "官方報導", en: "Official Records", route: "/news/official-reports", order: 5 },
  { id: "reviews", name: "藝術評論", en: "Art Criticism", route: "/art-reviews", order: 6 },
  { id: "artist", name: "關於藝術家", en: "About the Artist", route: "/about", order: 7 },
];
const catById = new Map(CATEGORIES.map((c) => [c.id, c]));

/* ------------------------------------------------------------------ 日期 */
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };


/* ------------------------------------------------------------------ 作品 */




/* ------------------------------------------------------------------ 圖庫 */
const ALBUM_META = {
  landscape: {
    title: "山水",
    en: "Landscape",
    route: "/collection/landscape",
    blurb: "山川煙雲、江河飛瀑。黃磊生以嶺南筆法行走大江南北，寫生後再以渲染與留白重構空間。",
  },
  "flowers-birds": {
    title: "花鳥蟲魚",
    en: "Flowers, Birds, Insects & Fish",
    route: "/collection/flowers-birds",
    blurb: "嶺南畫派以花鳥見長。撞粉、撞水、撞色的技法在此展現，色彩在層層渲染中見絢麗。",
  },
  calligraphy: {
    title: "書法",
    en: "Calligraphy",
    route: "/collection/calligraphy",
    blurb: "書畫同源。線條的輕重提頓，是黃磊生六十年筆墨功力的另一面。",
  },
  "exhibition-exchange": {
    title: "展覽交流",
    en: "Exhibition Exchange",
    route: "/life/exhibition-exchange",
    blurb: "自 1956 年香港聖約翰藝術廳首次個展起，黃磊生在海內外美術館、大學與畫廊的展覽現場。",
  },
  "life-footprint": {
    title: "生活足跡",
    en: "Life Footprints",
    route: "/life/life-footprint",
    blurb: "寫生途中、畫室日常、婚宴與家居。照片裡的黃磊生，與畫冊上的名字互為註腳。",
  },
  "art-exchange": {
    title: "藝術交流",
    en: "Artistic Exchange",
    route: "/life/art-exchange",
    blurb: "與趙少昂、張大千、關山月等人的往來，是嶺南畫派傳承的一手現場。",
  },
};

const galleries = galleriesRaw.map((g) => {
  const meta = ALBUM_META[g.slug] || {};
  const items = g.items.map((it) => {
    const parsed = parseArtworkTitle(it.title, g.id);
    const eventDate = parsed.kind === "photo" ? parseEventDate(parsed.caption) : parsed.year ? { year: parsed.year } : null;
    return {
      ...parsed,
      album: g.slug,
      src: it.src,
      thumb: it.thumb,
      desc: it.desc || "",
      order: it.index,
      eventDate,
      id: parsed.code || `${g.slug}-${String(it.index).padStart(3, "0")}`,
    };
  });
  const artworks = items.filter((i) => i.kind === "artwork");
  const photos = items.filter((i) => i.kind === "photo");
  return {
    slug: g.slug,
    albumId: g.id,
    ...meta,
    sourceRoute: g.route,
    count: items.length,
    counts: { artwork: artworks.length, photo: photos.length },
    withDimensions: artworks.filter((a) => a.width).length,
    withYear: items.filter((a) => a.eventDate?.year).length,
    yearRange: (() => {
      const ys = items.map((i) => i.eventDate?.year).filter(Boolean);
      return ys.length ? [Math.min(...ys), Math.max(...ys)] : null;
    })(),
    items,
  };
});

/* ------------------------------------------------------------------ 文章 */
// 事件年份／日期從標題抽
const articles = articlesRaw.map((a) => {
  const cat = catById.get(a.category) || { id: a.category, name: a.categoryName, route: "/news" };
  const eventDate = parseEventDate(a.title) || parseEventDate(a.bodyText.slice(0, 120));
  const slugPath = new URL(a.url).pathname.replace(/^\/index\.php\//, "").replace(/\.html$/, "");
  const route = "/" + slugPath;
  const isArtistArticle = a.category === "artist";
  return {
    id: slugPath,
    route,
    legacyRoute: "/index.php/" + slugPath,
    title: a.title,
    category: cat.id,
    categoryName: cat.name,
    categoryRoute: cat.route === "/about" && cat.id === "artist" ? "/about" : cat.route,
    publishedAt: a.date,
    publishedAtText: a.dateText,
    eventDate,
    author: a.author,
    hits: a.hits,
    hero: a.images.find((i) => i.role === "hero")?.src || null,
    images: a.images,
    bodyHtml: a.bodyHtml,
    bodyText: a.bodyText,
    charCount: a.wordCount,
    isStub: a.wordCount < 60,
    isArtistArticle,
    prev: a.prev ? { route: a.prev.route, title: a.prev.title } : null,
    next: a.next ? { route: a.next.route, title: a.next.title } : null,
  };
});

const newsArticles = articles.filter((a) => !a.isArtistArticle);
const artistArticles = articles.filter((a) => a.isArtistArticle);

/* ------------------------------------------------------------------ 年譜 */
// 來源：/about/chronology（原 /index.php/artist-luisang/spectral）
function parseTimeline(html) {
  const entries = [];
  const blocks = html.split(/<\/p>/i);
  for (const block of blocks) {
    // 每個 <p> 內以 <br> 分年
    const lines = block
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .split("\n")
      .map((s) => norm(s))
      .filter(Boolean);
    for (const line of lines) {
      const m = /^((?:19|20)\d{2})\s*年?\s*(.*)$/.exec(line);
      if (m) {
        entries.push({ year: Number(m[1]), text: norm(m[2]) });
      } else if (entries.length) {
        // 續行：併入上一筆（原站以 <br> 換行分段，無年份者屬同一年）
        entries[entries.length - 1].text = norm(entries[entries.length - 1].text + "　" + line);
      }
    }
  }
  // 移除照片檔名殘留（例如 "...榮譽市民證書.jpg 1971 美國水彩畫會..."）
  const cleaned = entries.map((e) => ({
    ...e,
    text: e.text.replace(/[\w./-]+\.jpg\s*/gi, "").trim(),
  }));
  // 同一年合併
  const byYear = new Map();
  for (const e of cleaned) {
    if (!byYear.has(e.year)) byYear.set(e.year, []);
    if (e.text) byYear.get(e.year).push(e.text);
  }
  return [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, texts]) => ({ year, events: texts }));
}

const chronologyArticle = artistArticles.find((a) => /年譜|年表/.test(a.title));
const paintingViewArticle = artistArticles.find((a) => /繪畫觀/.test(a.title));
const bioArticle = artistArticles.find((a) => /簡歷/.test(a.title));

const timeline = chronologyArticle ? parseTimeline(chronologyArticle.bodyHtml) : [];
const timelineByYear = new Map(timeline.map((t) => [t.year, t]));

// 照片上的年份 → 年譜對照（把「展覽交流」「藝術交流」的照片掛到年份上）
const photoAnchors = [];
for (const g of galleries.filter((x) => x.counts.photo > 0)) {
  for (const p of g.items) {
    if (!p.eventDate?.year) continue;
    photoAnchors.push({ year: p.eventDate.year, album: g.slug, albumTitle: g.title, code: p.code, caption: p.caption, src: p.src, thumb: p.thumb });
  }
}
const photosByYear = new Map();
for (const p of photoAnchors) {
  if (!photosByYear.has(p.year)) photosByYear.set(p.year, []);
  photosByYear.get(p.year).push(p);
}

/* ------------------------------------------------------------------ 首頁版塊（人工校讀後的結構） */
const homeBlocks = site.home.blocks.map((b) => ({
  id: b.id,
  addons: b.addons.map((a) => ({
    type: a.type,
    title: norm(a.title),
    content: norm(a.content),
    image: a.image,
    cta: a.cta,
  })),
}));

const findBlock = (pred) => homeBlocks.find((b) => b.addons.some(pred));
const textBlocks = homeBlocks
  .flatMap((b) => b.addons)
  .filter((a) => a.type === "text-block" && a.title);

/* ------------------------------------------------------------------ 聯絡 */
const contact = {
  phones: [
    { label: "市話", value: "02 8993 5275", tel: "+886289935275" },
    { label: "手機", value: "+886 987 887 970", tel: "+886987887970" },
  ],
  emails: [
    { label: "客服", value: "service@rumotan.com" },
    { label: "館務", value: "muti@rumotan.asia" },
    { label: "聯絡人", value: "lokelly145@gmail.com" },
  ],
  im: [
    { label: "Line", value: "mutiwang" },
    { label: "微信", value: "muti_wang" },
  ],
  website: "https://luisang.rumotan.com",
  hours: null,
  address: null,
};

/* ------------------------------------------------------------------ 統計 */
const model = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: "https://luisang.rumotan.com",
    sourceCms: "Joomla! 4/5 + Helix Ultimate + SP Page Builder + SP Easy Image Gallery",
    note:
      "本檔由 tools/model.mjs 從 raw/ 的原始 HTML 產生。原文一字未改，推導欄位（eventDate、name、width…）皆為機器解析，原始 caption 保留在 caption 欄位。",
  },
  site: {
    name: site.name,
    nameEn: site.nameEn,
    tagline: site.tagline,
    description: site.description,
    lang: site.lang,
    footerText: site.footerText,
  },
  menu: site.menu,
  contact,
  categories: CATEGORIES,
  hero: site.home.slides,
  homeBlocks,
  timeline,
  timelineSource: chronologyArticle
    ? { route: chronologyArticle.route, legacyRoute: chronologyArticle.legacyRoute, title: chronologyArticle.title }
    : null,
  paintingView: paintingViewArticle
    ? {
        route: paintingViewArticle.route,
        legacyRoute: paintingViewArticle.legacyRoute,
        title: paintingViewArticle.title,
        bodyHtml: paintingViewArticle.bodyHtml,
        bodyText: paintingViewArticle.bodyText,
        charCount: paintingViewArticle.charCount,
      }
    : null,
  biography: bioArticle
    ? { route: bioArticle.route, title: bioArticle.title, bodyHtml: bioArticle.bodyHtml, bodyText: bioArticle.bodyText }
    : null,
  galleries,
  articles: newsArticles,
  artistArticles,
};

// 寫兩份：
//   content/model.json           —— 給人看、給驗證腳本讀（單一真實來源）
//   site/src/data/model.json     —— Astro 直接 import（Vite 只能 import 專案內的檔案）
// 兩份必須一致，所以從同一支程式寫出，不要手動複製。
const payload = JSON.stringify(model, null, 2);
await fsp.writeFile(path.join(C, "model.json"), payload);
await fsp.writeFile(path.join(ROOT, "site", "src", "data", "model.json"), payload);

/* ------------------------------------------------------------------ 檢查報告 */
const artworks = galleries.flatMap((g) => g.items).filter((i) => i.kind === "artwork");
const report = {
  "文章總數": articles.length,
  "新聞文章": newsArticles.length,
  "藝術家文章": artistArticles.length,
  "新聞總字數": newsArticles.reduce((s, a) => s + a.charCount, 0),
  "圖庫相簿": galleries.length,
  "作品": artworks.length,
  "照片": galleries.flatMap((g) => g.items).filter((i) => i.kind === "photo").length,
  "作品有尺寸": artworks.filter((a) => a.width).length,
  "作品有年份": artworks.filter((a) => a.year).length,
  "作品有英文名": artworks.filter((a) => a.titleEn).length,
  "年譜年份數": timeline.length,
  "年譜起始": timeline[0]?.year,
  "年譜結束": timeline.at(-1)?.year,
  "照片可歸年": photoAnchors.length,
  "無內文文章": newsArticles.filter((a) => a.isStub).map((a) => a.title),
  "解析異常作品名": artworks.filter((a) => !a.name || a.name.length < 2).map((a) => a.caption),
};
console.log(JSON.stringify(report, null, 2));
console.log("\n年譜樣本:", JSON.stringify(timeline.slice(0, 3), null, 1));
console.log("作品樣本:", JSON.stringify(artworks.slice(0, 2), null, 1));
