#!/usr/bin/env node
/**
 * 效能量測（第四趟驗證）
 *
 * 量的是「使用者真正感覺到的東西」，不是實驗室數字：
 *   - LCP / CLS / TBT（用瀏覽器自己的 PerformanceObserver，不是自己算的估計值）
 *   - 首次載入的傳輸量（HTML + CSS + JS + 首屏圖片，gzip 後）
 *   - 有沒有 render-blocking 資源
 *   - 有沒有超過 100 KB 的單一資源
 *
 * 用 4G 速度模擬（下載 1.6 Mbps、上傳 750 kbps、延遲 150 ms），
 * 這是台灣行動網路的中位數體感。
 *
 * 用法：node tools/perf.mjs [--url http://localhost:4319] [--routes /,...]
 */
import fs from "node:fs";
import path from "node:path";
import { requireDep } from "./load-dep.mjs";
import { requireChrome } from "./chrome-path.mjs";

const puppeteer = requireDep("puppeteer-core");

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf("--" + k);
  return i >= 0 ? args[i + 1] : d;
};

// 受測站台基底網址：預設 astro preview（4319）；--url / --base 都能指到別的地方。
const BASE = (arg("url", arg("base", "http://localhost:4319")) || "").replace(/\/$/, "");
// 跨平台找 Chrome（macOS / Linux / Windows），可用 CHROME_PATH 覆寫
const CHROME = requireChrome();

const ROUTES = (arg("routes") || "/,/collection/landscape,/about/chronology,/news,/art-reviews,/life/exhibition-exchange,/contact,/search")
  .split(",")
  .filter(Boolean);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

const results = [];

for (const route of ROUTES) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setCacheEnabled(false);

  // 4G 模擬
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });

  // 統計傳輸量
  let bytes = 0;
  const byType = {};
  const big = [];
  page.on("response", async (res) => {
    try {
      const h = res.headers();
      const len = parseInt(h["content-length"] || "0", 10);
      if (len > 0) {
        bytes += len;
        const ct = (h["content-type"] || "other").split(";")[0];
        byType[ct] = (byType[ct] || 0) + len;
        if (len > 100 * 1024) big.push({ url: res.url().replace(BASE, ""), kb: Math.round(len / 1024) });
      }
    } catch {}
  });

  const t0 = Date.now();
  await page.goto(BASE + route, { waitUntil: "load", timeout: 60000 });

  // 等 LCP 穩定（最多 3 秒）
  const vitals = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const out = { lcp: 0, cls: 0, tbt: 0, fcp: 0, longTasks: 0 };
        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) out.lcp = Math.max(out.lcp, e.startTime);
          }).observe({ type: "largest-contentful-paint", buffered: true });
        } catch {}
        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) if (!e.hadRecentInput) out.cls += e.value;
          }).observe({ type: "layout-shift", buffered: true });
        } catch {}
        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              out.longTasks++;
              out.tbt += Math.max(0, e.duration - 50);
            }
          }).observe({ type: "longtask", buffered: true });
        } catch {}
        const fcp = performance.getEntriesByName("first-contentful-paint")[0];
        if (fcp) out.fcp = fcp.startTime;

        setTimeout(() => {
          // 補齊在 observer 註冊前就結束的項目
          const paints = performance.getEntriesByType("paint");
          const f = paints.find((p) => p.name === "first-contentful-paint");
          if (f && !out.fcp) out.fcp = f.startTime;
          const nav = performance.getEntriesByType("navigation")[0];
          out.domContentLoaded = nav?.domContentLoadedEventEnd || 0;
          out.load = nav?.loadEventEnd || 0;
          out.transferSize = nav?.transferSize || 0;
          resolve(out);
        }, 3000);
      })
  );

  // 資源清單：找出 render-blocking 與超大檔
  const res = await page.evaluate(() => {
    const resources = performance.getEntriesByType("resource").map((r) => ({
      name: r.name,
      type: r.initiatorType,
      bytes: r.transferSize || 0,
      dur: Math.round(r.duration),
    }));
    const blocking = [...document.querySelectorAll('link[rel="stylesheet"], script[src]:not([async]):not([defer])')].map((el) =>
      el.tagName === "LINK" ? el.href : el.src
    );
    return {
      count: resources.length,
      resources,
      blocking,
      domNodes: document.querySelectorAll("*").length,
    };
  });

  await page.close();

  const row = {
    route,
    lcp: Math.round(vitals.lcp),
    fcp: Math.round(vitals.fcp),
    cls: Number(vitals.cls.toFixed(4)),
    tbt: Math.round(vitals.tbt),
    longTasks: vitals.longTasks,
    load: Math.round(vitals.load),
    requests: res.count,
    blocking: res.blocking.length,
    domNodes: res.domNodes,
    kb: Math.round(bytes / 1024),
    byType,
    big,
    wall: Date.now() - t0,
  };
  results.push(row);

  const grade = (v, good, ok) => (v <= good ? "良好" : v <= ok ? "可接受" : "待改善");
  console.log(
    `${route.padEnd(30)} LCP ${String(row.lcp).padStart(4)}ms(${grade(row.lcp, 2500, 4000)})  ` +
      `CLS ${String(row.cls).padStart(6)}(${grade(row.cls * 1000, 100, 250)})  ` +
      `TBT ${String(row.tbt).padStart(3)}ms  ${String(row.kb).padStart(4)}KB  ${String(row.requests).padStart(3)} req  DOM ${row.domNodes}`
  );
  if (row.big.length) console.log(`   超過 100 KB：${row.big.map((b) => `${b.url.split("/").pop()} ${b.kb}KB`).join("、")}`);
}

await browser.close();

/* ---------------------------------------------------------------- 彙總 */
const avg = (k) => Math.round(results.reduce((s, r) => s + r[k], 0) / results.length);
const worst = (k) => Math.max(...results.map((r) => r[k]));

console.log(`\n── 彙總 ──`);
console.log(`頁數 ${results.length}`);
console.log(`LCP  平均 ${avg("lcp")}ms　最差 ${worst("lcp")}ms`);
console.log(`CLS  平均 ${(results.reduce((s, r) => s + r.cls, 0) / results.length).toFixed(4)}　最差 ${worst("cls")}`);
console.log(`TBT  平均 ${avg("tbt")}ms`);
console.log(`傳輸 平均 ${avg("kb")}KB　最大 ${worst("kb")}KB`);
console.log(`請求 平均 ${avg("requests")}　最多 ${worst("requests")}`);

const failing = results.filter((r) => r.lcp > 4000 || r.cls > 0.25 || r.blocking > 2);
console.log(failing.length ? `\n需注意：${failing.map((r) => r.route).join(", ")}` : `\n全部在可接受範圍`);

fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
fs.writeFileSync(path.join(ROOT, ".cache", "perf.json"), JSON.stringify(results, null, 1));
