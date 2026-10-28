# 黃磊生官方網站・數位重建版

把 `luisang.rumotan.com` 整個搬下來、重新做成一個可以自己跑的網站。

原站是 Joomla! 4 + Helix Ultimate + SP Page Builder 蓋的，後台密碼遺失、無法再更新。
這個版本把**所有內容抽出來變成結構化資料**，再用 Astro 重新產生靜態網站 ——
不依賴 Joomla、不依賴 MySQL、不需要後台，一張 Docker image 就能在任何機器上跑起來。

---

## 快速開始

### 第一次：裝一次就好

```bash
cd site && npm install      # 只有這步需要網路
```

> 需要 Node 20 以上。這個專案**不需要 Docker**，本機就能預覽與修改。

### 平常最常用的三個指令

在專案根目錄 `muti1/`：

```bash
npm run dev        # 改東西就看得到 → http://localhost:4321（熱更新）
npm run preview    # 看「建置後」的樣子 → http://localhost:4321
npm run verify     # 全部驗證跑一遍（不需要 Docker）
```

三個指令的分工：

| 指令 | 用途 | 什麼時候用 |
|---|---|---|
| `npm run dev` | 開發模式，改檔即時反映 | 平常改內容、改樣式 |
| `npm run preview` | 先建置，再起一個模擬 Cloudflare 行為的伺服器 | 想確認「部署後到底長怎樣」 |
| `npm run serve` | 直接起伺服器，不重新建置 | dist 已經是最新的時候 |
| `npm run build` | 只建置，不開伺服器 | 要產出檔案給別人 |

`preview` 與 `serve` 的差別只有一個：`preview` 會先跑一次建置。
兩個都是服務 `site/dist/`，都會套用 `_redirects` 與 `_headers` ——
所以 94 條舊網址的 301 在本機就看得到，不用等部署。

### 正式部署

```bash
# Cloudflare Workers（建議）
cd site && npx wrangler deploy

# 或者自架
docker compose up -d --build      # → http://localhost:8080
```

---

## 怎麼改內容

內容全部在 `content/model.json` 這一個檔案裡（744 KB 的 JSON）。
**改這一份就好**，不要改 `site/src/data/model.json` ——
那份是自動複製過去的，`npm run dev` 與 `npm run build` 都會先幫你同步。

```bash
# 改完之後
npm run dev        # 存檔就會看到變化（會自動同步）
```

你可以改什麼：

| 想改的東西 | 在 model.json 的哪裡 |
|---|---|
| 站名、標語、頁尾 | `site.name`、`site.tagline`、`site.footerText` |
| 電話、Email、Line | `contact` |
| 選單 | `menu` |
| 某篇文章的標題或正文 | `articles[]`、`artistArticles[]` |
| 作品名稱、尺寸、年份 | `galleries[].items[]` |
| 年譜某一條 | `timeline[]` |
| 首頁六大區塊的文案 | `homeBlocks` |

改壞了也不用怕 —— 但這裡要誠實說：**這個目錄目前不是 git repo**，
所以沒有 `git checkout` 可以救。保險的做法是改之前先複製一份：

```bash
cp content/model.json content/model.backup.json    # 改之前
mv content/model.backup.json content/model.json    # 想還原時
```

`content/` 底下的 `articles.json`、`galleries.json`、`site.json` 是抽取階段的中介產物，
真的救不回來的話，跑 `node tools/model.mjs` 可以從它們重新產生 `model.json`
（會蓋掉你對 `model.json` 的手動修改，但至少回到原站的真實內容）。

### 只想改樣式

`site/src/styles/base.css` 直接改，`npm run dev` 會即時反映。
顏色、間距、容器寬度這些設計變數都在檔案開頭的 `:root { … }` 裡
（`--paper`、`--ink`、`--ochre`、`--container`、`--measure` 等），
改一個變數全站一起變。

---

## 這個站有什麼

| 分類 | 內容 | 數量 |
|---|---|---|
| 作品 | 山水、花鳥蟲魚、書法 | 80 件 |
| 藝術生活 | 展覽交流、藝術交流、生活足跡 | 37 幀 |
| 本站新聞 | 紀念展、展覽新聞、拍賣新聞、媒體報導、官方報導 | 33 則 |
| 藝術評論 | 名家評論文章 | 9 篇 |
| 藝術家 | 年譜、我的繪畫觀、簡歷 | 3 篇（另做互動年表） |
| 年譜 | 1928–2011，59 個年份 | 61 條事件 |
| 圖片 | 原圖 150 張 → WebP 變體 | 414 個檔案 |

合計 **60 個頁面**，`sitemap.xml` 收錄 58 條（不含 `/search` 與 404）。

---

## 專案結構

```
muti1/
├── raw/                 ← 原站原始 HTML 與原圖（55 MB，只進不出，可回溯）
│   ├── pages/           ← 56 個頁面的完整 HTML
│   ├── assets/          ← 346 個原始素材
│   └── manifest.json    ← 爬取紀錄：每個網址的狀態碼、大小、時間
│
├── content/             ← 抽取後的結構化資料（744 KB，進版控）
│   ├── model.json       ← 正規化模型，Astro 的唯一資料來源
│   ├── articles.json    ← 36 篇文章（正文、主圖、日期、分類）
│   ├── galleries.json   ← 6 本相簿（117 個條目）
│   ├── site.json        ← 全站設定、導覽、聯絡資訊
│   ├── pages.json       ← 靜態頁
│   └── search-index.json← 搜尋索引（153 筆）
│
├── package.json         ← 根目錄指令（npm run dev / preview / verify）
│
├── tools/               ← 資料管線與驗證（純 Node，無框架、零依賴）
│   │
│   │  【日常使用】
│   ├── dev.mjs          ← 開發模式（同步 + Astro 熱更新）
│   ├── preview.mjs      ← 建置 + 起預覽伺服器
│   ├── serve.mjs        ← 本機預覽伺服器（模擬 Cloudflare 行為，零依賴）
│   ├── sync.mjs         ← content/model.json → site/src/data/
│   │
│   │  【資料管線】
│   ├── crawl.mjs        ← 爬蟲
│   ├── extract.mjs      ← HTML → JSON
│   ├── model.mjs        ← JSON → 正規化模型
│   ├── images.mjs       ← sharp 圖片管線
│   ├── redirects.mjs    ← 產生 _redirects / _headers
│   │
│   │  【驗證】
│   ├── verify-all.mjs   ← 一次跑完所有驗證
│   ├── verify-content.mjs ← 內容完整性（對照原文）
│   ├── link-check.mjs   ← 連結與資源完整性
│   ├── verify-source.mjs ← 原站廣度優先列舉
│   ├── verify-deploy.mjs ← 部署行為（Cloudflare + nginx）
│   ├── verify-serve.mjs ← 本機預覽 vs Cloudflare 行為對照
│   ├── verify-docker.mjs ← Docker 建置模擬
│   ├── visual-check.mjs ← 瀏覽器實測（溢出、對比、破圖）
│   └── perf.mjs         ← 4G 模擬效能量測
│
├── site/                ← Astro 網站
│   ├── src/pages/       ← 路由
│   ├── src/components/  ← GalleryView / ArticleView / Lightbox
│   ├── src/lib/content.js ← 資料存取層
│   ├── src/data/images.json ← 圖片變體清單
│   ├── public/          ← 靜態資產（會原樣複製到 dist）
│   └── wrangler.jsonc   ← Cloudflare Workers 設定
│
├── docs/                ← 這份文件與各項驗證報告
├── Dockerfile
└── docker-compose.yml
```

---

## 資料流

```
原站 ──crawl.mjs──► raw/ ──extract.mjs──► content/*.json ──model.mjs──► content/model.json
                                                                              │
                                                        images.mjs ───────────┤
                                                              ▼               ▼
                                              site/public/media/      site/src/lib/content.js
                                              site/src/data/images.json       │
                                                                              ▼
                                                                     Astro build
                                                                              │
                                                                              ▼
                                                                        site/dist/
```

**三層分離的理由**：`raw/` 是不可變的事實（爬下來就不再動），`content/` 是可檢視的中介資料
（出問題時可以肉眼比對），`model.json` 是給程式用的正規化結果。任何一層壞了都能從上一層重跑，
不必重新爬站。原站已經沒有人能登入後台了，`raw/` 就是唯一的一份原件。

---

## 幾個關鍵決定

### 作品一律不裁切

美術館網站把畫裁掉是最不能被接受的事 —— 一張直幅山水被裁成正方形，構圖就毀了。
所以作品卡片用 `object-fit: contain` 放在固定比例的卡紙上，寧可留白也不裁。
照片（紀錄照）才用 `cover`，因為那些沒有構圖問題。

### 圖片不硬寫檔名

原始圖片有 160 種尺寸，處理後每個來源的變體寬度都不一樣
（有的只有 `480+640`，有的 `480+960+1600`，還有一張只有 372px 寬）。
直接拼 `-960.webp` 會產生 404。所以全部走 `media()`：

```js
import { media } from "../lib/content.js";
const m = media(src, { sizes: "100vw" });
// → { src, srcset, width, height, ratio, lqip, variants }
```

`media()` 會去查 `images.json`，回傳實際存在的變體。這個函式是全站唯一能產生圖片網址的地方。

### 無 JavaScript 也要能讀

首頁的進場動畫用 `.js [data-reveal]` 選擇器控制，`document.documentElement.classList.add("js")`
寫在 `<head>` 最前面。所以：關掉 JS、搜尋引擎爬、列印，內容都是完整可見的，
不會有一整頁空白。

### 舊網址一個都不能斷

原站 67 條舊網址全部 301 到新路徑（`/index.php/news/...` → `/news/...` 等）。
`tools/redirects.mjs` 從 `model.json` 的 `legacyRoute` 自動產生，不是手寫的。

---

## 驗證

八項驗證，每項用不同方法，不互相採信。一次跑完：

```bash
npm run verify        # 全部（約 3 分鐘）
npm run verify:fast   # 跳過視覺與效能（約 40 秒）
```


原本規劃五趟，實際做了七項 —— 因為第五趟寫完後發現一個邏輯盲點：
**前五趟的起點都是 `model.json`，沒有人驗證「來源有沒有完整變成 model」**。
如果爬蟲的種子清單漏掉一整個區塊，前五趟全部會通過。所以補了第六趟
（從原站廣度優先重新列舉）與第七項（Docker 建置模擬）。

| # | 檢查 | 工具 | 結果 |
|---|---|---|---|
| 1 | 內容完整性 | `verify-content.mjs` | 36 篇文章、117 個條目、61 條年譜事件全部到位 |
| 2 | 連結與資源 | `link-check.mjs` | 60 頁 0 斷鏈、0 破圖、0 重複標題 |
| 3 | 視覺與響應式 | `visual-check.mjs` | 59 頁 × 3 種寬度（177 次渲染），0 溢出、0 低對比、0 破圖 |
| 4 | 效能 | `perf.mjs` | 見 [docs/verification.md](docs/verification.md) |
| 5 | 部署 | `verify-deploy.mjs` | 兩條路線（Cloudflare / nginx）行為一致，58 條舊網址 0 條走錯 |
| 6 | 來源列舉 | `verify-source.mjs` | 從原站廣度優先走一遍，證明沒有整區漏抓 |
| 7 | Docker | `verify-docker.mjs` | 依 `.dockerignore` 重建 context，乾淨目錄建出 60 頁 |
| 8 | 本機可執行性 | `verify-serve.mjs` | 自製預覽伺服器與 Cloudflare 逐條對照，160 條路徑一致 |

詳見 **[docs/verification.md](docs/verification.md)**。

其他文件：

- **[docs/architecture.md](docs/architecture.md)** — 三層資料模型、圖片管線、前端架構、設計系統
- **[docs/pipeline.md](docs/pipeline.md)** — 每一支工具在做什麼、踩過哪些坑

---

## 部署

### Cloudflare Workers（建議）

```bash
cd site
npx wrangler deploy
```

`wrangler.jsonc` 已設好靜態資產模式（`assets.directory: ./dist`），
不需要 Worker 腳本、不需要資料庫，免費方案就夠。

自訂網域在 Cloudflare 後台指到 `luisang-museum` 這個 Worker 即可。
`_redirects` 與 `_headers` 會由 Cloudflare 自動解析。

### Docker

```bash
docker compose up -d --build
```

多階段建置：`node:22-alpine` 負責 `astro build`，`nginx:1.27-alpine` 負責服務靜態檔。
最終映像約 **60 MB**，啟動後記憶體佔用約 10 MB。

nginx 版把 `_redirects` 的規則改寫成 `location` 區塊（見 `docker/nginx.conf`），
行為與 Cloudflare 版一致。

### 其他靜態主機

`site/dist/` 整個目錄丟上去就能跑（Netlify、Vercel、S3、GitHub Pages 都可以）。
若主機支援 `_redirects` 就直接生效，否則要另外設定等價的轉址規則。

---

## 資料來源與授權

本站內容（作品影像、文字、年譜）版權屬**黃磊生家屬**所有，
數位重建僅為保存與展示之用，未經書面同意請勿轉載或用於商業用途。

原始網站：`https://luisang.rumotan.com/`（已無法登入後台）

---

## 維護

原站不會再更新，所以這個站也不需要定期同步。要改內容時：

```bash
# 改 content/model.json 或 content/articles.json
cd site && npm run build

# 重新驗證
cd .. && node tools/verify-content.mjs && node tools/link-check.mjs
```

要重新爬站（例如原站復活）：

```bash
node tools/crawl.mjs && node tools/extract.mjs && node tools/model.mjs && node tools/images.mjs && node tools/redirects.mjs
```
