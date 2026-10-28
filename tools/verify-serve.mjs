#!/usr/bin/env node
/**
 * 本機預覽伺服器 vs wrangler dev —— 行為對照
 *
 * 為什麼要這一支：
 *   tools/serve.mjs 是「沒有 Docker、沒有 wrangler 時」的預覽方案。
 *   但一個自製的伺服器如果跟真正的部署行為不一樣，那預覽就是在騙人。
 *
 *   這支工具同時打兩個 port，逐條比對：
 *     - HTTP 狀態碼
 *     - Location（轉址目標）
 *     - 安全性標頭（CSP、X-Frame-Options…）
 *     - Cache-Control
 *
 *   兩邊都一致，才敢說「本機看到的就是部署後的样子」。
 *
 * 前置：
 *   node tools/serve.mjs --port 4460          # 或 npm run serve
 *   (cd site && npx wrangler dev --port 8788)  # 另一條路線
 *
 * 用法：
 *   node tools/verify-serve.mjs --local 4460 --cf 8788
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf("--" + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const LOCAL = arg("local", 4460);
const CF = arg("cf", 8788);

const problems = [];

const probe = async (port, p, method = "GET") => {
  try {
    const res = await fetch(`http://localhost:${port}${p}`, {
      method,
      redirect: "manual",
      headers: { "User-Agent": "luisang-verify-serve/1.0" },
    });
    const h = {};
    for (const [k, v] of res.headers) h[k.toLowerCase()] = v;
    return { code: res.status, loc: h.location, headers: h };
  } catch (e) {
    return { code: -1, error: e.message };
  }
};

// 只比對「部署行為」有定義的標頭，不比 Date/ETag/Server 這種每次不同的
const COMPARE_HEADERS = [
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cache-control",
];

const assertEquals = (label, a, b) => {
  if ((a ?? "") !== (b ?? "")) {
    problems.push(`${label}\n      本機: ${a ?? "(無)"}\n      CF  : ${b ?? "(無)"}`);
  }
};

/* ── 測試清單：現役頁面 + 轉址 + 404 ── */
const routes = JSON.parse(fs.readFileSync(path.join(ROOT, "content", "model.json"), "utf8")).routes ?? [];

// 現役頁面（從 dist 實際產出列）
const distRoutes = [];
(function collect(d, base = "") {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) collect(p, base + "/" + e.name);
    else if (e.name === "index.html") distRoutes.push(base || "/");
  }
})(path.join(ROOT, "site", "dist"));

// 轉址規則
const redirects = fs
  .readFileSync(path.join(ROOT, "site", "dist", "_redirects"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => l.split(/\s+/)[0]);

const staticAssets = [
  "/sitemap.xml",
  "/robots.txt",
  "/favicon.svg",
  "/og-default.jpg",
  "/_headers",
  "/_redirects",
];

const cases = [
  ...distRoutes,
  ...redirects,
  ...staticAssets,
  "/this-page-does-not-exist",
];

const checked = new Map();

console.log(`本機 :${LOCAL}  vs  Cloudflare :${CF}`);
console.log(`比對 ${cases.length} 條路徑…\n`);

for (const p of cases) {
  if (checked.has(p)) continue;
  const [a, b] = await Promise.all([probe(LOCAL, p), probe(CF, p)]);
  checked.set(p, { local: a, cf: b });

  if (a.code === -1) {
    problems.push(`本機無回應：${p}（${a.error}）— 伺服器有起來嗎？`);
    continue;
  }

  // 狀態碼
  if (a.code !== b.code) {
    problems.push(`狀態碼不同：${p}\n      本機: ${a.code}\n      CF  : ${b.code}`);
    continue;
  }

  // 轉址目標
  if (b.code >= 300 && b.code < 400) {
    const norm = (u) => (u ?? "").replace(`http://localhost:${LOCAL}`, "").replace(`http://localhost:${CF}`, "").replace(`http://127.0.0.1:${LOCAL}`, "").replace(`http://127.0.0.1:${CF}`, "");
    assertEquals(`轉址目標不同：${p}`, norm(a.loc), norm(b.loc));
    continue; // 轉址不看快取標頭
  }

  // 標頭
  for (const h of COMPARE_HEADERS) {
    // wrangler dev 對靜態資產會自己加 cache-control，本機也照做；
    // 但 HTML 的 cache-control 兩邊若能一致更好。
    assertEquals(`${h} 不同：${p}`, a.headers[h], b.headers[h]);
  }
}

/* ── 報告 ── */
const byCode = {};
for (const [, v] of checked) byCode[v.cf.code] = (byCode[v.cf.code] || 0) + 1;

console.log(`受測路徑：${checked.size}`);
console.log(`狀態碼分布：${JSON.stringify(byCode)}`);
console.log(`轉址：${[...checked.values()].filter((v) => v.cf.code >= 300 && v.cf.code < 400).length} 條`);

console.log(`\n════ 本機預覽可信度 ════`);
if (problems.length === 0) {
  console.log(`\n  ✓ 兩邊行為一致（${checked.size} 條路徑、${COMPARE_HEADERS.length} 個標頭）`);
} else {
  console.log(`\n  ✗ ${problems.length} 個不一致：\n`);
  for (const p of problems.slice(0, 25)) console.log(`    ${p}`);
  if (problems.length > 25) console.log(`    …還有 ${problems.length - 25} 個`);
}

fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, ".cache", "verify-serve.json"),
  JSON.stringify(
    {
      localPort: LOCAL,
      cfPort: CF,
      checked: [...checked.entries()].map(([p, v]) => ({
        path: p,
        local: { code: v.local.code, loc: v.local.loc },
        cf: { code: v.cf.code, loc: v.cf.loc },
      })),
      problems,
    },
    null,
    1
  )
);

process.exit(problems.length ? 1 : 0);
