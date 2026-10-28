#!/usr/bin/env node
/**
 * 產生 Cloudflare 需要的兩個檔案：
 *   site/public/_redirects  舊 Joomla 網址 → 新網址（301）
 *   site/public/_headers   快取與安全標頭
 *
 * 為什麼要另外寫程式產生，而不是手打：
 *   原站有 42 條 /index.php/... 的文章網址，手打一定漏。
 *   這裡直接從 content/model.json 的 legacyRoute → route 對應生成，不可能漏。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const model = JSON.parse(fs.readFileSync(path.join(ROOT, "content", "model.json"), "utf8"));
const OUT = path.join(ROOT, "site", "public");

/* ------------------------------------------------------------ _redirects */
const redirects = [];
const seen = new Set();

const add = (from, to, code = 301) => {
  if (!from || !to || seen.has(from)) return;
  seen.add(from);
  redirects.push({ from, to, code });
};

// 1. 每一篇文章：完整舊路徑 → 新路徑
for (const a of [...model.articles, ...model.artistArticles]) {
  add(a.legacyRoute, a.route);
}

// 2. 分類頁（舊 /index.php/xxx/yyy → 新 /news/xxx）
const catMap = {
  "/index.php/news/auction-news": "/news/auction-news",
  "/index.php/news/memorial-exhibition": "/news/memorial-exhibition",
  "/index.php/news/media-coverage": "/news/media-coverage",
  "/index.php/news/official-reports": "/news/official-reports",
  "/index.php/news/exhibition-news": "/news/exhibition-news",
  "/index.php/news": "/news",
  "/index.php/art-reviews": "/art-reviews",
  "/index.php/artist-luisang": "/about",
};
for (const [from, to] of Object.entries(catMap)) add(from, to);

// 3. 相簿（舊 SP Easy Image Gallery 路徑 → 新作品集）
//
// 原站同一本相簿有「多個入口」：同一個 albums/9 可以從
//   /index.php/landscape/exhibition-exchange、/index.php/art-life/exhibition-exchange、
//   /landscape/exhibition-exchange … 等路徑到達。
// 這些不是重複內容，而是不同選單深度指到同一個頁面 ——
// 使用者可能把任何一條加進書籤，所以全部都要轉。
//
// 這裡用「相簿 slug → 新路徑」定義一次，再展開成所有已知的舊前綴，
// 不要手寫 24 條（手寫一定漏，實際就漏了 8 條）。
const ALBUM_TARGETS = {
  landscape: "/collection/landscape",
  "flowers-birds-insects-fish": "/collection/flowers-birds",
  calligraphy: "/collection/calligraphy",
  "exhibition-exchange": "/life/exhibition-exchange",
  "life-footprint": "/life/life-footprint",
  "art-exchange": "/life/art-exchange",
};

// 原站實際存在的三種路徑形狀
const ALBUM_PREFIXES = ["/index.php/landscape/", "/index.php/art-life/", "/landscape/", "/art-life/"];

const albumMap = {
  // 「藝術生活」是相簿區塊的首頁，本身不是相簿
  "/index.php/art-life": "/life",
  "/art-life": "/life",
};
for (const [slug, target] of Object.entries(ALBUM_TARGETS)) {
  // 舊站的相簿頁有兩種寫法：/prefix/<slug> 與 /<slug>/<slug>
  albumMap[`/index.php/${slug}/${slug}`] = target;
  albumMap[`/${slug}/${slug}`] = target;
  for (const prefix of ALBUM_PREFIXES) {
    albumMap[prefix + slug] = target;
  }
}
for (const [from, to] of Object.entries(albumMap)) add(from, to);

// 4. 單頁（首頁、關於、聯絡…）
const pageMap = {
  "/index.php": "/",
  "/index.php/component/users": "/",
  "/index.php/component/users/": "/",
  "/index.php/contact": "/contact",
  "/index.php/about": "/about",
  "/index.php/search": "/search",
  "/index.php/component/search": "/search",
  "/index.php/component/search/": "/search",
  // Joomla 內建的 com_finder 搜尋（原站選單的放大鏡指的可能是這個）
  "/index.php/component/finder/search": "/search",
  "/home": "/",
  "/zh": "/",
  "/tw": "/",
  "/index.php/zh": "/",
};
for (const [from, to] of Object.entries(pageMap)) add(from, to);

// 5. 舊站圖片目錄 → 新站 media（不轉址，讓瀏覽器直接用快取；只擋掉目錄列表）
// 這一段不寫進 _redirects，避免吃掉 /media 的實際檔案。

const lines = [
  "# 由 tools/redirects.mjs 自動產生 —— 請勿手改，改 tools/redirects.mjs 後重跑。",
  `# 產生時間：${new Date().toISOString()}`,
  `# 條目數：${redirects.length}`,
  "",
  "# ── 舊 Joomla 文章網址（保住既有搜尋排名） ──",
  // 只挑「文章」層級的路徑（/index.php/news/<分類>/<slug>），
  // 不能用 startsWith 篩選 —— 那會把分類頁 /index.php/news/auction-news 也算進來，
  // 於是同一條規則在檔案裡出現兩次，Cloudflare 會判定重複並忽略後面的那條。
  ...redirects
    .filter((r) => {
      if (r.from.startsWith("/index.php/news/")) {
        return r.from.replace("/index.php/news/", "").split("/").filter(Boolean).length >= 2;
      }
      return r.from.startsWith("/index.php/art-reviews/") || r.from.startsWith("/index.php/artist-luisang/");
    })
    .map((r) => `${r.from}  ${r.to}  ${r.code}`),
  "",
  "# ── 舊分類頁 ──",
  ...redirects
    .filter((r) => Object.keys(catMap).includes(r.from))
    .map((r) => `${r.from}  ${r.to}  ${r.code}`),
  "",
  "# ── 舊相簿 ──",
  ...redirects
    .filter((r) => Object.keys(albumMap).includes(r.from))
    .map((r) => `${r.from}  ${r.to}  ${r.code}`),
  "",
  "# ── 其他舊路徑 ──",
  ...redirects
    .filter((r) => Object.keys(pageMap).includes(r.from))
    .map((r) => `${r.from}  ${r.to}  ${r.code}`),
  "",
  "# ── 收尾：任何殘留的 /index.php/* 都導到搜尋頁，不要讓訪客撞 404 ──",
  "/index.php/*  /search  302",
  "",
].join("\n");

fs.writeFileSync(path.join(OUT, "_redirects"), lines, "utf8");

/* -------------------------------------------------------------- _headers */
const headers = `# 由 tools/redirects.mjs 自動產生
#
# ⚠️ Cloudflare 會把「所有命中規則」的同名標頭串接起來，不是覆寫。
#    所以 /* 絕對不能設 Cache-Control —— 否則 /media/* 的 immutable 會變成
#    "public, max-age=0, must-revalidate, public, max-age=31536000, immutable"，
#    瀏覽器取第一個 max-age=0，等於圖片完全沒有快取。
#    安全性標頭可以放在 /*（各路徑不衝突），快取只能放在最具體的路徑規則上。
#    HTML 的快取交給 Cloudflare 靜態資產的预设值（max-age=0, must-revalidate）。

/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(), microphone=(), camera=(), interest-cohort=()
  Cross-Origin-Opener-Policy: same-origin
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'self'

# 指紋化的建置產物：一年不動
/_astro/*
  Cache-Control: public, max-age=31536000, immutable

# 圖片：檔名含原檔名與尺寸，內容不會變
/media/*
  Cache-Control: public, max-age=31536000, immutable
  Access-Control-Allow-Origin: *

# 字型
/fonts/*
  Cache-Control: public, max-age=31536000, immutable
  Access-Control-Allow-Origin: *

# 搜尋結果頁不進索引（帶與不帶結尾斜線都涵蓋）
/search
  X-Robots-Tag: noindex, follow
/search/*
  X-Robots-Tag: noindex, follow

# 後台（Sveltia CMS）：
#   - 全站 CSP 會擋掉 unpkg 的程式與 GitHub API，所以用「!」把 /* 的 CSP 拆掉，
#     改由 admin/index.html 裡的 <meta> CSP 管（同名標頭是串接，兩份會同時生效，只能拆）。
#   - COOP same-origin 會切斷 GitHub 登入彈窗與後台之間的 window.opener，登入會卡住。
/admin
  ! Content-Security-Policy
  ! Cross-Origin-Opener-Policy
  X-Robots-Tag: noindex, nofollow
/admin/*
  ! Content-Security-Policy
  ! Cross-Origin-Opener-Policy
  X-Robots-Tag: noindex, nofollow
`;
fs.writeFileSync(path.join(OUT, "_headers"), headers, "utf8");

console.log(`_redirects: ${redirects.length} 條`);
console.log(`_headers: 寫入完成`);
