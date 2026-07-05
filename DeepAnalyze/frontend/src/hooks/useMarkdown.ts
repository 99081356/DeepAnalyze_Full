import { useMemo } from "react";
import { marked } from "marked";
// Use highlight.js/lib/core and register languages on-demand.
// Full import (`highlight.js`) bundles all ~190 languages (~1MB / 332KB gzip),
// most of which never appear in user content. lib/core only loads what we
// register, shrinking the markdown chunk dramatically. highlightAuto() still
// works — it auto-detects among the registered languages only. Unregistered
// languages gracefully fall back to plain-text rendering. See issue #78.
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import DOMPurify from "dompurify";

// Register languages with their common aliases. Aliases are cheap (string
// mappings) and let users write ```js, ```py, ```sh, etc. in fenced blocks.
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("java", java);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
// Register common aliases so ```js / ```ts / ```py / ```sh / ```yml /
// ```html / ```shell all highlight correctly.
hljs.registerAliases(["js"], { languageName: "javascript" });
hljs.registerAliases(["ts"], { languageName: "typescript" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["html", "htm", "xhtml", "rss", "atom", "xsd", "xpath", "plist", "svg"], { languageName: "xml" });
hljs.registerAliases(["c", "h"], { languageName: "cpp" });
hljs.registerAliases(["cs"], { languageName: "csharp" });
hljs.registerAliases(["golang"], { languageName: "go" });
hljs.registerAliases(["rs"], { languageName: "rust" });
hljs.registerAliases(["md"], { languageName: "markdown" });

/**
 * Normalize malformed markdown produced by LLM streaming.
 * Fixes common issues where the model omits required whitespace.
 */
function normalizeMarkdown(content: string): string {
  let result = content;

  // Fix 1: Break inline heading markers (2+ hashes) that follow non-whitespace, non-# text
  // e.g. "观察###1.标题" → "观察\n###1.标题"
  // Exclude # from leading char class to avoid splitting ### into #\n##
  result = result.replace(/([^\n\s#])(#{2,6})/g, "$1\n$2");

  // Fix 2: Add space after heading markers that don't have one
  // e.g. "##heading" → "## heading"
  result = result.replace(/^(#{1,6})([^#\s])/gm, "$1 $2");

  // Fix 3: Ensure newline before unordered list items glued to text
  // e.g. "极其平滑- **眼镜**" → "极其平滑\n- **眼镜**"
  result = result.replace(/([^\n])(- \*\*)/g, "$1\n$2");

  // Fix 4: Ensure newline before numbered list items glued to text
  // e.g. "一些文字1. **项目**" → "一些文字\n1. **项目**"
  result = result.replace(/([^\n])(\d+\.\s+\*\*)/g, "$1\n$2");

  return result;
}

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true,
});

const renderer = new marked.Renderer();

// Code blocks with syntax highlighting
renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  const language = lang && hljs.getLanguage(lang) ? lang : "";
  let highlighted: string;
  try {
    highlighted = language
      ? hljs.highlight(text, { language }).value
      : hljs.highlightAuto(text).value;
  } catch {
    highlighted = text;
  }
  return `<pre><code class="hljs${language ? ` language-${language}` : ""}">${highlighted}</code></pre>`;
};

// Custom heading renderer
renderer.heading = function ({ text, depth }: { text: string; depth: number }) {
  return `<h${depth}>${text}</h${depth}>`;
};

// Configure DOMPurify to allow code highlighting classes
const purifyConfig = {
  ALLOWED_TAGS: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr",
    "ul", "ol", "li",
    "blockquote", "pre", "code",
    "strong", "em", "del", "s",
    "a", "img",
    "table", "thead", "tbody", "tr", "th", "td",
    "span", "div",
    "input", // for task lists
  ],
  ALLOWED_ATTR: [
    "href", "target", "rel",
    "class", "id",
    "checked", "disabled", "type",
    "alt", "src", "title",
  ],
  ADD_TAGS: ["code"],
  // Allow da-evidence:// and kb:// protocols for knowledge base evidence links
  ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|da-evidence|kb):|[^a-z]|[a-z+.-]+(?:[^a-z]|$))/i,
};

export function useMarkdown(content: string): string {
  return useMemo(() => {
    if (!content) return "";
    try {
      const normalized = normalizeMarkdown(content);
      const raw = marked(normalized, { renderer }) as string;
      return DOMPurify.sanitize(raw, purifyConfig);
    } catch {
      return DOMPurify.sanitize(content, purifyConfig);
    }
  }, [content]);
}

/**
 * Render markdown to sanitized HTML with syntax highlighting.
 * Can be called outside of React hooks for lazy/chunked rendering.
 */
export function renderMarkdown(content: string): string {
  if (!content) return "";
  try {
    const normalized = normalizeMarkdown(content);
    const raw = marked(normalized, { renderer }) as string;
    return DOMPurify.sanitize(raw, purifyConfig);
  } catch {
    return DOMPurify.sanitize(content, purifyConfig);
  }
}

export { purifyConfig };
