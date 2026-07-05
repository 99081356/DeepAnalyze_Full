// =============================================================================
// DeepAnalyze - Web Fetch Tool (Multi-Strategy)
// =============================================================================
// Fetches a URL and converts the content to clean Markdown text.
// Strategy chain: Direct HTTP → Baidu Search → MiniMax Search API
// Handles network-restricted environments where some domains are blocked.
// =============================================================================

import axios from "axios";
import TurndownService from "turndown";
import { wrapExternalContent } from "../../../security/prompt-injection.js";

// ---------------------------------------------------------------------------
// Proxy configuration (reads HTTP_PROXY / HTTPS_PROXY env vars)
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
// User-Agent rotation
// ---------------------------------------------------------------------------
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0",
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ---------------------------------------------------------------------------
// Turndown singleton (lazy)
// ---------------------------------------------------------------------------
let turndown: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
  }
  return turndown;
}

// ---------------------------------------------------------------------------
// Simple URL validation
// ---------------------------------------------------------------------------
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Extract title and keywords from URL for search fallback
// ---------------------------------------------------------------------------
function extractSearchQueries(url: string): string[] {
  const parsed = new URL(url);
  const pathSegments = parsed.pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s).replace(/_/g, " ").replace(/-/g, " "));

  const domain = parsed.hostname.replace(/^www\./, "");
  const lastSegment = pathSegments[pathSegments.length - 1] || "";

  const queries: string[] = [];

  // Query 1: site-specific search with title from URL
  if (lastSegment) {
    queries.push(`site:${domain} ${lastSegment}`);
  }

  // Query 2: generic search with URL-derived keywords
  if (lastSegment) {
    queries.push(lastSegment);
  }

  // Query 3: domain + path keywords
  if (pathSegments.length > 1) {
    queries.push(`${domain} ${pathSegments.join(" ")}`);
  }

  return queries.filter((q) => q.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Strategy 1: Direct HTTP fetch
// ---------------------------------------------------------------------------
async function fetchDirect(
  url: string,
  timeout: number = 15_000,
): Promise<{ content: string; bytes: number; statusCode: number; contentType: string }> {
  const proxy = getProxyConfig();
  const response = await axios.get(url, {
    timeout,
    maxContentLength: 5 * 1024 * 1024,
    responseType: "arraybuffer",
    headers: {
      "User-Agent": randomUA(),
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    },
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400,
    ...(proxy ? { proxy } : {}),
  });

  const contentType = response.headers["content-type"] || "application/octet-stream";
  const bytes = response.data.byteLength;
  const statusCode = response.status;

  const text = new TextDecoder("utf-8", { fatal: false }).decode(response.data);

  let content: string;
  if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
    content = getTurndown().turndown(text);
  } else if (contentType.includes("application/pdf") || url.toLowerCase().endsWith(".pdf")) {
    // PDF content - extract text from PDF buffer
    try {
      const { extractPdfText } = await import("./pdf-reader.js");
      const pdfText = await extractPdfText(Buffer.from(response.data));
      content = pdfText || `[PDF 文件，大小: ${bytes} 字节，无法提取文本内容。URL: ${url}]`;
    } catch {
      content = `[PDF 文件，大小: ${bytes} 字节。PDF 文本提取不可用。URL: ${url}]`;
    }
  } else {
    content = text;
  }

  return { content, bytes, statusCode, contentType };
}

// ---------------------------------------------------------------------------
// Strategy 2: Baidu Search fallback
// ---------------------------------------------------------------------------
async function fetchViaBaiduSearch(
  url: string,
  timeout: number = 15_000,
): Promise<{ content: string; source: string } | null> {
  const queries = extractSearchQueries(url);
  if (queries.length === 0) return null;

  const query = queries[0];
  const searchUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;

  try {
    const proxy = getProxyConfig();
    const response = await axios.get(searchUrl, {
      timeout,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
      },
      responseType: "text",
      ...(proxy ? { proxy } : {}),
    });

    const html = response.data as string;
    if (typeof html !== "string" || html.length < 1000) return null;

    // Extract snippets from Baidu search results
    const snippets: string[] = [];

    // Pattern: contentText in JSON data
    const contentTextMatches = html.matchAll(/"contentText":"(.*?)"/g);
    for (const match of contentTextMatches) {
      const text = match[1]
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\u[0-9a-fA-F]{4}/g, (m) => String.fromCharCode(parseInt(m.slice(2), 16)));
      if (text.trim().length > 30) {
        snippets.push(text.trim());
      }
    }

    // Pattern: c-abstract class
    const abstractMatches = html.matchAll(/class="c-abstract[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/g);
    for (const match of abstractMatches) {
      const text = match[1].replace(/<[^>]*>/g, "").trim();
      if (text.length > 30) {
        snippets.push(text);
      }
    }

    // Pattern: titles from result headers
    const titleMatches = html.matchAll(
      /<h3[^>]*class="[^"]*(?:t|title)[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/g,
    );
    for (const match of titleMatches) {
      const text = match[1].replace(/<[^>]*>/g, "").trim();
      if (text.length > 5) {
        snippets.push(`## ${text}`);
      }
    }

    if (snippets.length === 0) return null;

    // Also try fetching from Baidu Baike if relevant
    const baikeContent = await tryBaiduBaike(url);

    let content = `> [搜索结果摘要] 以下内容来自百度搜索（原始页面无法直接访问）\n\n`;
    if (baikeContent) {
      content += `## 百度百科内容\n\n${baikeContent}\n\n---\n\n`;
    }
    content += `## 搜索结果\n\n${snippets.join("\n\n")}`;

    return { content, source: "baidu_search" };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Strategy 2b: Try Baidu Baike for encyclopedic content
// ---------------------------------------------------------------------------
async function tryBaiduBaike(url: string): Promise<string | null> {
  // Only try for Wikipedia-like URLs
  const parsed = new URL(url);
  const isWikiLike =
    parsed.hostname.includes("wikipedia") ||
    parsed.hostname.includes("wiki") ||
    parsed.hostname.includes("britannica") ||
    parsed.hostname.includes("encyclopedia");

  if (!isWikiLike) return null;

  const pathSegments = parsed.pathname.split("/").filter((s) => s.length > 0);
  const title = pathSegments[pathSegments.length - 1];
  if (!title) return null;

  try {
    const baikeUrl = `https://baike.baidu.com/item/${encodeURIComponent(title)}`;
    const proxy = getProxyConfig();
    const response = await axios.get(baikeUrl, {
      timeout: 10_000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
      responseType: "text",
      maxRedirects: 3,
      validateStatus: (status) => status >= 200 && status < 400,
      ...(proxy ? { proxy } : {}),
    });

    const html = response.data as string;
    if (typeof html !== "string" || html.length < 500) return null;

    // Extract main content from Baidu Baike
    const mainContentMatch = html.match(
      /class="(?:J-lemma-content|lemma-summary|main-content)[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    );
    if (mainContentMatch) {
      const text = mainContentMatch[1]
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length > 50) {
        return text.substring(0, 5000);
      }
    }

    // Fallback: extract meta description
    const metaMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/);
    if (metaMatch && metaMatch[1].length > 50) {
      return metaMatch[1].substring(0, 3000);
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Strategy 3: MiniMax Search API fallback
// ---------------------------------------------------------------------------
async function fetchViaMiniMaxSearch(
  url: string,
  apiKey: string,
  apiHost: string,
  timeout: number = 15_000,
): Promise<{ content: string; source: string } | null> {
  const queries = extractSearchQueries(url);
  if (queries.length === 0) return null;

  const allSnippets: string[] = [];

  // Try up to 2 queries
  for (const query of queries.slice(0, 2)) {
    try {
      const response = await axios.post(
        `${apiHost}/v1/coding_plan/search`,
        { q: query },
        {
          timeout,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "MM-API-Source": "DeepAnalyze-WebFetch",
          },
        },
      );

      const data = response.data;
      const statusCode = data?.base_resp?.status_code;
      if (statusCode !== undefined && statusCode !== 0) {
        console.log(`[WebFetch] MiniMax search returned status ${statusCode} for query: ${query}`);
        continue;
      }

      const organic = data.organic || [];
      for (const result of organic) {
        const title = result.title || "";
        const snippet = result.snippet || "";
        const link = result.link || "";
        if (snippet.length > 20) {
          allSnippets.push(`### ${title}\n${snippet}\n[来源: ${link}]`);
        }
      }

      if (allSnippets.length >= 5) break;
    } catch (searchErr) {
      console.log(`[WebFetch] MiniMax search error for query "${query}": ${searchErr instanceof Error ? searchErr.message : String(searchErr)}`);
      continue;
    }
  }

  if (allSnippets.length === 0) return null;

  const content = `> [搜索结果摘要] 以下内容来自 MiniMax 搜索 API（原始页面无法直接访问）\n\n${allSnippets.join("\n\n")}`;
  return { content, source: "minimax_search" };
}

// ---------------------------------------------------------------------------
// Get MiniMax API credentials from settings
// ---------------------------------------------------------------------------
let minimaxCredentials: { apiKey: string; apiHost: string } | null = null;

/**
 * Set MiniMax API credentials (called during tool setup).
 * If not set, the search fallback will be skipped.
 */
export function setMiniMaxCredentials(apiKey: string, apiHost: string): void {
  minimaxCredentials = { apiKey, apiHost };
}

// ---------------------------------------------------------------------------
// Tool export
// ---------------------------------------------------------------------------

/**
 * Create a multi-strategy web_fetch tool for the agent system.
 * Falls back through: Direct HTTP → Baidu Search → MiniMax Search API
 */
export function createWebFetchTool(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
} {
  return {
    name: "web_fetch",
    description:
      "获取指定 URL 的网页内容并转换为 Markdown 文本。" +
      "适用于访问搜索结果中的链接、阅读文章、查看 Wikipedia 页面、获取论文摘要等。" +
      "返回的内容是干净的文本格式，方便阅读和分析。\n\n" +
      "参数：\n" +
      "- url: 目标页面 URL\n" +
      "- offset: 字符偏移量，分段阅读长页面（默认 0）\n" +
      "- max_length: 每次返回最大字符数（默认 30000）\n" +
      "- search: 在页面中搜索关键词，返回匹配位置上下文\n" +
      "- selector: CSS 选择器，提取特定元素内容\n\n" +
      "当目标网站无法直接访问时（网络限制），此工具会自动通过搜索 API 获取相关内容的摘要。" +
      "摘要内容可能不如完整页面详尽，但通常包含关键信息。\n\n" +
      "长页面处理策略：\n" +
      "- 短页面或只需定位关键词：用 search 参数直接搜索\n" +
      "- 中等长度：用 offset 分段阅读\n" +
      "- 长页面需深度分析：用 bash 将内容写入临时文件（如 /tmp/page.md），再用 grep/python3/read_file 等本地工具高效分析\n\n" +
      "注意：此工具使用 HTTP 请求获取内容，无法执行 JavaScript。" +
      "如需与动态网页交互（如点击、填写表单），请使用 browser 工具。",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "要获取内容的网页 URL（必须以 http:// 或 https:// 开头）",
        },
        selector: {
          type: "string",
          description:
            "可选。CSS 选择器，只提取页面中匹配该选择器的元素内容。" +
            "例如 '#content' 只提取 id=content 的元素，'.article-body' 只提取文章正文。" +
            "不提供时返回整个页面的内容。",
        },
        max_length: {
          type: "number",
          description:
            "可选。返回内容的最大字符数。默认 30000。对于很长的页面，" +
            "可以设置较小的值以只获取前面部分内容。",
        },
        offset: {
          type: "number",
          description:
            "可选。返回内容的起始字符偏移量（从 0 开始）。默认 0。" +
            "配合 max_length 实现分段阅读长页面。",
        },
        search: {
          type: "string",
          description:
            "可选。在页面内容中搜索关键词，返回所有匹配位置及其上下文（每处前后各 300 字符）。" +
            "适用于在长页面中快速定位特定信息。",
        },
      },
      required: ["url"],
    },

    async execute(input: Record<string, unknown>) {
      const url = input.url as string;
      const selector = input.selector as string | undefined;
      const maxLength = (input.max_length as number) || 30_000;
      const offset = (input.offset as number) || 0;
      const search = input.search as string | undefined;

      // Validate URL
      if (!url || typeof url !== "string") {
        return { error: true, message: "必须提供 url 参数" };
      }
      if (!isValidUrl(url)) {
        return { error: true, message: `无效的 URL: ${url}` };
      }

      // ------------------------------------------------------------------
      // Strategy 1: Direct HTTP fetch
      // ------------------------------------------------------------------
      try {
        const result = await fetchDirect(url);

        let content = result.content;

        // If selector is provided, try to extract matching section
        if (selector) {
          const idMatch = selector.match(/^#(.+)$/);
          if (idMatch) {
            const targetId = idMatch[1];
            const lines = content.split("\n");
            const sectionStart = lines.findIndex(
              (line) =>
                line.toLowerCase().includes(targetId.replace(/[-_]/g, " ")) &&
                (line.startsWith("#") || line.startsWith("**")),
            );
            if (sectionStart >= 0) {
              const headingMatch = lines[sectionStart].match(/^(#+)/);
              const headingLevel = headingMatch ? headingMatch[1].length : 1;
              let sectionEnd = lines.length;
              for (let i = sectionStart + 1; i < lines.length; i++) {
                const hMatch = lines[i].match(/^(#+)\s/);
                if (hMatch && hMatch[1].length <= headingLevel) {
                  sectionEnd = i;
                  break;
                }
              }
              content = lines.slice(sectionStart, sectionEnd).join("\n");
            }
          }
        }

        // search parameter: find keyword in page markdown content
        if (search) {
          const lowerContent = content.toLowerCase();
          const lowerSearch = search.toLowerCase();
          const matches: Array<{ pos: number; context: string }> = [];
          let searchFrom = 0;
          while (searchFrom < lowerContent.length) {
            const idx = lowerContent.indexOf(lowerSearch, searchFrom);
            if (idx < 0) break;
            const ctxStart = Math.max(0, idx - 300);
            const ctxEnd = Math.min(content.length, idx + search.length + 300);
            matches.push({
              pos: idx,
              context: (ctxStart > 0 ? "..." : "") + content.slice(ctxStart, ctxEnd) + (ctxEnd < content.length ? "..." : ""),
            });
            searchFrom = idx + 1;
            if (matches.length >= 5) break; // max 5 matches
          }

          if (matches.length === 0) {
            return {
              success: true, url,
              content: `[Keyword "${search}" not found in page (${content.length} chars total)]`,
              bytes: result.bytes,
              statusCode: result.statusCode,
              contentType: result.contentType,
              fetchMethod: "direct",
            };
          }

          content = `[Found "${search}" at ${matches.length} position(s) in page (${content.length} chars total)]\n\n` +
            matches.map((m, i) => `--- Match ${i + 1} (position ${m.pos}) ---\n${m.context}`).join("\n\n");
        } else {
          // offset parameter: read from specified position
          const totalChars = content.length;
          if (offset > 0) {
            if (offset >= totalChars) {
              return { error: true, message: `offset ${offset} exceeds page length ${totalChars}` };
            }
            content = `[Showing chars ${offset}-${Math.min(offset + maxLength, totalChars)} of ${totalChars}]\n\n` + content.slice(offset);
          }
        }

        // Truncate if needed — with hint for next offset
        if (content.length > maxLength) {
          const totalChars = content.length;
          content =
            content.substring(0, maxLength) +
            `\n\n... [内容已截断, 共 ${totalChars} 字符. 继续阅读请用 offset=${maxLength}]`;
        }

        // Wrap external content with security boundary markers
        const wrapped = wrapExternalContent(content, {
          source: "web_fetch",
          sourceDetails: `URL: ${url}\nContent-Type: ${result.contentType}\nSize: ${result.bytes} bytes`,
        });
        return {
          success: true,
          url,
          content: wrapped.wrapped,
          bytes: result.bytes,
          statusCode: result.statusCode,
          contentType: result.contentType,
          truncated: result.content.length > maxLength,
          fetchMethod: "direct",
          _security: wrapped.detection?.detected
            ? { injectionWarnings: wrapped.detection.matches }
            : undefined,
        };
      } catch (directErr) {
        // Direct fetch failed - check if it's a network/DNS error
        const isNetworkError =
          axios.isAxiosError(directErr) &&
          (directErr.code === "ECONNABORTED" ||
            directErr.code === "ETIMEDOUT" ||
            directErr.code === "ECONNREFUSED" ||
            directErr.code === "ENETUNREACH" ||
            directErr.code === "EAI_AGAIN" ||
            directErr.code === "ERR_NETWORK" ||
            directErr.code === "EHOSTUNREACH" ||
            !directErr.response);

        // For HTTP error responses (4xx, 5xx), check if we should return error or try fallbacks
        if (!isNetworkError) {
          if (axios.isAxiosError(directErr)) {
            const status = directErr.response?.status;
            if (status === 404) {
              return {
                error: true,
                message: `页面不存在 (404): ${url}`,
                suggestion: "检查 URL 是否正确，或尝试搜索获取正确的链接",
              };
            }
            if (status === 403) {
              // Check for Cloudflare protection — fall through to fallback strategies
              const cfRay = directErr.response?.headers?.['cf-ray'];
              const isCloudflare = !!cfRay || (directErr.response?.data && typeof directErr.response.data === 'string' && directErr.response.data.includes('cloudflare'));
              if (isCloudflare) {
                console.log(`[WebFetch] Cloudflare block (403) for ${url}, trying fallback strategies...`);
                // Fall through to fallback strategies (Wayback, Google Cache, etc.)
              } else {
                return {
                  error: true,
                  message: `访问被拒绝 (403): ${url}`,
                  suggestion: "该网站不允许自动访问，建议使用 web_search 搜索相关内容或尝试其他来源",
                };
              }
            }
            // For 5xx errors, fall through to fallback strategies
            if (status && status >= 500) {
              console.log(`[WebFetch] Server error ${status} for ${url}, trying fallback strategies...`);
              // Fall through to fallback strategies below
            } else {
              // Other HTTP errors (4xx except 403/404) - return error
              return {
                error: true,
                message: `获取页面失败 (${status}): ${directErr instanceof Error ? directErr.message : String(directErr)}`,
                suggestion: "检查 URL 是否正确，或尝试使用 web_search 搜索相关内容",
              };
            }
          } else {
            // Non-Axios, non-network error
            return {
              error: true,
              message: `获取页面失败: ${directErr instanceof Error ? directErr.message : String(directErr)}`,
              suggestion: "检查 URL 是否正确，或尝试使用 web_search 搜索相关内容",
            };
          }
        }
        // For network errors and 5xx errors, continue to fallback strategies

        // ------------------------------------------------------------------
        // Strategy 2: Baidu Search fallback
        // ------------------------------------------------------------------
        console.log(`[WebFetch] Direct fetch failed for ${url}: ${directErr instanceof Error ? directErr.message : String(directErr)}, code=${axios.isAxiosError(directErr) ? directErr.code : 'N/A'}`);
        const baiduResult = await fetchViaBaiduSearch(url);
        if (baiduResult && baiduResult.content.length > 100) {
          let content = baiduResult.content;
          if (content.length > maxLength) {
            content = content.substring(0, maxLength) + "\n\n... [内容已截断]";
          }
          const wrapped = wrapExternalContent(content, {
            source: "web_fetch",
            sourceDetails: `URL: ${url}\nFetch method: baidu_search`,
          });
          return {
            success: true,
            url,
            content: wrapped.wrapped,
            fetchMethod: "baidu_search",
            note: "原始页面无法直接访问，以下内容来自搜索结果摘要。如需更详细信息，建议使用 web_search 工具进行更多搜索。",
          };
        }

        // ------------------------------------------------------------------
        // Strategy 3: MiniMax Search API fallback
        // ------------------------------------------------------------------
        console.log(`[WebFetch] Baidu search failed, trying MiniMax search API fallback...`);
        if (minimaxCredentials) {
          const minimaxResult = await fetchViaMiniMaxSearch(
            url,
            minimaxCredentials.apiKey,
            minimaxCredentials.apiHost,
          );
          console.log(`[WebFetch] MiniMax search result: ${minimaxResult ? `${minimaxResult.content.length} chars` : 'null'}`);
          if (minimaxResult && minimaxResult.content.length > 100) {
            let content = minimaxResult.content;
            if (content.length > maxLength) {
              content = content.substring(0, maxLength) + "\n\n... [内容已截断]";
            }
            const wrapped = wrapExternalContent(content, {
              source: "web_fetch",
              sourceDetails: `URL: ${url}\nFetch method: minimax_search`,
            });
            return {
              success: true,
              url,
              content: wrapped.wrapped,
              fetchMethod: "minimax_search",
              note: "原始页面无法直接访问，以下内容来自搜索结果摘要。如需更详细信息，建议使用 web_search 工具进行更多搜索。",
            };
          }
        } else {
          console.log(`[WebFetch] MiniMax credentials not available, skipping search fallback`);
        }

        // ------------------------------------------------------------------
        // Strategy 4: Wayback Machine fallback
        // ------------------------------------------------------------------
        try {
          const waybackUrl = `https://web.archive.org/web/${url}`;
          console.log(`[WebFetch] Trying Wayback Machine: ${waybackUrl}`);
          const waybackResult = await fetchDirect(waybackUrl, 15_000);
          if (waybackResult.content && waybackResult.content.length > 100) {
            let content = waybackResult.content;
            if (content.length > maxLength) {
              content = content.substring(0, maxLength) + "\n\n... [内容已截断]";
            }
            const wrapped = wrapExternalContent(content, {
              source: "web_fetch",
              sourceDetails: `URL: ${url}\nFetch method: wayback_machine`,
            });
            return {
              success: true,
              url,
              content: wrapped.wrapped,
              fetchMethod: "wayback_machine",
              note: "原始页面无法直接访问，内容来自 Internet Archive Wayback Machine 缓存。",
            };
          }
        } catch (waybackErr) {
          console.log(`[WebFetch] Wayback Machine fallback failed: ${waybackErr instanceof Error ? waybackErr.message : String(waybackErr)}`);
        }

        // ------------------------------------------------------------------
        // Strategy 5: Google Cache fallback
        // ------------------------------------------------------------------
        try {
          const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
          console.log(`[WebFetch] Trying Google Cache`);
          const cacheResult = await fetchDirect(cacheUrl, 15_000);
          if (cacheResult.content && cacheResult.content.length > 100) {
            let content = cacheResult.content;
            if (content.length > maxLength) {
              content = content.substring(0, maxLength) + "\n\n... [内容已截断]";
            }
            const wrapped = wrapExternalContent(content, {
              source: "web_fetch",
              sourceDetails: `URL: ${url}\nFetch method: google_cache`,
            });
            return {
              success: true,
              url,
              content: wrapped.wrapped,
              fetchMethod: "google_cache",
              note: "原始页面无法直接访问，内容来自 Google 缓存。",
            };
          }
        } catch (cacheErr) {
          console.log(`[WebFetch] Google Cache fallback failed: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`);
        }

        // All strategies failed
        return {
          error: true,
          message: `无法获取页面内容: ${url}`,
          suggestion:
            "目标网站在当前网络环境下无法访问，且搜索回退也未找到相关内容。" +
            "建议使用 web_search 工具搜索相关关键词获取信息。",
          originalError: directErr instanceof Error ? directErr.message : String(directErr),
        };
      }
    },
  };
}
