// =============================================================================
// DeepAnalyze - Wikipedia API Tool
// =============================================================================
// Provides structured access to Wikipedia content via the MediaWiki API.
// Supports: page content, search, links, categories, revisions, and more.
// Uses proxy configuration from DEEPANALYZE_WEB_PROXY env var.
// =============================================================================

import axios from "axios";

// ---------------------------------------------------------------------------
// Proxy configuration (reads from saved env var)
// ---------------------------------------------------------------------------
function getProxyConfig(): { host: string; port: number; protocol: string } | false {
  const envKeys = ['DEEPANALYZE_WEB_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];
  let proxyUrl: string | undefined;
  for (const key of envKeys) {
    const val = process.env[key];
    if (val && val.length > 0) {
      proxyUrl = val;
      break;
    }
  }
  if (!proxyUrl) return false;
  try {
    const parsed = new URL(proxyUrl);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port) || (parsed.protocol === "https:" ? 443 : 80),
      protocol: parsed.protocol.replace(":", ""),
    };
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wikipedia API helpers
// ---------------------------------------------------------------------------

const DEFAULT_LANG = "en";
const USER_AGENT = "DeepAnalyze/0.1 (https://github.com/deepanalyze)";

interface WikiPageContent {
  title: string;
  pageId: number;
  content: string;
  sections: WikiSection[];
  lastModified: string;
  lastEditor: string;
  revisionId: number;
  lang: string;
}

interface WikiSection {
  tocLevel: number;
  level: number;
  line: string; // section title
  number: string; // e.g. "1.2.3"
  index: number;
}

interface WikiSearchResult {
  title: string;
  snippet: string;
  pageId: number;
  wordCount: number;
  timestamp: string;
}

interface WikiRevision {
  revid: number;
  parentid: number;
  user: string;
  timestamp: string;
  comment: string;
  size: number;
}

interface WikiPageInfo {
  title: string;
  pageId: number;
  lastModified: string;
  lastEditor: string;
  revisionCount: number;
  length: number;
  categories: string[];
  links: string[];
  langLinks: Record<string, string>;
}

async function wikiApiRequest(
  params: Record<string, string>,
  lang: string = DEFAULT_LANG,
): Promise<Record<string, unknown>> {
  const url = `https://${lang}.wikipedia.org/w/api.php`;
  const query = new URLSearchParams({
    format: "json",
    ...params,
  });

  const proxy = getProxyConfig();
  const response = await axios.get(`${url}?${query.toString()}`, {
    timeout: 15_000,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    ...(proxy ? { proxy } : {}),
  });

  return response.data as Record<string, unknown>;
}

async function wikiRestRequest(
  path: string,
  lang: string = DEFAULT_LANG,
): Promise<unknown> {
  const url = `https://${lang}.wikipedia.org/api/rest_v1${path}`;
  const proxy = getProxyConfig();

  const response = await axios.get(url, {
    timeout: 15_000,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    ...(proxy ? { proxy } : {}),
  });

  return response.data;
}

// ---------------------------------------------------------------------------
// Action implementations
// ---------------------------------------------------------------------------

async function getPage(title: string, lang: string, section?: number): Promise<WikiPageContent> {
  // First get the parsed content via REST API for clean HTML
  const encodedTitle = encodeURIComponent(title);
  let restPath = `/page/html/${encodedTitle}`;
  if (section !== undefined) {
    // Fall back to action API for specific sections
    const data = await wikiApiRequest({
      action: "parse",
      page: title,
      prop: "wikitext|sections",
      section: String(section),
      redirects: "true",
    }, lang);

    const parse = data.parse as Record<string, unknown>;
    const wikitext = (parse?.wikitext as Record<string, unknown>)?.["*"] as string || "";
    const sections = (parse?.sections as unknown[])?.map((s: any) => ({
      tocLevel: s.toclevel,
      level: s.level,
      line: s.line,
      number: s.number,
      index: s.index,
    })) || [];

    return {
      title: (parse?.title as string) || title,
      pageId: (parse?.pageid as number) || 0,
      content: wikitext,
      sections,
      lastModified: "",
      lastEditor: "",
      revisionId: 0,
      lang,
    };
  }

  // Get clean HTML via REST API
  try {
    const html = await wikiRestRequest(`/page/html/${encodedTitle}`, lang) as string;

    // Get sections via action API
    const sectionData = await wikiApiRequest({
      action: "parse",
      page: title,
      prop: "sections",
      redirects: "true",
    }, lang);

    const parse = sectionData.parse as Record<string, unknown>;
    const sections = (parse?.sections as unknown[])?.map((s: any) => ({
      tocLevel: s.toclevel,
      level: s.level,
      line: s.line,
      number: s.number,
      index: s.index,
    })) || [];

    // Strip HTML to plain text (basic)
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/h[1-6]>/gi, "\n\n")
      .replace(/<h[1-6][^>]*>/gi, "## ")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return {
      title: title,
      pageId: 0,
      content: text,
      sections,
      lastModified: "",
      lastEditor: "",
      revisionId: 0,
      lang,
    };
  } catch {
    // Fall back to action=parse for wikitext
    const data = await wikiApiRequest({
      action: "parse",
      page: title,
      prop: "wikitext|sections",
      redirects: "true",
    }, lang);

    const parse = data.parse as Record<string, unknown>;
    const wikitext = (parse?.wikitext as Record<string, unknown>)?.["*"] as string || "";
    const sections = (parse?.sections as unknown[])?.map((s: any) => ({
      tocLevel: s.toclevel,
      level: s.level,
      line: s.line,
      number: s.number,
      index: s.index,
    })) || [];

    return {
      title: (parse?.title as string) || title,
      pageId: (parse?.pageid as number) || 0,
      content: wikitext,
      sections,
      lastModified: "",
      lastEditor: "",
      revisionId: 0,
      lang,
    };
  }
}

async function searchPages(query: string, lang: string, limit: number = 10): Promise<WikiSearchResult[]> {
  const data = await wikiApiRequest({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: String(limit),
    srprop: "snippet|wordcount|timestamp",
  }, lang);

  const searchResults = (data.query as Record<string, unknown>)?.search as any[] || [];
  return searchResults.map((r: any) => ({
    title: r.title,
    snippet: r.snippet?.replace(/<[^>]+>/g, "") || "",
    pageId: r.pageid,
    wordCount: r.wordcount,
    timestamp: r.timestamp,
  }));
}

async function getPageInfo(title: string, lang: string): Promise<WikiPageInfo> {
  const data = await wikiApiRequest({
    action: "query",
    titles: title,
    prop: "info|categories|links|langlinks",
    inprop: "url|displaytitle|timestamp|user",
    cllimit: "50",
    pllimit: "50",
    lllimit: "50",
    redirects: "true",
  }, lang);

  const pages = (data.query as Record<string, unknown>)?.pages as Record<string, any>;
  if (!pages) throw new Error(`Page not found: ${title}`);

  const page = Object.values(pages)[0] as any;
  if (!page || page.missing !== undefined) throw new Error(`Page not found: ${title}`);

  return {
    title: page.title,
    pageId: page.pageid,
    lastModified: page.touched || "",
    lastEditor: page.lastrevid ? String(page.lastrevid) : "",
    revisionCount: page.revisions?.length || 0,
    length: page.length || 0,
    categories: (page.categories || []).map((c: any) => c.title),
    links: (page.links || []).map((l: any) => l.title),
    langLinks: Object.fromEntries(
      (page.langlinks || []).map((ll: any) => [ll.lang, ll["*"]]),
    ),
  };
}

async function getRevisions(
  title: string,
  lang: string,
  limit: number = 50,
  options?: { start?: string; end?: string; dir?: "newer" | "older" },
): Promise<WikiRevision[]> {
  const params: Record<string, string> = {
    action: "query",
    titles: title,
    prop: "revisions",
    rvlimit: String(Math.min(limit, 500)),
    rvprop: "ids|timestamp|user|comment|size",
    redirects: "true",
  };

  if (options?.start) params.rvstart = options.start;
  if (options?.end) params.rvend = options.end;
  if (options?.dir) params.rvdir = options.dir;

  const data = await wikiApiRequest(params, lang);

  const pages = (data.query as Record<string, unknown>)?.pages as Record<string, any>;
  if (!pages) throw new Error(`Page not found: ${title}`);

  const page = Object.values(pages)[0] as any;
  if (!page || page.missing !== undefined) throw new Error(`Page not found: ${title}`);

  return (page.revisions || []).map((r: any) => ({
    revid: r.revid,
    parentid: r.parentid,
    user: r.user,
    timestamp: r.timestamp,
    comment: r.comment || "",
    size: r.size,
  }));
}

async function getLinks(title: string, lang: string): Promise<string[]> {
  const data = await wikiApiRequest({
    action: "query",
    titles: title,
    prop: "links",
    pllimit: "500",
    redirects: "true",
  }, lang);

  const pages = (data.query as Record<string, unknown>)?.pages as Record<string, any>;
  if (!pages) return [];

  const page = Object.values(pages)[0] as any;
  return (page.links || []).map((l: any) => l.title);
}

async function getTableOfContents(title: string, lang: string): Promise<WikiSection[]> {
  const data = await wikiApiRequest({
    action: "parse",
    page: title,
    prop: "sections",
    redirects: "true",
  }, lang);

  const parse = data.parse as Record<string, unknown>;
  return ((parse?.sections as unknown[]) || []).map((s: any) => ({
    tocLevel: s.toclevel,
    level: s.level,
    line: s.line,
    number: s.number,
    index: s.index,
  }));
}

// ---------------------------------------------------------------------------
// Tool export
// ---------------------------------------------------------------------------

export function createWikipediaTool(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
} {
  return {
    name: "wikipedia",
    description:
      "访问维基百科（Wikipedia）的结构化内容。支持多种操作模式：" +
      "\n- get_page: 获取维基百科页面的完整文本内容（可指定章节编号）" +
      "\n- search: 搜索维基百科，返回匹配的页面列表和摘要" +
      "\n- get_info: 获取页面元信息（分类、链接、最后修改日期、页面大小等）" +
      "\n- get_revisions: 获取页面的编辑历史（修订记录），支持按时间范围过滤（start/end）和排序方向（dir），limit 最大 500" +
      "\n- get_links: 获取页面中的所有内部链接（最多500个）" +
      "\n- get_toc: 获取页面的目录结构（章节列表）" +
      "\n\n使用场景：" +
      "\n- 查询人物、地点、事件的百科信息" +
      "\n- 获取特定维基百科页面的详细内容" +
      "\n- 浏览页面编辑历史或统计信息" +
      "\n- 查找页面中的特定章节" +
      "\n\n注意：此工具访问的是公共维基百科（Wikipedia.org），不是本地知识库。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get_page", "search", "get_info", "get_revisions", "get_links", "get_toc"],
          description:
            "操作类型：" +
            "get_page=获取页面内容, search=搜索页面, get_info=页面元信息, " +
            "get_revisions=编辑历史, get_links=内部链接, get_toc=目录结构",
        },
        title: {
          type: "string",
          description: "维基百科页面标题（如 'Mercedes Sosa'）。用于 get_page/get_info/get_revisions/get_links/get_toc。",
        },
        query: {
          type: "string",
          description: "搜索查询文本。用于 search 操作。",
        },
        lang: {
          type: "string",
          description: "维基百科语言代码（默认 'en' 英文）。如 'zh' 中文, 'fr' 法文等。",
        },
        section: {
          type: "number",
          description: "获取特定章节编号的内容（用于 get_page）。不提供则返回整页。",
        },
        limit: {
          type: "number",
          description: "返回结果数量限制。search 默认10, get_revisions 默认50（最大500）。",
        },
        start: {
          type: "string",
          description: "修订起始时间戳（ISO 8601 格式，如 '2023-01-01T00:00:00Z'）。仅用于 get_revisions。",
        },
        end: {
          type: "string",
          description: "修订结束时间戳（ISO 8601 格式）。仅用于 get_revisions。",
        },
        dir: {
          type: "string",
          enum: ["newer", "older"],
          description: "修订排序方向：newer=从旧到新，older=从新到旧（默认）。仅用于 get_revisions。",
        },
      },
      required: ["action"],
    },

    async execute(input: Record<string, unknown>) {
      const action = input.action as string;
      const title = input.title as string | undefined;
      const query = input.query as string | undefined;
      const lang = (input.lang as string) || DEFAULT_LANG;
      const section = input.section as number | undefined;
      const limit = (input.limit as number) || 10; // search defaults to 10; get_revisions overrides below

      try {
        switch (action) {
          case "get_page": {
            if (!title) return { error: true, message: "get_page 需要 title 参数" };
            const page = await getPage(title, lang, section);
            // Truncate content if too long
            const maxLen = 30000;
            const truncated = page.content.length > maxLen;
            const content = truncated
              ? page.content.substring(0, maxLen) + "\n\n... [内容已截断，完整页面共 " + page.content.length + " 字符]"
              : page.content;
            return {
              success: true,
              title: page.title,
              pageId: page.pageId,
              content,
              sections: page.sections,
              truncated,
              lang: page.lang,
            };
          }

          case "search": {
            if (!query) return { error: true, message: "search 需要 query 参数" };
            const results = await searchPages(query, lang, limit);
            return {
              success: true,
              query,
              results,
              count: results.length,
              lang,
            };
          }

          case "get_info": {
            if (!title) return { error: true, message: "get_info 需要 title 参数" };
            const info = await getPageInfo(title, lang);
            return { success: true, ...info };
          }

          case "get_revisions": {
            if (!title) return { error: true, message: "get_revisions 需要 title 参数" };
            const revLimit = (input.limit as number) || 50;
            const revOptions: { start?: string; end?: string; dir?: "newer" | "older" } = {};
            if (input.start) revOptions.start = input.start as string;
            if (input.end) revOptions.end = input.end as string;
            if (input.dir) revOptions.dir = input.dir as "newer" | "older";
            const revisions = await getRevisions(title, lang, revLimit, revOptions);
            return {
              success: true,
              title,
              revisions,
              count: revisions.length,
              lang,
            };
          }

          case "get_links": {
            if (!title) return { error: true, message: "get_links 需要 title 参数" };
            const links = await getLinks(title, lang);
            return {
              success: true,
              title,
              links,
              count: links.length,
              lang,
            };
          }

          case "get_toc": {
            if (!title) return { error: true, message: "get_toc 需要 title 参数" };
            const toc = await getTableOfContents(title, lang);
            return {
              success: true,
              title,
              sections: toc,
              count: toc.length,
              lang,
            };
          }

          default:
            return { error: true, message: `未知操作: ${action}` };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          error: true,
          message: `维基百科操作失败: ${message}`,
          suggestion: "检查标题拼写，或使用 search 操作搜索正确的页面标题",
        };
      }
    },
  };
}
