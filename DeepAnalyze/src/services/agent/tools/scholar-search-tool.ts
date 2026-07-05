// =============================================================================
// DeepAnalyze - Scholar Search Tool
// =============================================================================
// Provides academic paper search via Semantic Scholar API and Google Scholar.
// Used for finding research papers, citations, and author information.
// Falls back to web search if primary APIs are unavailable.
// =============================================================================

const SEMANTIC_SCHOLAR_API = "https://api.semanticscholar.org/graph/v1";
const USER_AGENT = "DeepAnalyze/0.1 (https://github.com/deepanalyze)";

// Proxy support for fetch calls
async function getProxyOpts(): Promise<import("../web-proxy.js").ProxyFetchOptions> {
  const proxyUrl = process.env.DEEPANALYZE_WEB_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxyUrl) return {};
  try {
    const { getWebProxyFetchOptions } = await import("../web-proxy.js");
    return getWebProxyFetchOptions();
  } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Semantic Scholar API search
// ---------------------------------------------------------------------------

interface ScholarPaper {
  paperId: string;
  title: string;
  authors: Array<{ name: string }>;
  year: number | null;
  abstract: string | null;
  url: string | null;
  citationCount: number | null;
  venue: string | null;
  externalIds: Record<string, string> | null;
}

async function searchSemanticScholar(
  query: string,
  maxResults: number,
  fields: string[],
): Promise<{ papers: ScholarPaper[]; source: string }> {
  const url = new URL(`${SEMANTIC_SCHOLAR_API}/paper/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(Math.min(maxResults, 20)));
  url.searchParams.set("fields", fields.join(","));

  const proxyOpts = await getProxyOpts();
  const resp = await fetch(url.toString(), {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15000),
    ...proxyOpts,
  });

  if (!resp.ok) {
    throw new Error(`Semantic Scholar API returned HTTP ${resp.status}`);
  }

  const data = await resp.json() as {
    data?: ScholarPaper[];
    total?: number;
  };

  return {
    papers: data.data ?? [],
    source: "Semantic Scholar",
  };
}

async function getAuthorPapers(
  authorName: string,
  maxResults: number,
): Promise<{ papers: ScholarPaper[]; source: string }> {
  // First search for the author
  const searchUrl = new URL(`${SEMANTIC_SCHOLAR_API}/author/search`);
  searchUrl.searchParams.set("query", authorName);
  searchUrl.searchParams.set("limit", "5");

  const searchProxyOpts = await getProxyOpts();
  const searchResp = await fetch(searchUrl.toString(), {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15000),
    ...searchProxyOpts,
  });

  if (!searchResp.ok) {
    throw new Error(`Semantic Scholar author search returned HTTP ${searchResp.status}`);
  }

  const authorData = await searchResp.json() as {
    data?: Array<{ authorId: string; name: string }>;
  };

  const authors = authorData.data ?? [];
  if (authors.length === 0) {
    return { papers: [], source: "Semantic Scholar" };
  }

  // Get papers for the first matching author
  const authorId = authors[0].authorId;
  const papersUrl = new URL(`${SEMANTIC_SCHOLAR_API}/author/${authorId}/papers`);
  papersUrl.searchParams.set("limit", String(Math.min(maxResults, 20)));
  papersUrl.searchParams.set("fields", "title,year,authors,abstract,url,citationCount,venue,externalIds");

  const papersProxyOpts = await getProxyOpts();
  const papersResp = await fetch(papersUrl.toString(), {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15000),
    ...papersProxyOpts,
  });

  if (!papersResp.ok) {
    throw new Error(`Semantic Scholar author papers returned HTTP ${papersResp.status}`);
  }

  const papersData = await papersResp.json() as {
    data?: ScholarPaper[];
  };

  return {
    papers: papersData.data ?? [],
    source: `Semantic Scholar (author: ${authors[0].name})`,
  };
}

async function getPaperDetails(
  paperId: string,
): Promise<{ paper: ScholarPaper & { references?: ScholarPaper[]; citations?: ScholarPaper[] }; source: string }> {
  const url = new URL(`${SEMANTIC_SCHOLAR_API}/paper/${encodeURIComponent(paperId)}`);
  url.searchParams.set("fields", "title,authors,year,abstract,url,citationCount,venue,externalIds,references.title,references.authors,references.year,references.url,citations.title,citations.authors,citations.year,citations.url");

  const detailProxyOpts = await getProxyOpts();
  const resp = await fetch(url.toString(), {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15000),
    ...detailProxyOpts,
  });

  if (!resp.ok) {
    throw new Error(`Semantic Scholar paper detail returned HTTP ${resp.status}`);
  }

  const paper = await resp.json() as ScholarPaper & { references?: ScholarPaper[]; citations?: ScholarPaper[] };

  return { paper, source: "Semantic Scholar" };
}

function formatPaper(paper: ScholarPaper, index: number): string {
  const authors = paper.authors?.map(a => a.name).join(", ") ?? "Unknown";
  const year = paper.year ?? "N/A";
  const venue = paper.venue ? ` [${paper.venue}]` : "";
  const citations = paper.citationCount != null ? ` (cited ${paper.citationCount} times)` : "";
  const doi = paper.externalIds?.DOI ? ` DOI: ${paper.externalIds.DOI}` : "";
  const url = paper.url ?? "";
  const abstract = paper.abstract ? `\n    Abstract: ${paper.abstract.substring(0, 300)}${paper.abstract.length > 300 ? "..." : ""}` : "";

  return `[${index}] ${paper.title}${venue} (${year})\n    Authors: ${authors}${citations}${doi}\n    ${url}${abstract}`;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createScholarSearchTool() {
  return {
    name: "scholar_search",
    description:
      "搜索学术论文。通过 Semantic Scholar API 查找研究论文、作者信息和引用关系。\n\n" +
      "适用场景：\n" +
      "- 查找特定论文（按标题或关键词搜索）\n" +
      "- 查找作者的论文列表\n" +
      "- 获取论文详情（摘要、引用数、DOI等）\n" +
      "- 当 web_search 找不到学术论文时的补充搜索\n\n" +
      "使用建议：\n" +
      "- 用英文搜索效果最好（Semantic Scholar 以英文论文为主）\n" +
      "- 搜索特定论文时，使用论文标题的关键部分\n" +
      "- 找到论文后，可用 paperId 通过 action=get_details 获取完整信息\n" +
      "- 查找作者所有论文时，使用 action=search_author",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["search", "search_author", "get_details"],
          description:
            "操作类型：search=按关键词/标题搜索论文，search_author=按作者名查找其论文列表，get_details=获取特定论文详情（需要 paperId）",
        },
        query: {
          type: "string",
          description: "搜索查询（论文标题关键词或作者姓名）",
        },
        paperId: {
          type: "string",
          description: "论文 ID（Semantic Scholar paperId 或 DOI，仅在 action=get_details 时使用）",
        },
        maxResults: {
          type: "number",
          description: "返回结果的最大数量（默认：10）",
        },
      },
      required: ["action"],
    },
    async execute(input: Record<string, unknown>) {
      const args = input as {
        action: string;
        query?: string;
        paperId?: string;
        maxResults?: number;
      };
      const maxResults = args.maxResults ?? 10;
      const fields = ["title", "authors", "year", "abstract", "url", "citationCount", "venue", "externalIds"];

      try {
        switch (args.action) {
          case "search": {
            if (!args.query) {
              return { error: true, message: "search action requires a 'query' parameter" };
            }
            const result = await searchSemanticScholar(args.query, maxResults, fields);
            if (result.papers.length === 0) {
              return `No academic papers found for "${args.query}". Try different keywords or use web_search as fallback.`;
            }
            return `Source: ${result.source}\n\n` + result.papers.map((p, i) => formatPaper(p, i + 1)).join("\n\n");
          }

          case "search_author": {
            if (!args.query) {
              return { error: true, message: "search_author action requires a 'query' parameter (author name)" };
            }
            const result = await getAuthorPapers(args.query, maxResults);
            if (result.papers.length === 0) {
              return `No papers found for author "${args.query}". Try a different name spelling or use web_search to find the author.`;
            }
            return `Source: ${result.source}\n\n` + result.papers.map((p, i) => formatPaper(p, i + 1)).join("\n\n");
          }

          case "get_details": {
            if (!args.paperId) {
              return { error: true, message: "get_details action requires a 'paperId' parameter" };
            }
            const result = await getPaperDetails(args.paperId);
            const paper = result.paper;
            let output = `Source: ${result.source}\n\n` + formatPaper(paper, 1);

            if (paper.references && paper.references.length > 0) {
              output += `\n\n--- References (${Math.min(paper.references.length, 10)} shown) ---\n`;
              output += paper.references.slice(0, 10).map((r, i) =>
                `[${i + 1}] ${r.title} (${r.year ?? "N/A"}) - ${(r.authors ?? []).map(a => a.name).join(", ")}`
              ).join("\n");
            }

            if (paper.citations && paper.citations.length > 0) {
              output += `\n\n--- Recent Citations (${Math.min(paper.citations.length, 10)} shown) ---\n`;
              output += paper.citations.slice(0, 10).map((c, i) =>
                `[${i + 1}] ${c.title} (${c.year ?? "N/A"}) - ${(c.authors ?? []).map(a => a.name).join(", ")}`
              ).join("\n");
            }

            return output;
          }

          default:
            return { error: true, message: `Unknown action: ${args.action}. Supported: search, search_author, get_details` };
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // If Semantic Scholar fails, suggest web_search as fallback
        if (errMsg.includes("429")) {
          return {
            error: true,
            message: "Semantic Scholar API rate limit reached. Please wait a moment and try again, or use web_search to search for the paper directly.",
            suggestion: "Search for the paper title using web_search, then use web_fetch to access the paper page.",
          };
        }
        return {
          error: true,
          message: `Scholar search failed: ${errMsg}`,
          suggestion: "Try using web_search with the paper title as an alternative.",
        };
      }
    },
  };
}
