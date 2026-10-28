#!/usr/bin/env node
/**
 * Docker 建置模擬（第五趟驗證的 Docker 部分）
 *
 * 這台機器沒有 docker 指令，所以沒辦法跑真的 `docker build`。
 * 但「Dockerfile 會不會失敗」可以靠**複製它的輸入條件**來逼近：
 *
 *   1. 依照 .dockerignore 算出 docker build context 會包含哪些檔案
 *      → 如果少複製了什麼，這裡就會撞到
 *   2. 把那些檔案複製到一個乾淨的暫存目錄（模擬 COPY site/ ./）
 *   3. 在裡面跑 npm ci + astro build（模擬 RUN 指令）
 *   4. 比對產出的 dist 是否與正式建置一致
 *   5. 檢查 nginx.conf 的括號與 location 是否成對、參照的檔案是否存在
 *
 * 這不能取代真的 docker build，但能擋掉「Dockerfile 少 COPY 一個目錄」
 * 這種最常見的錯。
 *
 * 用法：node tools/verify-docker.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { findNode } from "./node-path.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const problems = [];
const notes = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};

/* ══════════════════════════════════════ 1. 算出 docker build context */
const ignoreLines = fs
  .readFileSync(path.join(ROOT, ".dockerignore"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

// .dockerignore 的 pattern → 正規式（只實作我們實際用到的語法：目錄、glob、*.ext）
const toRe = (pat) => {
  let p = pat.replace(/^\/+/, "").replace(/\/+$/, "");
  const escaped = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  // 「目錄」形式在任何深度都成立
  return new RegExp(`(^|/)${escaped}(/|$)`);
};
const ignoreRes = ignoreLines.map(toRe);

const excluded = (rel) => ignoreRes.some((re) => re.test(rel));

// 走訪整個 repo，標記哪些會被排除
const contextFiles = [];
const skipped = [];
function walk(dir, rel = "") {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    // node_modules 用符號連結，不要跟進去
    if (e.isSymbolicLink()) {
      skipped.push(r);
      continue;
    }
    if (excluded(r)) {
      skipped.push(r);
      continue;
    }
    if (e.isDirectory()) walk(abs, r);
    else contextFiles.push(r);
  }
}
walk(ROOT);

const contextBytes = contextFiles.reduce((s, f) => s + fs.statSync(path.join(ROOT, f)).size, 0);
console.log(`docker build context：${contextFiles.length} 個檔案、${(contextBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`被 .dockerignore 排除：${skipped.length} 個項目`);

/* ══════════════════════════════════════ 2. Dockerfile 需要的東西在不在 */
// Dockerfile 明確 COPY 的路徑
//   COPY site/package.json site/package-lock.json* ./
//   COPY site/ ./
//   COPY docker/nginx.conf /etc/nginx/conf.d/luisang.conf
//   COPY --from=build /app/dist /usr/share/nginx/html
for (const need of ["site/package.json", "site/package-lock.json", "docker/nginx.conf"]) {
  check(!excluded(need), `Dockerfile 需要的 ${need} 被 .dockerignore 排除了`);
  check(fs.existsSync(path.join(ROOT, need)), `Dockerfile 需要的 ${need} 不存在`);
}

// 網站建置的輸入：資料檔與圖片必須進 image
const mustShip = [
  "site/src/data/model.json",
  "site/src/data/images.json",
  "site/public/media",
  "site/src/pages/index.astro",
  "site/astro.config.mjs",
];
for (const m of mustShip) {
  check(!excluded(m), `建置輸入 ${m} 被 .dockerignore 排除了（image 會建不起來或缺圖）`);
  check(fs.existsSync(path.join(ROOT, m)), `建置輸入 ${m} 不存在`);
}

// 圖片目錄至少要進一批檔案
const mediaCount = contextFiles.filter((f) => f.startsWith("site/public/media/")).length;
check(mediaCount > 100, `context 裡的 media 檔只有 ${mediaCount} 個（應該有 400+）`);
notes.push(`media 進 context：${mediaCount} 個檔案`);

// raw/ 與 content/ 不該進 image
check(excluded("raw/pages/index.html"), "raw/ 沒有被排除（會讓 image 多 55 MB）");
check(excluded("content/model.json"), "content/ 沒有被排除");
notes.push("raw/ 與 content/ 已排除（執行期不需要，網站用的是 site/src/data/）");

/* ══════════════════════════════════════ 3. 在乾淨目錄實際建置 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luisang-docker-"));
const stage = path.join(tmp, "site");

console.log(`\n模擬 COPY site/ → ${stage}`);
fs.mkdirSync(stage, { recursive: true });
for (const f of contextFiles.filter((x) => x.startsWith("site/"))) {
  const dest = path.join(tmp, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f), dest);
}

// 容器裡 npm ci 會產生 node_modules；這裡用符號連結代替（內容相同）。
// 不這樣做的話 astro.config.mjs 的 `import "astro/config"` 找不到套件，
// 失敗的是「模擬」而不是 Dockerfile。
fs.symlinkSync(path.join(ROOT, "site", "node_modules"), path.join(stage, "node_modules"), "dir");

let buildOk = false;
let buildOut = "";
try {
  // 模擬 RUN npx astro build（node_modules 借用專案裡的，容器裡會是 npm ci 裝的）
  buildOut = execFileSync(
    findNode(),
    [path.join(ROOT, "site", "node_modules", "astro", "bin", "astro.mjs"), "build"],
    {
      cwd: stage,
      encoding: "utf8",
      env: {
        ...process.env,
        ASTRO_TELEMETRY_DISABLED: "1",
        NODE_ENV: "production",
        CI: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300000,
    }
  );
  buildOk = true;
} catch (e) {
  buildOut = (e.stdout || "") + (e.stderr || "");
}

const distDir = path.join(stage, "dist");
// 頁數 = 所有 .html 檔（含 404.html；它不在 index.html 的形式裡）
const pages = buildOk && fs.existsSync(distDir)
  ? (function count(d) {
      let n = 0;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) n += count(p);
        else if (e.name.endsWith(".html")) n++;
      }
      return n;
    })(distDir)
  : 0;

if (!buildOk) {
  // 建置失敗時立刻把尾巴印出來 —— 不要等到最後才彙總，
  // 因為後面任何一步出錯都會讓這些線索消失（CI 上就發生過）。
  console.log("\n─── 暫存目錄建置失敗，輸出尾巴 ───");
  const lines = buildOut.split("\n").filter((l) => l.trim());
  for (const l of lines.slice(-25)) console.log(`  ${l}`);
  console.log("───");
}
check(buildOk, "暫存目錄建置失敗（見上方輸出）");
/**
 * 頁數要跟「本機建置」一致，不是硬編一個數字。
 *
 * 原本寫死 60，加了 /admin/（Sveltia CMS 後台）之後變 61 就紅了。
 * 硬編數字的問題是：每次多一頁就得改這裡，而下一次還是會忘。
 * 改成跟 site/dist 的實際頁數比對 —— 這才是這個檢查真正想問的問題：
 * 「乾淨目錄建置的結果跟平常建置的一樣嗎？」
 */
const referencePages = (() => {
  const root = path.join(ROOT, "site", "dist");
  if (!fs.existsSync(root)) return null;
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".html")) n++;
    }
  };
  walk(root);
  return n;
})();

check(
  referencePages == null || pages === referencePages,
  `乾淨目錄建置產出 ${pages} 頁，本機建置是 ${referencePages} 頁 —— 兩者應相同`
);

// dist 該有的東西
for (const f of ["_redirects", "_headers", "404.html", "sitemap.xml", "robots.txt", "favicon.svg", "og-default.jpg"]) {
  check(fs.existsSync(path.join(distDir, f)), `dist 缺少 ${f}`);
}
const distBytes = fs.existsSync(distDir)
  ? (function size(d) {
      let s = 0;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) s += size(p);
        else s += fs.statSync(p).size;
      }
      return s;
    })(distDir)
  : 0;

console.log(`乾淨目錄建置：${buildOk ? "成功" : "失敗"}，${pages} 頁，${(distBytes / 1024 / 1024).toFixed(1)} MB`);

/* ══════════════════════════════════════ 4. nginx.conf 靜態檢查 */
const nginx = fs.readFileSync(path.join(ROOT, "docker", "nginx.conf"), "utf8");

// 括號成對
let depth = 0;
let balanced = true;
for (const ch of nginx) {
  if (ch === "{") depth++;
  if (ch === "}") depth--;
  if (depth < 0) balanced = false;
}
check(balanced && depth === 0, `nginx.conf 大括號不成對（結尾深度 ${depth}）`);

// 每個 location 都要有 return / try_files / deny
const blocks = [...nginx.matchAll(/location\s+([^{]+)\{([^}]*)\}/g)];
// 只有 add_header 的 location 是合法的：nginx 會照樣從 root 服務靜態檔。
// 真正有問題的是「空的」location。
const noAction = blocks.filter(([, , body]) => !body.trim());
check(noAction.length === 0, `nginx.conf 有 ${noAction.length} 個空 location`);

// root 指到的目錄（在容器裡是 /usr/share/nginx/html）
check(/root\s+\/usr\/share\/nginx\/html/.test(nginx), "nginx.conf 的 root 不是 /usr/share/nginx/html");

// 轉址目標不該指到自己
const selfLoop = blocks
  .map(([, sel, body]) => {
    const to = /return\s+30\d\s+(\S+?);/.exec(body)?.[1];
    const eq = /location\s*=\s*(\S+)/.exec(sel)?.[1];
    return to && eq && to === eq ? `${eq} → ${to}` : null;
  })
  .filter(Boolean);
check(selfLoop.length === 0, `nginx.conf 有自我轉址迴圈：${selfLoop.join(", ")}`);

notes.push(`nginx location 區塊：${blocks.length} 個（含 return ${blocks.filter(([,,b]) => /return/.test(b)).length} 條轉址）`);

// 轉址目標（不含捕獲組的）必須是新站真的有的頁面。
// 建置若失敗，distDir 根本不存在 —— 要讓它變成一個「問題」，
// 而不是讓 readdirSync 丟 ENOENT 把整個腳本炸掉（那樣看不到其他診斷）。
const distRoutes = new Set();
if (fs.existsSync(distDir)) {
  (function collect(d, base = "") {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) collect(p, base + "/" + e.name);
      else if (e.name === "index.html") distRoutes.add(base || "/");
    }
  })(distDir);
} else {
  check(false, "暫存目錄裡沒有 dist（建置階段失敗，往上找錯誤訊息）");
}
if (distRoutes.size) {
  const literalTargets = [...nginx.matchAll(/return\s+30\d\s+(\S+?);/g)]
    .map((m) => m[1])
    .filter((t) => t.startsWith("/") && !t.includes("$")) // 有 $ 的是捕獲組，另外驗
    .map((t) => t.replace(/\?.*$/, ""));
  const badTargets = [...new Set(literalTargets)].filter((t) => !distRoutes.has(t));
  check(badTargets.length === 0, `nginx 轉址指向不存在的頁面：${badTargets.join(", ")}`);
  notes.push(`nginx 固定轉址目標：${new Set(literalTargets).size} 條，全部存在`);
}

// Dockerfile 引用的 nginx.conf 路徑
check(
  fs.existsSync(path.join(ROOT, "docker", "nginx.conf")),
  "docker/nginx.conf 不存在（Dockerfile 的 COPY 會失敗）"
);
check(/COPY docker\/nginx\.conf/.test(fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8")), "Dockerfile 沒有 COPY nginx.conf");

/* ══════════════════════════════════════ 報告 */
console.log(`\n════ Docker 建置模擬 ════`);
for (const n of notes) console.log(`  · ${n}`);
if (problems.length === 0) {
  console.log(`\n  ✓ 通過（注意：這是模擬，不是真的 docker build）`);
} else {
  console.log(`\n  ✗ ${problems.length} 個問題：`);
  for (const p of problems) console.log(`    ${p}`);
}

fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, ".cache", "verify-docker.json"),
  JSON.stringify({ contextFiles: contextFiles.length, contextBytes, pages, distBytes, buildOk, problems, notes }, null, 1)
);

// 清理
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(problems.length ? 1 : 0);
