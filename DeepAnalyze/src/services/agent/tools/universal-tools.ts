import type { AgentTool } from "../types.js";

/**
 * General-purpose tools for any Agent.
 * Domain-agnostic base capabilities.
 */

// ---------------------------------------------------------------------------
// ListFiles — list directory contents
// ---------------------------------------------------------------------------

export const listFilesTool: AgentTool = {
  name: "list_files",
  description:
    "列出目录中的文件和子目录。返回文件名、类型和大小。",
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  shouldDefer: true,
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "目录路径。默认当前目录。",
      },
      recursive: {
        type: "boolean",
        description: "是否递归列出子目录。默认 false。",
      },
    },
  },
  async execute(input) {
    const { readdir, stat } = await import("fs/promises");
    const pathMod = await import("path");
    const dirPath = (input.path as string) || ".";
    const recursive = (input.recursive as boolean) || false;

    async function walk(dir: string, prefix: string = ""): Promise<Array<{ name: string; type: string; size?: number }>> {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: Array<{ name: string; type: string; size?: number }> = [];

      for (const entry of entries) {
        const fullPath = pathMod.join(dir, entry.name);
        const displayName = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          files.push({ name: displayName, type: "directory" });
          if (recursive) {
            try {
              files.push(...await walk(fullPath, displayName));
            } catch {
              // Skip inaccessible directories
            }
          }
        } else if (entry.isFile()) {
          try {
            const s = await stat(fullPath);
            files.push({ name: displayName, type: "file", size: s.size });
          } catch {
            files.push({ name: displayName, type: "file" });
          }
        }
      }
      return files;
    }

    try {
      const files = await walk(dirPath);
      return {
        files: files.slice(0, 500),
        total: files.length,
        truncated: files.length > 500,
      };
    } catch (err) {
      return { error: true, message: `Failed to list directory: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

// ---------------------------------------------------------------------------
// NotebookRead — read Jupyter notebooks
// ---------------------------------------------------------------------------

export const notebookReadTool: AgentTool = {
  name: "notebook_read",
  description: "读取 Jupyter Notebook (.ipynb) 文件，返回所有 cell 及其输出。",
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  shouldDefer: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Notebook 文件路径" },
    },
    required: ["path"],
  },
  async execute(input) {
    const { readFile } = await import("fs/promises");
    try {
      const content = await readFile(input.path as string, "utf-8");
      const notebook = JSON.parse(content);
      const cells = (notebook.cells || []).map((cell: any, i: number) => ({
        index: i,
        type: cell.cell_type,
        source: Array.isArray(cell.source) ? cell.source.join("") : cell.source,
        outputs: (cell.outputs || []).map((o: any) => {
          if (o.text) return { type: "text", data: Array.isArray(o.text) ? o.text.join("") : o.text };
          if (o.data) return { type: "data", mimetype: Object.keys(o.data)[0], data: JSON.stringify(o.data).slice(0, 2000) };
          return { type: o.output_type || "unknown" };
        }),
      }));
      return { cells, cellCount: cells.length, metadata: notebook.metadata };
    } catch (err) {
      return { error: true, message: `Failed to read notebook: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

// ---------------------------------------------------------------------------
// All universal tools
// ---------------------------------------------------------------------------

export const UNIVERSAL_TOOLS: AgentTool[] = [
  listFilesTool,
  notebookReadTool,
];
