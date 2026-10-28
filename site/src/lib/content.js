import model from "../data/model.json";
import images from "../data/images.json";

export const SITE = {
  ...model.site,
  url: model.meta?.source ?? "https://luisang.rumotan.com",
};
export const META = model.meta;
export const CATEGORIES = model.categories;
export const menu = model.menu;
export const contact = model.contact;
export const galleries = model.galleries;
export const articles = model.articles;
export const artistArticles = model.artistArticles;
export const timeline = model.timeline;
export const paintingView = model.paintingView;
export const biography = model.biography;
export const homeBlocks = model.homeBlocks;

export const IMAGES = images;

/* ------------------------------------------------------------------ 路由 */
export const routes = {
  home: "/",
  about: "/about",
  chronology: "/about/chronology",
  paintingView: "/about/painting-view",
  news: "/news",
  reviews: "/art-reviews",
  collection: "/collection",
  life: "/life",
  contact: "/contact",
  search: "/search",
  archives: "/archive",
};

/* ------------------------------------------------------------------ 分類 */
export const newsCategories = CATEGORIES.filter((c) =>
  ["memorial", "exhibition", "auction", "media", "official"].includes(c.id)
);

export const categoriesWithCounts = CATEGORIES.map((c) => {
  const pool = c.id === "reviews" ? articles.filter((a) => a.category === "reviews") : articles.filter((a) => a.category === c.id);
  return { ...c, count: pool.length };
});

export function articlesByCategory(id) {
  return articles.filter((a) => a.category === id).sort((a, b) => {
    const da = a.eventDate?.iso || a.publishedAt || "";
    const db = b.eventDate?.iso || b.publishedAt || "";
    return db.localeCompare(da);
  });
}

/* ------------------------------------------------------------------ 圖片工具 */
export function img(src) {
  return IMAGES[src] || null;
}

/** 產生 srcset 字串（給 <img srcset> 用） */
export function srcset(src, widths) {
  const m = IMAGES[src];
  if (!m) return undefined;
  const picks = widths ? m.variants.filter((v) => widths.includes(v.w)) : m.variants;
  const list = (picks.length ? picks : m.variants).map((v) => `${v.file} ${v.width}w`);
  return list.join(", ");
}

/** 取最接近某寬度的變體 URL */
export function pick(src, w = 960) {
  const m = IMAGES[src];
  if (!m) return null;
  let best = m.variants[0];
  for (const v of m.variants) {
    if (Math.abs(v.width - w) < Math.abs(best.width - w)) best = v;
  }
  return best;
}

export function dims(a) {
  if (!a.width || !a.height) return null;
  return `${a.width} × ${a.height} ${a.dimUnit === "cm" ? "cm" : a.dimUnit || ""}`.trim();
}

/* ------------------------------------------------------------------ 文章分組 */
export const articlesSorted = [...articles].sort((a, b) => {
  const da = a.eventDate?.iso || a.publishedAt || "";
  const db = b.eventDate?.iso || b.publishedAt || "";
  if (db !== da) return db.localeCompare(da);
  return a.title.localeCompare(b.title);
});

export const featuredArticles = articlesSorted.slice(0, 6);

/* 全部文章（含藝術家文章）給搜尋與典藏用 */
export const allArticles = [...articles, ...artistArticles];

/* 年 → 該年事件（含照片） */
/* 年譜旁的照片：只收「照片」，不收作品。
 * 一幅 2009 年畫的作品不是「2009 年的照片」—— 它的年份是創作年，
 * 不是事件年。混進來會讓年譜看起來像「那年他拍了這張」，
 * 對一個編年體來說是錯的資訊。 */
export const timelineWithPhotos = timeline.map((t) => ({
  ...t,
  photos: galleries
    .flatMap((g) => g.items.map((i) => ({ ...i, albumTitle: g.title, albumSlug: g.slug })))
    .filter((i) => i.kind === "photo" && i.eventDate?.year === t.year),
}));

export const artworks = galleries.flatMap((g) =>
  g.items.filter((i) => i.kind === "artwork").map((i) => ({ ...i, albumTitle: g.title, albumRoute: g.route }))
);

export const photos = galleries.flatMap((g) =>
  g.items.filter((i) => i.kind === "photo").map((i) => ({ ...i, albumTitle: g.title, albumRoute: g.route }))
);

/* 統計（給首頁與關於頁用，全部由資料算出，不寫死） */
export const stats = {
  artworks: artworks.length,
  photos: photos.length,
  albums: galleries.length,
  articles: articles.length,
  yearsSpan: (() => {
    const ys = artworks.map((a) => a.year).filter(Boolean);
    if (!ys.length) return null;
    return [Math.min(...ys), Math.max(...ys)];
  })(),
  timelineYears: timeline.length,
  charters: articles.reduce((s, a) => s + a.charCount, 0),
};

/* 以年份分組的作品索引 */
export const artworksByYear = (() => {
  const map = new Map();
  for (const a of artworks) {
    if (!a.year) continue;
    if (!map.has(a.year)) map.set(a.year, []);
    map.get(a.year).push(a);
  }
  return [...map.entries()].sort((a, b) => b[0] - a[0]);
})();

export const formatDate = (iso, fallback = "") => {
  if (!iso) return fallback;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  return d ? `${y}.${mo}.${d}` : `${y}.${mo}`;
};

export const formatDateZh = (iso, fallback = "") => {
  if (!iso) return fallback;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  return d ? `${y} 年 ${Number(mo)} 月 ${Number(d)} 日` : `${y} 年 ${Number(mo)} 月`;
};

/* 全文檢索索引（給 /search 用；在 build 時內嵌，零後端） */
export const searchDocs = [
  ...articles.map((a) => ({
    t: "a",
    r: a.route,
    n: a.title,
    c: a.categoryName,
    x: (a.bodyText || "").replace(/\s+/g, " ").slice(0, 2600),
    y: a.eventDate?.year ?? Number(a.publishedAt?.slice(0, 4)) ?? null,
  })),
  ...artistArticles.map((a) => ({
    t: "a",
    r: a.route,
    n: a.title,
    c: "關於藝術家",
    x: (a.bodyText || "").replace(/\s+/g, " ").slice(0, 2600),
    y: null,
  })),
  ...artworks.map((a) => ({
    t: "w",
    r: `${a.albumRoute}#${a.id}`,
    n: a.name || a.caption,
    c: a.albumTitle,
    // 年份已經在 meta 顯示，這裡不要再重複一次
    x: [a.titleEn, a.width && `${a.width}×${a.height}${a.dimUnit || "cm"}`, a.note, a.medium]
      .filter(Boolean)
      .join(" "),
    y: a.year ?? null,
  })),
  ...photos.map((p) => ({
    t: "p",
    r: `${p.albumRoute}#${p.id}`,
    n: p.name || p.caption,
    c: p.albumTitle,
    x: p.caption || "",
    y: p.eventDate?.year ?? null,
  })),
  ...timeline.map((t) => ({
    t: "y",
    r: `/about/chronology#y${Math.floor(t.year / 10) * 10}`,
    n: `${t.year} 年`,
    c: "年譜",
    x: t.events.join(" ").slice(0, 700),
    y: t.year,
  })),
];

/* ------------------------------------------------------------------ 媒體工具（安全版）
 * 圖片的可用寬度依原圖而定（885px 的原圖不會有 960/1600 變體），
 * 所以 srcset 一律從 images.json 反查，不硬寫檔名。 */
export function media(src, { sizes = null, fallback = 640 } = {}) {
  const m = IMAGES[src];
  if (!m || !m.variants?.length) return null;
  const vs = [...m.variants].sort((a, b) => a.width - b.width);
  const best = vs.reduce((acc, v) => (Math.abs(v.width - fallback) < Math.abs(acc.width - fallback) ? v : acc), vs[0]);
  return {
    src: best.file,
    srcset: vs.map((v) => `${v.file} ${v.width}w`).join(", "),
    width: best.width,
    height: best.height,
    ratio: m.ratio,
    lqip: m.lqip,
    sizes,
    variants: vs,
  };
}

/** 取某張圖最大可用變體（Lightbox 用） */
export function mediaFull(src) {
  const m = IMAGES[src];
  if (!m || !m.variants?.length) return null;
  return [...m.variants].sort((a, b) => b.width - a.width)[0];
}

/** 由相簿項目物件直接取媒體（items 的 src 是 /images/... 開頭） */
export function mediaOf(item, opts) {
  return media(item?.src, opts);
}

/** 佔位：圖片不存在時回傳一個可用的 CSS 背景 */
export const hasMedia = (src) => Boolean(src && IMAGES[src]?.variants?.length);

/* 摘要用：剔除 issuu 等嵌入器的介面文案，只留館方文字 */
export function excerpt(article, max = 160) {
  let t = (article?.bodyText || "")
    .replace(/Open publication[^\n]*/gi, "")
    .replace(/Free publishing/gi, "")
    .replace(/More art/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max).replace(/[，、。；：\s]+$/, "") + "…" : t;
}
