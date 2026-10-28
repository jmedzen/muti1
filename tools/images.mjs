#!/usr/bin/env node
/**
 * Phase 4 — 圖片管線：把 raw/assets 的原圖轉成多尺寸 WebP/AVIF 並產出 manifest。
 *
 * 輸出 site/public/media/…（Astro 靜態資產）
 *      site/src/data/images.json（寬高、佔位色、srcset，供 <ArtImage> 使用）
 *
 * 設計：
 *  - 作品圖（無 _thumb）產 480 / 960 / 1600 三檔 + LQIP（20px 模糊佔位）
 *  - 文章特圖同規格
 *  - 相簿封面 thumb.jpg 只產 640 一檔
 *  - 全部輸出 WebP（瀏覽器支援率 > 97%），原始 JPEG 不複製，避免重複佔空間
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { requireDep } from "./load-dep.mjs";

const sharp = requireDep("sharp");

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "raw", "assets");
const PUB = path.join(ROOT, "site", "public", "media");
const DATA = path.join(ROOT, "site", "src", "data");

const model = JSON.parse(await fsp.readFile(path.join(ROOT, "content", "model.json"), "utf8"));

/* ---------------------------------------------------------------- 收集唯一原圖 */
const wanted = new Map(); // 原始站路徑 -> {sizes, priority}
const want = (u, sizes = [480, 960, 1600]) => {
  if (!u || !u.startsWith("/images/")) return;
  if (u.includes("_thumb")) return;
  const prev = wanted.get(u);
  if (prev) prev.sizes = [...new Set([...prev.sizes, ...sizes])].sort((a, b) => a - b);
  else wanted.set(u, { sizes: [...sizes].sort((a, b) => a - b) });
};

model.hero.forEach((h) => want(h.image, [960, 1600, 2000]));
model.galleries.forEach((g) => g.items.forEach((i) => want(i.src, [480, 960, 1600])));
[...model.articles, ...model.artistArticles].forEach((a) => {
  want(a.hero, [640, 1280]);
  (a.images || []).forEach((i) => want(i.src, [480, 960]));
});
model.homeBlocks.forEach((b) =>
  b.addons.forEach((x) => {
    if (x.image && !x.image.includes("_thumb")) want(x.image, [480, 960, 1600]);
  })
);

/**
 * --incremental：只處理 images.json 裡還沒有的圖（後台新上傳的），既有項目原封不動。
 * 建置時用這個模式（site/package.json 的 build），每次只多花新圖的時間，
 * images.json 也不會因為並行處理的完成順序不同而整份重排。
 */
const INCREMENTAL = process.argv.includes("--incremental");
const MANIFEST = path.join(DATA, "images.json");
const out = INCREMENTAL && fs.existsSync(MANIFEST) ? JSON.parse(await fsp.readFile(MANIFEST, "utf8")) : {};
if (INCREMENTAL) for (const k of Object.keys(out)) wanted.delete(k);
let done = 0;
let totalOut = 0;
const t0 = Date.now();

await fsp.mkdir(PUB, { recursive: true });
await fsp.mkdir(DATA, { recursive: true });

const jobs = [...wanted.entries()];
console.log(`[images] ${jobs.length} unique sources`);

async function processOne([srcPath, cfg]) {
  const abs = path.join(SRC, srcPath);
  if (!fs.existsSync(abs)) {
    console.warn("  MISSING", srcPath);
    return;
  }
  const base = srcPath.replace(/^\/images\//, "").replace(/\.[^.]+$/, "");
  const meta = await sharp(abs).metadata();
  const longest = Math.max(meta.width || 0, meta.height || 0);
  const isLandscape = (meta.width || 1) >= (meta.height || 1);

  // 只用「可達到的」尺寸：超過原圖長邊的規格會是小放，直接去掉，避免重複檔
  const capped = [...new Set(cfg.sizes.filter((w) => w <= longest).concat([Math.min(longest, Math.min(...cfg.sizes))]))]
    .filter((w) => w > 0)
    .sort((a, b) => a - b);

  const variants = [];
  for (const w of capped) {
    const resizeOpt = isLandscape ? { width: w } : { height: w };
    const outFile = `${base}-${w}.webp`;
    const outAbs = path.join(PUB, outFile);
    await fsp.mkdir(path.dirname(outAbs), { recursive: true });
    if (!fs.existsSync(outAbs)) {
      const buf = await sharp(abs).rotate().resize({ ...resizeOpt, withoutEnlargement: true }).webp({ quality: 82, effort: 4 }).toBuffer();
      await fsp.writeFile(outAbs, buf);
      totalOut += buf.length;
    } else {
      totalOut += fs.statSync(outAbs).size;
    }
    const m2 = await sharp(outAbs).metadata();
    // 若與前一檔實際像素相同（原圖本來就小），跳過重複
    const last = variants.at(-1);
    if (last && last.width === m2.width && last.height === m2.height) {
      await fsp.rm(outAbs, { force: true });
      continue;
    }
    // encodeURI：後台上傳的檔名可能有空白或中文，srcset 以空白分隔，不編碼會斷掉
    variants.push({ w, file: encodeURI(`/media/${outFile}`), width: m2.width, height: m2.height, bytes: fs.statSync(outAbs).size });
  }

  // LQIP：20px WebP 內嵌 data URI
  const lqipBuf = await sharp(abs).rotate().resize({ width: 20 }).webp({ quality: 40 }).toBuffer();
  const lqip = `data:image/webp;base64,${lqipBuf.toString("base64")}`;

  const ratio = (meta.height || 1) / (meta.width || 1);
  out[srcPath] = {
    src: srcPath,
    width: meta.width,
    height: meta.height,
    ratio: Number(ratio.toFixed(4)),
    lqip,
    originalBytes: fs.statSync(abs).size,
    variants,
  };
  if (++done % 25 === 0) console.log(`  ${done}/${jobs.length}`);
}

const CONC = 4;
const queue = [...jobs];
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (queue.length) await processOne(queue.shift());
  })
);

if (INCREMENTAL && !jobs.length) {
  console.log("[images] 沒有新圖，images.json 不變");
  process.exit(0);
}
await fsp.writeFile(MANIFEST, JSON.stringify(out, null, 1));

const inBytes = Object.values(out).reduce((s, v) => s + v.originalBytes, 0);
console.log(
  `[images] ${Object.keys(out).length} sources → ${Object.values(out).reduce((s, v) => s + v.variants.length, 0)} variants, ` +
    `${(totalOut / 1048576).toFixed(1)} MB webp (from ${(inBytes / 1048576).toFixed(1)} MB originals), ${((Date.now() - t0) / 1000).toFixed(0)}s`
);
