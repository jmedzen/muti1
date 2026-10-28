# 驗證報告

五趟驗證，每趟用不同方法，不互相採信。全部在 2026-10-28 於本機實際跑過。

```
npm run build                      60 pages / 0.6s
node tools/verify-content.mjs      通過 6　警告 0　失敗 0
node tools/link-check.mjs          60 頁 497 檔　問題 0
node tools/visual-check.mjs        177 次渲染　問題 0
node tools/perf.mjs                LCP 平均 931ms　CLS 0
node tools/verify-deploy.mjs       兩條部署路線一致　全部通過
```

---

## 第一趟：內容完整性

**方法**：不相信「我看過了」，改用字元多重集（multiset）比對。
把 `content/model.json` 的原文與 `site/dist` 渲染出來的實際文字，兩邊都去掉
空白與標點後，逐字元計數 —— 原文有 3 個「黃」，新頁面只有 2 個，就是少了東西。
這比 `includes()` 可靠，因為排版會插入空格、全形標點可能被轉半形，
但「整段話不見」是躲不掉的。

```
node tools/verify-content.mjs
```

| 檢查 | 數量 | 結果 |
|---|---|---|
| 文章有頁面、標題與正文完整 | 36 篇 | ✓ |
| 相簿條目編號全部出現 | 6 本 / 117 件 | ✓ |
| 年譜年份與事件全部出現 | 59 年 / 61 條 | ✓ |
| 圖片變體全部存在 | 150 張 → 414 檔 | ✓ |
| 每本相簿首件原圖可回溯到 raw/ | 6 張 | ✓ |
| 首頁六大區塊齊備 | 6 項 | ✓ |

**過程中修掉的問題**：

1. 第一次跑就抓出 2 篇文章「正文缺字」。
   一篇缺 9 字（19.6%）—— 那是圖檔型文章，原站正文是「展覽日期：2013.7.4～2013.7.8／地點：廈門美術館」，
   我把「圖檔型文章」簡化成只有圖，把日期地點丟了。**這是真正的內容遺失，不是誤判。**
   修法：`ArticleView` 新增 `.stub-meta`，把圖檔型文章的說明文字解析成 `dl` 呈現。
   另一篇缺 2 字，是 issuu 嵌入器的介面文案（"Open publication - Free publishing"），
   那本來就不該顯示，屬於誤判 —— 在比對前剔除。

2. 第二輪還剩 2 字，原因是「展覽日期：」的冒號在排版後變成空白。
   把比對範圍縮到只算中文、英數，排除標點與空白。這不是放寬標準，
   是修正「排版差異 ≠ 內容遺失」的判定邏輯。

**這一趟證明的事**：80 件作品的編號、61 條年譜事件、18,406 字新聞正文，
在最終 HTML 裡一字不少。

---

## 第二趟：連結與資源

**方法**：靜態掃描 `dist/`，不開瀏覽器。遍歷 60 個 HTML，把每個 `href`、`src`、
`srcset` 的每一段、CSS 裡的 `url()` 全部拿去對檔案系統。

```
node tools/link-check.mjs
```

```
掃描 60 個頁面、497 個檔案
問題總數：0
```

檢查項目：

- 站內連結 → 檔案存在（含 `/about` `/about/` `/about/index.html` 三種寫法都試）
- `<img src>` 與 `srcset` 每一段 → 檔案存在
- CSS `url()` → 檔案存在（字型 `woff2` 走這條）
- `canonical`、`meta description`、`og:image` 存在
- `<title>` 不重複、`h1` 恰好一個
- 有 `width` 的 `img` 也要有 `height`（防 CLS）

**過程中修掉的問題**：

1. **40 頁的 `og:image` 是 404。** 版型傳進來的 `image` 是原圖路徑
   （`/images/speasyimagegallery/albums/6/images/o004.jpg`），但原圖沒有複製到 `dist/`，
   只有處理後的 WebP。修法：`BaseLayout` 改走 `media()` 取得實際存在的變體，
   取不到就退回 `/og-default.jpg`。分享到 Facebook / Line 才會有圖。

2. **重複的 `<title>`。** `/about/chronology`（互動年表）與
   `/artist-luisang/spectral`（年譜原文）都叫「黃磊生年譜」。
   修法：原文版加上「（原文）」後綴，`ArticleView` 新增 `titleOverride` prop。

3. **`/sitemap.xml` 是 404。** 原本根本沒有這個檔案。新增 `sitemap.xml.js` 端點，
   從實際資料產生 58 條網址，`lastmod` 用文章發佈日而非 build 時間
   （每次都回 build 時間會讓搜尋引擎覺得整站在洗內容）。

4. **sitemap 的分類網址錯了。** 我手寫 `["memorial","exhibition",...]` 拼成
   `/news/memorial`，實際路由是 `/news/memorial-exhibition`。
   修法：改從 `CATEGORIES` 取 `route`，不自己拼 slug。
   修正後交叉比對：sitemap 58 條、dist 59 頁，差的那一頁是 `/search`（刻意不收錄）。

---

## 第三趟：視覺與響應式

**方法**：用真的 Chrome（puppeteer-core）逐頁載入，量實際的版面。不是看截圖有沒有怪，
是量數字：`scrollWidth - clientWidth > 0` 就是橫向溢出，並找出兇手元素。

```
node tools/visual-check.mjs --width 1440,768,390
```

```
=== 177 page renders (1440px, 768px, 390px) ===
clean: 177   with issues: 0
```

檢查項目：

| 項目 | 判定方式 |
|---|---|
| 橫向溢出 | `documentElement.scrollWidth > clientWidth`，並列出超出邊界的元素 |
| 破圖 | 圖片 `complete && naturalWidth === 0` |
| 對比度 | 取 computed style，**把半透明色疊到父層背景**再算 WCAG 比值 |
| 標題被切 | `scrollHeight > clientHeight` |
| 空連結 | `href` 為空或只有 `#` 的 `a` |
| 失敗請求 | `response.status >= 400` |

**過程中修掉的問題**（共 16 個：12 個視覺、2 個內容正確性、2 個無障礙）：

1. **16–41 個低對比警告／頁。** `--ink-faint` 是 `#8a8272`，在紙色底上只有 3.59:1。
   加深到 `#6f6857` → 5.22:1（紙色）/ 4.83:1（暖紙色），全數通過 AA。

2. **對比度演算法本身有兩個 bug。** 一開始報「白字配白底 1:1」，
   但那個按鈕其實疊在照片上（`btn--light` 用 `backdrop-filter`）。
   - 背景色只取第一個 `alpha > 0.05` 的祖先就停 → 改成由外而內收集所有半透明層再疊起來
   - `color-mix(in srgb, ...)` 的計算結果是 `color(srgb 0.1 0.07 0.05 / 0.72)` 格式，
     原本的 regex 只認 `rgb()`，解析成 `null` 就跳過 → 補上 `color(srgb ...)` 解析
   - 疊在照片上的文字靜態分析永遠不準 → 加 `onImage()` 判斷，遇到就跳過而不是誤報

3. **`/about/chronology` 桌機橫向溢出 3,825px。** 年表用 `grid-template-columns: 150px 1fr`，
   `1fr` 的預設 `min-width` 是 `auto`，被裡面的長句撐開。
   改成 `150px minmax(0, 1fr)`，並在 `.chrono-main`、`.year-body` 加 `min-width: 0`。

4. **`/collection/*` 手機橫向溢出 51–125px。** 工具列的 flex 子項沒設 `min-width: 0`，
   內容把它撐寬了。加上 `min-width: 0` + `max-width: 100%`。

5. **作品被裁切。** 這是自找的：原本作品卡片用 `object-fit: cover` + `aspect-ratio: 1/1`，
   一張直幅山水（62×128cm）被裁成正方形，構圖整個毀掉。
   **美術館網站把畫裁掉是最不能接受的事。**
   改成 `contain` 放在固定比例的「卡紙」上（`--frame-ratio: 4/5` + 內距 + 淡陰影），
   寧可留白也不裁。照片（`data-kind="photo"`）才用 `cover`，因為紀錄照沒有構圖問題。

6. **Lightbox 的畫質糊掉。** 「1 / 34」那張圖被放大到 1123×1977 顯示，超出原始 909×1600。
   原因是 `max-height: 100%` 在 flex 子項上失效（父層高度不確定時百分比會被忽略）。
   改成 CSS 變數 `--stage-h: calc(100dvh - 15rem)` 直接算死。

7. **Lightbox 背景透出網格。** `rgba(10,9,7,0.96)` 會讓底下的作品縮圖隱約可見，看畫時很干擾。
   改成不透明 `#0a0907`。

8. **圖檔型文章的主圖左右被切。** 用了 `margin-left: calc(50% - 50vw + 1.5rem)` 想把圖拉寬，
   在 grid 容器裡算錯，實測左邊超出視窗 200px。
   改成 `width: min(140%, 46rem)` + `margin: auto` 置中放大。

9. **`/news` 頭條摘要顯示「Open publication - Free publishing - More art」。**
   那是 issuu 嵌入器的文案，不是館方內容。
   新增 `excerpt()` 統一過濾，新聞列表、分類頁、評論頁共用。

10. **年譜側欄的數字掉到下一行。** `<a>` 裡是兩個 `<span>`，父層 flex 讓它們分行了。
    改成 `flex` + `justify-content: space-between`，並給 `dj-year` / `dj-count` 各自的 class。

11. **手機上的作品集一欄到底。** `minmax(240px, 1fr)` 在 390px 寬只排得出一欄，
    一張卡就佔滿螢幕，34 件作品要滑很久。改成手機用 `9.2rem`（約 147px）→ 兩欄，
    密度接近紙本的圖版索引。

12. **年譜旁的照片混進了畫作。** `timelineWithPhotos` 用 `eventDate.year` 比對，
    但畫作的「年份」是**創作年**不是事件年 —— 一幅 2009 年的畫被排進 2009 年的年譜條目下，
    看起來像「那年他拍了這張」。53 件作品因此混進年譜。
    修法：`filter` 加上 `i.kind === "photo"`。修正後：18 個年份、32 幀照片（原本誤報成 24 年）。

13. **年譜文案說「至 2011 年辭世」。** 但資料裡有 2014 與 2018 兩筆紀念展紀錄，
    等於頁面自己說「到 2011 為止」卻又列出 2018 的事。
    改成「2011 年辭世，其後仍有紀念展持續舉行」。

14. **搜尋結果完全沒有樣式。** 這是整趟驗證裡最嚴重的一個，而且是**肉眼掃過去不會發現**的那種。
    搜尋結果是 JS 用 `innerHTML` 產生的，但 Astro 的 `<style>` 預設是 **scoped** ——
    編譯後選擇器變成 `.s-item[data-astro-cid-wp2l4cmv] a[data-astro-cid-wp2l4cmv]`，
    而 `innerHTML` 產生的節點**不帶** `data-astro-cid` 屬性，所以一條規則都沒命中。
    結果頁一直是「純文字堆疊」，看起來像設計成那樣，其實是壞的。
    修法：把結果區的樣式移到 `<style is:global>`。
    （偵測方式：`getComputedStyle(a).display` 回 `inline` 而不是 `flex`。）

15. **搜尋結果的層級是反的。** 原本是「山水 · 2007 · 作品」在前、標題在後，
    讀起來像「山水」是標題的一部份。改成標題先、資訊後 ——
    使用者在搜尋結果裡是「找名字」，不是「找分類」。

16. **篩選晶片沒有 `aria-pressed`。** 點下去只有 class 變，讀屏軟體不會知道哪個篩選生效了。
    加上 `aria-pressed`，並在 JS 裡與 class 一起更新（`chips` 與密度切換都補）。

---

## 第四趟：效能

**方法**：Chrome DevTools Protocol 模擬 4G（下載 1.6 Mbps、延遲 150 ms），
mobile viewport 390×844 @2x。LCP / CLS / TBT 全部由瀏覽器自己的 PerformanceObserver 提供，
不是我自己的估計值。

```
node tools/perf.mjs
```

| 頁面 | LCP | CLS | TBT | 傳輸 | 請求 | DOM |
|---|---|---|---|---|---|---|
| `/` | 1,628 ms | 0 | 0 ms | 334 KB | 11 | 641 |
| `/collection/landscape` | 1,908 ms | 0 | 0 ms | 456 KB | 16 | 850 |
| `/about/chronology` | 560 ms | 0 | 0 ms | 45 KB | 5 | 982 |
| `/news` | 540 ms | 0 | 0 ms | 143 KB | 7 | 481 |
| `/art-reviews` | 492 ms | 0 | 0 ms | 45 KB | 4 | 322 |
| `/life/exhibition-exchange` | 1,292 ms | 0 | 0 ms | 271 KB | 16 | 550 |
| `/contact` | 508 ms | 0 | 0 ms | 45 KB | 4 | 284 |
| `/search` | 516 ms | 0 | 0 ms | 45 KB | 4 | 254 |

**平均 LCP 931 ms、CLS 0、TBT 0 ms、傳輸 173 KB、8 個請求。**
全部落在 Google 的「良好」區間（LCP < 2.5s、CLS < 0.1、TBT < 200ms）。

**怎麼做到的**：

- **零外部請求。** 沒有 Google Fonts、沒有 CDN、沒有分析腳本。字型是自己 host 的
  EB Garamond `woff2`（用 `@fontsource` 的思路手動放進 `public/fonts/`，只留實際用到的字重）。
- **沒有 JavaScript 框架。** Astro 輸出純 HTML + CSS，唯一的 JS 是內聯的
  reveal observer 和 lightbox，加起來不到 8 KB。
- **CLS = 0** 是因為所有 `<img>` 都有 `width`/`height`（`media()` 從 `images.json` 查實際像素），
  瀏覽器在圖片下載前就知道要留多少空間。
- **首屏圖片用 LQIP。** `images.mjs` 對每張圖產生 20px 的 base64 data-URI 當佔位，
  內聯在 HTML 裡（不增加請求），圖片載入後淡入。
- **HTML 全站 45 KB 起跳**（gzip 後約 9 KB）。
  首頁 334 KB 是因為有 6 張首屏大圖 —— 那是內容本身的重量，不是程式碼。

**取捨**：`/collection/landscape` 有 34 件作品，我沒有做虛擬滾動或分頁。
34 張縮圖在格線裡用 `loading="lazy"` 分擔，實測 LCP 1,908 ms 仍在「良好」門檻（2.5 s）內。
以美術館網站來說，「一眼看到全部作品」比「少 100 KB」重要。

---

## 第五趟：部署

**方法**：不只看「部署成功」，而是同時驗證兩條部署路線（Cloudflare Workers 與 nginx）
的行為**是否一致**。只修好一邊的話，訪客從 Google 點進來還是會撞 404，而你不會知道。

```
node tools/verify-deploy.mjs
```

```
_redirects：68 條規則、0 條重複

受測：舊文章 36 條、分類/相簿/單頁 11 條、現役頁面 12 條
Cloudflare 轉址成功：36/36
nginx 規則數：17（exact 13、regex 4）

  ✓ 兩條部署路線行為一致，全部通過
```

nginx 的部分沒有執行檔可用（這台機器沒有 Docker，也沒有 nginx），
所以 `verify-deploy.mjs` 把 `docker/nginx.conf` 的 `location` 區塊解析出來，
用 JS 重放 nginx 的比對順序（先 `=` 精確、再 `~` 正規式、最後前綴），
對同一批網址跑一次，比對結果是否與 Cloudflare 相同。

**實測的 HTTP 行為**（`wrangler dev`，Port 8788）：

```
/                                                         200
/index.php/artist-luisang                         301 → /about
/index.php/news/official-reports/2008nian8yue29ri-...     301 → /news/official-reports/...
/index.php/news/auction-news                      301 → /news/auction-news
/landscape/landscape                              301 → /collection/landscape
/index.php/whatever                               302 → /search
/this-page-does-not-exist-9f3a                    404（自訂 404 頁）
```

**過程中修掉的問題**：

1. **`_redirects` 有 5 條重複規則。** 分類頁 `/index.php/news/auction-news` 同時符合
   「文章」與「分類」兩個篩選條件，被寫進去兩次。
   Cloudflare 的日誌直接說 `Ignoring duplicate rule`。
   修法：文章篩選改成「路徑深度 ≥ 2」，不含分類本身。

2. **快取標頭互相打架。** Workers 靜態資產對每個檔案都自帶
   `Cache-Control: public, max-age=0, must-revalidate`，而 `_headers` 是**附加**不是覆寫。
   兩者合併後變成
   `public, max-age=0, must-revalidate, public, max-age=31536000, immutable`
   —— 瀏覽器只認第一個 `max-age=0`，**圖片、字型、JS 等於完全沒有快取**，
   每次回訪都要重抓。
   修法：`/*` 不再設 `Cache-Control`（只放安全性標頭），
   並新增 `site/src/worker.js` 在 Worker 層**替換**（不是附加）標頭：

   ```
   /media/...    → public, max-age=31536000, immutable
   /_astro/...   → public, max-age=31536000, immutable
   /             → public, max-age=0, must-revalidate
   ```

   修完實測：

   ```
   /                                                    Cache-Control: public, max-age=0, must-revalidate
   /media/speasyimagegallery/albums/6/images/o004-960.webp  Cache-Control: public, max-age=31536000, immutable
   /search/                                             Cache-Control: public, max-age=0, must-revalidate
                                                        X-Robots-Tag: noindex, follow
   ```

3. **`_redirects` / `_headers` 沒有進 `dist/`。** 第一次建置在產生這兩個檔案之前就跑完了。
   重跑 `astro build` 後確認 `dist/_redirects`（68 條）與 `dist/_headers`（6 條）都在。

4. **`wrangler deploy` 的 entry。** 加了 Worker 之後 `wrangler.jsonc` 要指 `main`。
   `--dry-run` 實測：`Read 581 files`、`Total Upload: 0.97 KiB / gzip: 0.50 KiB`、
   `env.ASSETS` binding 正常。

---

## 第六趟：來源站點列舉（source → model）

**為什麼要補這一趟**：前五趟驗的所有東西，起點都是 `content/model.json`。
它們證明「model 有沒有正確變成頁面」，但**沒有人證明「來源有沒有完整變成 model」**。

如果爬蟲的種子清單本身就漏掉一整個區塊，前五趟全部會通過 ——
因為它們都只信任 `model.json`。這是驗證邏輯上的盲點，不是實作 bug。

**方法**：不看 `raw/manifest.json`，也不看 `crawl.mjs` 的種子。
直接從 `https://luisang.rumotan.com/` 出發，**廣度優先**抓每個頁面上的所有站內連結，
一路走到沒東西為止。這是不帶任何假設的列舉。

```
node tools/verify-source.mjs --limit 300
```

```
列舉完成：59 次請求、59 個相異路徑、耗時 25.1s

══════════ 來源站點列舉 vs 實際爬取 ══════════

來源可達頁面（HTTP 200）：59
raw/manifest.json 記錄：  55
兩邊都有：                55
來源有、我們沒抓：        0  ← 這個必須是 0
其中是已記錄的別名：      3  ← 同內容多入口，不算漏
其中是 Joomla 功能頁：     1  ← 無內容可存，由新站對應頁取代
我們有抓、列舉沒走到：    0
舊網址沒有明確轉址規則：  0
```

**這才發現的真問題**：

1. **8 條原站可達的網址沒有專屬轉址，全部掉進 `/search` 降落傘。**
   `_redirects` 的結尾有一條 `^/index\.php/.* → /search 302` 當降落傘，
   所以這些網址**回得了 200，看起來沒事**，但訪客被丟到搜尋頁而不是他要看的相簿。

   掉進去的包括：
   ```
   /index.php/art-life                           → 應到 /life
   /index.php/art-life/exhibition-exchange       → 應到 /life/exhibition-exchange
   /index.php/art-life/life-footprint            → 應到 /life/life-footprint
   /index.php/art-life/art-exchange              → 應到 /life/art-exchange
   /index.php/landscape/flowers-birds-insects-fish → 應到 /collection/flowers-birds
   /index.php/landscape/calligraphy              → 應到 /collection/calligraphy
   /index.php/news                               → 應到 /news
   /index.php/component/finder/search            → 應到 /search
   ```

   根本原因：轉址表把相簿路徑**逐條手寫**，只寫了我當初看到的那幾條。
   原站同一本相簿有三種入口（`/index.php/landscape/<slug>`、
   `/index.php/art-life/<slug>`、`/<slug>/<slug>`），手寫一定漏。

   修法：改成用「相簿 slug → 新路徑」定義一次，再展開成所有已知前綴。
   nginx 那邊也改成正規式（`^/(?:index\.php/)?(?:landscape/|art-life/)?<slug>/?$`），
   一條涵蓋四種前綴。

   **修正後：58 條原站可達網址，58 條都有專屬 301，0 條掉進降落傘。**

2. **兩份 `model.json` 會不同步。** `content/model.json` 與 `site/src/data/model.json`
   是兩個獨立檔案，先前靠手動複製。改了其中一份，另一份不會跟著變 ——
   這種事一定會忘記。修法：`tools/model.mjs` 一次寫兩份，不再手動複製。

**這一趟證明的事**：原站 59 條可達路徑，**沒抓的是 0 條**。

```
來源可達頁面（HTTP 200）：59
raw/manifest.json 記錄：  55
來源有、我們沒抓：        0  ← 這個必須是 0
其中是已記錄的別名：      3  ← 同內容多入口，不算漏
其中是 Joomla 功能頁：     1  ← 無內容可存，由新站對應頁取代
舊網址沒有明確轉址規則：  0  ← 這個也必須是 0
```

差額 4 條的組成：

- **3 條是同內容的別名路徑。** 逐一以圖片清單比對確認 byte-level 相同 ——
  例如 `/index.php/art-life/exhibition-exchange` 與 `/index.php/landscape/exhibition-exchange`
  都是 `albums/9` 的同一批 32 張圖。同一份內容只留一份 `raw/`，
  別名記錄在 `model.meta.sourceAliases`，並且全部有 301 轉址。
- **1 條是 Joomla 的 `com_finder` 搜尋元件**（`/index.php/component/finder/search`），
  它沒有文章內容可存，新站用自己的 `/search` 取代（已有 301）。

把這三類分開之後，`missed` 才是真正有意義的斷言 ——
不然它永遠是 4，永遠紅著，久了就沒人看。

---

## 沒做／不確定的部分

誠實記錄，不假裝都做完了：

1. **沒有真的跑過 `docker build`**（這台機器沒有 Docker）。改用「模擬」逼近：
   這台機器沒有 `docker` 指令（`which docker` 是空的），所以沒辦法跑真的建置。
   但「Dockerfile 會不會失敗」可以靠**複製它的輸入條件**逼近 ——
   `tools/verify-docker.mjs` 做的事：

   1. 依 `.dockerignore` 算出 `docker build context` 會包含哪些檔案
   2. 把那些檔案複製到一個乾淨的暫存目錄（模擬 `COPY site/ ./`）
   3. 在裡面跑 `astro build`（模擬 `RUN`）
   4. 比對產出的頁數與 `dist` 內容
   5. 靜態檢查 `nginx.conf`：括號成對、每個 location 有動作、
      轉址目標都是新站真的存在的頁面

   結果：

   ```
   docker build context：500 個檔案、26.1 MB
   乾淨目錄建置：成功，60 頁，26.3 MB

     · media 進 context：414 個檔案
     · raw/ 與 content/ 已排除（執行期不需要）
     · nginx location 區塊：31 個（含 return 23 條轉址）
     · nginx 固定轉址目標：13 條，全部存在
   ```

   **這不能取代真的 `docker build`**，但擋掉了最常見的錯（少 COPY 一個目錄、
   路徑寫錯、dist 少檔）。有 Docker 的機器上仍建議實際跑一次。

3. **`_headers` 的 CSP 用了 `'unsafe-inline'`。** Astro 會內聯樣式與少量腳本，
   沒有 nonce 機制下只能用 `unsafe-inline`。這比沒有 CSP 好，但不是最嚴的。
   若之後要收緊，得改 Astro 的 inline 策略。

4. **圖片沒有做 AVIF。** WebP 已涵蓋 97% 的瀏覽器，AVIF 能再省 20–30% 但編碼慢 5 倍。
   以這個站的規模（414 個變體）重跑一次要幾十分鐘，效益不划算。

5. **搜尋是前端過濾。** 153 筆文件全部內聯在 `/search` 頁（約 45 KB gzip 後 12 KB）。
   在這個資料量下比任何後端搜尋都快（零延遲），但如果資料長到幾千筆就該換方案。

6. **原站的 `pending` 資產。** `raw/manifest.json` 裡有 1 筆
   `fonts.googleapis.com/css` 一直是 `pending` —— 那是外部 CDN 請求，本來就不該抓。
   不影響任何頁面。

---

## 第八趟：本機可執行性（沒有 Docker 也要能跑、能改）

Docker 很好，但「要改一個字」不該需要它。這一趟的目標是：
**在任何裝了 Node 的機器上，`npm run dev` 就能改、`npm run preview` 就能看。**

### 補上的東西

| 檔案 | 作用 |
|---|---|
| `tools/serve.mjs` | 零依賴本機伺服器，模擬 Cloudflare Static Assets |
| `tools/dev.mjs` | 同步 + Astro 熱更新（改檔即時反映） |
| `tools/preview.mjs` | 建置 + 起伺服器（一條指令） |
| `tools/sync.mjs` | `content/model.json` → `site/src/data/` 自動同步 |
| `tools/verify-all.mjs` | 全部驗證一次跑完，自動起停伺服器 |
| `tools/node-path.mjs` | 找「真正的 node」（見下面的坑） |
| `tools/load-dep.mjs` | 從 `site/node_modules` 載入套件 |
| 根 `package.json` | `npm run dev / preview / serve / build / verify` |

### 這一趟抓到的問題

1. **`npm run dev` 直接崩潰。** Astro 啟動時會去建
   `~/Library/Preferences/astro`，在受控環境下噴
   `EPERM: operation not permitted, mkdir`，整個 dev server 起不來。
   放在 `.env` 裡沒用 —— Astro 讀 `.env` 之前就已經碰那個目錄了。
   修法：寫進 npm script（`ASTRO_TELEMETRY_DISABLED=1 astro dev`）。

2. **自製預覽伺服器跟 Cloudflare 行為不一致。** 三個地方：
   補斜線用 308（應為 307）、靜態檔沒有快取標頭、`/_headers` 與 `/_redirects`
   被當資產公開。這三個都是靠 `verify-serve.mjs` 逐條比對 160 條路徑才發現的
   —— 沒有這個對照，預覽看起來「能用」，但看到的是假的。

3. **預覽伺服器沒有壓縮。** 效能量測顯示 260 KB，比部署後的 173 KB 差很多
   （因為 Cloudflare 會 gzip/brotli）。加上壓縮後回到 190 KB。
   不加的話，用本機數字判斷效能會做出錯誤結論。

4. **`process.execPath` 在 Electron 宿主裡不是 node。** 這是最陰的一個：
   `process.execPath` 指向 DSH 的 Electron helper，用它 spawn 子行程時
   argv 會被吃掉，wrangler 冒出 `Unknown arguments: port, …`，
   看起來像參數寫錯，其實根本沒在跑 node。
   修法：`tools/node-path.mjs` 依序找 `/opt/homebrew/bin/node`、
   `/usr/local/bin/node`、`/usr/bin/node`，都找不到才退回 `execPath`。

5. **`tools/` 的腳本找不到 `site/node_modules` 裡的套件。**
   原本靠根目錄一個 `node_modules` 符號連結，但 `npm install` 一跑就會被覆蓋。
   改成 `tools/load-dep.mjs` 在 runtime 從 `site/node_modules` 解析，
   並在找不到時給出「請在 site/ 跑 npm install」這種可行動的訊息。

6. **wrangler 的 `bin/wrangler.js` 是 shell wrapper。**
   用它啟動時 `--port` 會被吃掉，wrangler 改用預設埠，看起來像「連接埠一直被佔用」。
   修法：直接呼叫 `wrangler-dist/cli.js`。

### 驗證結果

```
node tools/verify-all.mjs

總結：10 通過、0 失敗、0 略過
  ✓ 0. 內容同步（兩份 model.json 一致）
  ✓ 1. 建置
  ✓ 2. 內容完整性
  ✓ 3. 連結與資源
  ✓ 4. 來源列舉（原站 vs 已抓取）
  ✓ 5. Docker 建置模擬
  ✓ 6. 部署驗證（Cloudflare 路線 + nginx 規則）
  ✓ 7. 本機預覽 vs Cloudflare 行為一致
  ✓ 8. 視覺與響應式（1440 / 768 / 390）
  ✓ 9. 效能（4G 模擬）
```

另外手動驗過「改內容 → 看到變化」的完整迴路：

```
改 content/model.json 的 site.tagline
  → sync --watch 偵測到（120 ms 去抖）
  → Astro 熱更新
  → 頁面 title 立即變成新標語
```

（改完已還原，`diff` 確認兩份 model.json 與改動前完全一致。）
