// Verify the language set covers common LLM-produced code blocks.
// Mirrors the registration in frontend/src/hooks/useMarkdown.ts.

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

// Aliases
hljs.registerAliases(["js"], { languageName: "javascript" });
hljs.registerAliases(["ts"], { languageName: "typescript" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["html"], { languageName: "xml" });
hljs.registerAliases(["c", "h"], { languageName: "cpp" });
hljs.registerAliases(["cs"], { languageName: "csharp" });
hljs.registerAliases(["md"], { languageName: "markdown" });

// Test cases: each entry is [fence language, sample code, expected highlight tokens]
const cases = [
  // Explicit language tagging
  ["javascript", "const x = await foo();", "js: const/await"],
  ["typescript", "function foo(x: number): string { return ''; }", "ts: function/number"],
  ["python", "def foo(x: int) -> str: return ''", "py: def/int"],
  ["bash", "npm install --save foo", "bash: npm install"],
  ["json", '{"a": 1, "b": [2, 3]}', "json: object"],
  ["yaml", "key:\n  - item1\n  - item2", "yaml: list"],
  ["sql", "SELECT * FROM users WHERE id = 1;", "sql: SELECT"],
  ["go", "func main() { fmt.Println(\"hi\") }", "go: func"],
  ["rust", "fn main() { let x = 42; }", "rust: fn/let"],
  ["java", "public class Foo { int x = 0; }", "java: public class"],
  ["cpp", "int main() { std::cout << 1; return 0; }", "cpp: int/main"],
  ["csharp", "using System; namespace Foo { class Bar {} }", "csharp: using/namespace"],
  ["css", "body { color: red; margin: 0; }", "css: body/color"],
  ["xml", "<div class=\"x\"><span>hi</span></div>", "xml: div/span"],
  ["markdown", "# Title\n\nSome **bold** text.", "md: heading"],
  // Aliases
  ["js", "const y = 2;", "alias: js"],
  ["ts", "type T = number;", "alias: ts"],
  ["py", "x: int = 1", "alias: py"],
  ["sh", "echo hello", "alias: sh"],
  ["yml", "key: value", "alias: yml"],
  ["html", "<p>hello</p>", "alias: html"],
  ["md", "# Hello", "alias: md"],
];

let pass = 0;
let fail = 0;
for (const [lang, code, label] of cases) {
  // Mirror useMarkdown.ts logic
  const language = lang && hljs.getLanguage(lang) ? lang : "";
  let highlighted;
  try {
    highlighted = language
      ? hljs.highlight(code, { language }).value
      : hljs.highlightAuto(code).value;
  } catch (e) {
    highlighted = "";
  }

  // Highlighting produces HTML with <span class="hljs-keyword"> etc.
  // Verify it contains at least one hljs-tagged span (meaning real highlighting happened)
  const hasHighlight = highlighted.includes('class="hljs-');
  if (hasHighlight) {
    console.log(`✓ ${label}: highlighted ${code.length} chars → ${highlighted.length} chars`);
    pass++;
  } else {
    console.log(`✗ ${label}: NO hljs spans in output: ${highlighted.slice(0, 80)}`);
    fail++;
  }
}

// Also test auto-detection (no language specified)
const autoCode = "def foo(x):\n    return x + 1";
const autoHighlighted = hljs.highlightAuto(autoCode).value;
const autoHasPython = autoHighlighted.includes("hljs-keyword") && autoHighlighted.includes("def");
console.log(`${autoHasPython ? "✓" : "✗"} highlightAuto detected Python style`);

console.log(`\n${pass}/${pass + fail} language cases ${fail === 0 && autoHasPython ? "PASSED" : "FAILED"}`);
process.exit(fail > 0 || !autoHasPython ? 1 : 0);
