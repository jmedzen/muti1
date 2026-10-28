import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// 文章：Markdown 是唯一真實來源（content/md/articles/）。
// 放在 repo 根目錄的 content/ 而不是 site/src/content/，
// 是為了讓 tools/ 底下的驗證腳本讀同一份檔案，不必複製。
const articles = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "../content/md/articles" }),
  schema: z.object({
    title: z.string(),
    category: z.string(),
    order: z.number().optional(),
    publishedAt: z.string().optional(),
    eventDate: z.union([z.string(), z.number()]).optional(),
    hero: z.string().optional(),
    hits: z.string().optional(),
    isStub: z.boolean().optional(),
    bodyHtmlRaw: z.string().optional(),
  }),
});

// 長文（生平、畫論）：單篇，用 md 寫。
const longform = defineCollection({
  loader: glob({ pattern: "*.md", base: "../content/md/longform" }),
  schema: z.object({
    title: z.string(),
    route: z.string(),
    legacyRoute: z.string().optional(),
  }),
});

export const collections = { articles, longform };
