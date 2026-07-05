// =============================================================================
// DeepAnalyze - YouTube Transcript Tool
// =============================================================================
// Extracts transcripts/captions and metadata from YouTube videos.
// Uses yt-dlp subprocess as primary method (most reliable against bot detection),
// with page-scraping fallback for basic info.
// Uses proxy configuration from DEEPANALYZE_WEB_PROXY env var.
// =============================================================================

import axios from "axios";
import { execFile } from "child_process";

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

function getProxyUrl(): string | undefined {
  const envKeys = ['DEEPANALYZE_WEB_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];
  for (const key of envKeys) {
    const val = process.env[key];
    if (val && val.length > 0) return val;
  }
  return undefined;
}

function getCookiesPath(): string | undefined {
  return process.env.DEEPANALYZE_YOUTUBE_COOKIES;
}

// ---------------------------------------------------------------------------
// YouTube helpers
// ---------------------------------------------------------------------------

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface TranscriptEntry {
  text: string;
  start: number;
  duration: number;
}

/**
 * Extract video ID from various YouTube URL formats.
 */
function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pat of patterns) {
    const match = url.match(pat);
    if (match) return match[1];
  }
  return null;
}

/**
 * Build common yt-dlp args (proxy, cookies).
 */
function buildYtdlpArgs(): string[] {
  const args: string[] = [];
  const proxyUrl = getProxyUrl();
  if (proxyUrl) args.push("--proxy", proxyUrl);
  const cookiesPath = getCookiesPath();
  if (cookiesPath) args.push("--cookies", cookiesPath);
  return args;
}

/**
 * Run a yt-dlp command and return its stdout.
 */
function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile("yt-dlp", args, {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Get video metadata via yt-dlp --dump-single-json.
 */
async function getYtdlpVideoInfo(videoId: string): Promise<Record<string, any>> {
  const args = [
    ...buildYtdlpArgs(),
    "--dump-single-json",
    "--no-download",
    "--no-warnings",
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  const stdout = await runYtDlp(args);
  return JSON.parse(stdout);
}

/**
 * Get video subtitles via yt-dlp (writes to temp file, reads it back).
 */
async function getYtdlpSubtitles(videoId: string, lang: string): Promise<TranscriptEntry[]> {
  const tmpBase = `/tmp/da_yt_${videoId}_${Date.now()}`;

  const args = [
    ...buildYtdlpArgs(),
    "--write-subs", "--write-auto-subs",
    "--skip-download",
    "--sub-format", "json3",
    "--sub-lang", lang,
    "-o", tmpBase,
    "--no-warnings",
    `https://www.youtube.com/watch?v=${videoId}`,
  ];

  try {
    await runYtDlp(args);
  } catch (e) {
    // Try without manual subs (auto-only)
    const args2 = [
      ...buildYtdlpArgs(),
      "--write-auto-subs", "--skip-download",
      "--sub-format", "json3", "--sub-lang", lang,
      "-o", tmpBase, "--no-warnings",
      `https://www.youtube.com/watch?v=${videoId}`,
    ];
    try {
      await runYtDlp(args2);
    } catch {
      return [];
    }
  }

  // Read the subtitle file
  const fs = await import("fs/promises");
  const subFile = `${tmpBase}.${lang}.json3`;
  try {
    const content = await fs.readFile(subFile, "utf-8");
    // Cleanup
    await fs.unlink(subFile).catch(() => {});
    const data = JSON.parse(content);
    const entries: TranscriptEntry[] = [];
    for (const event of data.events || []) {
      const segs = event.segs || [];
      const text = segs.map((s: any) => s.utf8 || "").join("").trim();
      if (text && !text.startsWith("[") && !text.includes("__")) {
        entries.push({
          text,
          start: (event.tStartMs || 0) / 1000,
          duration: (event.dDurationMs || 0) / 1000,
        });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Invidious API fallback for transcripts (bypasses YouTube rate limits)
// ---------------------------------------------------------------------------

const INVIDIOUS_INSTANCES = [
  "https://inv.tux.pizza",
  "https://vid.puffyan.us",
  "https://invidious.lunar.icu",
  "https://yewtu.be",
];

/**
 * Try fetching captions via Invidious API (public YouTube frontend).
 * Returns transcript entries or empty array if all instances fail.
 */
async function getInvidiousTranscript(videoId: string, lang: string): Promise<TranscriptEntry[]> {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      // Step 1: Get available caption tracks
      const captionsUrl = `${instance}/api/v1/captions/${videoId}`;
      const proxy = getProxyConfig();
      const resp = await axios.get(captionsUrl, {
        headers: { "User-Agent": USER_AGENT },
        proxy: proxy || undefined,
        timeout: 15000,
        validateStatus: () => true,
      });

      if (resp.status !== 200 || !resp.data?.captions) continue;

      const captions = resp.data.captions as Array<{ language_code: string; url: string; label: string }>;

      // Find the requested language, fall back to English
      let caption = captions.find(c => c.language_code === lang);
      if (!caption && lang !== "en") {
        caption = captions.find(c => c.language_code === "en");
      }
      if (!caption) {
        caption = captions[0];
      }
      if (!caption) continue;

      // Step 2: Fetch the actual caption content (JSON3 format)
      let captionUrl = caption.url;
      if (!captionUrl.startsWith("http")) {
        captionUrl = `${instance}${captionUrl}`;
      }
      // Request JSON3 format for structured data
      const separator = captionUrl.includes("?") ? "&" : "?";
      captionUrl += `${separator}fmt=json3`;

      const captionResp = await axios.get(captionUrl, {
        headers: { "User-Agent": USER_AGENT },
        proxy: proxy || undefined,
        timeout: 15000,
        validateStatus: () => true,
      });

      if (captionResp.status !== 200) continue;

      const data = captionResp.data;
      const entries: TranscriptEntry[] = [];
      for (const event of data.events || []) {
        const segs = event.segs || [];
        const text = segs.map((s: any) => s.utf8 || "").join("").trim();
        if (text && !text.startsWith("[") && !text.includes("__")) {
          entries.push({
            text,
            start: (event.tStartMs || 0) / 1000,
            duration: (event.dDurationMs || 0) / 1000,
          });
        }
      }

      if (entries.length > 0) {
        console.log(`[YouTube] Got ${entries.length} transcript entries from Invidious (${instance})`);
        return entries;
      }
    } catch (err) {
      // Try next instance
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[YouTube] Invidious instance ${instance} failed: ${msg}`);
      continue;
    }
  }
  return [];
}

/**
 * Try fetching captions via YouTube's internal timedtext API.
 */
async function getTimedtextTranscript(videoId: string, lang: string): Promise<TranscriptEntry[]> {
  const proxy = getProxyConfig();
  const langs = lang !== "en" ? [lang, "en"] : ["en"];

  for (const tryLang of langs) {
    try {
      const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${tryLang}&fmt=json3`;
      const resp = await axios.get(url, {
        headers: { "User-Agent": USER_AGENT },
        proxy: proxy || undefined,
        timeout: 15000,
        validateStatus: () => true,
      });

      if (resp.status !== 200) continue;

      const data = resp.data;
      const entries: TranscriptEntry[] = [];
      for (const event of data.events || []) {
        const segs = event.segs || [];
        const text = segs.map((s: any) => s.utf8 || "").join("").trim();
        if (text && !text.startsWith("[") && !text.includes("__")) {
          entries.push({
            text,
            start: (event.tStartMs || 0) / 1000,
            duration: (event.dDurationMs || 0) / 1000,
          });
        }
      }

      if (entries.length > 0) {
        console.log(`[YouTube] Got ${entries.length} transcript entries from timedtext API (lang=${tryLang})`);
        return entries;
      }
    } catch {
      continue;
    }
  }
  return [];
}

/**
 * Get video metadata via page scraping (fallback when yt-dlp is unavailable).
 */
async function getPageVideoInfo(videoId: string): Promise<{
  title: string;
  author: string;
  description: string;
  lengthSeconds: number;
}> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const proxy = getProxyConfig();
  const resp = await axios.get(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
    proxy: proxy || undefined,
    timeout: 30000,
  });
  const html = resp.data as string;

  // Extract title from og:meta or title tag
  let title = "Unknown";
  const titleMatch = html.match(/<meta\s+name="title"\s+content="([^"]+)"/)
    || html.match(/<title>([^<]+)<\/title>/);
  if (titleMatch) title = titleMatch[1].replace(/ - YouTube$/, "");

  // Extract author
  let author = "Unknown";
  const authorMatch = html.match(/"ownerChannelName":"([^"]+)"/)
    || html.match(/<link\s+itemprop="name"\s+content="([^"]+)"/);
  if (authorMatch) author = authorMatch[1];

  // Extract description
  let description = "";
  const descMatch = html.match(/"shortDescription":"([^"]*?)"/);
  if (descMatch) description = descMatch[1].replace(/\\n/g, "\n").substring(0, 2000);

  // Extract length
  let lengthSeconds = 0;
  const lenMatch = html.match(/"lengthSeconds":"(\d+)"/);
  if (lenMatch) lengthSeconds = parseInt(lenMatch[1]);

  return { title, author, description, lengthSeconds };
}

/**
 * Format seconds to MM:SS or HH:MM:SS timestamp.
 */
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Tool creation
// ---------------------------------------------------------------------------

export function createYouTubeTool(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
} {
  return {
    name: "youtube_transcript",
    description:
      "获取 YouTube 视频的字幕文本和元数据信息。支持以下操作：" +
      "\n- get_transcript: 获取视频的完整字幕/文本内容（带时间戳），支持指定语言" +
      "\n- get_info: 获取视频的基本信息（标题、作者、时长、简介等）" +
      "\n\n使用场景：" +
      "\n- 获取 YouTube 视频的完整对话/旁白内容" +
      "\n- 查找视频中特定时间点提到的内容" +
      "\n- 分析视频中的数字、名称等具体信息" +
      "\n- 获取视频标题、频道名称等元数据" +
      "\n\n注意：某些视频可能没有字幕（自动生成或手动上传）。需要 yt-dlp 命令行工具。",

    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get_transcript", "get_info"],
          description:
            "操作类型：get_transcript=获取字幕文本, get_info=视频元数据信息",
        },
        url: {
          type: "string",
          description: "YouTube 视频 URL 或视频 ID。支持 youtube.com/watch?v=、youtu.be/、youtube.com/shorts/ 等格式。",
        },
        lang: {
          type: "string",
          description: "首选字幕语言代码（如 'en', 'zh', 'ja'）。默认为 'en'。",
        },
        format: {
          type: "string",
          enum: ["text", "timestamped", "json"],
          description: "字幕输出格式：text=纯文本（默认），timestamped=带时间戳的文本，json=结构化 JSON。",
        },
      },
      required: ["action", "url"],
    },

    async execute(input: Record<string, unknown>) {
      const action = input.action as string;
      const url = input.url as string;
      const lang = (input.lang as string) || "en";
      const format = (input.format as string) || "text";

      if (!url) {
        return { error: true, message: "需要提供 YouTube 视频 URL 或视频 ID" };
      }

      const videoId = extractVideoId(url);
      if (!videoId) {
        return { error: true, message: `无法从 URL 中提取视频 ID: ${url}` };
      }

      try {
        if (action === "get_info") {
          // Try yt-dlp first, then fall back to page scraping
          try {
            const info = await getYtdlpVideoInfo(videoId);
            return {
              success: true,
              videoId,
              title: info.title || info.fulltitle || "Unknown",
              author: info.channel || info.uploader || "Unknown",
              description: (info.description || "").substring(0, 2000),
              duration: info.duration || 0,
              durationFormatted: formatTime(info.duration || 0),
              uploadDate: info.upload_date || "",
              viewCount: info.view_count || 0,
              categories: info.categories || [],
              tags: (info.tags || []).slice(0, 20),
            };
          } catch {
            // Fallback to page scraping
            const pageInfo = await getPageVideoInfo(videoId);
            return {
              success: true,
              videoId,
              ...pageInfo,
              durationFormatted: formatTime(pageInfo.lengthSeconds),
            };
          }
        }

        if (action === "get_transcript") {
          // Get info first — wrap in its own try/catch to prevent propagation
          let title = "Unknown";
          let duration = 0;
          try {
            const info = await getYtdlpVideoInfo(videoId);
            title = info.title || "Unknown";
            duration = info.duration || 0;
          } catch {
            try {
              const pageInfo = await getPageVideoInfo(videoId);
              title = pageInfo.title;
              duration = pageInfo.lengthSeconds;
            } catch {
              // Both info methods failed, continue with defaults
              console.log("[YouTube] Both info methods failed, proceeding with transcript extraction");
            }
          }

          // Get subtitles - try multiple methods with fallback chain
          let entries = await getYtdlpSubtitles(videoId, lang);

          // If requested language has no subtitles, try 'en' as fallback
          if (entries.length === 0 && lang !== "en") {
            entries = await getYtdlpSubtitles(videoId, "en");
          }

          // Fallback 1: Try Invidious API (bypasses YouTube rate limits)
          if (entries.length === 0) {
            console.log("[YouTube] yt-dlp failed, trying Invidious fallback...");
            entries = await getInvidiousTranscript(videoId, lang);
          }

          // Fallback 2: Try YouTube timedtext API directly
          if (entries.length === 0) {
            console.log("[YouTube] Invidious failed, trying timedtext API...");
            entries = await getTimedtextTranscript(videoId, lang);
          }

          if (entries.length === 0) {
            const cookiesHint = getCookiesPath()
              ? ""
              : " 提示：可设置 DEEPANALYZE_YOUTUBE_COOKIES 环境变量指向浏览器 cookie 文件来绕过限制。";
            return {
              error: true,
              message: "无法获取此视频的字幕。可能该视频没有字幕，或被 YouTube 的反爬虫机制阻止。" + cookiesHint,
              videoId,
              title,
              suggestion: "建议：1) 使用 web_search 搜索该视频标题+transcript 获取文字内容；2) 对于视觉内容的问题，尝试搜索视频描述、评论或相关文章来获取信息。",
            };
          }

          // Format output
          if (format === "json") {
            return {
              success: true,
              videoId,
              title,
              language: lang,
              entries,
              count: entries.length,
              durationFormatted: formatTime(duration),
            };
          }

          let transcript: string;
          if (format === "timestamped") {
            transcript = entries.map(e =>
              `[${formatTime(e.start)}] ${e.text}`
            ).join("\n");
          } else {
            transcript = entries.map(e => e.text).join(" ");
          }

          // Truncate if very long
          const maxLen = 50000;
          const truncated = transcript.length > maxLen;

          return {
            success: true,
            videoId,
            title,
            language: lang,
            transcript: truncated
              ? transcript.substring(0, maxLen) + "\n\n[... 截断，完整字幕共 " + transcript.length + " 字符]"
              : transcript,
            entryCount: entries.length,
            durationFormatted: formatTime(duration),
            truncated,
          };
        }

        return { error: true, message: `未知操作: ${action}` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          error: true,
          message: `YouTube 操作失败: ${message}`,
          suggestion: "检查视频 URL 是否正确，确保 yt-dlp 已安装且可访问 YouTube",
        };
      }
    },
  };
}
