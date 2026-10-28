/**
 * 內容推導（純函式，無 I/O）
 *
 * 為什麼要把這些抽出來：
 *   同一套推導邏輯現在有兩個地方要用 ——
 *     1. `tools/model.mjs`       從 raw/ 的原始 HTML 產生 model.json（爬蟲路線）
 *     2. `tools/md-to-model.mjs` 從 content/md/ 的 Markdown 產生 model.json（編輯路線）
 *
 *   如果兩邊各留一份，遲早會漂移：改了其中一邊的尺寸正規表達式，
 *   另一邊沒改，於是「同一件作品」在兩條路線上得到不同結果 ——
 *   而且是靜默的，直到有人發現某一頁的尺寸不對。
 *
 *   所以：推導邏輯只留一份，兩邊都 import 這裡。
 *   這些函式必須是純的（不讀檔、不寫檔、不看環境），否則就不能共用。
 */

export const norm = (s) => (s || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\s+\n/g, "\n").trim();

export function parseEventDate(text) {
  // 2008年9月22日 / 2006.4.27 / 2006-4-30 / 2013.7.4
  const m =
    /((?:19|20)\d{2})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]\s*(\d{1,2})/.exec(text || "") ||
    /((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月/.exec(text || "");
  if (m) {
    const [, y, mo, d] = m;
    const mm = String(Number(mo)).padStart(2, "0");
    const dd = d ? String(Number(d)).padStart(2, "0") : null;
    return { year: Number(y), month: Number(mo), day: d ? Number(d) : null, iso: `${y}-${mm}${dd ? "-" + dd : ""}` };
  }
  const y = /((?:19|20)\d{2})/.exec(text || "");
  if (y) return { year: Number(y[1]), month: null, day: null, iso: String(y[1]) };
  return null;
}

// 兩類條目：
//   artwork  — 「編號 黃磊生---作品名 尺寸 年份」，有尺寸/年份，屬作品集
//   photo    — 展覽交流 / 生活足跡 / 藝術交流，是照片說明文字
const ALBUM_KIND = {
  6: "artwork",
  7: "artwork",
  8: "artwork",
  9: "photo",
  10: "photo",
  11: "photo",
};

export function parseArtworkTitle(raw, albumId) {
  const title = norm(raw);
  const kind = ALBUM_KIND[albumId] || "artwork";
  const codeMatch = /^([A-Z])(\d{2,3})\b/.exec(title);
  const code = codeMatch ? `${codeMatch[1]}${codeMatch[2]}` : null;
  const series = codeMatch ? codeMatch[1] : null;

  // 去掉編號與「黃磊生---」連接詞
  let body = title
    .replace(/^[A-Z]\d{2,3}\s*/, "")
    .replace(/^黃磊生(?:老師|教授|大師)?\s*[-–—]{2,}\s*/, "")
    .trim();

  // 括號註記（展覽、收藏、題字等）先抽出
  const notes = [];
  body = body.replace(/[（(]\s*([^（()）]{1,60}?)\s*[)）]/g, (_, inner) => {
    // 尺寸括號（例如 "(98x109cm)"）不算註記
    if (/^\d+(?:\.\d+)?\s*[x×X]\s*\d+/.test(inner)) return ` ${inner} `;
    // 純拉丁字括号是英文副題的一部分，留在原文讓英文解析接手
    if (/^[A-Za-z0-9 .,'’&\-]+$/.test(inner)) return ` ${inner} `;
    notes.push(norm(inner));
    return " ";
  });

  // 尺寸
  let width = null,
    height = null,
    dimUnit = null,
    dimRaw = null;
  const dim = /(\d+(?:\.\d+)?)\s*[x×X]\s*(\d+(?:\.\d+)?)\s*(cm|公分|m)?/i.exec(body);
  if (dim) {
    width = Number(dim[1]);
    height = Number(dim[2]);
    dimUnit = (dim[3] || "cm").toLowerCase();
    dimRaw = dim[0];
    body = body.replace(dim[0], " ");
  }

  // 年份（可帶干支）
  let year = null,
    yearGanzhi = null;
  // 原站有「2006年丙戊」這類干支筆誤（應為丙戌），仍原樣收在 yearGanzhiRaw
  const yz = /((?:19|20)\d{2})\s*年?\s*([甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥])/.exec(body);
  const yzTypo = /((?:19|20)\d{2})\s*年\s*([甲乙丙丁戊己庚辛壬癸])([子丑寅卯辰巳午未申酉戌亥])/.exec(body);
  if (yz) {
    year = Number(yz[1]);
    yearGanzhi = yz[2];
    body = body.replace(yz[0], " ");
  } else if (yzTypo) {
    year = Number(yzTypo[1]);
    yearGanzhi = yzTypo[2] + yzTypo[3];
    body = body.replace(yzTypo[0], " ");
  } else {
    const y = /(?<![x×X\d])((?:19|20)\d{2})(?![x×X\d])/.exec(body);
    if (y) {
      year = Number(y[1]);
      body = body.replace(y[0] + "年", " ").replace(y[0], " ");
    }
  }

  // 媒材
  let medium = null;
  const med = /(水墨|彩墨|設色|水墨設色|紙本|絹本)/.exec(body);
  if (med) {
    medium = med[0];
    body = body.replace(med[0], " ");
  }

  // 英文副題：連續拉丁字母片段（可含 . ' , & - 與內部空白），至少 3 個字母
  let titleEn = null;
  const enM = /([A-Za-z][A-Za-z0-9'’.,&\-]*(?:\s+[A-Za-z0-9'’.,&\-]+)*)/.exec(body);
  if (enM && /[A-Za-z]{3,}/.test(enM[1])) {
    const cand = norm(enM[1]).replace(/[.,]$/, "");
    // 過濾掉單字雜訊（例如只剩「cm」）
    if (cand.replace(/[^A-Za-z]/g, "").length >= 3) {
      titleEn = cand;
      body = body.replace(enM[1], " ");
    }
  }

  // 「2006年丙戊」這類干支筆誤：年份已抽走，剩下的裸干支再清掉
  body = body.replace(/[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]/g, " ");
  // 原站把「丙戌」誤打成「丙戊」（戊是干不是支）→ 抽掉，避免污染作品名
  body = body.replace(/丙戊/g, " ");

  // 題字／落款等中文註記留在名字後面
  let name = norm(
    body
      .replace(/[（(]\s*[)）]/g, " ")
      .replace(/(^|\s)年(?=\s|$)/g, " ")
      .replace(/\s{2,}/g, " ")
  ).replace(/^[-–—·\s、,]+|[-–—·\s、,]+$/g, "");

  return {
    code,
    series,
    kind,
    caption: title,
    name: name || null,
    titleEn,
    medium,
    note: notes.length ? notes.join("；") : null,
    width,
    height,
    dimUnit,
    dimRaw,
    year,
    yearGanzhi,
  };
}
