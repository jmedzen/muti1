#!/usr/bin/env node
/**
 * Phase 2 — 從 raw/pages/*.html 抽出結構化內容，輸出 content/*.json
 *
 * 只做「抽取」，不改寫文字。所有中文原文逐字保留。
 * 產出：
 *   content/site.json        站台資訊、選單、聯絡、頁尾
 *   content/articles.json    所有文章（含分類、日期、內文 HTML、圖片、前後篇）
 *   content/galleries.json   作品圖庫（album → items）
 *   content/pages.json       單頁內容（關於、年譜、繪畫觀、展覽交流…）
 *   content/media.json       圖片資產清單與尺寸
 *   content/search-index.json 全文檢索索引
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const ROOT = path.resolve(import.meta.dirname, "..");
const PAGES = path.join(ROOT, "raw", "pages");
const OUT = path.join(ROOT, "content");
const ORIGIN = "https://luisang.rumotan.com";

const norm = (s) => (s || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\r/g, "").trim();

function cleanHtmlBody($, el) {
  // 保留段落/換行/圖/清單/連結，去掉 Joomla 的內嵌樣式與空白
  const $el = $(el);
  $el.find("script,style,iframe,noscript").remove();
  $el.find("[onclick]").each((_, n) => {
    $(n).removeAttr("onclick");
  });
  $el.find("*").each((_, n) => {
    const $n = $(n);
    $n.removeAttr("style");
    $n.removeAttr("class");
    $n.removeAttr("id");
    $n.removeAttr("data-*");
  });
  let html = $el.html() || "";
  html = html.replace(/<\/?div[^>]*>/gi, "");
  html = html.replace(/\s*\n\s*/g, "\n");
  html = html.replace(/\n{3,}/g, "\n\n");
  html = html.replace(/<p>\s*<\/p>/gi, "");
  return html.trim();
}

function textOf(html) {
  return norm(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  );
}

const files = (await fsp.readdir(PAGES)).filter((f) => f.endsWith(".html"));
const pages = new Map();
for (const f of files) {
  const slug = f.replace(/\.html$/, "");
  pages.set(slug, await fsp.readFile(path.join(PAGES, f), "utf8"));
}

// ---------------------------------------------------------------- 站台骨架
function extractChrome(html) {
  const $ = cheerio.load(html);
  const menu = [];
  $("nav.sp-megamenu-wrapper ul.sp-megamenu-parent > li").each((_, li) => {
    const $li = $(li);
    const a = $li.children("a").first();
    const item = { title: norm(a.text()), href: a.attr("href") || "", children: [] };
    $li.find("ul.sp-dropdown-items > li > a").each((_, c) => {
      item.children.push({ title: norm($(c).text()), href: $(c).attr("href") || "" });
    });
    menu.push(item);
  });
  const footer = norm($("#sp-footer, .sp-footer, footer").first().text()) || "";
  return { menu, footer };
}

// ---------------------------------------------------------------- 文章
const CAT_MAP = {
  "紀念展": "memorial",
  "拍賣新聞": "auction",
  "媒體報導": "media",
  "官方報導": "official",
  "展覽新聞": "exhibition",
  "藝術評論": "reviews",
  "關於藝術家": "artist",
};

function articleFrom(html, slug) {
  const $ = cheerio.load(html);
  const body = $('[itemprop="articleBody"]').first();
  if (!body.length) return null;
  const title = norm($("h1").first().text()) || norm($('meta[property="og:title"]').attr("content"));
  const catName = norm($(".category-name a").first().text()) || norm($(".article-info .category-name").first().text());
  const dateRaw = $("time[datetime]").first().attr("datetime") || "";
  const dateText = norm($(".article-info .published").first().text());
  const author = norm($(".article-info .createdby").first().text()) || "admin";
  const category = CAT_MAP[catName] || "other";

  const images = [];
  // 只看本文區塊（#sp-component 內的第一個 .article-details），避免把「相關文章」的縮圖混進來
  const scope = $(".article-details").first().length ? $(".article-details").first() : $("#sp-component").first();
  scope.find(".article-feature-gallery img").each((_, img) => {
    const src = $(img).attr("src");
    if (src) images.push({ src, role: "hero" });
  });
  body.find("img").each((_, img) => {
    const src = $(img).attr("src");
    if (src) images.push({ src, role: "inline" });
  });

  const bodyHtml = cleanHtmlBody($, body);
  const bodyText = textOf(bodyHtml);

  const prev = $('a[rel="prev"]').first();
  const next = $('a[rel="next"]').first();
  const nav = (a) => (a.length ? { href: a.attr("href"), title: norm(a.find(".visually-hidden").text()).replace(/^(上一篇文章|下一篇文章):\s*/, "") } : null);

  const hits = norm($(".hits, .article-info .hits, .js-hits").first().text());

  return {
    slug,
    url: ORIGIN + "/" + (slug === "home" ? "index.php" : "index.php/" + slug),
    title,
    category,
    categoryName: catName,
    date: dateRaw,
    dateText,
    author,
    hits,
    images: dedupeBy(images, (i) => i.src),
    bodyHtml,
    bodyText,
    wordCount: bodyText.replace(/\s/g, "").length,
    prev: nav(prev),
    next: nav(next),
  };
}

function dedupeBy(arr, key) {
  const seen = new Set();
  return arr.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const articles = [];
const others = [];
for (const [slug, html] of pages) {
  const a = articleFrom(html, slug);
  if (a) articles.push(a);
  else others.push(slug);
}

// 用 slug 對應回真實 URL（從 manifest 取最準）
const manifest = JSON.parse(await fsp.readFile(path.join(ROOT, "raw", "manifest.json"), "utf8"));
const urlBySlug = new Map(manifest.pages.map((p) => [p.slug, p.url]));
for (const a of articles) {
  a.url = urlBySlug.get(a.slug) || a.url;
  a.route = routeFromUrl(a.url);
  if (a.prev) a.prev.route = routeFromUrl(new URL(a.prev.href, ORIGIN).toString());
  if (a.next) a.next.route = routeFromUrl(new URL(a.next.href, ORIGIN).toString());
}

function routeFromUrl(u) {
  const url = new URL(u, ORIGIN);
  let p = url.pathname.replace(/^\/+/, "");
  p = p.replace(/^index\.php\/?/, "");
  return "/" + p.replace(/\/+$/, "");
}

// ---------------------------------------------------------------- 圖庫
const ALBUMS = [
  { id: "6", slug: "landscape", title: "山水", titleEn: "Landscape" },
  { id: "7", slug: "flowers-birds", title: "花鳥蟲魚", titleEn: "Flowers, Birds, Insects & Fish" },
  { id: "8", slug: "calligraphy", title: "書法", titleEn: "Calligraphy" },
  { id: "9", slug: "exhibition-exchange", title: "展覽交流", titleEn: "Exhibition Exchange" },
  { id: "10", slug: "life-footprint", title: "生活足跡", titleEn: "Life Footprints" },
  { id: "11", slug: "art-exchange", title: "藝術交流", titleEn: "Artistic Exchange" },
];

function parseGallery(html, albumId) {
  const $ = cheerio.load(html);
  const items = [];
  $(`.speasyimagegallery-gallery-item`).each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href") || "";
    if (!href.includes(`albums/${albumId}/`)) return;
    const title = norm($a.attr("data-title") || $a.find("img").attr("title") || $a.text());
    const desc = norm($a.attr("data-desc") || "");
    const thumb = $a.find("img").attr("src") || "";
    items.push({ src: href, thumb, title, desc });
  });
  return items;
}

const galleries = ALBUMS.map((al) => {
  const pageEntry = manifest.pages.find((p) => (p.url || "").includes(`albums/${al.id}`) || false);
  // 直接掃所有頁面，取包含該 album 圖片的那一頁
  let best = null;
  for (const [slug, html] of pages) {
    const items = parseGallery(html, al.id);
    if (items.length && (!best || items.length > best.items.length)) best = { slug, items };
  }
  return {
    ...al,
    route: routeFromUrl((manifest.pages.find((p) => p.slug === best?.slug) || {}).url || ""),
    items: best ? best.items : [],
    count: best ? best.items.length : 0,
  };
});

// 作品編號解析（M001 / O004 / C016 / A013 / B008 …）
function parseArtwork(title) {
  const t = title.replace(/\s+/g, " ").trim();
  const m = /^([A-Z])(\d{2,3})\b/.exec(t);
  const code = m ? `${m[1]}${m[2]}` : null;
  const dim = /(\d+(?:\.\d+)?)\s*[x×X]\s*(\d+(?:\.\d+)?)\s*(?:cm|公分)?/i.exec(t);
  const year = /(19|20)\d{2}(?!\s*[x×X])/.exec(t.replace(/[A-Z]\d{2,3}/, ""));
  const en = /[A-Za-z][A-Za-z .,'-]{3,}/.exec(t.replace(/^[A-Z]\d{2,3}\s*/, "").replace(/黃磊生---?/, ""));
  let name = t
    .replace(/^[A-Z]\d{2,3}\s*/, "")
    .replace(/黃磊生\s*-{2,3}\s*/, "")
    .replace(/\d+(?:\.\d+)?\s*[x×X]\s*\d+(?:\.\d+)?\s*(?:cm|公分)?/gi, "")
    .replace(/\b(19|20)\d{2}\b/g, "");
  const enMatch = /([A-Za-z][A-Za-z0-9 .,'’\-]{3,})/.exec(name);
  if (enMatch) name = name.replace(enMatch[1], "");
  name = norm(name.replace(/[()（）]/g, "")).replace(/^[-–—·\s]+|[-–—·\s]+$/g, "");
  return {
    code,
    name,
    titleEn: enMatch ? norm(enMatch[1]) : null,
    width: dim ? Number(dim[1]) : null,
    height: dim ? Number(dim[2]) : null,
    year: year ? Number(year[0]) : null,
  };
}

for (const g of galleries) {
  g.items = g.items.map((it, i) => ({ ...it, index: i + 1, ...parseArtwork(it.title) }));
}

// ---------------------------------------------------------------- 單頁內容
function pageSections(html) {
  const $ = cheerio.load(html);
  const $c = $("#sp-component").first();
  if (!$c.length) return null;
  // 移除圖庫/文章列表，只留文字區塊
  $c.find(".speasyimagegallery-gallery, .speasyimagegallery-albums, .article-list, .blog").remove();
  const out = [];
  $c.find(".sppb-addon, .sppb-addon-content, article, .article-body, .sp-module").each((_, el) => {});
  $c.find("h1,h2,h3,h4,p,li").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const t = norm($(el).text());
    if (!t || t.length < 1) return;
    out.push({ tag, text: t });
  });
  return out;
}

// ---------------------------------------------------------------- 主檔輸出
await fsp.mkdir(OUT, { recursive: true });

const homeHtml = pages.get("home") || "";
const chrome = extractChrome(homeHtml);

const site = {
  origin: ORIGIN,
  name: "黃磊生官方網站",
  nameEn: "Huang LuiSang Art Museum",
  tagline: "嶺南畫派 · 藝術生命紀念館暨數位美術館",
  description:
    "黃磊生藝術生命紀念館暨數位美術館－任美國東方藝術協會最高榮譽顧問、美國中華藝術學會理事長，歷任三石書畫學會理事長，黃磊生六十年繪畫藝術巡回展。",
  lang: "zh-Hant",
  menu: chrome.menu,
  footerText: chrome.footer,
  contact: null,
  social: [],
};

// 聯絡頁
const contactHtml = pages.get("contact") || "";
{
  const $ = cheerio.load(contactHtml);
  const text = norm($("#sp-component").text());
  const tels = [...contactHtml.matchAll(/tel:([+0-9\s-]+)/g)].map((m) => norm(m[1]));
  const mails = [...contactHtml.matchAll(/mailto:([^"'>\s]+)/g)].map((m) => norm(m[1]));
  const addr = /地址[:：]\s*([^<\n]{4,80})/.exec(text);
  site.contact = {
    phones: [...new Set(tels)],
    emails: [...new Set(mails)],
    address: addr ? norm(addr[1]) : null,
    text: text.slice(0, 1200),
  };
}

// 首頁 hero 與版塊
function homeContent(html) {
  const $ = cheerio.load(html);
  const c = $("#sp-component");
  const slides = [];
  c.find(".sp-item").each((_, s) => {
    const bg = /url\(([^)]+)\)/.exec($(s).find(".sp-background").attr("style") || "");
    slides.push({
      title: norm($(s).find(".sppb-sp-slider-title").text()),
      cta: norm($(s).find(".sppb-sp-slider-button").text()),
      ctaHref: $(s).find(".sppb-sp-slider-button").attr("href"),
      image: bg ? bg[1].replace(/["']/g, "") : null,
    });
  });
  const blocks = [];
  c.find("section.sppb-section").each((_, sec) => {
    const addons = [];
    $(sec)
      .find(".sppb-addon")
      .each((_, a) => {
        const cls = $(a).attr("class") || "";
        const type = (/sppb-addon-([a-z0-9-]+)/.exec(cls) || [])[1] || "unknown";
        const title = norm($(a).find(".sppb-addon-title").first().text());
        const content = norm($(a).find(".sppb-addon-content").first().text());
        const img = $(a).find("img").first().attr("src") || null;
        const btn = $(a).find("a.sppb-btn").first();
        if (title || content || img || btn.length) {
          addons.push({
            type,
            title,
            content,
            image: img,
            cta: btn.length ? { text: norm(btn.text()), href: btn.attr("href") } : null,
          });
        }
      });
    if (addons.length) blocks.push({ id: $(sec).attr("id"), addons });
  });
  const html2 = c.html() || "";
  const bodyText = norm(c.text());
  return { slides, blocks, bodyText };
}

const home = homeContent(homeHtml);

// 年譜：從 artist-luisang 列表頁取 intro，或文章內取
const timeline = [];
{
  const html = pages.get("artist-luisang-spectral") || pages.get("artist-luisang") || "";
  const $ = cheerio.load(html);
  const bodyHtml = cleanHtmlBody($, $('[itemprop="articleBody"]').first());
  const txt = textOf(bodyHtml);
  const lines = txt.split("\n").map(norm).filter(Boolean);
  for (const l of lines) {
    const m = /^((?:19|20)\d{2})\s+(.{4,})$/.exec(l);
    if (m) timeline.push({ year: Number(m[1]), text: m[2] });
    else {
      const m2 = /^((?:19|20)\d{2})\s*$/.exec(l);
      if (m2) timeline.push({ year: Number(m2[1]), text: "" });
    }
  }
  // 若抓到的是純年份 + 下一行文字，合併
  const merged = [];
  for (let i = 0; i < timeline.length; i++) {
    const cur = timeline[i];
    if (!cur.text && timeline[i + 1] && !timeline[i + 1].text === false) {
      // 下一個若有 text 就直接用
    }
    merged.push(cur);
  }
  site.timelineRaw = txt;
}

const singlePages = {};
for (const [slug, html] of pages) {
  if (articles.some((a) => a.slug === slug)) continue;
  if (slug.startsWith("news") || slug === "art-reviews" || slug === "home") continue;
  singlePages[slug] = { slug, route: routeFromUrl(urlBySlug.get(slug) || ""), sections: pageSections(html) };
}

await fsp.writeFile(path.join(OUT, "site.json"), JSON.stringify({ ...site, home }, null, 2));
await fsp.writeFile(
  path.join(OUT, "articles.json"),
  JSON.stringify(articles.sort((a, b) => (b.date || "").localeCompare(a.date || "")), null, 2)
);
await fsp.writeFile(path.join(OUT, "galleries.json"), JSON.stringify(galleries, null, 2));
await fsp.writeFile(path.join(OUT, "pages.json"), JSON.stringify(singlePages, null, 2));

const searchIndex = [
  ...articles.map((a) => ({
    type: "article",
    route: a.route,
    title: a.title,
    category: a.categoryName,
    text: a.bodyText.slice(0, 4000),
  })),
  ...galleries.flatMap((g) =>
    g.items.map((i) => ({ type: "artwork", route: `/gallery/${g.slug}#${i.code || i.index}`, title: i.title, category: g.title, text: i.desc || "" }))
  ),
];
await fsp.writeFile(path.join(OUT, "search-index.json"), JSON.stringify(searchIndex, null, 2));

// ---------------------------------------------------------------- 報告
const stats = {
  pages: pages.size,
  articles: articles.length,
  articleChars: articles.reduce((s, a) => s + a.wordCount, 0),
  galleries: galleries.map((g) => `${g.slug}:${g.count}`),
  artworks: galleries.reduce((s, g) => s + g.count, 0),
  withCode: galleries.flatMap((g) => g.items).filter((i) => i.code).length,
  withDims: galleries.flatMap((g) => g.items).filter((i) => i.width).length,
  withYear: galleries.flatMap((g) => g.items).filter((i) => i.year).length,
  articleWithImages: articles.filter((a) => a.images.some((i) => i.role === "hero")).length,
  emptyBodies: articles.filter((a) => a.wordCount < 20).map((a) => a.slug),
  notArticle: others,
};
console.log(JSON.stringify(stats, null, 2));
