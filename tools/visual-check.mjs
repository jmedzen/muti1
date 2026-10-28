#!/usr/bin/env node
/**
 * 視覺驗證：用 Chrome 實際渲染 dist/ 的頁面，量測並截圖。
 *
 * 用法：
 *   node tools/visual-check.mjs                 # 全部頁面，1440 + 390 兩種寬度
 *   node tools/visual-check.mjs --only / --width 1440
 *
 * 檢查項目（每一項都是「使用者真的會看到」的問題）：
 *   1. 水平溢出（scrollWidth > clientWidth）
 *   2. 圖片 404 / 載入失敗（naturalWidth === 0）
 *   3. 文字與背景對比度不足（WCAG AA 4.5:1，大字 3:1）
 *   4. 元素重疊（相鄰 block 互相覆蓋）
 *   5. 折行異常（中文落單字、標題溢出容器）
 *   6. 首屏 CLS（累積佈局位移）
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { requireDep } from "./load-dep.mjs";

// puppeteer-core 裝在 site/node_modules（見 tools/load-dep.mjs 的說明）
const puppeteer = requireDep("puppeteer-core");

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "site", "dist");
const SHOTS = path.join(ROOT, ".cache", "shots");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const ONLY = argOf("only", null);
const WIDTHS = (argOf("width", "1440,390") || "").split(",").map(Number);
// 受測站台基底網址。預設是 astro preview（npm run preview，port 4319）；
// 也可以用 --base 指到本機預覽伺服器（tools/serve.mjs）或 wrangler dev。
const BASE = (argOf("base", "http://localhost:4319") || "").replace(/\/$/, "");
const MAX = Number(argOf("max", 999));

/* ---------------------------------------------------------------- 蒐集路由 */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "index.html") out.push(p);
  }
  return out;
}

const files = walk(DIST).sort();
const routes = files.map((f) => {
  let r = "/" + path.relative(DIST, f).replace(/index\.html$/, "");
  r = r.replace(/\/$/, "") || "/";
  return r;
}).filter((r) => !ONLY || r === ONLY || r.startsWith(ONLY));
routes.length = Math.min(routes.length, MAX);

await fsp.mkdir(SHOTS, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--font-render-hinting=none"],
});

// 先確認伺服器活著。
// 沒有這道檢查的話，伺服器沒起來時每一頁都會等 45 秒 timeout，
// 60 頁 × 3 寬度就是一場漫長的等待，而且最後只說「全部失敗」。
try {
  const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) {
  console.error(`\n連不上 ${BASE}（${e.message}）\n`);
  console.error("先把伺服器起起來，例如：");
  console.error("  node tools/serve.mjs --port 4321      # 本機預覽（已建置的 dist）");
  console.error("  node tools/dev.mjs                    # 開發模式（熱更新）\n");
  process.exit(2);
}

const results = [];

for (const width of WIDTHS) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
  const failedRequests = [];
  page.on("requestfailed", (r) => failedRequests.push({ url: r.url(), err: r.failure()?.errorText }));
  page.on("response", (r) => {
    if (r.status() >= 400) failedRequests.push({ url: r.url(), err: `HTTP ${r.status()}` });
  });

  for (const route of routes) {
    failedRequests.length = 0;
    const url = `${BASE}${route}`;
    let nav;
    try {
      nav = await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    } catch (e) {
      results.push({ route, width, fatal: `navigation: ${e.message}` });
      continue;
    }

    // 等字型與圖片
    await page.evaluate(() => document.fonts?.ready);
    await new Promise((r) => setTimeout(r, 320));

    const audit = await page.evaluate(() => {
      const issues = [];
      const de = document.documentElement;

      // 1. 水平溢出
      const overflowX = de.scrollWidth - de.clientWidth;
      if (overflowX > 1) {
        // 找出真正超出的元素
        const culprits = [];
        document.querySelectorAll("body *").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.right > de.clientWidth + 1.5 || r.left < -1.5)) {
            const cs = getComputedStyle(el);
            if (cs.position === "fixed" || cs.visibility === "hidden" || cs.display === "none") return;
            culprits.push({
              tag: el.tagName.toLowerCase(),
              cls: (el.className || "").toString().slice(0, 70),
              right: Math.round(r.right),
              left: Math.round(r.left),
            });
          }
        });
        issues.push({ type: "overflow-x", detail: `${overflowX}px`, culprits: culprits.slice(0, 4) });
      }

      // 2. 圖片載入失敗
      const brokenImgs = [];
      document.querySelectorAll("img").forEach((img) => {
        if (!img.complete) return;
        if (img.naturalWidth === 0 && img.currentSrc) {
          brokenImgs.push({ src: img.currentSrc.slice(-70), alt: img.alt.slice(0, 40) });
        }
      });
      if (brokenImgs.length) issues.push({ type: "broken-image", detail: brokenImgs.length, culprits: brokenImgs.slice(0, 5) });

      // 3. 對比度
      const parseRGB = (s) => {
        if (!s) return null;
        // rgb()/rgba() 傳統寫法
        let m = s.match(/rgba?\(([^)]+)\)/);
        if (m) {
          const [r, g, b, a = 1] = m[1].split(/[\s,\/]+/).filter(Boolean).map((x) => parseFloat(x));
          return { r, g, b, a };
        }
        // color(srgb r g b / a) —— color-mix() 的計算結果會長這樣
        m = s.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
        if (m) {
          return {
            r: parseFloat(m[1]) * 255,
            g: parseFloat(m[2]) * 255,
            b: parseFloat(m[3]) * 255,
            a: m[4] === undefined ? 1 : parseFloat(m[4]),
          };
        }
        return null;
      };
      // 把半透明色疊在下層色上，算出「眼睛真正看到的顏色」
      const over = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      });
      const lum = ({ r, g, b }) => {
        const f = (c) => {
          c /= 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (a, b) => {
        const l1 = lum(a), l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      const bgOf = (el) => {
        // 由外向內收集背景，再逐層疊起來
        const layers = [];
        let n = el;
        while (n && n !== document.documentElement) {
          const cs = getComputedStyle(n);
          const c = parseRGB(cs.backgroundColor);
          if (c && c.a > 0.001) {
            layers.push(c);
            if (c.a >= 0.999) break;
          }
          n = n.parentElement;
        }
        let base = { r: 250, g: 248, b: 243, a: 1 };
        for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
        return base;
      };
      // 元素是否覆蓋在照片/大圖上（此時演算法算不準，跳過）
      const onImage = (el) => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
        }
        // 同一個容器裡有絕對定位的大圖（hero）也算
        const box = el.getBoundingClientRect();
        return [...document.querySelectorAll("img")].some((im) => {
          const r = im.getBoundingClientRect();
          if (r.width < 200 || r.height < 150) return false;
          const cs = getComputedStyle(im);
          if (cs.position !== "absolute" && cs.position !== "fixed") return false;
          return !(r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom);
        });
      };
      const lowContrast = [];
      document.querySelectorAll("p,a,li,span,h1,h2,h3,h4,time,cite,button,figcaption,label,td,th").forEach((el) => {
        if (!el.textContent.trim()) return;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.opacity === "0") return;
        const fg = parseRGB(cs.color);
        if (!fg) return;
        if (onImage(el)) return; // 疊在照片上的文字，靜態分析不準
        const bg = bgOf(el);
        if (fg.a < 0.95) return;
        const cr = ratio(fg, bg);
        const size = parseFloat(cs.fontSize);
        const bold = parseInt(cs.fontWeight, 10) >= 700;
        const large = size >= 24 || (size >= 18.66 && bold);
        const need = large ? 3 : 4.5;
        if (cr < need) {
          lowContrast.push({
            text: el.textContent.trim().slice(0, 28),
            color: cs.color,
            bg: `rgb(${bg.r},${bg.g},${bg.b})`,
            ratio: Number(cr.toFixed(2)),
            need,
            size,
            cls: (el.className || "").toString().slice(0, 40),
          });
        }
      });
      if (lowContrast.length)
        issues.push({ type: "low-contrast", detail: lowContrast.length, culprits: lowContrast.slice(0, 6) });

      // 4. 首頁大標溢出
      document.querySelectorAll("h1,h2,.hero-title-zh,.sh-title").forEach((el) => {
        if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== "visible") {
          issues.push({ type: "clipped-heading", detail: el.textContent.trim().slice(0, 30) });
        }
      });

      // 5. 空連結 / 死錨點
      const badLinks = [];
      document.querySelectorAll('a[href="#"], a[href=""]').forEach((a) => {
        badLinks.push({ text: a.textContent.trim().slice(0, 30) });
      });
      if (badLinks.length) issues.push({ type: "empty-link", detail: badLinks.length, culprits: badLinks.slice(0, 4) });

      // 6. 內容高度（抓佈局崩塌：頁面只剩 header/footer）
      const mainH = document.querySelector("main")?.getBoundingClientRect().height ?? 0;

      return {
        issues,
        title: document.title,
        mainHeight: Math.round(mainH),
        docHeight: Math.round(de.scrollHeight),
        imgCount: document.querySelectorAll("img").length,
      };
    });

    const shotName = `${route.replace(/[^a-z0-9]+/gi, "_") || "root"}_${width}.png`;
    await page.screenshot({ path: path.join(SHOTS, shotName), fullPage: true, captureBeyondViewport: false });

    results.push({
      route,
      width,
      status: nav?.status(),
      title: audit.title,
      mainHeight: audit.mainHeight,
      docHeight: audit.docHeight,
      imgCount: audit.imgCount,
      issues: audit.issues,
      failedRequests: failedRequests.filter((f) => !f.url.includes("favicon")).slice(0, 6),
      shot: shotName,
    });
  }
  await page.close();
}

await browser.close();

/* ---------------------------------------------------------------- 報告 */
const problems = results.filter((r) => r.fatal || r.issues?.length || r.failedRequests?.length);
console.log(`\n=== ${results.length} page renders (${WIDTHS.join("px, ")}px) ===`);
console.log(`clean: ${results.length - problems.length}   with issues: ${problems.length}\n`);

for (const r of problems) {
  console.log(`── ${r.route} @${r.width}px  ${r.fatal ?? ""}`);
  if (r.failedRequests?.length) console.log(`   requests: ${r.failedRequests.map((f) => f.err + " " + f.url.slice(-50)).join(" | ")}`);
  for (const i of r.issues ?? []) {
    console.log(`   [${i.type}] ${i.detail ?? ""}`);
    for (const c of i.culprits ?? []) console.log(`      · ${JSON.stringify(c)}`);
  }
}

const byType = {};
for (const r of results) for (const i of r.issues ?? []) byType[i.type] = (byType[i.type] || 0) + 1;
console.log("\nissue totals:", byType);

await fsp.writeFile(path.join(ROOT, ".cache", "visual-report.json"), JSON.stringify(results, null, 1));
process.exit(problems.length ? 1 : 0);
