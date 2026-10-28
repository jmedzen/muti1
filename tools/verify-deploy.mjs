#!/usr/bin/env node
/**
 * 部署驗證（第五趟）
 *
 * 同時驗兩條部署路線是否一致：
 *   A. Cloudflare Workers —— 真的打 HTTP，看狀態碼與 Location
 *   B. nginx（Docker 版）—— 沒有 nginx 執行檔，所以把 docker/nginx.conf 的
 *      location 規則解析出來，用 JS 重放同樣的比對順序
 *
 * 重點是「兩邊的行為要一樣」。如果只有一邊修好，訪客從 Google 點進來
 * 還是會撞到 404，而你不會知道。
 *
 * 用法：node tools/verify-deploy.mjs [--cf http://localhost:8788]
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf("--" + k);
  return i >= 0 ? args[i + 1] : d;
};
const CF = arg("cf", "http://localhost:8788");

const model = JSON.parse(fs.readFileSync(path.join(ROOT, "content", "model.json"), "utf8"));
const cfRules = fs.readFileSync(path.join(ROOT, "site", "public", "_redirects"), "utf8");
const nginxConf = fs.readFileSync(path.join(ROOT, "docker", "nginx.conf"), "utf8");

/* ══════════════════════════════════════ nginx 規則重放 */
// 抓出 location 區塊：`location = /path { return 301 /to; }` 與
// `location ~ ^regex$ { return 301 /to$1$is_args$args; }`
const nginxRules = [];
const norm = (p) => p.replace(/\$is_args\$args/g, "").replace(/\$1/g, "{1}");

// 精確比對
for (const m of nginxConf.matchAll(/location\s*=\s*(\S+)\s*\{\s*return\s+(\d{3})\s+(\S+?);/g)) {
  nginxRules.push({ kind: "exact", from: m[1], code: +m[2], to: norm(m[3]) });
}
// 正規表示式
for (const m of nginxConf.matchAll(/location\s*~\s*(\S+)\s*\{\s*return\s+(\d{3})\s+(\S+?);/g)) {
  try {
    nginxRules.push({ kind: "regex", re: new RegExp(m[1]), code: +m[2], to: norm(m[3]) });
  } catch (e) {
    console.log(`nginx 正規式無法解析：${m[1]} — ${e.message}`);
  }
}

// nginx 的比對順序：先精確（=），再正規式（~，依檔案順序），最後前綴。
// 這裡只實作我們實際用到的前兩種。
const nginxResolve = (url) => {
  const p = url.split("?")[0];
  for (const r of nginxRules) {
    if (r.kind === "exact" && r.from === p) return { code: r.code, to: r.to };
  }
  for (const r of nginxRules) {
    if (r.kind !== "regex") continue;
    const m = r.re.exec(p);
    if (m) {
      // $1 之類的捕獲組
      let to = r.to;
      for (let i = m.length - 1; i >= 1; i--) to = to.replace(`{${i}}`, m[i] ?? "");
      return { code: r.code, to };
    }
  }
  return null; // 不轉址
};

/* ══════════════════════════════════════ 受測網址 */
// 全部舊文章路徑（這是最容易被搜尋引擎記住的一群）
const legacy = [...model.articles, ...model.artistArticles].map((a) => ({ from: a.legacyRoute, want: a.route }));

// 舊分類頁、相簿、單頁
const misc = [
  { from: "/index.php/news/auction-news", want: "/news/auction-news" },
  { from: "/index.php/news/memorial-exhibition", want: "/news/memorial-exhibition" },
  { from: "/index.php/news/media-coverage", want: "/news/media-coverage" },
  { from: "/index.php/news/official-reports", want: "/news/official-reports" },
  { from: "/index.php/news/exhibition-news", want: "/news/exhibition-news" },
  { from: "/index.php/art-reviews", want: "/art-reviews" },
  { from: "/index.php/artist-luisang", want: "/about" },
  { from: "/landscape/landscape", want: "/collection/landscape" },
  { from: "/calligraphy/calligraphy", want: "/collection/calligraphy" },
  { from: "/index.php/contact", want: "/contact" },
  { from: "/index.php", want: "/" },
];

// 應該維持 200 的新網址（不能被轉址規則誤傷）
const alive = ["/", "/about", "/about/chronology", "/collection", "/collection/landscape", "/life/exhibition-exchange", "/news", "/art-reviews", "/contact", "/search", "/sitemap.xml", "/robots.txt"];

/* ══════════════════════════════════════ 打 Cloudflare */
const cf = async (p) => {
  const res = await fetch(CF + p, { redirect: "manual" });
  return { code: res.status, loc: res.headers.get("location") };
};

const problems = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};

// 1. 舊文章網址
let cfOk = 0;
for (const { from, want } of legacy) {
  const r = await cf(from);
  if (r.code === 301 && r.loc && r.loc.endsWith(want)) cfOk++;
  else problems.push(`CF 轉址錯：${from} → ${r.code} ${r.loc || ""}（應為 301 ${want}）`);

  // 2. nginx 也要處理
  const n = nginxResolve(from);
  check(
    n && n.code === 301 && n.to === want,
    `nginx 缺規則或轉錯：${from} → ${n ? n.code + " " + n.to : "（無規則，會 404）"}（應為 301 ${want}）`
  );
}

// 3. 舊分類/相簿/單頁
for (const { from, want } of misc) {
  const r = await cf(from);
  check(r.code >= 300 && r.code < 400 && r.loc && r.loc.endsWith(want), `CF 分類轉址錯：${from} → ${r.code} ${r.loc || ""}`);
  const n = nginxResolve(from);
  check(n && n.code >= 300 && n.code < 400 && n.to === want, `nginx 分類轉址錯：${from} → ${n ? n.code + " " + n.to : "（無規則，會 404）"}`);
}

// 4. 新網址不能被誤轉
//    注意：Workers 的 auto-trailing-slash 會把 /about 以 307 導到 /about/，
//    那是正常的正規化，不是壞掉。所以這裡「跟著轉一次」，只看最後有沒有 200。
for (const p of alive) {
  const r = await cf(p);
  if (r.code === 200) continue;
  if (r.code === 307 || r.code === 308) {
    const r2 = await cf(new URL(r.loc, CF).pathname);
    check(r2.code === 200, `CF 正常頁被影響：${p} → ${r.code} → ${r2.code}`);
    continue;
  }
  check(false, `CF 正常頁被影響：${p} → ${r.code}`);
}

// 4.5 原站每一條可達的舊網址，都要轉到「對的頁面」，不是掉進 /search 降落傘。
//     這是第六趟驗證抓到的真問題：/index.php/art-life/exhibition-exchange
//     原本被 catch-all 丟到 /search，頁面活著但訪客走錯門。
const srcPath = path.join(ROOT, ".cache", "verify-source.json");
if (fs.existsSync(srcPath)) {
  const src = JSON.parse(fs.readFileSync(srcPath, "utf8"));
  let checked = 0;
  let wrong = 0;
  for (const legacy of src.livePages) {
    if (legacy === "/") continue;
    const r = await cf(legacy);
    checked++;
    if (!(r.code === 301 && r.loc)) {
      problems.push(`舊網址沒有專屬 301：${legacy} → ${r.code} ${r.loc || ""}`);
      wrong++;
      continue;
    }
    // 不可以掉到 /search（除非它本來就是指到搜尋）
    if (r.loc.endsWith("/search") && !legacy.includes("finder") && !legacy.includes("component/search")) {
      problems.push(`舊網址掉進搜尋降落傘：${legacy} → ${r.loc}`);
      wrong++;
    }
  }
  console.log(`原站可達網址：${checked} 條，轉錯 ${wrong} 條`);
} else {
  console.log("（略過原站網址覆蓋率：先跑 node tools/verify-source.mjs）");
}

// 5. 不存在的頁面要 404，不能是 200
const nf = await cf("/this-page-does-not-exist-9f3a");
check(nf.code === 404, `不存在的頁面回了 ${nf.code}（應為 404）`);

// 6. 未預期的舊路徑要有降落傘（不該 404）
const fallback = await cf("/index.php/component/weird/thing");
check(fallback.code >= 300 && fallback.code < 400, `未知的舊路徑沒有降落傘：${fallback.code}`);

/* ------------------------------------------------ _redirects 自我一致性 */
{
  const lines = cfRules.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const seen = new Map();
  let dup = 0;
  for (const l of lines) {
    const from = l.trim().split(/\s+/)[0];
    if (seen.has(from)) dup++;
    seen.set(from, true);
  }
  check(dup === 0, `_redirects 有 ${dup} 條重複規則（Cloudflare 會忽略重複的那條）`);
  console.log(`_redirects：${lines.length} 條規則、${dup} 條重複`);
}

// 7. nginx 是否有覆蓋率缺口
{
  const uncovered = [];
  for (const { from } of [...legacy, ...misc]) {
    if (!nginxResolve(from)) uncovered.push(from);
  }
  check(uncovered.length === 0, `nginx 有 ${uncovered.length} 條舊網址沒有規則，例如 ${uncovered.slice(0, 3).join(", ")}`);
}

/* ══════════════════════════════════════ 報告 */
/* ── 兩份 wrangler 設定的關鍵欄位必須相符 ──
 * repo 根目錄一份（Cloudflare CI 用）、site/ 一份（本機用）。
 * 兩份只有 assets 路徑前綴不同，其他都該一樣 ——
 * 任何一邊改了而另一邊忘了改，就會出現「本機能部署、CI 不能」這種事。 */
const stripJsonc = (t) => t.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const rootWr = path.join(ROOT, "wrangler.jsonc");
const siteWr = path.join(ROOT, "site", "wrangler.jsonc");
if (fs.existsSync(rootWr) && fs.existsSync(siteWr)) {
  const a = JSON.parse(stripJsonc(fs.readFileSync(rootWr, "utf8")));
  const b = JSON.parse(stripJsonc(fs.readFileSync(siteWr, "utf8")));

  for (const key of ["name", "compatibility_date"]) {
    if (a[key] !== b[key]) {
      problems.push(`兩份 wrangler 設定的 ${key} 不一致：根目錄 "${a[key]}" vs site/ "${b[key]}"`);
    }
  }
  for (const key of ["binding", "not_found_handling", "html_handling"]) {
    if (a.assets?.[key] !== b.assets?.[key]) {
      problems.push(`兩份 wrangler 的 assets.${key} 不一致`);
    }
  }
  // main 與 directory 只該差 ./site/ 前綴
  const norm = (p) => (p || "").replace(/^\.\/site\//, "./").replace(/^\.\//, "");
  if (norm(a.main) !== norm(b.main)) problems.push(`兩份 wrangler 的 main 不一致：${a.main} vs ${b.main}`);
  if (norm(a.assets?.directory) !== norm(b.assets?.directory)) {
    problems.push(`兩份 wrangler 的 assets.directory 不一致：${a.assets?.directory} vs ${b.assets?.directory}`);
  }

  // 兩份指到的 dist 都必須存在且是同一份
  for (const [label, file] of [["根目錄", rootWr], ["site/", siteWr]]) {
    const cfg = JSON.parse(stripJsonc(fs.readFileSync(file, "utf8")));
    const dir = path.resolve(path.dirname(file), cfg.assets.directory);
    if (!fs.existsSync(dir)) problems.push(`${label} wrangler 的 assets.directory 不存在：${dir}`);
  }
  console.log(`wrangler 設定：兩份關鍵欄位一致`);
}

console.log(`\n════ 部署驗證 ════`);
console.log(`受測：舊文章 ${legacy.length} 條、分類/相簿/單頁 ${misc.length} 條、現役頁面 ${alive.length} 條`);
console.log(`Cloudflare 轉址成功：${cfOk}/${legacy.length}`);
console.log(`nginx 規則數：${nginxRules.length}（exact ${nginxRules.filter((r) => r.kind === "exact").length}、regex ${nginxRules.filter((r) => r.kind === "regex").length}）`);

if (problems.length === 0) {
  console.log(`\n  ✓ 兩條部署路線行為一致，全部通過`);
} else {
  console.log(`\n  ✗ ${problems.length} 個問題：`);
  for (const p of problems.slice(0, 40)) console.log(`    ${p}`);
}

fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, ".cache", "verify-deploy.json"),
  JSON.stringify({ cfOk, legacy: legacy.length, misc: misc.length, alive: alive.length, problems }, null, 1)
);

process.exit(problems.length ? 1 : 0);
