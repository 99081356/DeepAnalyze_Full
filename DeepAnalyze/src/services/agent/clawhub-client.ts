// =============================================================================
// DeepAnalyze - ClawHub API Client
// =============================================================================
// Client for the ClawHub remote skill registry (https://clawhub.ai/).
// Provides search, download, and metadata retrieval for skills.
// =============================================================================

import axios, { type AxiosInstance } from "axios";
import { parseSkillMd, type SkillManifest } from "./skill-loader.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** ClawHub skill search result */
export interface ClawHubSkillResult {
  slug: string;
  name: string;
  description: string;
  author: string;
  url: string;
  /** Download URL for the SKILL.md content */
  downloadUrl: string;
  tags?: string[];
  version?: string;
  /** Number of installs (if available) */
  installs?: number;
  /** Security scan status */
  securityStatus?: "verified" | "pending" | "flagged";
}

/** ClawHub search response */
export interface ClawHubSearchResponse {
  total: number;
  skills: ClawHubSkillResult[];
}

/** ClawHub skill download result */
export interface ClawHubDownloadResult {
  manifest: SkillManifest;
  content: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ClawHubClient {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor(baseUrl = "https://clawhub.ai") {
    this.baseUrl = baseUrl;
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 15000,
      headers: {
        "Accept": "application/json",
        "User-Agent": "DeepAnalyze/1.0",
      },
    });
  }

  /**
   * Search for skills on ClawHub.
   * Tries /api/v1/search first, falls back to web scraping.
   */
  async search(query: string, options?: { limit?: number }): Promise<ClawHubSearchResponse> {
    try {
      const response = await this.client.get("/api/v1/search", {
        params: { q: query, limit: options?.limit ?? 10 },
      });

      const data = response.data;

      // Array response
      if (Array.isArray(data)) {
        return {
          total: data.length,
          skills: data.map((d: unknown) => this.normalizeSearchResult(d)),
        };
      }

      // Object with results/skills array
      if (data?.results || data?.skills) {
        const items = (data.results ?? data.skills) as unknown[];
        return {
          total: data.total ?? items.length,
          skills: items.map((d: unknown) => this.normalizeSearchResult(d)),
        };
      }

      // HTML fallback
      if (typeof data === "string") {
        return this.parseHtmlSearchResults(data);
      }

      return { total: 0, skills: [] };
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return this.searchViaWebScrape(query);
      }
      throw new Error(
        `ClawHub search failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Download a skill's SKILL.md content from ClawHub.
   */
  async downloadSkill(slug: string): Promise<ClawHubDownloadResult> {
    // Try the API endpoint first
    try {
      const response = await this.client.get(`/api/v1/skills/${slug}`);
      const data = response.data;

      let content: string;
      if (typeof data === "string") {
        content = data;
      } else if (data?.content) {
        content = data.content;
      } else if (data?.skill?.content) {
        content = data.skill.content;
      } else {
        content = await this.fetchSkillMdFromPage(slug);
      }

      const manifest = parseSkillMd(content, slug);
      return { manifest, content, slug };
    } catch (err) {
      // Fallback: try fetching the skill page directly
      try {
        const content = await this.fetchSkillMdFromPage(slug);
        const manifest = parseSkillMd(content, slug);
        return { manifest, content, slug };
      } catch {
        throw new Error(
          `Failed to download skill "${slug}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Get skill details/metadata from ClawHub.
   */
  async getSkillDetails(slug: string): Promise<ClawHubSkillResult | null> {
    try {
      const response = await this.client.get(`/api/v1/skills/${slug}`);
      return this.normalizeSearchResult(response.data);
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Fallback methods
  // -----------------------------------------------------------------------

  private async fetchSkillMdFromPage(slug: string): Promise<string> {
    const response = await this.client.get(`/skills/${slug}`);
    if (typeof response.data !== "string") {
      throw new Error("Expected HTML page");
    }
    const html = response.data as string;

    // Try extracting from <pre> or <code> blocks
    const preMatch = html.match(/<pre[^>]*class="[^"]*skill-content[^"]*"[^>]*>([\s\S]*?)<\/pre>/);
    if (preMatch) return this.unescapeHtml(preMatch[1]!);

    const codeMatch = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
    if (codeMatch) return this.unescapeHtml(codeMatch[1]!);

    // Try to find a download link
    const dlMatch = html.match(/href="([^"]*download[^"]*)"/);
    if (dlMatch) {
      const dlResponse = await this.client.get(dlMatch[1]!);
      return typeof dlResponse.data === "string"
        ? dlResponse.data
        : JSON.stringify(dlResponse.data);
    }

    throw new Error(`Could not extract SKILL.md content from page for "${slug}"`);
  }

  private async searchViaWebScrape(query: string): Promise<ClawHubSearchResponse> {
    try {
      const response = await this.client.get("/skills", {
        params: { q: query },
      });
      if (typeof response.data === "string") {
        return this.parseHtmlSearchResults(response.data);
      }
    } catch { /* ignore */ }
    return { total: 0, skills: [] };
  }

  private parseHtmlSearchResults(html: string): ClawHubSearchResponse {
    const skillPattern = /href="\/skills\/([^"]+)"[^>]*>[\s\S]*?<[^>]*>([^<]*)/g;
    const skills: ClawHubSkillResult[] = [];
    let match;
    while ((match = skillPattern.exec(html)) !== null) {
      skills.push({
        slug: match[1]!,
        name: match[1]!,
        description: match[2]?.trim() ?? "",
        author: "",
        url: `${this.baseUrl}/skills/${match[1]}`,
        downloadUrl: `${this.baseUrl}/api/v1/skills/${match[1]}`,
      });
    }
    return { total: skills.length, skills };
  }

  private normalizeSearchResult(raw: unknown): ClawHubSkillResult {
    const d = raw as Record<string, unknown>;
    return {
      slug: String(d.slug ?? d.id ?? d.name ?? ""),
      name: String(d.name ?? d.title ?? ""),
      description: String(d.description ?? d.when_to_use ?? ""),
      author: String(d.author ?? d.owner ?? ""),
      url: String(d.url ?? d.html_url ?? ""),
      downloadUrl: String(d.download_url ?? d.content_url ?? ""),
      tags: Array.isArray(d.tags) ? d.tags as string[] : undefined,
      version: d.version != null ? String(d.version) : undefined,
      installs: (d.installs ?? d.downloads ?? undefined) as number | undefined,
      securityStatus: (d.security_status ?? d.vetted ?? undefined) as ClawHubSkillResult["securityStatus"],
    };
  }

  private unescapeHtml(html: string): string {
    return html
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
}
