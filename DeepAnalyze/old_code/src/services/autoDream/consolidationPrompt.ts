// Extracted from dream.ts so auto-dream ships independently of KAIROS
// feature flags (dream.ts is behind a feature()-gated require).

import {
  DIR_EXISTS_GUIDANCE,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
} from '../../memdir/memdir.js'

export function buildConsolidationPrompt(
  memoryRoot: string,
  transcriptDir: string,
  extra: string,
): string {
  return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Memory directory: \`${memoryRoot}\`
${DIR_EXISTS_GUIDANCE}

Session transcripts: \`${transcriptDir}\` (large JSONL files — grep narrowly, don't read whole files)

---

## Phase 1 — Orient

- \`ls\` the memory directory to see what already exists
- Read \`${ENTRYPOINT_NAME}\` to understand the current index
- Skim existing topic files so you improve them rather than creating duplicates
- If \`logs/\` or \`sessions/\` subdirectories exist (assistant-mode layout), review recent entries there

## Phase 2 — Gather recent signal

Only gather new information from the following vetted sources:

1. **Wiki report pages** (pages where \`page_type = 'report'\`) — these are already curated, structured analysis outputs
2. **Session memory notes** — high-level summaries written by agents during sessions

**Do NOT extract "new knowledge" from raw session transcripts.**
Transcripts are only for understanding context (e.g., what task was being performed), not for extracting facts or conclusions. Raw transcripts may contain mistakes, hallucinations, or unfinished reasoning that should not be persisted.

If you need to understand the context behind a report or memory, you may grep transcripts for narrow terms:
   \`grep -rn "<narrow term>" ${transcriptDir}/ --include="*.jsonl" | tail -50\`
But use the result only for context, never as a source of truth for memory content.

## Phase 3 — Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory. Use the memory file format and type conventions from your system prompt's auto-memory section — it's the source of truth for what to save, how to structure it, and what NOT to save.

Every consolidated memory **must** include:

- **Source annotation**: which wiki report page or session memory supports this memory
- **Confidence level**:
  - \`HIGH\` — directly stated in a source document (verbatim fact)
  - \`MED\` — Agent analysis conclusion (synthesized from multiple signals)
  - \`LOW\` — Speculation or unverified inference
- **Timestamp**: when the memory was produced (ISO 8601 date)

Format each memory entry as:
\`[HIGH/MED/LOW] content — 来源: [[source_title]]\`

Example:
\`[HIGH] The project uses React 18.2 with TypeScript 5.1 — 来源: [[技术栈分析报告]]\`
\`[MED] Performance degrades significantly above 10k concurrent users — 来源: [[负载测试报告]]\`
\`[LOW] The team may switch to Vue 3 in Q3 — 来源: [[技术选型讨论记录]]\`

Focus on:
- Merging new signal into existing topic files rather than creating near-duplicates
- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes
- Deleting contradicted facts — if today's investigation disproves an old memory, fix it at the source
- Preserving source annotations and confidence tags so future sessions can assess reliability

## Phase 4 — Prune and index

Update \`${ENTRYPOINT_NAME}\` so it stays under ${MAX_ENTRYPOINT_LINES} lines AND under ~25KB. It's an **index**, not a dump — each entry should be one line under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into it.

- Remove pointers to memories that are now stale, wrong, or superseded
- Demote verbose entries: if an index line is over ~200 chars, it's carrying content that belongs in the topic file — shorten the line, move the detail
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one

---

Return a brief summary of what you consolidated, updated, or pruned. If nothing changed (memories are already tight), say so.${extra ? `\n\n## Additional context\n\n${extra}` : ''}`
}
