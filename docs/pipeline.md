# 資料管線與工具

`tools/` 底下全是純 Node 腳本，沒有框架、沒有 TypeScript、沒有 bundler。
每一支都能獨立執行，彼此只透過檔案溝通。

## 內容的真實來源是 Markdown

```
content/md/  ──md-to-model.mjs──►  content/model.json  ──sync.mjs──►  site/src/data/model.json
   ▲                                  （產物）                          （產物）
   │                                                                        │
   └──────────────── 你編輯這裡 ────────────────────────────────────────────┘
                                                                     Astro 讀這裡
```

- **`content/md/` 是唯一真實來源**。156 個 `.md`：站台設定 1、文章 36、
  作品與照片 117、長文 2。
- `content/model.json` 與 `site/src/data/model.json` 都是**編譯產物**，手改會被蓋掉。
- `npm run dev` / `build` / `deploy` 都會自動跑 `md-to-model` + `sync`，不必手動。

為什麼要繞這一段：12 支驗證工具在 repo 根目錄跑、需要結構化資料，
而 Vite 只能 import `site/` 內的檔案。與其讓兩邊各有一套資料，
不如從同一批 Markdown 編譯出兩份形狀相同的 JSON。

## 日常用的（不需要 Docker）

```bash
npm run dev        # 開發模式：編譯 MD + 同步 + Astro 熱更新 → 4321
npm run preview    # 建置 + 起預覽伺服器 → 4321
npm run serve      # 只起預覽伺服器（dist 已是最新時）
npm run build      # 只建置
npm run verify     # 全部驗證（自動起停伺服器）
```

這五個是包裝，底下的實作：

| 指令 | 實際執行 | 說明 |
|---|---|---|
| `npm run dev` | `tools/dev.mjs` → `sync.mjs --watch` | 監看 `content/md/`，改任何 `.md` 就重編 |
| `npm run preview` | `tools/preview.mjs` | 編譯 → 同步 → 建置 → `tools/serve.mjs` |
| `npm run serve` | `tools/serve.mjs` | 零依賴靜態伺服器，模擬 Cloudflare 行為 |
| `npm run verify` | `tools/verify-all.mjs` | 跑完下面所有驗證項目 |

## Markdown 工具

| 檔案 | 方向 | 說明 |
|---|---|---|
| `tools/md-to-model.mjs` | `content/md/` → `model.json` | 編譯器。`--check` 只比對不寫入、`--verify` 與基準快照逐位元組比對 |
| `tools/md-from-model.mjs` | `model.json` → `content/md/` | 一次性遷移與救援。`--force` 才覆寫 |
| `tools/sync.mjs` | 編譯 + 複製到 `site/` | `--check` 只檢查、`--watch` 監看 MD、`--no-build` 只複製 |
| `tools/verify-roundtrip.mjs` | 往返驗證 | MD → model → MD 是否逐位元組相同 |

### 編譯器會吃掉的東西（都已修掉，並由 `verify-roundtrip` 釘住）

這些都是**靜默**的 —— 畫面上看不太出來，但資料已經變了。
每一條都是實際踩到才發現的：

| 症狀 | 原因 | 處理 |
|---|---|---|
| `B3~4頁` 的 `~` 消失 | GFM 把 `~` 當刪除線 | 產生時轉義成 `\~`，反向解回 |
| 瀏覽器顯示字面的 `&lt;藝術概論&gt;` | `bodyText` 純文字被二次轉義 | Markdown 路徑只轉義一次（修好了原本的 bug） |
| 照片日期 `1996-11-21` 退化成 `1996` | YAML 把 ISO 日期解析成 `Date` | 產生時加引號，反向依精度還原 |
| 相簿順序由「新→舊」變成「編號序」 | 沒記錄原站排列 | frontmatter 加 `order` |
| 選單葉節點多了 `children: []` | 對稱化處理 | 照原結構：只有真的有小孩才帶 `children` |
| 電話 `+886289935275` 變成 `886289935275` | YAML 當成數字 | 電話一律加引號 |
| `<p>&nbsp;</p>` 空段落消失 | `trim()` 把 nbsp 當空白 | 用單行 `\u00a0` 表示，反向還原 |
| 全形空格被壓縮 | 文字正規化太積極 | 只去行尾半形空白 |

### 編輯時的注意事項

- **`<br>` 要留著**：原站用它做行內換行，Markdown 會原樣保留。改成空行會變兩個段落。
- **`~` 寫成 `\~`**：否則被當刪除線。
- **電話號碼的引號不要拆**：`tel: "+886289935275"`。
- **`order` 是原站列表順序**，不是日期序。刪檔案會讓後面的遞補。

## 資料管線（改版、重爬時才需要）

```bash
node tools/crawl.mjs        # 1. 爬站   → raw/
node tools/extract.mjs      # 2. 抽取   → content/*.json
node tools/model.mjs        # 3. 正規化 → content/model.json
node tools/images.mjs       # 4. 圖片   → site/public/media/ + images.json
node tools/redirects.mjs    # 5. 轉址   → site/public/_redirects + _headers
```

驗證工具：

```bash
node tools/verify-content.mjs              # 內容完整性（對照原文逐字比對）
node tools/link-check.mjs                  # 連結、資源、SEO 標籤
node tools/visual-check.mjs --width 1440,768,390   # 瀏覽器實測
node tools/perf.mjs                        # 效能（4G 模擬）
node tools/verify-deploy.mjs               # 部署行為（Cloudflare vs nginx）
node tools/verify-source.mjs               # 原站廣度優先列舉 vs 實際爬取
node tools/verify-docker.mjs               # Docker 建置模擬（無 docker 環境時）
node tools/verify-serve.mjs                # 本機預覽 vs wrangler dev 行為對照
node tools/verify-all.mjs                  # 上面全部跑一遍（會自動起停伺服器）
```

`verify-all.mjs` 是平常最該跑的那一支 —— 它會自己起 `wrangler dev` 與
`tools/serve.mjs`，跑完自動關掉，不會留下孤兒行程。只改內容、想快速確認的話用
`node tools/verify-all.mjs --fast`（跳過視覺與效能，約 40 秒）。

---

## crawl.mjs

爬 `luisang.rumotan.com` 的全部內容。

**種子**：23 個頁面（首頁、關於、6 本相簿、5 個新聞分類、藝術評論、聯絡…）。

**發現文章**：對每個分類頁持續翻 `?start=N` 直到連續兩輪沒有新連結為止。
不能只抓第一頁 —— 原站的分類頁一頁只有 4–10 篇，而且 `limit=` 參數被樣板覆寫無效。
這個做法讓文章數從 24 增加到 36（補回 9 篇藝術評論）。

**抓素材**：`extractAssetRefs()` 會找四種來源：
1. `<img src>` / `srcset`
2. `<a href>` 指向圖片
3. 行內 `style="background-image:url(...)"` ← 有 3 張 hero 只寫在這裡，只掃 `<img>` 會漏
4. `<style>` 區塊裡的 `url(...)`

**輸出**：
```
raw/pages/<slug>.html     56 個頁面的完整 HTML
raw/assets/...            349 個素材（原圖原封不動）
raw/manifest.json         每個網址的狀態碼、位元組數、抓取時間
```

`manifest.json` 裡有 1 筆 `pending`（`fonts.googleapis.com/css`）—— 那是外部 CDN
請求，本來就不該抓，不影響任何頁面。

**禮貌**：每個請求間隔 200 ms，只抓同網域，不重試 404。

---

## extract.mjs

Cheerio 解析 HTML → 結構化 JSON。

**主圖為什麼要限定範圍**：一開始從整頁找第一張大圖，結果抓到「相關文章」的縮圖，
不同文章共用同一張 hero。修法：只在 `.article-details` 內找。
修正後驗證：0 個重複的 hero URL。

**輸出**：
```
content/articles.json       36 篇文章（正文、主圖、日期、分類）
content/galleries.json      6 本相簿（117 個條目）
content/pages.json          靜態頁
content/site.json           全站設定、導覽、聯絡資訊
content/search-index.json   搜尋索引
```

---

## model.mjs

把 `content/*.json` 正規化成 `content/model.json` —— Astro 的唯一資料來源。

**推導但不改寫**：所有推導欄位（`name`、`width`、`year`、`eventDate`）
都是機器解析出來的，**原始 `caption` 完整保留**。所以出錯時永遠能回頭看原文。

**幾個解析器**：

| 函式 | 做什麼 | 處理過的坑 |
|---|---|---|
| `parseArtworkTitle()` | `"O004 黃磊生---山高水長 62x128cm 2009"` → `{code, name, width, height, year}` | 名稱後面殘留的「年」字、干支（`丙戊` 是 `丙戌` 的錯字，要清掉）、系列字母 O/M/L/F/C |
| `parseEventDate()` | 從照片 caption 抓年份 | 只有 32/37 張抓得到，其餘留 `null` 不臆測 |
| `parseTimeline()` | 年譜原文按 `<br>` 切年 | 一條事件可能跨行，要用「開頭是 19xx/20xx 年」判斷 |

**作品 vs 照片的判定**：不用猜，用相簿分。
專輯 6/7/8 是作品（caption 帶尺寸與年份），9/10/11 是照片（caption 帶事件描述）。
所以 `kind` 是穩定的，不依賴解析成功率。

**解析品質**（80 件作品）：
- 有名稱 80/80
- 有尺寸 79/80
- 有年份 79/80
- 有英文標題 56/80

---

## images.mjs

`sharp` 圖片管線。

```js
// 核心：只產生不大於原圖的尺寸
const widths = [480, 960, 1600].filter((w) => w <= meta.width);
```

**為什麼變體寬度不一致是正常的**：

| 變體組合 | 來源數 |
|---|---|
| `480 + 960` | 48 |
| `480 + 960 + 1600` | 40 |
| `480 + 640` | 9 |
| 單一寬度 | 其餘 |

所以**絕對不能硬寫檔名**。詳見 [architecture.md](architecture.md#圖片管線)。

**去重**：有些「不同尺寸」的變體像素完全相同（來源本來就小），
用 buffer hash 比對後去掉 91 個重複檔，從 505 個變體 / 33.9 MB 降到 414 個 / 24.2 MB。

**LQIP**：每張圖額外產生 20px 寬的 base64 data-URI，內聯在 HTML 裡當佔位。
不增加請求數。

**輸出**：
```
site/public/media/...       414 個 WebP
site/src/data/images.json   每個來源的變體清單（含實際像素尺寸與位元組數）
```

---

## redirects.mjs

從 `model.json` 的 `legacyRoute` → `route` 自動產生轉址，**不是手寫的**。
原站有 42 條 `/index.php/...` 文章網址，手打一定漏。

**輸出**：
```
site/public/_redirects   68 條規則
site/public/_headers     安全標頭 + 快取
```

**兩個踩過的坑**（都已修，見 [verification.md](verification.md#第五趟部署)）：

1. 分類頁同時符合「文章」與「分類」篩選條件 → 重複規則，Cloudflare 忽略後面那條。
   修法：文章篩選改成「路徑深度 ≥ 2」。

2. `_headers` 的 `/*` 設了 `Cache-Control` → 與靜態資產自帶的標頭**串接**而非覆寫，
   變成 `max-age=0, ..., max-age=31536000`，瀏覽器取第一個，等於完全沒快取。
   修法：`/*` 只放安全性標頭；快取由 `site/src/worker.js` 在 Worker 層替換。

---

## verify-content.mjs

**不相信「我看過了」**，用字元多重集（multiset）比對原文與實際渲染結果。

```js
// 去掉空白與標點後，逐字元計數
const semantic = (s) => s.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, "");
```

原文有 3 個「黃」而新頁面只有 2 個，就是少了東西。
比 `includes()` 可靠：排版會插入空格、全形標點可能被轉半形，
但「整段話不見」躲不掉。

比對範圍：36 篇文章的正文、117 個相簿條目的編號、61 條年譜事件、414 個圖片變體。

**這支工具抓到的真問題**：2 篇「圖檔型文章」的日期與地點被我在簡化時丟掉了
（缺 9 字，19.6%）。那是真正的內容遺失，不是誤判。修法見
[verification.md](verification.md#第一趟內容完整性)。

---

## link-check.mjs

靜態掃描 `dist/`，不開瀏覽器。遍歷 60 個 HTML，把每個 `href`、`src`、
`srcset` 的每一段、CSS 裡的 `url()` 全部對檔案系統。

**這支工具抓到的真問題**：
- 40 頁的 `og:image` 是 404（原圖路徑沒有複製到 `dist/`，只有處理後的 WebP）
- `/sitemap.xml` 根本不存在
- sitemap 的分類網址拼錯（`/news/memorial` vs `/news/memorial-exhibition`）
- `/about/chronology` 與 `/artist-luisang/spectral` 標題重複

---

## visual-check.mjs

真的 Chrome（puppeteer-core），逐頁量數字而不是看截圖。

```bash
node tools/visual-check.mjs --width 1440,768,390 [--only /about] [--max N]
```

| 檢查 | 判定 |
|---|---|
| 橫向溢出 | `scrollWidth > clientWidth`，並列出超出邊界的元素 |
| 破圖 | `complete && naturalWidth === 0` |
| 對比度 | 取 computed style，**把半透明色疊到父層背景**再算 WCAG |
| 標題被切 | `scrollHeight > clientHeight` |
| 空連結 | `href` 為空或只有 `#` |
| 失敗請求 | `status >= 400` |

截圖存到 `.cache/shots/`，報告存到 `.cache/visual-report.json`。

**對比度演算法的三個坑**（都已修）：
1. 背景只取第一個 `alpha > 0.05` 的祖先 → 改成由外而內收集所有半透明層再疊
2. `color-mix()` 算出的是 `color(srgb ...)` 格式，原本 regex 只認 `rgb()` → 補上
3. 疊在照片上的文字靜態分析永遠不準 → 加 `onImage()` 判斷，遇到就跳過而不是誤報

---

## perf.mjs

CDP 模擬 4G（下載 1.6 Mbps、延遲 150 ms），mobile viewport 390×844 @2x。
LCP / CLS / TBT 由瀏覽器自己的 PerformanceObserver 提供，不是估計值。

```bash
node tools/perf.mjs [--url http://localhost:4319] [--routes /,...]
```

---

## verify-deploy.mjs

同時驗證 Cloudflare Workers 與 nginx 兩條路線的**行為是否一致**。

nginx 的部分沒有執行檔可用，所以把 `docker/nginx.conf` 的 `location` 區塊解析出來，
用 JS 重放 nginx 的比對順序（先 `=` 精確、再 `~` 正規式、最後前綴），
對同一批網址跑一次。

只修好一邊的話，訪客從 Google 點進來還是會撞 404，而你不會知道。

```bash
node tools/verify-deploy.mjs [--cf http://localhost:8788]
```

---

## verify-source.mjs

**這一支補的是驗證邏輯的盲點。**

前面所有驗證的起點都是 `content/model.json` —— 它們證明「model 正確變成頁面」，
但**沒有人證明「來源完整變成 model」**。如果爬蟲的種子清單漏了一整個區塊，
前面全部會通過，因為它們都只信任 `model.json`。

做法是不帶任何假設：不看 `raw/manifest.json`、不看 `crawl.mjs` 的種子，
直接從 `https://luisang.rumotan.com/` 廣度優先抓每個頁面上的所有站內連結，
一路走到沒東西為止，然後與實際爬取結果對比。

```bash
node tools/verify-source.mjs [--limit 300]
```

三種輸出，任何一種非 0 都算失敗：

| 項目 | 意義 |
|---|---|
| `missed` | 原站可達、我們沒抓 → **必須是 0** |
| `uncovered` | 舊網址沒有專屬轉址規則 → **必須是 0** |
| `extra` | 我們有抓、列舉沒走到（種子直接指定）→ 正常 |

`uncovered` 這一項抓到的真問題：8 條原站可達的網址沒有專屬轉址，
被結尾的 `^/index\.php/.* → /search` 降落傘接住 —— **回得了 200，看起來沒事**，
但訪客被丟到搜尋頁而不是他要看的相簿。這種「活著但走錯門」最難發現。

---

## verify-docker.mjs

這台機器沒有 `docker` 指令，所以沒辦法跑真的 `docker build`。
但「Dockerfile 會不會失敗」可以靠**複製它的輸入條件**逼近：

1. 依 `.dockerignore` 算出 `docker build context` 會包含哪些檔案（含 glob 展開）
2. 把那些檔案複製到一個乾淨的暫存目錄（模擬 `COPY site/ ./`）
3. 補上 `node_modules`（容器裡由 `npm ci` 產生），跑 `astro build`
4. 比對頁數（應為 60）與 `dist` 該有的檔案
5. 靜態檢查 `nginx.conf`：括號成對、沒有空 location、
   固定轉址目標都是 `dist` 裡真的存在的路由

```bash
node tools/verify-docker.mjs
```

**這支工具抓到的真問題**：`.dockerignore` 沒有排除 `content/`，
等於 image 裡多帶一份 744 KB 的重複資料（Astro 讀的是 `site/src/data/model.json`）。

**限制**：這不是真的 `docker build`。它能擋掉「少 COPY 一個目錄」「路徑寫錯」
「dist 少檔」這類最常見的錯，但擋不掉 base image 問題、層快取行為、
或 nginx 映像本身的差異。有 Docker 的機器上仍應實際跑一次。

---

## serve.mjs

本機預覽伺服器。**零依賴**，只用 Node 內建模組 —— 不需要 Docker、不需要 wrangler、
不需要 nginx。

```bash
node tools/serve.mjs                 # http://localhost:4321
node tools/serve.mjs --port 8080
node tools/serve.mjs --host          # 同網段手機也能連
```

它刻意**模擬 Cloudflare Workers Static Assets 的行為**，而不是模擬 nginx：

| 行為 | 實作 |
|---|---|
| `_redirects` | 解析 94 條規則，支援 `*` 與 `:param` |
| `_headers` | 套用安全性與快取標頭（同名標頭會合併，與 Cloudflare 一致） |
| 乾淨網址 | `/about` → `308`/`307` 補斜線 → `/about/index.html` |
| 404 | 回 `dist/404.html` |
| 壓縮 | gzip / brotli（尊重 `Accept-Encoding`，`identity` 不壓） |
| 設定檔不外露 | `/_headers`、`/_redirects` 回 404（與 Cloudflare 一致） |

**為什麼要模擬 Cloudflare 而不是 nginx**：`wrangler deploy` 是主要部署路線，
而 `_redirects` / `_headers` 的語意是 Cloudflare 定義的。本機若行為不同，
預覽就是在騙人。

### 它自己被驗過

`tools/verify-serve.mjs` 同時打 `serve.mjs` 與 `wrangler dev`，逐條比對
**160 條路徑**的狀態碼、轉址目標、7 個標頭：

```
受測路徑：160
狀態碼分布：{"200":5,"301":93,"302":1,"307":58,"404":3}
  ✓ 兩邊行為一致（160 條路徑、7 個標頭）
```

這一比就抓到三個「我以為一樣、其實不一樣」的地方：

1. **補斜線用 307，不是 308。** 我原本寫 308，是憑印象寫的。
2. **一般靜態檔（`robots.txt`、`favicon.svg`）也有快取標頭。**
   我原本只對 HTML 加，其他檔案沒加。
3. **`/_headers` 與 `/_redirects` 在 Cloudflare 上不公開。**
   Cloudflare 把它們當設定檔，不會當資產服務；我原本照檔案系統直接回 200，
   等於多出兩條部署後不存在的路徑。

## dev.mjs

`astro dev` 只認得 `site/src/data/model.json`，但使用者改的是
`content/model.json`（那份才是「真的」內容）。少了同步這步就會出現
「我明明改了，頁面沒變」—— 這個坑我自己踩過，所以直接做進指令裡。

```
npm run dev
  ├── tools/sync.mjs --watch   ← 監看 content/model.json，有變就複製
  └── astro dev                ← Vite 熱更新
```

## sync.mjs

`model.json` 有兩份，因為 Vite 只能 import 專案內的檔案：

| 檔案 | 給誰用 |
|---|---|
| `content/model.json` | 人編輯、驗證腳本讀（**唯一真實來源**） |
| `site/src/data/model.json` | Astro 直接 import |

**使用者永遠只編輯 `content/model.json`**，`sync.mjs` 在每次 dev / build 前
自動複製過去。`--check` 只檢查不動（給驗證用），`--watch` 持續監看。
