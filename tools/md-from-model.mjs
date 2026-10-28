#!/usr/bin/env node
/**
 * 遷移工具：content/model.json → content/md/
 *
 * ⚠️ 這是「一次性遷移」用的，不是同步工具。
 *   跑過一次之後，`content/md/` 就是唯一真實來源，
 *   要改內容請直接改 MD，不要改 model.json（它是產物）。
 *
 * 只有在以下情況才該再跑：
 *   - 從 raw/ 重新抽取了內容，想把新內容灌回 MD（配合 --force）
 *   - 想比對「現在的 MD」與「原本抽取到的內容」差在哪（不加 --force 的 dry-run）
 *
 * 它會蓋掉手改，所以預設拒絕覆寫已存在的檔案；要覆寫必須明確 --force。
 *
 * 用法：
 *   node tools/md-from-model.mjs              # 只產生缺少的檔案（安全）
 *   node tools/md-from-model.mjs --dry-run    # 只列出會產生什麼
 *   node tools/md-from-model.mjs --force      # 覆寫既有檔案（會蓋掉手改！）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = path.join(ROOT, "content", "model.json");
const OUT = path.join(ROOT, "content", "md");

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const DRY = args.includes("--dry-run");

const model = JSON.parse(fs.readFileSync(MODEL, "utf8"));

/* ══════════════════════════════════════════════════════ YAML 輸出 */

/**
 * 產生 YAML 純量。
 *
 * 這裡刻意不用套件：我們要的只是「能被人讀、能被 parser 讀回去」，
 * 而 js-yaml 的預設輸出會把中文標題加上引號、把日期轉成 ISO，
 * 對「要手編集」的檔案來說反而難讀。
 *
 * 規則：
 *   - 需要引號時用雙引號（並轉義內部的 " 與 \）
 *   - 日期、純數字、布林都保持原樣（讓 parser 自己判斷型別）
 *   - null 寫成 null（不要寫成空，空值與 null 語意不同）
 */
function yamlScalar(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  // 空字串、或含會破壞 YAML 結構的字元 → 一律用雙引號
  if (s === "") return '""';
  if (/^[\s]|[\s]$/.test(s)) return JSON.stringify(s);
  // 這些開頭會被 YAML 當成結構
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return JSON.stringify(s);
  // 含 : （後接空白）或 # （前有空白）或換行
  if (/:\s|#|\n|\t/.test(s)) return JSON.stringify(s);
  // 長得像數字／布林／null 的中文以外字串，要引號以免型別跑掉
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(s)) return JSON.stringify(s);
  if (/^-?\d+(\.\d+)?$/.test(s)) return JSON.stringify(s);
  return s;
}

function yamlList(items, indent = "  ") {
  return items.map((i) => `${indent}- ${yamlScalar(i)}`).join("\n");
}

/* ══════════════════════════════════════════════════════ 內文：HTML → MD */

/**
 * 把抽取階段得到的 bodyHtml 轉成 Markdown 內文。
 *
 * 關鍵限制（已實測）：
 *   - `<br>` 必須原樣保留成 `<br>`，不能變成換行。
 *     轉成換行的話，Markdown 會把它當成同一段落內的軟換行，
 *     渲染結果是空格 —— 比現在更糟，等於把換行語意丟掉。
 *   - 連續兩個 `<br>` 代表「段內空行」。實測 `<br><br>` 在 MD 裡
 *     會原樣渲染成 `<br><br>`，所以可以直接照抄。
 *   - `<p>` 之間用空行分隔（Markdown 的段落）。
 *   - `<a href="…">text</a>` → `[text](href)`；但若 text 與 href 相同
 *     （原站常見的裸網址自動連結），直接寫網址更自然。
 */
function htmlToMd(html) {
  if (!html) return "";
  let s = html;

  // 段落切分：</p> 後面接 <p> 或字串開頭/結尾
  s = s.replace(/<\/p>\s*(?=<p>)/g, "\n\n");
  s = s.replace(/^<p>/, "").replace(/<\/p>\s*$/, "");
  s = s.replace(/<\/?p>/g, "\n\n");

  // 連結先換成佔位符，等標籤清理完再放回來。
  // 為什麼要這樣做：text 與 href 相同時我們想輸出 `<https://…>`（Markdown 的自動連結），
  // 但下一步「移除所有標籤」會把 `<https://…>` 也當成標籤一起吃掉 ——
  // 結果網址整段消失，而且不會報錯。用佔位符就沒這個問題。
  const links = [];
  s = s.replace(
    /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, text) => {
      const t = text.replace(/<[^>]+>/g, "").trim();
      const h = href.replace(/&amp;/g, "&");
      const md = !t || t === h ? `<${h}>` : `[${t}](${h})`;
      links.push(md);
      return `\u0000LINK${links.length - 1}\u0000`;
    }
  );

  // 剩下的行內標籤：只保留 <br>，其餘去掉（本專案實際只用到 p/br/a，見 files 統計）
  s = s.replace(/<(?!br\s*\/?>)[^>]+>/gi, "");

  // 放回連結
  s = s.replace(/\u0000LINK(\d+)\u0000/g, (_, i) => links[Number(i)]);

  // 實體處理。
  //
  // ⚠️ &lt; / &gt; 刻意「不還原」。
  // 原站的正文用 &lt;藝術概論&gt; 表示書名號（全形尖括號的排版寫法），
  // 這是字面文字、不是標籤。若還原成 <藝術概論>，一來與原文不符，
  // 二來下次再經過 HTML 清理時可能被當成標籤吃掉。
  // &amp; 也不還原，同理：原站已經轉義過的 &amp; 應該保持轉義。
  s = s.replace(/&nbsp;/g, "\u00a0");

  // 轉義會觸發 Markdown 語法的字元。
  //
  // 實際踩到的坑：原文「2008年Vol.7第B3~4頁」裡的 ~ 被 GFM 當成刪除線標記，
  // 渲染後 ~ 消失、變成 <del> —— 資料靜默損壞，而且只在這一篇看得出來。
  // 這裡把 ~ 一律轉義成 \~（Markdown 會渲染成字面的 ~）。
  // 反向編譯時再解回 ~（見 md-to-model.mjs）。
  s = s.replace(/~/g, "\\~");

  // 收斂：段落之間恰好一個空行，行尾空白去掉
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  // 空段落（原站用 <p>&nbsp;</p> 排版）。
  // 上面的處理會把它變成空白行，而 trim() 又會把尾端的空白行去掉 ——
  // 那兩個空 <p> 就消失了。用一個明確的標記「孤立的空白行」表達，
  // 讓 mdToHtml 認得出來要還原成 <p>&nbsp;</p>。
  // 這裡用  （不換行空格）單獨成行，肉眼幾乎看不出來，但語意明確。
  const lines2 = s.split("\n");
  const out = lines2.map((l) => (l.trim() === "" && l !== "" ? "\u00a0" : l));
  s = out.join("\n");
  // 頭尾的真空行去掉，但保留   行
  return s.replace(/^\n+/, "").replace(/\n+$/, "");
}

/* ══════════════════════════════════════════════════════ 寫檔 */

let created = 0;
let skipped = 0;
let overwritten = 0;
const wouldCreate = [];

function write(rel, content) {
  const abs = path.join(OUT, rel);
  const exists = fs.existsSync(abs);

  if (exists && !FORCE) {
    skipped++;
    return;
  }

  if (DRY) {
    wouldCreate.push(rel);
    if (exists) overwritten++;
    else created++;
    return;
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  if (exists) overwritten++;
  else created++;
}

/* ══════════════════════════════════════════════════════ 1. 站台設定 */

/**
 * site.md 的正文寫「首頁區塊」的人話版本；
 * 結構化資料（選單、聯絡方式、hero）放 frontmatter。
 *
 * 這一檔最容易被人手改，所以加了大量註解 ——
 * YAML 註解在解析後會消失，不影響資料。
 */
function buildSiteMd() {
  const m = model;
  const L = [];

  L.push("---");
  L.push("# ═══════════════════════════════════════════════════════════");
  L.push("#  站台設定");
  L.push("#  改這裡會影響全站的頁首、頁尾、選單與聯絡頁。");
  L.push("#  YAML 註解（# 開頭）不會被讀取，是給人看的。");
  L.push("# ═══════════════════════════════════════════════════════════");
  L.push("");
  L.push(`name: ${yamlScalar(m.site.name)}`);
  L.push(`nameEn: ${yamlScalar(m.site.nameEn)}`);
  L.push(`tagline: ${yamlScalar(m.site.tagline)}`);
  L.push(`description: ${yamlScalar(m.site.description)}`);
  L.push(`lang: ${yamlScalar(m.site.lang)}`);
  L.push(`footerText: ${yamlScalar(m.site.footerText)}`);
  L.push("");

  // ── 選單 ──
  // 結構與 model.json 一致：{ title, href, children: [...] }
  L.push("# ── 主選單 ──");
  L.push("# href 可寫成 /news 這種乾淨路徑；轉址會自動處理舊的 /index.php/… 形式。");
  L.push("menu:");
  const menuYaml = (items, indent) => {
    for (const it of items) {
      const pad = " ".repeat(indent);
      L.push(`${pad}- title: ${yamlScalar(it.title)}`);
      L.push(`${pad}  href: ${yamlScalar(it.href)}`);
      if (it.children?.length) {
        L.push(`${pad}  children:`);
        menuYaml(it.children, indent + 4);
      } else {
        L.push(`${pad}  children: []`);
      }
    }
  };
  menuYaml(m.menu, 2);
  L.push("");

  // ── 聯絡方式 ──
  // 結構：phones/emails/im 都是 { label, value, tel? } 的陣列
  const c = m.contact;
  L.push("# ── 聯絡方式 ──");
  L.push("# 這些號碼與信箱是館方公開資訊，改動前請確認。");
  L.push("contact:");
  const kvList = (key, arr) => {
    if (!arr?.length) return;
    L.push(`  ${key}:`);
    for (const x of arr) {
      L.push(`    - label: ${yamlScalar(x.label)}`);
      // 電話號碼一定要引號：+886289935275 不加引號會被 YAML 吃掉 "+"，前導 0 也會消失
      L.push(`      value: ${JSON.stringify(String(x.value))}`);
      if (x.tel) L.push(`      tel: ${JSON.stringify(String(x.tel))}`);
    }
  };
  kvList("phones", c.phones);
  kvList("emails", c.emails);
  kvList("im", c.im);
  L.push(`  website: ${c.website ? yamlScalar(c.website) : "null"}`);
  L.push(`  hours: ${c.hours ? yamlScalar(c.hours) : "null"}`);
  L.push(`  address: ${c.address ? yamlScalar(c.address) : "null"}`);
  L.push("");

  // ── Hero ──
  // 結構：{ title, cta, ctaHref, image }
  L.push("# ── 首頁大圖（輪播）──");
  L.push("hero:");
  for (const h of m.hero) {
    L.push(`  - title: ${yamlScalar(h.title)}`);
    L.push(`    image: ${yamlScalar(h.image)}`);
    if (h.cta) L.push(`    cta: ${yamlScalar(h.cta)}`);
    if (h.ctaHref) L.push(`    ctaHref: ${yamlScalar(h.ctaHref)}`);
  }
  L.push("");

  // ── 首頁區塊（原站 SP Page Builder 的原始結構）──
  //
  // 這 13 個區塊前端目前沒有渲染（首頁是另外設計的版型），
  // 但它是原站首頁的完整紀錄，不該憑空消失。
  // 放進 MD 的理由是：不能讓「MD 是唯一真實來源」出現例外，
  // 否則就會有第二個檔案在某天悄悄變成必要的補充資料。
  if (model.homeBlocks?.length) {
    L.push("# ── 首頁區塊（原站 SP Page Builder 結構，目前未渲染，僅留存紀錄）──");
    L.push("homeBlocks:");
    for (const b of model.homeBlocks) {
      L.push(`  - id: ${JSON.stringify(b.id)}`);
      if (b.addons?.length) {
        L.push("    addons:");
        for (const a of b.addons) {
          L.push(`      - type: ${yamlScalar(a.type)}`);
          if (a.title) L.push(`        title: ${yamlScalar(a.title)}`);
          if (a.content) L.push(`        content: ${yamlScalar(a.content)}`);
          L.push(`        image: ${a.image ? yamlScalar(a.image) : "null"}`);
          L.push(`        cta: ${a.cta ? yamlScalar(a.cta) : "null"}`);
        }
      }
    }
    L.push("");
  }

  L.push("---");
  L.push("");
  L.push("# 首頁區塊");
  L.push("");
  L.push("<!--");
  L.push("  下面是首頁的各個區塊。目前由程式依 homeBlocks 產生版面，");
  L.push("  這一段正文是「人看的摘要」，改了不會影響版面，但方便你確認首頁有什麼。");
  L.push("  真正的區塊順序與內容在 frontmatter 的 homeBlocks（如果需要逐塊調整，見文件）。");
  L.push("-->");
  L.push("");
  for (const b of m.homeBlocks) {
    for (const a of b.addons) {
      const t = a.title || a.content;
      if (t) L.push(`- ${t}`);
    }
  }

  return L.join("\n") + "\n";
}

/* ══════════════════════════════════════════════════════ 2. 文章 */

/**
 * 文章 frontmatter 只放「人會編輯的欄位」。
 * route / legacyRoute / charCount / prev / next / bodyText 都是推導的，不寫進來。
 */
function buildArticleMd(a, order) {
  const L = ["---"];
  // order 是原站列表的排列順序。
  // 它「不是」單純的日期序（同日多篇、以及無 eventDate 的篇章都靠原順序），
  // 所以必須顯式記錄，否則重建後首頁與新聞列表的次序會變。
  L.push(`order: ${order}`);
  L.push(`title: ${yamlScalar(a.title)}`);
  L.push(`category: ${yamlScalar(a.category)}`);
  // publishedAt 同樣要加引號，否則 YAML 會轉成 Date 物件（見上面 eventDate 的說明）
  if (a.publishedAt) L.push(`publishedAt: "${a.publishedAt}"`);

  // 事件日期：有月日就寫完整 ISO（例如 2008-09-22），只有年份就寫年份。
  // 建置時再推導回 {year, month, day, iso} —— 兩者都必須能還原。
  //
  // ⚠️ 日期一定要加引號。不加的話 YAML 會把 2008-09-22 解析成 Date 物件，
  //    於是一路傳下去變成 "Mon Sep 22 2008 08:00:00 GMT+0800"，
  //    時區一變還會差一天。加引號讓它保持字串，所見即所得。
  const d = a.eventDate;
  if (d) {
    const hasMonth = d.month != null;
    L.push(`eventDate: "${hasMonth ? d.iso : d.year}"`);
  }
  if (a.hero) L.push(`hero: ${yamlScalar(a.hero)}`);
  // 原站的點擊數（例如「點擊數: 99」）。它是原文的一部分，逐篇不同，必須保留。
  if (a.hits) L.push(`hits: ${yamlScalar(a.hits)}`);
  if (a.isStub) L.push(`isStub: true`);

  // 少數文章的正文不是段落結構（例如整篇只有一行 issuu 嵌入器連結的 <a>）。
  // 這種情況用 Markdown 段落表達會多包一層 <p>，與原文不符，
  // 所以把原始 HTML 收在 frontmatter 的 bodyHtmlRaw，反向編譯時照原樣還原。
  // ⚠️ 必須寫在 frontmatter 結束的 --- 之前。
  const notParagraphs = a.bodyHtml && !a.bodyHtml.startsWith("<p>");
  if (notParagraphs) {
    L.push("bodyHtmlRaw: |");
    for (const line of a.bodyHtml.split("\n")) L.push(`  ${line}`);
  }

  L.push("---");
  L.push("");

  const body = notParagraphs ? "" : htmlToMd(a.bodyHtml);
  if (body) L.push(body);
  return L.join("\n") + "\n";
}

/* ══════════════════════════════════════════════════════ 3. 作品 */

function buildItemMd(it, album) {
  const L = ["---"];
  L.push(`code: ${yamlScalar(it.code)}`);
  // order 是原站相簿裡的排列順序（大致是新→舊，不是編號順序）。
  // 不寫進 MD 的話，重建時只能按 code 排，整個相簿的次序會變。
  L.push(`order: ${it.order}`);
  L.push(`album: ${yamlScalar(album.slug)}`);
  L.push(`kind: ${yamlScalar(it.kind)}`);
  L.push(`name: ${yamlScalar(it.name)}`);

  // 尺寸刻意寫成「跟原站 caption 一樣的字串」，
  // 建置時用同一套正規表達式拆，保證推導結果不變。
  if (it.dimRaw) L.push(`dimensions: ${yamlScalar(it.dimRaw)}`);
  if (it.year) L.push(`year: ${it.year}`);
  if (it.yearGanzhi) L.push(`yearGanzhi: ${yamlScalar(it.yearGanzhi)}`);

  // 選填欄位：保留 null 讓欄位形狀穩定，但也標示哪些可以留空
  L.push(`titleEn: ${yamlScalar(it.titleEn)}`);
  L.push(`medium: ${yamlScalar(it.medium)}`);
  L.push(`note: ${yamlScalar(it.note)}`);

  // 圖片路徑不可從 code 推導（檔名含 slug 後綴），必須顯式記錄
  L.push(`image: ${yamlScalar(it.src)}`);

  // 原始 caption：這是「原文可追溯」的依據，不建議改
  L.push(`caption: ${yamlScalar(it.caption)}`);

  // 照片的日期精度有三種（只有年 / 年月 / 年月日），要照原樣寫，
  // 否則「1996-11-21」會退化成「1996」，畫面上看不出來但資料已经丢了。
  if (it.eventDate?.year) {
    L.push(`eventDate: "${it.eventDate.iso ?? it.eventDate.year}"`);
  }
  L.push("---");
  L.push("");

  // 說明文字（目前 117 件都是空的）
  if (it.desc) L.push(it.desc);
  return L.join("\n") + "\n";
}

/* ══════════════════════════════════════════════════════ 4. 長文 */

function buildLongformMd(key, page) {
  const L = ["---"];
  L.push(`title: ${yamlScalar(page.title)}`);
  L.push(`route: ${yamlScalar(page.route)}`);
  if (page.legacyRoute) L.push(`legacyRoute: ${yamlScalar(page.legacyRoute)}`);
  L.push("---");
  L.push("");
  const body = htmlToMd(page.bodyHtml);
  if (body) L.push(body);
  return L.join("\n") + "\n";
}

/* ══════════════════════════════════════════════════════ 執行 */

if (!DRY) fs.mkdirSync(OUT, { recursive: true });

// 1. 站台
write("site.md", buildSiteMd());

// 2. 文章
// 兩份清單各自有獨立的 order（文章列表與「關於藝術家」列表是分開的）
model.articles.forEach((a, i) => {
  write(path.join("articles", a.id + ".md"), buildArticleMd(a, i + 1));
});
model.artistArticles.forEach((a, i) => {
  write(path.join("articles", a.id + ".md"), buildArticleMd(a, i + 1));
});

// 3. 作品
for (const g of model.galleries) {
  for (const it of g.items) {
    write(path.join("collections", g.slug, it.code + ".md"), buildItemMd(it, g));
  }
}

// 4. 長文
if (model.biography) {
  write("longform/biography.md", buildLongformMd("biography", model.biography));
}
if (model.paintingView) {
  write("longform/painting-view.md", buildLongformMd("paintingView", model.paintingView));
}

/* ══════════════════════════════════════════════════════ 結果 */

const total = countMd(OUT);
console.log(`\nMD 遷移${DRY ? "（dry-run，未寫檔）" : ""}`);
console.log(`  產生 ${created}　覆寫 ${overwritten}　略過（已存在）${skipped}`);
console.log(`  content/md/ 目前共 ${total} 個 .md\n`);

if (DRY && wouldCreate.length) {
  console.log("會產生：");
  for (const f of wouldCreate.slice(0, 20)) console.log(`  ${f}`);
  if (wouldCreate.length > 20) console.log(`  …還有 ${wouldCreate.length - 20} 個`);
  console.log();
}

if (skipped > 0 && !FORCE) {
  console.log(`  ${skipped} 個既有檔案未動。要覆寫請加 --force（會蓋掉手改）。\n`);
}

function countMd(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += countMd(p);
    else if (e.name.endsWith(".md")) n++;
  }
  return n;
}
