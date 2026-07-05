// =============================================================================
// DeepAnalyze - Graph Builder Tool
// =============================================================================
// Extracts entity relationships from wiki pages and link data, building a
// knowledge graph with nodes and edges suitable for frontend visualization.
// Uses PG Repository layer for all database operations.
// =============================================================================

import type { AgentTool } from "../../services/agent/types.js";
import type { Retriever } from "../../wiki/retriever.js";
import type { Linker } from "../../wiki/linker.js";
import { getRepos } from "../../store/repos/index.js";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface GraphToolDeps {
  linker: Linker;
  retriever: Retriever;
  dataDir: string;
}

// ---------------------------------------------------------------------------
// Graph types (for frontend visualization)
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  label: string;
  type: string; // "document" | "entity" | "concept" | "report" | "overview" | "abstract" | "fulltext"
  group?: string; // KB ID for color coding
}

export interface GraphEdge {
  source: string;
  target: string;
  label?: string; // entityName or linkType
  type: string; // linkType
}

interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
  };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createGraphTool(deps: GraphToolDeps): AgentTool {
  return {
    name: "graph_build",
    description:
      "从知识库内容构建关系图谱。从 Wiki 页面和链接数据中提取" +
      "实体及其关系。返回节点和边数据用于可视化。",
    inputSchema: {
      type: "object",
      properties: {
        kbId: {
          type: "string",
          description: "要构建图谱的知识库 ID",
        },
        query: {
          type: "string",
          description: "可选的搜索查询，用于限定图谱范围到相关页面",
        },
        startPageId: {
          type: "string",
          description: "可选的起始页面 ID，从此处开始 BFS 遍历（构建子图）",
        },
        depth: {
          type: "number",
          description: "使用 startPageId 时的 BFS 遍历深度（默认：2，最大：3）",
        },
        maxNodes: {
          type: "number",
          description: "包含的最大节点数（默认：100）",
        },
      },
      required: ["kbId"],
    },
    async execute(input: Record<string, unknown>): Promise<GraphResult | { error: string }> {
      try {
        const kbId = input.kbId as string;
        const query = input.query as string | undefined;
        const startPageId = input.startPageId as string | undefined;
        const depth = Math.min((input.depth as number) || 2, 3);
        const maxNodes = (input.maxNodes as number) || 100;
        const repos = await getRepos();

        const nodeMap = new Map<string, GraphNode>();
        const edgeList: GraphEdge[] = [];
        const edgeSet = new Set<string>(); // "source->target->type" to deduplicate

        // Helper to add a node
        function addNode(page: { id: string; title: string; page_type: string; kb_id: string }): void {
          if (!nodeMap.has(page.id)) {
            nodeMap.set(page.id, {
              id: page.id,
              label: page.title,
              type: mapPageTypeToNodeType(page.page_type),
              group: page.kb_id,
            });
          }
        }

        // Helper to add an edge (deduplicated)
        function addEdge(
          source: string,
          target: string,
          linkType: string,
          label?: string,
        ): void {
          const key = `${source}->${target}->${linkType}`;
          if (!edgeSet.has(key) && source !== target) {
            edgeSet.add(key);
            edgeList.push({
              source,
              target,
              label: label || linkType,
              type: linkType,
            });
          }
        }

        // -----------------------------------------------------------------
        // Strategy 1: BFS from a start page (subgraph)
        // -----------------------------------------------------------------

        if (startPageId) {
          const startPage = await repos.wikiPage.getById(startPageId);
          if (!startPage) {
            return { error: `Start page not found: ${startPageId}` };
          }

          // BFS traversal
          const visited = new Set<string>();
          const queue: Array<{ pageId: string; currentDepth: number }> = [
            { pageId: startPageId, currentDepth: 0 },
          ];
          visited.add(startPageId);

          // Add the start node
          addNode(startPage);

          while (queue.length > 0 && nodeMap.size < maxNodes) {
            const current = queue.shift()!;

            if (current.currentDepth >= depth) continue;

            // Get outgoing links
            const outgoing = await deps.linker.getOutgoingLinks(current.pageId);
            for (const link of outgoing) {
              const targetPage = await repos.wikiPage.getById(link.targetPageId);
              if (!targetPage) continue;

              addNode(targetPage);
              addEdge(
                current.pageId,
                link.targetPageId,
                link.linkType,
                link.entityName || undefined,
              );

              if (!visited.has(link.targetPageId)) {
                visited.add(link.targetPageId);
                queue.push({
                  pageId: link.targetPageId,
                  currentDepth: current.currentDepth + 1,
                });
              }
            }

            // Get incoming links
            const incoming = await deps.linker.getIncomingLinks(current.pageId);
            for (const link of incoming) {
              const sourcePage = await repos.wikiPage.getById(link.sourcePageId);
              if (!sourcePage) continue;

              addNode(sourcePage);
              addEdge(
                link.sourcePageId,
                current.pageId,
                link.linkType,
                link.entityName || undefined,
              );

              if (!visited.has(link.sourcePageId)) {
                visited.add(link.sourcePageId);
                queue.push({
                  pageId: link.sourcePageId,
                  currentDepth: current.currentDepth + 1,
                });
              }
            }
          }
        }

        // -----------------------------------------------------------------
        // Strategy 2: Search-based graph (query or full KB)
        // -----------------------------------------------------------------

        if (!startPageId) {
          let pageIds: string[];

          if (query) {
            // Search for relevant pages
            const results = await deps.retriever.search(query, {
              kbIds: [kbId],
              topK: 20,
            });
            pageIds = results.map((r) => r.pageId);

            // Add search result nodes
            for (const result of results) {
              addNode({
                id: result.pageId,
                title: result.title,
                page_type: result.pageType,
                kb_id: result.kbId,
              });
            }
          } else {
            // Full KB graph - get all pages
            const pages = await repos.wikiPage.getByKbAndType(kbId);
            pageIds = pages.map((p) => p.id);

            // Add all pages as nodes
            for (const page of pages) {
              addNode(page);
            }
          }

          // For each page, get its links and build edges
          for (const pageId of pageIds) {
            if (nodeMap.size >= maxNodes) break;

            const outgoing = await deps.linker.getOutgoingLinks(pageId);
            for (const link of outgoing) {
              const targetPage = await repos.wikiPage.getById(link.targetPageId);
              if (!targetPage) continue;

              // Only include targets in the same KB
              if (targetPage.kb_id !== kbId) continue;

              addNode(targetPage);
              addEdge(
                pageId,
                link.targetPageId,
                link.linkType,
                link.entityName || undefined,
              );
            }

            // Also get incoming links for better connectivity
            const incoming = await deps.linker.getIncomingLinks(pageId);
            for (const link of incoming) {
              const sourcePage = await repos.wikiPage.getById(link.sourcePageId);
              if (!sourcePage) continue;

              if (sourcePage.kb_id !== kbId) continue;

              addNode(sourcePage);
              addEdge(
                link.sourcePageId,
                pageId,
                link.linkType,
                link.entityName || undefined,
              );
            }
          }
        }

        // -----------------------------------------------------------------
        // Build and return result
        // -----------------------------------------------------------------

        const nodes = Array.from(nodeMap.values());

        // Filter edges to only include edges between nodes that are in our set
        const validEdges = edgeList.filter(
          (e) => nodeMap.has(e.source) && nodeMap.has(e.target),
        );

        return {
          nodes,
          edges: validEdges,
          stats: {
            nodeCount: nodes.length,
            edgeCount: validEdges.length,
          },
        };
      } catch (err) {
        return {
          error: `Graph generation failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a wiki page type to a node type for visualization.
 */
function mapPageTypeToNodeType(pageType: string): string {
  switch (pageType) {
    case "abstract":
    case "overview":
    case "fulltext":
      return "document";
    case "entity":
      return "entity";
    case "concept":
      return "concept";
    case "report":
      return "report";
    default:
      return "document";
  }
}
