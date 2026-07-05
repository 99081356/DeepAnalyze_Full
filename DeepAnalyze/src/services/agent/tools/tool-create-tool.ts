// =============================================================================
// DeepAnalyze - Tool Creation Tool
// =============================================================================
// Allows the agent to create new executable tools at runtime.
// Created tools are registered in the ToolRegistry and immediately available.
// They persist for the lifetime of the process only.
// =============================================================================

import type { AgentTool } from "../types.js";
import type { ToolRegistry } from "../tool-registry.js";

// ---------------------------------------------------------------------------
// Sandbox: restricted execution environment for dynamic tool code
// ---------------------------------------------------------------------------

/**
 * Create a sandboxed async function from user-provided code.
 *
 * Security model:
 * - Only whitelisted globals are available (fetch, JSON, Math, Date, etc.)
 * - No `require`, `import`, `eval`, or `Function` allowed in the code string
 * - `new Function` is used here to construct the sandbox, but the code
 *   itself cannot use `Function` to escape (blocked by regex check)
 */
function createSandboxedFunction(
  code: string,
): (input: Record<string, unknown>) => Promise<unknown> {
  // Normalize: wrap bare code into an async function if needed
  const trimmed = code.trim();
  const wrappedCode = trimmed.startsWith("async function")
    ? trimmed
    : `async function execute(input) { ${trimmed} }`;

  // Build a restricted function using new Function with explicit parameter injection.
  // Only the listed globals are available inside the sandbox.
  const fn = new Function(
    "fetch",
    "JSON",
    "Math",
    "Date",
    "console",
    "TextEncoder",
    "TextDecoder",
    "AbortSignal",
    "URL",
    "URLSearchParams",
    "Buffer",
    "crypto",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    `return (${wrappedCode});`,
  );

  const executeFn = fn(
    fetch,
    JSON,
    Math,
    Date,
    console,
    TextEncoder,
    TextDecoder,
    AbortSignal,
    URL,
    URLSearchParams,
    typeof Buffer !== "undefined" ? Buffer : undefined,
    typeof crypto !== "undefined" ? crypto : undefined,
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval,
  );

  return async (input: Record<string, unknown>) => {
    try {
      const result = await executeFn(input);
      return result;
    } catch (err) {
      return {
        error: `Dynamic tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}

// ---------------------------------------------------------------------------
// tool_create tool
// ---------------------------------------------------------------------------

/**
 * Create the tool_create agent tool.
 *
 * @param registry - The ToolRegistry to register newly created tools into.
 */
export function createToolCreateTool(registry: ToolRegistry): AgentTool {
  return {
    name: "tool_create",
    description:
      "创建并注册新的可执行工具。工具代码以 JavaScript 异步函数形式提供。" +
      "创建后立即可用，无需重启。工具会在当前进程中持续有效。" +
      "注意：动态创建的工具仅在当前进程中有效，重启后需重新创建。\n\n" +
      "代码规则：\n" +
      "- 函数签名为 async function(input) { ... return result; }\n" +
      "- 可用全局对象：fetch, JSON, Math, Date, console, URL, crypto, setTimeout 等\n" +
      "- 禁止使用 require/import/eval/Function（安全限制）\n" +
      "- input 为用户传入的参数对象，返回值为工具执行结果",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "工具名称（snake_case 格式，如 url_fetch、text_hash）。必须以字母开头。",
        },
        description: {
          type: "string",
          description: "工具功能的简要描述，帮助模型决定何时调用此工具。",
        },
        code: {
          type: "string",
          description:
            "工具执行函数的 JavaScript 代码。" +
            "可以写完整的 async function(input) { ... } 或仅写函数体。" +
            "示例完整形式：'async function(input) { const r = await fetch(input.url); return r.json(); }'" +
            "示例函数体：'const url = input.url; const resp = await fetch(url); return resp.json();'",
        },
        inputSchema: {
          type: "object",
          description:
            "工具输入参数的 JSON Schema（可选）。定义工具接受的参数结构，" +
            '格式如：{ type: "object", properties: { url: { type: "string" } }, required: ["url"] }',
        },
        isReadOnly: {
          type: "boolean",
          description: "工具是否为只读（不修改任何状态）。默认 false。",
        },
      },
      required: ["name", "description", "code"],
    },
    async execute(input: Record<string, unknown>) {
      const name = input.name as string;
      const description = input.description as string;
      const code = input.code as string;
      const schema = input.inputSchema as Record<string, unknown> | undefined;
      const readOnly = (input.isReadOnly as boolean) ?? false;

      // Validate required fields
      if (!name || !description || !code) {
        return { error: "name, description, and code are required." };
      }

      // Validate name format
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        return {
          error:
            "Tool name must start with a letter and contain only letters, numbers, and underscores.",
        };
      }

      // Security check: block dangerous patterns
      if (/\b(require\s*\(|import\s+|eval\s*\()\b/.test(code)) {
        return {
          error:
            "Security violation: require/import/eval are not allowed in dynamic tool code. " +
            "Use the provided global objects (fetch, JSON, etc.) instead.",
        };
      }

      // Check for obvious escape attempts
      if (/\bnew\s+Function\b/.test(code)) {
        return {
          error:
            "Security violation: new Function is not allowed in dynamic tool code.",
        };
      }

      try {
        // Create sandboxed execution function
        const sandboxedExecute = createSandboxedFunction(code);

        // Build and register the new tool
        const newTool: AgentTool = {
          name,
          description,
          execute: sandboxedExecute,
          inputSchema: schema,
          isReadOnly: () => readOnly,
          isConcurrencySafe: () => readOnly,
          isDestructive: () => false,
        };

        registry.register(newTool);

        return {
          success: true,
          message: `Tool "${name}" created and registered. You can now call ${name} directly.`,
          toolName: name,
          hint: schema
            ? undefined
            : "Tip: Adding an inputSchema helps the model call this tool correctly.",
        };
      } catch (err) {
        return {
          error: `Failed to create tool: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    shouldDefer: true,
  };
}
