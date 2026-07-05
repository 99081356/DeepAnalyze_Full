// =============================================================================
// DeepAnalyze - MCP Builtin Adapters
// =============================================================================
// Wraps internal capabilities (VLM image analysis, web search) as MCP servers
// so they appear in the MCP management UI and are managed consistently.
// =============================================================================

import type { AgentTool } from "./types.js";

// ---------------------------------------------------------------------------
// Builtin MCP tool definitions
// ---------------------------------------------------------------------------

interface BuiltinMCPToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// VLM Image Analysis adapter
// ---------------------------------------------------------------------------

function createVLMTools(): BuiltinMCPToolDef[] {
  return [
    {
      name: "analyze_image",
      description:
        "使用视觉语言模型（VLM）分析图片。" +
        "支持五种图片引用方式：" +
        "session-media://{sessionId}/{mediaId}、kb://{kbId}/{docId}、http(s)://URL、" +
        "data:image/ base64 URI、本地文件路径。",
      inputSchema: {
        type: "object",
        properties: {
          imageRef: {
            type: "string",
            description: "图片引用（session-media://、kb://、http(s)://、data:image/、本地路径）",
          },
          prompt: {
            type: "string",
            description: "分析指令",
          },
        },
        required: ["imageRef", "prompt"],
      },
      async execute(input: Record<string, unknown>) {
        const imageRef = input.imageRef as string;
        const prompt = input.prompt as string;
        if (!imageRef || !prompt) return { error: "imageRef and prompt are required." };

        const { CapabilityDispatcher } = await import("../../models/capability-dispatcher.js");
        const dispatcher = new CapabilityDispatcher();

        // Resolve image reference to data URL (same logic as tool-setup.ts image_analysis)
        let imageDataUrl: string;

        if (imageRef.startsWith("session-media://")) {
          const { getRepos } = await import("../../store/repos/index.js");
          const repos = await getRepos();
          // Read dataDir from settings or config
          const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
          const path = imageRef.slice("session-media://".length);
          const [sessionId, mediaId] = path.split("/");
          if (!sessionId || !mediaId) return { error: `Invalid session-media reference: ${imageRef}` };
          const { MediaStore } = await import("../session/media-store.js");
          const dataUri = await MediaStore.toDataUri(DEEPANALYZE_CONFIG.dataDir, sessionId, mediaId);
          if (!dataUri) return { error: `Media file not found: ${imageRef}` };
          imageDataUrl = dataUri;
        } else if (imageRef.startsWith("kb://")) {
          const match = imageRef.match(/^kb:\/\/([^/]+)\/([^/]+)$/);
          if (!match) return { error: "Invalid kb:// format. Use: kb://{kbId}/{docId}" };
          const [, , docId] = match;
          const { getRepos } = await import("../../store/repos/index.js");
          const repos = await getRepos();
          const doc = await repos.document.getById(docId);
          if (!doc?.file_path) return { error: `Document ${docId} not found or has no file_path.` };
          const { readFile } = await import("node:fs/promises");
          const buffer = await readFile(doc.file_path);
          const ext = doc.file_path.split(".").pop()?.toLowerCase() ?? "png";
          const mimeMap: Record<string, string> = {
            png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
            gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
          };
          imageDataUrl = `data:${mimeMap[ext] ?? "image/png"};base64,${buffer.toString("base64")}`;
        } else if (imageRef.startsWith("http://") || imageRef.startsWith("https://")) {
          imageDataUrl = imageRef;
        } else if (imageRef.startsWith("data:image/")) {
          imageDataUrl = imageRef;
        } else {
          const { readFile } = await import("node:fs/promises");
          const { isAbsolute, resolve } = await import("node:path");
          const resolvedPath = isAbsolute(imageRef) ? imageRef : resolve(process.cwd(), imageRef);
          const buffer = await readFile(resolvedPath);
          const ext = resolvedPath.split(".").pop()?.toLowerCase() ?? "png";
          const mimeMap: Record<string, string> = {
            png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
            gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
          };
          imageDataUrl = `data:${mimeMap[ext] ?? "image/png"};base64,${buffer.toString("base64")}`;
        }

        const result = await dispatcher.analyzeImage(imageDataUrl, prompt);
        return { analysis: result.content };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Web Search adapter
// ---------------------------------------------------------------------------

function createWebSearchTools(): BuiltinMCPToolDef[] {
  return [
    {
      name: "search",
      description:
        "搜索网络获取信息。返回包含标题、URL 和摘要的搜索结果。" +
        "适用于查找知识库中没有的最新信息。",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索查询",
          },
          maxResults: {
            type: "number",
            description: "返回结果的最大数量（默认：10）",
          },
        },
        required: ["query"],
      },
      async execute(input: Record<string, unknown>) {
        const query = (input as { query: string; maxResults?: number }).query;
        const maxResults = (input as { maxResults?: number }).maxResults ?? 10;
        const backend = process.env.SEARCH_BACKEND ?? "searxng";

        const { getWebProxyFetchOptions } = await import("./web-proxy.js");
        const proxyOpts = getWebProxyFetchOptions();

        try {
          if (backend === "serper") {
            const apiKey = process.env.SERPER_API_KEY;
            if (!apiKey) return { error: "SERPER_API_KEY not configured." };
            const resp = await fetch("https://google.serper.dev/search", {
              method: "POST",
              headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
              body: JSON.stringify({ q: query, num: maxResults }),
              signal: AbortSignal.timeout(15000),
              ...proxyOpts,
            });
            if (!resp.ok) return { error: `Search failed: HTTP ${resp.status}` };
            const data = await resp.json() as { organic?: Array<{ title: string; link: string; snippet: string }> };
            return (data.organic ?? []).slice(0, maxResults)
              .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.link}\n    ${r.snippet}`)
              .join("\n\n") || `No results for "${query}".`;
          }

          if (backend === "minimax") {
            const { getRepos } = await import("../../store/repos/index.js");
            const repos = await getRepos();
            const settings = await repos.settings.getProviderSettings();
            const provider = settings.providers.find(
              (p: { id: string; enabled: boolean }) => p.id.startsWith("minimax") && p.enabled,
            );
            if (!provider?.apiKey) return { error: "MiniMax provider not configured." };

            try {
              // MiniMax search API — coding_plan/search endpoint
              const minimaxBaseUrl = provider.id.includes("global")
                ? "https://api.minimax.io"
                : "https://api.minimaxi.com";
              const resp = await fetch(`${minimaxBaseUrl}/v1/coding_plan/search`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({ q: query }),
                signal: AbortSignal.timeout(15000),
                ...proxyOpts,
              });
              if (resp.ok) {
                const data = await resp.json() as { organic?: Array<{ title: string; link: string; snippet: string; date?: string }> };
                const results = (data.organic ?? []).slice(0, maxResults);
                if (results.length > 0) {
                  return results.map((r, i) => {
                    const link = r.link ?? "";
                    const rawSnippet = r.snippet ?? "";
                    const snippet = rawSnippet.length > 1500
                      ? rawSnippet.slice(0, 1500) + `\n    [... ${rawSnippet.length} chars total, showing first 1500]`
                      : rawSnippet;
                    return `[${i + 1}] ${r.title}\n    ${link}\n    ${snippet}`;
                  }).join("\n\n");
                }
              }
            } catch { /* fall through to Baidu */ }

            // Baidu HTML fallback
            try {
              const baiduResp = await fetch(`http://www.baidu.com/s?wd=${encodeURIComponent(query)}`, {
                headers: { "User-Agent": "Mozilla/5.0" },
                signal: AbortSignal.timeout(15000),
                ...proxyOpts,
              });
              if (baiduResp.ok) {
                const html = await baiduResp.text();
                const titles: string[] = [];
                let match: RegExpExecArray | null;
                const re = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
                let count = 0;
                while ((match = re.exec(html)) !== null && count < maxResults) {
                  const title = match[1].replace(/<[^>]*>/g, "").trim();
                  if (title.length >= 5) { titles.push(`[${count + 1}] ${title}`); count++; }
                }
                if (titles.length > 0) return titles.join("\n");
              }
            } catch { /* ignore */ }
            return { error: `Search failed for "${query}".` };
          }

          // SearXNG
          const searxngUrl = process.env.SEARXNG_URL ?? "http://localhost:8888";
          const resp = await fetch(
            `${searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general`,
            { signal: AbortSignal.timeout(15000), ...proxyOpts },
          );
          if (!resp.ok) return { error: `SearXNG failed: HTTP ${resp.status}` };
          const data = await resp.json() as { results?: Array<{ title: string; url: string; content: string }> };
          return (data.results ?? []).slice(0, maxResults)
            .map((r, i) => {
              const raw = r.content ?? "";
              const snippet = raw.length > 1500
                ? raw.slice(0, 1500) + `\n    [... ${raw.length} chars total, showing first 1500]`
                : raw;
              return `[${i + 1}] ${r.title}\n    ${r.url}\n    ${snippet}`;
            })
            .join("\n\n") || `No results for "${query}".`;
        } catch (err) {
          return { error: `Search failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuiltinMCPServer {
  id: string;
  name: string;
  tools: BuiltinMCPToolDef[];
}

/**
 * Get the list of builtin MCP servers.
 * Each server wraps an internal capability as an MCP-compatible tool set.
 */
export function getBuiltinMCPServers(): BuiltinMCPServer[] {
  return [
    {
      id: "vlm",
      name: "vlm",
      tools: createVLMTools(),
    },
    {
      id: "websearch",
      name: "websearch",
      tools: createWebSearchTools(),
    },
  ];
}

/**
 * Register builtin MCP server tools into the ToolRegistry.
 * Tools are prefixed with `mcp__{serverName}__{toolName}`.
 */
export function registerBuiltinMCPTools(
  registry: { register: (tool: AgentTool) => void },
): void {
  for (const server of getBuiltinMCPServers()) {
    for (const toolDef of server.tools) {
      const tool: AgentTool = {
        name: `mcp__${server.name}__${toolDef.name}`,
        description: toolDef.description,
        inputSchema: toolDef.inputSchema,
        execute: toolDef.execute,
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        shouldDefer: true,
      };
      registry.register(tool);
    }
  }
}
