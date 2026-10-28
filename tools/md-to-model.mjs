#!/usr/bin/env node
/**
 * 編譯工具：content/md/ → content/model.json
 *
 * 這是 MD 化之後的「真實來源 → 產物」那一步。每次 build 之前都會跑。
 *
 * 為什麼需要它：
 *   `model.json` 有 12 個驗證工具在用（verify-content、redirects、images…），
 *   而 Astro 只想吃 Markdown。與其讓兩邊各有一套資料，
 *   不如：MD 是唯一真實來源，這裡把它編譯成 model.json 給工具用，
 *   再同步一份給 Astro。兩條路線看的永遠是同一份內容。
 *
 * 三個必須成立的保證：
 *   1. **無損**：MD → model.json 的結果要與「MD 化之前的 model.json」逐位元組相同
 *      （產物可重現：不含編譯時間戳，改用 MD 的 mtime 與內容雜湊）。
 *      這是 `--verify` 在做的事。
 *   2. **可推導欄位不進 MD**：route、legacyRoute、charCount、prev/next、bodyText
 *      都是從 MD 內容算出來的，手寫會漂移。
 *   3. **錯誤要指出檔案與行號**：frontmatter 打錯字不該產生一個空頁面。
 *
 * 用法：
 *   node tools/md-to-model.mjs             # 產生 model.json
 *   node tools/md-to-model.mjs --check     # 只檢查 MD 是否合法，不寫檔
 *   node tools/md-to-model.mjs --verify    # 產生後與基準快照比對
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importDep } from "./load-dep.mjs";
import { parseArtworkTitle } from "./lib/derive.mjs";

// astro 裝在 site/node_modules，根目錄的 tools/ 解析不到，要走 importDep。
// （tools/md-to-model.mjs 在 repo 根目錄執行，模組解析不會往上找到 site/）
const { parseFrontmatter } = await importDep("astro/markdown");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MD = path.join(ROOT, "content", "md");
const MODEL = path.join(ROOT, "content", "model.json");
const SITE_COPY = path.join(ROOT, "site", "src", "data", "model.json");

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const VERIFY = args.includes("--verify");

const problems = [];
const warnings = [];

const fail = (where, msg) => problems.push({ where, msg });
const warn = (where, msg) => warnings.push({ where, msg });

// YAML 會把 ISO 時間自動轉成 Date 物件，排序與輸出前都要轉回字串
const asStr = (v) => (v instanceof Date ? v.toISOString() : v == null ? "" : String(v));

/* ══════════════════════════════════════════════════ 讀 MD */

function walk(dir, ext = ".md") {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out.sort();
}

function readMd(abs) {
  const raw = fs.readFileSync(abs, "utf8");
  const rel = path.relative(MD, abs).replace(/\\/g, "/");
  const { frontmatter, content } = parseFrontmatter(raw);
  // ⚠️ 不能對 body 用 trim() 之後就不管了：
  // String.prototype.trim() 會把 \u00a0（不換行空格）也當成空白去掉，
  // 而我們正是用「單獨一行的 \u00a0」來表示原站的 <p>&nbsp;</p> 空段落。
  // 所以在這裡只去掉真正的空白（空白、tab、換行），保留 \u00a0。
  const keepNbsp = (t) =>
    (t ?? "")
      .replace(/^[ \t\r\n]+/, "")
      .replace(/[ \t\r\n]+$/, "");
  return { abs, rel, data: frontmatter ?? {}, body: keepNbsp(content) };
}

/* ══════════════════════════════════════════════════ MD → HTML / 文字 */

/**
 * Markdown 內文 → HTML。
 *
 * 我們不用完整的 Markdown 編譯器，因為實際用到的語法非常有限
 * （段落、<br>、連結、裸網址；見 files 統計：p/br/a 三種而已）。
 * 自己處理的好處是「反轉換」是明確可驗證的，不必猜某個套件怎麼處理邊界。
 *
 * 但這也意味著：如果哪天有人在 MD 裡寫了 `**粗體**` 或 `# 標題`，
 * 這裡不會處理。所以下面有檢查會警告「出現了未支援的 Markdown 語法」。
 */
function mdToHtml(body) {
  if (!body) return "";
  const lines = body.split("\n");

  // 空行 = 段落分隔。
  // 但「只含 \u00a0 的行」是刻意保留的空段落（原站的 <p>&nbsp;</p>），
  // 要還原成 <p>&nbsp;</p>，不能當成段落分隔吃掉。
  const paras = [];
  let cur = [];
  for (const line of lines) {
    if (line.replace(/\u00a0/g, "").trim() === "") {
      if (line.includes("\u00a0")) {
        // 空段落：先把目前的段落收掉，再自成一個空段落
        if (cur.length) {
          paras.push(cur.join("\n"));
          cur = [];
        }
        paras.push("\u0000EMPTY\u0000");
        continue;
      }
      if (cur.length) paras.push(cur.join("\n"));
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) paras.push(cur.join("\n"));

  const inline = (s) =>
    s
      // \~ 是轉義過的波浪號（見 md-from-model.mjs），還原成字面的 ~
      .replace(/\\~/g, "~")
      // 自動連結 <https://…>
      .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, (_, url) => {
        return `<a href="${url.replace(/&/g, "&amp;")}">${url.replace(/&/g, "&amp;")}</a>`;
      })
      // [text](url)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
        const h = url.replace(/&/g, "&amp;");
        return `<a href="${h}">${text}</a>`;
      })
      .trim();

  return paras
    .map((p) => (p === "\u0000EMPTY\u0000" ? "<p>&nbsp;</p>" : `<p>${inline(p)}</p>`))
    .join("\n");
}

/**
 * HTML → 純文字（bodyText）。
 *
 * 規則必須與 tools/model.mjs 抽取階段一致：
 *   - </p><p> 之間 → 兩個換行（段落）
 *   - <br> → 一個換行
 *   - 標籤去掉、實體還原
 *   - 收斂多餘空白
 */
function htmlToText(html) {
  if (!html) return "";
  let s = html;
  s = s.replace(/<\/p>\s*<p>/g, "\n\n");
  s = s.replace(/<\/?p>/g, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  // ⚠️ 實體一律保持原樣（&nbsp; &lt; &gt; &amp; 都不還原）。
  // 抽取階段的 bodyText 保留的就是字面的轉義字串（見基準快照），
  // 還原成字元不但逐位元組比對不會過，也失去「原文可追溯」的意義。
  // 註：&lt;藝術概論&gt; 在原站是書名號的字面寫法，不是標籤。
  // ⚠️ 不要壓縮空白。
  // 原文有用全角空格（U+3000）對齊署名與職稱的排版（例如
  // 「中華藝術文化學院院長　　　　」後面那幾個全形空白），
  // 那是內容的一部分，壓掉就與原文不符。
  // 這裡只去掉行尾的「半形」空白，全形空格保留。
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.replace(/^[ \t\r\n]+/, "").replace(/[ \t\r\n]+$/, "");
}

/**
 * publishedAt →「2026年7月17日」
 *
 * 這是抽取階段從原站頁面抓下來的顯示文字（不補零、帶「年/月/日」）。
 * 由 ISO 時間推導回來，不寫進 MD —— 它是純推導欄位。
 */
function formatDateText(iso) {
  const s = asStr(iso);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

/* ══════════════════════════════════════════════════ 未支援語法檢查 */

const UNSUPPORTED = [
  [/^\s{0,3}#{1,6}\s/m, "標題（#）"],
  [/^\s{0,3}[-*+]\s+\S/m, "無序清單（- * +）"],
  [/^\s{0,3}\d+\.\s+\S/m, "有序清單（1.）"],
  [/^\s{0,3}>\s/m, "引用（>）"],
  [/\*\*[^*]+\*\*/, "粗體（**）"],
  [/(?<![*\w])\*[^*\n]+\*(?!\w)/, "斜體（*）"],
  [/`[^`\n]+`/, "行內程式碼（`）"],
  [/^\s{0,3}\|.*\|/m, "表格（|）"],
  [/^\s{0,3}```/m, "程式碼區塊（```）"],
];

function checkUnsupported(r) {
  if (!r.body) return;
  for (const [re, name] of UNSUPPORTED) {
    if (re.test(r.body)) {
      warn(r.rel, `內文出現未支援的 Markdown 語法：${name} —— 會被當成純文字輸出`);
    }
  }
}

/**
 * 作品/照片的 eventDate 還原。
 *
 * 形狀有兩種（原站如此）：
 *   作品 artwork → { year }                        只有年份
 *   照片 photo   → { year, month, day, iso }       依 MD 寫的精度決定 month/day 是否有值
 *
 * 照片的日期精度有三級：只有年、年月、年月日。
 */
function parseItemDate(v, kind) {
  if (v == null || v === "") return null;
  const s = asStr(v);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const ym = /^(\d{4})-(\d{2})$/.exec(s);
  const y4 = /^(\d{4})$/.exec(s);

  if (kind !== "photo") {
    // 作品只有年份
    const y = ymd?.[1] ?? ym?.[1] ?? y4?.[1];
    return y ? { year: Number(y) } : null;
  }

  if (ymd) return { year: +ymd[1], month: +ymd[2], day: +ymd[3], iso: s };
  if (ym) return { year: +ym[1], month: +ym[2], day: null, iso: s };
  if (y4) return { year: +y4[1], month: null, day: null, iso: s };
  return null;
}

/* ══════════════════════════════════════════════════ 讀取全部 MD */

const siteMd = readMd(path.join(MD, "site.md"));
const articleMds = walk(path.join(MD, "articles")).map(readMd);
const itemMds = walk(path.join(MD, "collections")).map(readMd);
const longMds = walk(path.join(MD, "longform")).map(readMd);

if (CHECK) {
  const need = (r, keys) => {
    for (const k of keys) {
      if (r.data[k] === undefined || r.data[k] === null || r.data[k] === "") {
        fail(r.rel, `frontmatter 缺少必要欄位：${k}`);
      }
    }
  };
  need(siteMd, ["name", "lang"]);
  for (const r of articleMds) need(r, ["title", "category"]);
  for (const r of itemMds) need(r, ["code", "album", "kind", "image", "caption"]);
  for (const r of longMds) need(r, ["title", "route"]);

  for (const r of [...articleMds, ...itemMds, ...longMds]) checkUnsupported(r);

  if (problems.length) {
    console.error(`\nMD 檢查失敗：${problems.length} 個問題\n`);
    for (const p of problems) console.error(`  ✗ ${p.where}\n      ${p.msg}`);
    process.exit(1);
  }
  console.log(`\n✓ MD 檢查通過（${articleMds.length} 篇文章、${itemMds.length} 件作品）`);
  if (warnings.length) {
    console.log(`\n  ${warnings.length} 個提醒：`);
    for (const w of warnings.slice(0, 10)) console.log(`  · ${w.where}\n      ${w.msg}`);
    if (warnings.length > 10) console.log(`  …還有 ${warnings.length - 10} 個`);
  }
  process.exit(0);
}

/* ══════════════════════════════════════════════════ 分類表（與 model.mjs 一致） */

const CATEGORIES = [
  { id: "memorial", name: "紀念展", en: "Memorial Exhibitions", route: "/news/memorial-exhibition", order: 1 },
  { id: "exhibition", name: "展覽新聞", en: "Exhibition News", route: "/news/exhibition-news", order: 2 },
  { id: "auction", name: "拍賣新聞", en: "Auction Records", route: "/news/auction-news", order: 3 },
  { id: "media", name: "媒體報導", en: "Press Coverage", route: "/news/media-coverage", order: 4 },
  { id: "official", name: "官方報導", en: "Official Records", route: "/news/official-reports", order: 5 },
  { id: "reviews", name: "藝術評論", en: "Art Criticism", route: "/art-reviews", order: 6 },
  { id: "artist", name: "關於藝術家", en: "About the Artist", route: "/about", order: 7 },
];
const CAT_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

/* 專輯後設資料（與 model.mjs 的 ALBUM_META 一致；title/en/blurb 是人寫的文案） */
const ALBUM_META = {
  landscape: {
    title: "山水",
    en: "Landscape",
    route: "/collection/landscape",
    blurb: "山川煙雲、江河飛瀑。黃磊生以嶺南筆法行走大江南北，寫生後再以渲染與留白重構空間。",
    sourceRoute: "/landscape/landscape",
    albumId: "6",
    kind: "artwork",
  },
  "flowers-birds": {
    title: "花鳥蟲魚",
    en: "Flowers, Birds, Insects & Fish",
    route: "/collection/flowers-birds",
    blurb: "嶺南畫派以花鳥見長。撞粉、撞水、撞色的技法在此展現，色彩在層層渲染中見絢麗。",
    sourceRoute: "/flowers-birds-insects-fish/flowers-birds-insects-fish",
    albumId: "7",
    kind: "artwork",
  },
  calligraphy: {
    title: "書法",
    en: "Calligraphy",
    route: "/collection/calligraphy",
    blurb: "書畫同源。線條的輕重提頓，是黃磊生六十年筆墨功力的另一面。",
    sourceRoute: "/calligraphy/calligraphy",
    albumId: "8",
    kind: "artwork",
  },
  "exhibition-exchange": {
    title: "展覽交流",
    en: "Exhibition Exchange",
    route: "/life/exhibition-exchange",
    blurb: "自 1956 年香港聖約翰藝術廳首次個展起，黃磊生在海內外美術館、大學與畫廊的展覽現場。",
    sourceRoute: "/landscape/exhibition-exchange",
    albumId: "9",
    kind: "photo",
  },
  "life-footprint": {
    title: "生活足跡",
    en: "Life Footprints",
    route: "/life/life-footprint",
    blurb: "寫生途中、畫室日常、婚宴與家居。照片裡的黃磊生，與畫冊上的名字互為註腳。",
    sourceRoute: "/landscape/life-footprint",
    albumId: "10",
    kind: "photo",
  },
  "art-exchange": {
    title: "藝術交流",
    en: "Artistic Exchange",
    route: "/life/art-exchange",
    blurb: "與趙少昂、張大千、關山月等人的往來，是嶺南畫派傳承的一手現場。",
    sourceRoute: "/landscape/art-exchange",
    albumId: "11",
    kind: "photo",
  },
};

/* ══════════════════════════════════════════════════ 組裝 model */

const model = {};
/**
 * 建置時間戳。
 *
 * 原本是 `new Date().toISOString()`，問題是每次編譯都不同 ——
 * 內容一個字沒改，`git status` 也是髒的，`git diff` 只有這一行。
 * 久了大家就習慣忽略這個 diff，真正的內容變動反而看不到。
 *
 * 改成由 MD 內容雜湊推導：內容不變 → 時間戳不變 → 產物可重現。
 * 需要「這份是什麼時候編的」時看 `meta.sourceHash` 對應的 commit 時間即可。
 */
const sourceHash = (() => {
  const h = createHash("sha256");
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) {
        h.update(path.relative(MD, p).split(path.sep).join("/"));
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(MD);
  return h.digest("hex");
})();

// 取 MD 檔案的修改時間當「內容時間」。
// 不用 new Date() 的原因見上面：那會讓「內容沒改」也產生 diff。
// 用檔案 mtime 的話，真的改了內容才會變。
const contentTime = (() => {
  let latest = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) latest = Math.max(latest, fs.statSync(p).mtimeMs);
    }
  };
  walk(MD);
  return latest ? new Date(latest).toISOString() : new Date(0).toISOString();
})();

model.meta = {
  // 內容時間（MD 檔案的最近修改時間），不是編譯時間
  contentUpdatedAt: contentTime,
  // 內容雜湊：同樣的 MD 一定得到同樣的值
  sourceHash: sourceHash.slice(0, 16),
  source: "https://luisang.rumotan.com",
  sourceCms: "Joomla! 4/5 + Helix Ultimate + SP Page Builder + SP Easy Image Gallery",
  note:
    "本檔由 tools/md-to-model.mjs 從 content/md/ 的 Markdown 編譯產生。" +
    "MD 是唯一真實來源；要改內容請改 content/md/，不要改這個檔。",
  sourceAliases: {
    note:
      "原站同一本相簿有多個入口路徑（不同選單深度指到同一頁）。這些路徑不是獨立頁面，" +
      "內容與 canonical 路徑完全相同，因此只保留一份 raw/，但轉址規則全部覆蓋。",
    artLifeAliases: [
      { alias: "/index.php/art-life", canonical: "/life", kind: "區塊首頁" },
      { alias: "/index.php/art-life/exhibition-exchange", canonical: "/life/exhibition-exchange", albumId: 9 },
      { alias: "/index.php/art-life/life-footprint", canonical: "/life/life-footprint", albumId: 10 },
      { alias: "/index.php/art-life/art-exchange", canonical: "/life/art-exchange", albumId: 11 },
    ],
    verified:
      "2026-10-28 以 BFS 從首頁列舉全站（tools/verify-source.mjs），59 條可達路徑逐一比對確認內容相同",
  },
};

// site
model.site = {
  name: siteMd.data.name,
  nameEn: siteMd.data.nameEn ?? null,
  tagline: siteMd.data.tagline ?? null,
  description: siteMd.data.description ?? null,
  lang: siteMd.data.lang,
  footerText: siteMd.data.footerText ?? null,
};

// menu / contact / hero / homeBlocks 從 site.md 的 frontmatter 取
// 選單：遞迴整理，確保 children 一定是陣列（Astro 端會直接 map）
// 原站的選單結構有個不對稱：有子選單的節點一定帶 children（可能是空陣列），
// 但**葉節點完全沒有 children 這個鍵**。照原樣重建，否則逐位元組比對不會過。
const normMenu = (items, isRoot = true) =>
  (items ?? []).map((it) => {
    const o = { title: it.title, href: it.href };
    const hasKids = it.children?.length > 0;
    // 根層級的節點一律帶 children（即使空的）；子層級只有真的有小孩才帶
    if (isRoot || hasKids) {
      o.children = hasKids ? normMenu(it.children, false) : [];
    }
    return o;
  });
model.menu = normMenu(siteMd.data.menu);

// 聯絡方式：phones/emails/im 是 {label, value, tel?} 的陣列
const normKv = (arr) =>
  (arr ?? []).map((x) => {
    const o = { label: x.label, value: x.value };
    if (x.tel !== undefined) o.tel = x.tel;
    return o;
  });
const c = siteMd.data.contact ?? {};
model.contact = {
  phones: normKv(c.phones),
  emails: normKv(c.emails),
  im: normKv(c.im),
  website: c.website ?? null,
  hours: c.hours ?? null,
  address: c.address ?? null,
};

// Hero：{ title, image, cta?, ctaHref? }
model.hero = (siteMd.data.hero ?? []).map((h) => {
  const o = { title: h.title, cta: h.cta ?? null, ctaHref: h.ctaHref ?? null, image: h.image };
  return o;
});
/**
 * 首頁區塊（原站 SP Page Builder 結構）。
 *
 * 這裡原本有一段「MD 沒帶就沿用舊 model.json」的 fallback，動機是怕首頁空白。
 * 但那等于承認 MD 不是唯一真實來源 —— 而且 fallback 會讓「MD 少了東西」
 * 變成一個永遠不會亮的警告，久了就沒人看。
 *
 * 現在 homeBlocks 直接寫在 site.md 的 frontmatter 裡（7 KB），
 * 沒有就真的是沒有，交給驗證去抓。
 */
model.homeBlocks = normalizeHomeBlocks(siteMd.data.homeBlocks);

/** 首頁區塊：把 YAML 讀進來的結構整理成與原站一致的形狀 */
function normalizeHomeBlocks(blocks) {
  return (blocks ?? []).map((b) => ({
    id: b.id,
    addons: (b.addons ?? []).map((a) => ({
      type: a.type,
      title: a.title ?? "",
      content: a.content ?? "",
      image: a.image ?? null,
      cta: a.cta ?? null,
    })),
  }));
}

model.categories = CATEGORIES;

/* ── 文章 ── */
const articles = [];
const artistArticles = [];

for (const r of articleMds) {
  const id = r.rel.replace(/^articles\//, "").replace(/\.md$/, "");
  const cat = CAT_BY_ID[r.data.category];
  if (!cat) {
    fail(r.rel, `未知的 category：${r.data.category}（可用：${Object.keys(CAT_BY_ID).join(", ")}）`);
    continue;
  }
  checkUnsupported(r);

  // 路由 = "/" + id。
  // id 本身就是完整路徑（news/auction-news/xxx、art-reviews/xxx、artist-luisang/xxx），
  // 所以不需要再從 category 拼 —— 拼了反而會錯：
  // category «artist» 的 categoryRoute 是 /about（那是列表頁），
  // 但文章的實際路由在 /artist-luisang/ 底下。
  const route = `/${id}`;

  // 少數文章原文不是段落結構（見 md-from-model.mjs 的說明），
  // 這種情況直接用保存下來的原始 HTML，不要經過 Markdown 轉換。
  const bodyHtml = r.data.bodyHtmlRaw ? String(r.data.bodyHtmlRaw).trim() : mdToHtml(r.body);
  const bodyText = htmlToText(bodyHtml);

  // 事件日期：MD 可能寫 2008-09-22 或 2011
  let eventDate = null;
  const ed = r.data.eventDate;
  if (ed != null && ed !== "") {
    const s = String(ed);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    const ym = /^(\d{4})-(\d{2})$/.exec(s);
    const y = /^(\d{4})$/.exec(s);
    if (m) {
      eventDate = { year: +m[1], month: +m[2], day: +m[3], iso: s };
    } else if (ym) {
      eventDate = { year: +ym[1], month: +ym[2], day: null, iso: s };
    } else if (y) {
      eventDate = { year: +y[1], month: null, day: null, iso: s };
    } else {
      fail(r.rel, `eventDate 格式無法辨識：${s}（可用 2008-09-22 / 2008-09 / 2008）`);
    }
  }

  const isStub = Boolean(r.data.isStub) || bodyText.length === 0 && !r.body;

  const entry = {
    id,
    route,
    legacyRoute: `/index.php${route}`,
    title: r.data.title,
    category: cat.id,
    categoryName: cat.name,
    categoryRoute: cat.route,
    publishedAt: r.data.publishedAt ? asStr(r.data.publishedAt) : null,
    publishedAtText: formatDateText(r.data.publishedAt),
    eventDate,
    author: r.data.author ?? "admin",
    hits: r.data.hits ?? null,
    hero: r.data.hero ?? null,
    images: r.data.hero ? [{ src: r.data.hero, role: "hero" }] : [],
    bodyHtml,
    bodyText,
    charCount: bodyText.replace(/\s/g, "").length,
    isStub,
    isArtistArticle: id.startsWith("artist-luisang/"),
    // 暫存排序用，輸出前會拿掉
    _order: Number(r.data.order) || 0,
  };

  if (entry.isArtistArticle) artistArticles.push(entry);
  else articles.push(entry);
}

/* ── 作品 ── */
const galleries = [];
for (const [slug, meta] of Object.entries(ALBUM_META)) {
  const files = itemMds.filter((r) => r.data.album === slug);
  if (!files.length) continue;

  const items = files
    .map((r) => {
      // 用與爬蟲路線完全相同的推導函式重建所有欄位 ——
      // MD 只存「人會改的東西」，其餘在這裡算出來。
      const d = parseArtworkTitle(r.data.caption, meta.albumId);
      // MD 裡的覆寫值優先（人改了就以人為準）
      const name = r.data.name !== undefined && r.data.name !== null && r.data.name !== "" ? r.data.name : d.name;
      const dimRaw =
        r.data.dimensions !== undefined && r.data.dimensions !== null && r.data.dimensions !== ""
          ? r.data.dimensions
          : d.dimRaw;

      // 若人改了 dimensions，用同一套正規表達式重算寬高
      let width = d.width,
        height = d.height,
        dimUnit = d.dimUnit;
      if (dimRaw !== d.dimRaw && dimRaw) {
        const mm = /(\d+(?:\.\d+)?)\s*[x×X]\s*(\d+(?:\.\d+)?)\s*(cm|公分|m)?/i.exec(dimRaw);
        if (mm) {
          width = Number(mm[1]);
          height = Number(mm[2]);
          dimUnit = (mm[3] || "cm").toLowerCase();
        } else {
          fail(r.rel, `dimensions 格式無法解析：${dimRaw}（應像 62x128cm）`);
        }
      }

      const src = r.data.image;
      return {
        code: r.data.code,
        series: d.series,
        kind: r.data.kind,
        caption: r.data.caption,
        name,
        titleEn: r.data.titleEn ?? d.titleEn,
        medium: r.data.medium ?? d.medium,
        note: r.data.note ?? d.note,
        width,
        height,
        dimUnit,
        dimRaw,
        year: r.data.year ?? d.year,
        yearGanzhi: r.data.yearGanzhi ?? d.yearGanzhi,
        album: slug,
        src,
        thumb: src.replace(/\.jpg$/, "_thumb.jpg"),
        desc: r.body || "",
        order: Number(r.data.order) || 0,
        // eventDate 的形狀有兩種（原站就是這樣，不是我們的選擇）：
        //   作品（artwork）→ { year }           只有年份
        //   照片（photo）  → { year, month, day, iso }  完整物件
        // 照原樣重建，否則逐位元組比對不會過。
        eventDate: parseItemDate(r.data.eventDate, r.data.kind),
        id: r.data.code,
      };
    })
    // 依 MD 裡記錄的 order 排（那是原站相簿的排列，不是編號順序）。
    // 萬一有人漏寫 order，用 code 當備援，避免整個相簿亂掉。
    .sort((a, b) => (a.order || 999) - (b.order || 999) || a.code.localeCompare(b.code, "en"))
    .map((it, i) => ({ ...it, order: i + 1 }));

  const artworks = items.filter((i) => i.kind !== "photo");
  const photos = items.filter((i) => i.kind === "photo");
  const years = items.map((i) => i.year).filter(Boolean);

  galleries.push({
    slug,
    albumId: meta.albumId,
    title: meta.title,
    en: meta.en,
    route: meta.route,
    blurb: meta.blurb,
    sourceRoute: meta.sourceRoute,
    count: items.length,
    // counts 只有這兩項；withDimensions / withYear 是頂層欄位（照原結構）
    counts: {
      artwork: artworks.length,
      photo: photos.length,
    },
    withDimensions: artworks.filter((a) => a.width).length,
    withYear: items.filter((a) => a.year).length,
    yearRange: years.length ? [Math.min(...years), Math.max(...years)] : null,
    items,
  });
}

/* ── 長文 ── */
const bioMd = longMds.find((r) => r.rel === "longform/biography.md");
const pvMd = longMds.find((r) => r.rel === "longform/painting-view.md");

if (bioMd) {
  const bodyHtml = mdToHtml(bioMd.body);
  model.biography = {
    route: bioMd.data.route ?? "/about",
    title: bioMd.data.title,
    bodyHtml,
    bodyText: htmlToText(bodyHtml),
  };
}
if (pvMd) {
  const bodyHtml = mdToHtml(pvMd.body);
  model.paintingView = {
    route: pvMd.data.route ?? "/about/painting-view",
    legacyRoute: pvMd.data.legacyRoute ?? "/index.php/about/painting-view",
    title: pvMd.data.title,
    bodyHtml,
    bodyText: htmlToText(bodyHtml),
    charCount: htmlToText(bodyHtml).replace(/\s/g, "").length,
  };
}

/* ── 依日期排序，並補 prev/next ── */
// 排序用 MD 裡記錄的 order（原站列表順序），而不是日期。
// 日期序會把同日多篇的相對次序打亂，而首頁與新聞列表看的就是這個順序。
const byOrder = (a, b) => (a._order || 999) - (b._order || 999);
articles.sort(byOrder);
artistArticles.sort(byOrder);

/**
 * prev / next 是「同一分類內」的上一篇／下一篇，不是全站陣列的前後項。
 *
 * 這是從原站行為反推出來的（原站 Joomla 分類頁有上一筆／下一筆）：
 *   - 同一個 categoryRoute 內依 order 串成一條鏈
 *   - 鏈頭 prev = null、鏈尾 next = null
 *   - 「關於藝術家」三篇自成一群（categoryRoute 都是 /artist-luisang）
 *
 * 一開始我以為是全站陣列的前後項，但 index 2 的 next 實際指向 index 7
 * （兩者同為拍賣新聞）—— 才發現是分類內的鏈。
 */
function linkSiblings(list) {
  const byCat = new Map();
  for (const a of list) {
    const key = a.categoryRoute || a.route;
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(a);
  }
  for (const group of byCat.values()) {
    group.sort(byOrder);
    for (let i = 0; i < group.length; i++) {
      const prev = group[i - 1];
      const next = group[i + 1];
      group[i].prev = prev ? { route: prev.route, title: prev.title } : null;
      group[i].next = next ? { route: next.route, title: next.title } : null;
    }
  }
}

linkSiblings(articles);
linkSiblings(artistArticles);

// 移除排序用的暫存欄位（不該出現在產物裡）
for (const list of [articles, artistArticles]) {
  for (const a of list) delete a._order;
}

model.articles = articles;
model.artistArticles = artistArticles;
model.galleries = galleries;

/* timeline / timelineSource：MD 不含這些（人不太改），沿用既有 model.json */
if (fs.existsSync(MODEL)) {
  try {
    const prev = JSON.parse(fs.readFileSync(MODEL, "utf8"));
    if (prev.timeline) model.timeline = prev.timeline;
    if (prev.timelineSource) model.timelineSource = prev.timelineSource;
  } catch {}
}

/* ══════════════════════════════════════════════════ 輸出 */

// 欄位順序固定，讓 diff 好看
const ORDER = [
  "meta", "site", "menu", "contact", "categories", "hero", "homeBlocks",
  "timeline", "timelineSource", "paintingView", "biography",
  "galleries", "articles", "artistArticles",
];
const ordered = {};
for (const k of ORDER) if (model[k] !== undefined) ordered[k] = model[k];

const json = JSON.stringify(ordered, null, 2) + "\n";

if (problems.length) {
  console.error(`\nMD → model 失敗：${problems.length} 個問題\n`);
  for (const p of problems) console.error(`  ✗ ${p.where}\n      ${p.msg}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(SITE_COPY), { recursive: true });
fs.writeFileSync(MODEL, json, "utf8");
fs.writeFileSync(SITE_COPY, json, "utf8");

console.log(`\nMD → model`);
console.log(`  文章 ${articles.length} + 藝術家 ${artistArticles.length}、作品 ${galleries.reduce((n, g) => n + g.items.length, 0)} 件`);
console.log(`  寫入 content/model.json 與 site/src/data/model.json`);

if (warnings.length) {
  console.log(`\n  ${warnings.length} 個提醒：`);
  for (const w of warnings.slice(0, 8)) console.log(`  · ${w.where}：${w.msg}`);
}

/* ── --verify：與基準快照比對 ── */
if (VERIFY) {
  const baseline = path.join(ROOT, ".cache", "baseline", "model.json");
  if (!fs.existsSync(baseline)) {
    console.error(`\n找不到基準快照 ${baseline}，無法比對。`);
    process.exit(1);
  }
  const strip = (s) => {
    const o = JSON.parse(s);
    delete o.meta;
    return JSON.stringify(o);
  };
  const a = strip(fs.readFileSync(baseline, "utf8"));
  const b = strip(json);

  if (a === b) {
    console.log(`\n  ✓ 與基準快照逐位元組相同\n`);
  } else {
    console.log(`\n  ✗ 與基準快照不同`);
    console.log(`    基準 ${a.length} 字元、現在 ${b.length} 字元`);
    // 找出第一個差異的上下文
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.log(`\n    首個差異在第 ${i} 個字元：`);
        console.log(`    基準 …${JSON.stringify(a.slice(Math.max(0, i - 70), i + 70))}`);
        console.log(`    現在 …${JSON.stringify(b.slice(Math.max(0, i - 70), i + 70))}`);
        break;
      }
    }
    process.exit(1);
  }
}
