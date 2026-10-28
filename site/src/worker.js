/**
 * Cloudflare Workers 入口
 *
 * 為什麼需要這支 Worker：
 *
 *   Workers 靜態資產對每個檔案都會自己加上 `Cache-Control: public, max-age=0, must-revalidate`，
 *   而 `_headers` 的內容是「附加」上去的，不是覆寫。兩者合併後會變成
 *   `public, max-age=0, must-revalidate, public, max-age=31536000, immutable` ——
 *   瀏覽器只認第一個 max-age=0，等於圖片、字型、JS 全部沒有快取，
 *   每次回訪都要重新下載 33 MB 裡的相關檔案。
 *
 *   所以在 Worker 這一層把標頭「換掉」而不是「加上去」。
 *   指紋化的資產（檔名含 hash 或尺寸）可以永久快取，HTML 則每次驗證。
 */

const IMMUTABLE = /^\/(?:media|_astro|fonts)\//;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const res = await env.ASSETS.fetch(request);

    // 只處理成功的回應；404 / 轉址不要動
    if (!res.ok) return res;

    const headers = new Headers(res.headers);

    if (IMMUTABLE.test(url.pathname)) {
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      headers.set("Access-Control-Allow-Origin", "*");
      // 這些路徑不會變，不必每次問伺服器
      headers.delete("ETag");
    } else if (/\.(?:html?|xml|txt|webmanifest)$/.test(url.pathname) || url.pathname.endsWith("/")) {
      headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    }

    // 搜尋結果頁不進索引
    if (url.pathname === "/search" || url.pathname.startsWith("/search/")) {
      headers.set("X-Robots-Tag", "noindex, follow");
    }

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  },
};
