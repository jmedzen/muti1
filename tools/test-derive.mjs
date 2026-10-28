#!/usr/bin/env node
/**
 * 推導函式回歸測試
 *
 * 為什麼要有這一支：
 *   `tools/lib/derive.mjs` 的推導邏輯現在同時服務兩條路線 ——
 *   爬蟲路線（model.mjs）與編輯路線（md-to-model.mjs）。
 *   這些函式一旦被改動，兩條路線的輸出會「一起」改變，
 *   於是「MD → model.json 與原本相同」這個保證就失效了 ——
 *   而且是靜默失效。
 *
 *   所以把「已知正確」的輸入輸出釘在這裡。
 *   如果哪天有人（包括未來的我）調了尺寸正規表達式，
 *   這支會立刻紅，而不是等到某個頁面的尺寸不對才發現。
 *
 * 用法：node tools/test-derive.mjs
 */
import { norm, parseEventDate, parseArtworkTitle } from "./lib/derive.mjs";

let pass = 0;
const fails = [];

const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else fails.push({ label, expected: e, actual: a });
};

/* ────────────────────────────────────────── norm */
eq("norm：收斂空白", norm("  山水   畫  "), "山水 畫");
eq("norm：nbsp 轉半形空白", norm("山\u00a0水"), "山 水");
eq("norm：null → 空字串", norm(null), "");
eq("norm：尾端空白去掉", norm("山水  \n"), "山水");

/* ────────────────────────────────────────── parseEventDate */
eq("日期：西元年月日（點分隔）", parseEventDate("2013.7.4～2013.7.8"), {
  year: 2013,
  month: 7,
  day: 4,
  iso: "2013-07-04",
});
eq("日期：中文年月日", parseEventDate("2008年9月22日"), {
  year: 2008,
  month: 9,
  day: 22,
  iso: "2008-09-22",
});
eq("日期：只有年月", parseEventDate("2014年3月"), {
  year: 2014,
  month: 3,
  day: null,
  iso: "2014-03",
});
eq("日期：只有年份", parseEventDate("2017年秋"), { year: 2017, month: null, day: null, iso: "2017" });
eq("日期：無日期", parseEventDate("展覽現場"), null);
eq("日期：空字串", parseEventDate(""), null);

/* ────────────────────────────────────────── parseArtworkTitle */
// 基準案例：一般山水作品
eq(
  "作品：編號＋尺寸＋年份",
  parseArtworkTitle("O004 黃磊生---山高水長 62x128cm 2009", 6),
  {
    code: "O004",
    series: "O",
    kind: "artwork",
    caption: "O004 黃磊生---山高水長 62x128cm 2009",
    name: "山高水長",
    titleEn: null,
    medium: null,
    note: null,
    width: 62,
    height: 128,
    dimUnit: "cm",
    dimRaw: "62x128cm",
    year: 2009,
    yearGanzhi: null,
  }
);

// 原始檔的筆誤「178x31m」—— 必須原樣解析成 m，不能「順手修正」
// 理由是：這個專案的規則是原文不改，筆誤也是證據的一部分。
{
  const r = parseArtworkTitle("C002 黃磊生---書法 178x31m", 8);
  eq("作品：單位筆誤 m 原樣保留", [r.width, r.height, r.dimUnit], [178, 31, "m"]);
}

// 英文副題
{
  const r = parseArtworkTitle("F001 黃磊生---Flowers in Spring 45x60cm 1998", 7);
  eq("作品：英文副題抽出", r.titleEn, "Flowers in Spring");
  eq("作品：英文副題不污染名稱", r.name, null);
}

// 括號註記
{
  const r = parseArtworkTitle("O010 黃磊生---山水（國父紀念館收藏） 90x180cm 1995", 6);
  eq("作品：括號註記進 note", r.note, "國父紀念館收藏");
  eq("作品：註記不留在名稱", r.name, "山水");
}

// 照片類條目（album 9/10/11）→ kind 必須是 photo
{
  const r = parseArtworkTitle("P001 2013年 廈門美術館展覽開幕", 9);
  eq("作品：相簿 9 是 photo", r.kind, "photo");
  eq("作品：照片也抽年份", r.year, 2013);
}

// 尺寸寫在括號裡
{
  const r = parseArtworkTitle("O020 黃磊生---春江水暖 (98x109cm) 2001", 6);
  eq("作品：括號內尺寸仍算尺寸", [r.width, r.height], [98, 109]);
}

/* ────────────────────────────────────────── 結果 */
console.log(`\n推導函式回歸測試`);
console.log(`  通過 ${pass}　失敗 ${fails.length}\n`);

if (fails.length) {
  for (const f of fails) {
    console.log(`  ✗ ${f.label}`);
    console.log(`      預期 ${f.expected}`);
    console.log(`      實際 ${f.actual}`);
  }
  process.exit(1);
}
console.log("  ✓ 全部通過\n");
