# 架構說明

## 為什麼要重建

原站 `luisang.rumotan.com` 是 **Joomla! 4/5 + Helix Ultimate + SP Page Builder +
SP Easy Image Gallery** 蓋的。後台密碼遺失，無法登入、無法更新、無法修任何東西。
Joomla 的版本升級與外掛相容性問題會讓它慢慢爛掉，而沒有人能救。

所以策略是：**把內容全部抽出來，跟 Joomla 徹底分手。**

抽出來之後，網站變成純靜態 —— 沒有資料庫、沒有後台、沒有 PHP，
也就沒有「忘記密碼」這件事。

---

## 三層資料模型

```
raw/                     content/                  site/
（不可變的事實）          （可檢視的中介）           （可替換的呈現）
─────────────────        ─────────────────         ─────────────────
pages/*.html       →     articles.json       →     Astro 頁面
assets/*（350 個）       galleries.json            components/
manifest.json            site.json                 lib/content.js
                         model.json
```

### 為什麼要三層，不直接爬完就產生頁面？

因為**出問題時要能定位**。

假設某篇文章的日期顯示錯了。如果是「爬蟲直接寫 HTML」的架構，你只能去翻爬蟲的輸出，
不知道是原始資料就錯了、還是解析錯了、還是排版時算錯了。

三層的話：

1. 打開 `raw/pages/<slug>.html` 看原文怎麼寫 → **原始資料對不對**
2. 打開 `content/articles.json` 看解析結果 → **解析對不對**
3. 打開 `site/dist/<route>/index.html` 看渲染結果 → **呈現對不對**

任何一層壞了都能從上一層重跑，不必重新爬站。
而原站已經沒有人能登入後台了，`raw/` 就是**唯一的一份原件** ——
這也是為什麼它佔 55 MB 也留著。

### 每一層的職責

| 層 | 只做什麼 | 絕對不做什麼 |
|---|---|---|
| `raw/` | 原封不動保存 | 不改寫、不清理、不重新編碼 |
| `content/` | 從 HTML 抽出結構 | 不推導、不臆測、不補值 |
| `model.json` | 正規化（解析日期、清理名稱、分類） | 不改動原文（原文留在 `caption`、`bodyText`） |

`model.meta.note` 把這個原則寫在資料裡：

> 本檔由 tools/model.mjs 從 raw/ 的原始 HTML 產生。原文一字未改，
> 推導欄位（eventDate、name、width…）皆為機器解析，原始 caption 保留在 caption 欄位。

---

## 資料管線

```
node tools/crawl.mjs        →  raw/          56 頁、350 素材、55 MB
node tools/extract.mjs      →  content/      articles / galleries / pages / search-index
node tools/model.mjs        →  content/model.json   正規化
node tools/images.mjs       →  site/public/media/   414 個 WebP + images.json
node tools/redirects.mjs    →  site/public/_redirects（68 條）、_headers
```

四支工具都是**可獨立重跑**的純 Node 腳本，彼此只透過檔案溝通，沒有共用狀態。

### 爬蟲的幾個關鍵決定

**分類頁要翻頁。** 一開始只抓到 24 篇文章，少了 9 篇藝術評論。
原因是分類頁的 `?start=N` 分頁被樣板覆寫（`limit=` 無效，一頁固定 4–10 篇），
而且每頁數量不一致。解法是持續翻頁直到連續兩輪沒有新文章為止。

**主圖要限定範圍。** 一開始 hero 圖片會抓到「相關文章」的縮圖，
導致不同文章共用同一張圖。修法：只在 `.article-details` 範圍內找。

**行內樣式裡的圖也要抓。** 有 3 張 hero 是寫在
`style="background-image:url(...)"` 裡，只掃 `<img>` 會漏掉。補上 `url()` 正則。

**不抓外部 CDN。** `fonts.googleapis.com/css` 這種請求本來就不該抓 ——
新站的字型是自己 host 的，零外部依賴。

---

## 圖片管線

原站有 160 張來源圖，尺寸極不平均（最大的 1600px 寬，最小的只有 372px）。

```js
// tools/images.mjs 的核心邏輯
for (const src of sources) {
  const meta = await sharp(src).metadata();
  // 只產生「不大於原圖」的尺寸 —— 放大只會變糊、浪費空間
  const widths = [480, 960, 1600].filter((w) => w <= meta.width);
  // 產生 WebP + 20px LQIP
}
```

**為什麼變體寬度不一致是常態、不是 bug**：

| 變體組合 | 來源數 |
|---|---|
| `480 + 960` | 48 |
| `480 + 960 + 1600` | 40 |
| `480 + 640` | 9 |
| 單一寬度（40px、372px 等） | 其餘 |

所以**絕對不能硬寫檔名**。曾經寫死 `-960.webp`，結果那張 885px 寬的來源只有
`480` 和 `640` 兩個變體，直接 404。

修法是 `site/src/lib/content.js` 的 `media()`：

```js
import { media } from "../lib/content.js";
const m = media(src, { sizes: "100vw" });
// m = { src, srcset, width, height, ratio, lqip, variants }
```

它去查 `images.json`（建置時產生），回傳**實際存在**的變體。
這個函式是全站唯一能產生圖片網址的地方 —— 全站 `.astro` 檔裡沒有任何
`-960.webp`、`-480.webp` 這種字面量。

**指紋化去重。** 有些「不同尺寸」的變體其實像素完全相同（來源本來就小），
用 sharp 的 buffer hash 比對後去掉了 91 個重複檔案，414 個變體從 33.9 MB 降到 24.2 MB。

---

## 前端架構

Astro 7 靜態輸出，**零 JavaScript 框架**。

```
site/src/
├── pages/            路由（檔案即路由）
│   ├── index.astro
│   ├── about/        about, chronology, painting-view
│   ├── collection/   index, [slug]（3 本作品集）, years
│   ├── life/         index, [slug]（3 本相簿）
│   ├── news/         index, [category], [...slug]
│   ├── art-reviews/  index, [...slug]
│   ├── artist-luisang/[...slug]   舊路徑保留 + 升級提示
│   ├── contact, search, archive, 404
│   ├── rss.xml.js
│   └── sitemap.xml.js
├── components/
│   ├── GalleryView.astro    作品集／相簿共用（篩選、排序、密度）
│   ├── ArticleView.astro    文章共用（圖檔型／文字型）
│   └── Lightbox.astro       燈箱（鍵盤、觸控、深連結）
├── layouts/BaseLayout.astro  head meta / OG / JSON-LD / 字型
├── lib/content.js           資料存取層（唯一的資料入口）
├── styles/base.css          設計系統
└── data/                    model.json / images.json
```

### 為什麼不用框架

這個站的全部互動只有三件事：**篩選、排序、看大圖**。
React/Vue 會為了這三件事送 40 KB 的 runtime 下載、解析、執行。
用原生 `<dialog>` + 幾十行 JS 可以做到一樣的事，而且：
- 沒有 hydration 延遲（LCP 不會被 JS 拖累）
- 關掉 JS 之後，所有內容仍然完整可讀（只有篩選功能失效）
- 沒有版本升級的維護負擔

實測 TBT（總阻塞時間）是 **0 ms**。

### 無 JavaScript 的降級

進場動畫用 `.js [data-reveal]` 選擇器控制，而 `js` class 是在 `<head>` 最前面
用內聯腳本加的：

```html
<script>document.documentElement.classList.add("js")</script>
```

順序很重要 —— 如果這段在 CSS 之後才執行，會有一段閃爍。
放在最前面還有一個好處：**關掉 JS、搜尋引擎爬、列印、讀屏軟體，看到的都是完整內容**，
不會有一整頁空白（這是 `[data-reveal] { opacity: 0 }` 最常見的災難）。

### 燈箱為什麼不用函式庫

用原生 `<dialog>` + `showModal()`，瀏覽器自己處理：
- 焦點鎖定（focus trap）
- `Esc` 關閉
- 背景 `inert`
- 頂層堆疊（top layer，不受 z-index 影響）

自己寫的部分只有：左右鍵切換、`Z` 縮放、觸控滑動、`history.replaceState` 同步 hash。
深連結（`#O004`）在載入時直接開到那一件 —— 這個功能讓「把某件作品貼給朋友」
變得可能，而大多數現成燈箱做不到。

---

## 設計系統

```
--paper:      #faf8f3    紙
--paper-warm: #ece5d6    暖紙（卡紙、區塊底）
--ink:        #14110d    墨
--ink-soft:   #4a4438    次級文字
--ink-faint:  #6f6857    輔助文字（已加深至 AA 通過）
--ochre:      #9c5b32    赭（連結、強調）
--ochre-deep: #7a4525    深赭（深底上的赭）
--indigo:     #2c3e50    靛（極少用）
--container:  78rem
--measure:    34em       正文行長
```

**為什麼是這組顏色**：紙、墨、赭石是水墨畫本身的材料色。
不用純黑（`#000`）是因為紙上的墨從來不是純黑，是帶暖調的深褐。
不用純白當底色是因為刺眼，`#faf8f3` 接近宣紙。

**豎排的節奏**：中文直書的視覺重量和橫排不同。標題用 `letter-spacing: 0.06em`
拉開字距模擬直書的呼吸感，行高 1.95 讓漢字方塊之間有足夠留白。

**字型**：`EB Garamond`（拉丁）+ 系統中文字型堆疊。
不載入中文字型是因為一個完整的繁體中文字型至少 4–8 MB，
而系統的蘋方／微軟正黑已經很好。EB Garamond 只用在英文標題與數字。

**作品的呈現**：見 [verification.md](verification.md) 第三趟第 5 點 ——
`object-fit: contain` 放在卡紙上，寧可留白也不裁切。

---

## 部署架構

兩條路線，行為一致（由 `tools/verify-deploy.mjs` 驗證）：

### Cloudflare Workers（建議）

```
訪客 → Cloudflare Edge → Worker（修標頭）→ Static Assets（dist/）
                                  ↓
                          _redirects（68 條）
                          _headers（安全標頭）
```

- 免費方案：100,000 請求/天、無限靜態資產請求
- 全球 300+ 節點，台灣訪客由台北／香港節點服務
- `Total Upload: 0.97 KiB` —— 只有 Worker 腳本要上傳，資產走靜態層

### Docker + nginx（自架）

```
訪客 → nginx:80 → /usr/share/nginx/html（dist/）
```

- 多階段建置：`node:22-alpine` 建置 → `nginx:1.27-alpine` 服務
- 映像約 60 MB，啟動後記憶體約 10 MB
- `docker/nginx.conf` 把 `_redirects` 改寫成 `location` 區塊

### 兩者的差異

| | Cloudflare | nginx |
|---|---|---|
| 轉址 | `_redirects`（68 條，含 42 篇全文對應） | `location` 區塊（17 條，涵蓋分類與正規式） |
| 快取 | Worker 替換標頭 | `add_header` |
| 404 | `not_found_handling: 404-page` | `error_page 404 /404.html` |
| 邊緣快取 | 有 | 無（可前面加 Caddy/Cloudflare） |

nginx 版沒有逐篇列出 42 篇文章的轉址 —— 那用正規式 `^/index\.php/news/(.*)$` 一次涵蓋，
路徑結構本來就相同。`verify-deploy.mjs` 確認兩種寫法對 36 條實際網址的結果一致。

---

## 已知限制

1. **沒有後台。** 這是刻意的 —— 要改內容得改 `content/model.json` 再重跑建置。
   對一個不會再更新的紀念館網站，這比維護一套 CMS 合理。
   若日後需要，可以接 Decap CMS 或 Sanity，資料層不用動。

2. **搜尋是前端過濾。** 153 筆文件內聯在 `/search`（gzip 後約 12 KB）。
   零延遲，但資料長到幾千筆就該換。

3. **CSP 有 `'unsafe-inline'`。** Astro 內聯樣式與腳本所需。比沒有 CSP 好，但不是最嚴。

4. **沒有 AVIF。** WebP 已涵蓋 97%，AVIF 再省 20–30% 但編碼慢 5 倍，不划算。
