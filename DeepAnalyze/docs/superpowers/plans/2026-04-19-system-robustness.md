# Sub-Project 5: System Robustness & Auto-Degradation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement capability-aware dispatching using ProviderFeatures metadata, circuit breaker for model failover, and fix `searchByLevels()` to support multiple knowledge bases.

**Architecture:** The `CapabilityDispatcher` gains a `getSystemCapabilities()` method that derives `SystemCapabilities` from the currently configured providers' `ProviderFeatures` in the registry. `ModelRouter` wraps each `chat()` and `chatStream()` call with a per-provider `CircuitBreaker` that tracks failures and auto-switches to an alternate provider. `Retriever.searchByLevels()` changes from `kbId: string` to `kbIds: string[]` with RRF merge across KBs. Double compounding was already fixed in Sub-project 4 — verification only.

**Tech Stack:** TypeScript, Hono (backend)

**Spec:** `docs/superpowers/specs/2026-04-18-deepanalyze-system-redesign.md` Section 七

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/models/capability-dispatcher.ts` | Add `getSystemCapabilities()` using ProviderFeatures |
| `src/models/router.ts` | Add CircuitBreaker per provider, auto-failover on chat/chatStream |
| `src/wiki/retriever.ts` | Fix `searchByLevels()` to accept `kbIds: string[]` |
| `src/services/agent/tool-setup.ts` | Verify kb_search cross-KB (already works, no change expected) |
| `src/server/routes/agents.ts` | Verify no double compounding (already fixed in SP4, no change expected) |

---

### Task 1: CapabilityDispatcher — Add SystemCapabilities Detection

**Files:**
- Modify: `src/models/capability-dispatcher.ts`

The `CapabilityDispatcher` already resolves providers by role. Add a `getSystemCapabilities()` method that inspects the currently configured providers and returns a `SystemCapabilities` object derived from the `ProviderFeatures` metadata in the provider registry. This lets the frontend and agent system know what capabilities are available at runtime.

- [ ] **Step 1: Add SystemCapabilities interface and detection method**

In `src/models/capability-dispatcher.ts`, add the `SystemCapabilities` interface and the `getSystemCapabilities()` method.

First, add the import for `getProviderMetadata` at the top (alongside the existing imports):

```typescript
import { getProviderMetadata } from "./provider-registry.js";
```

Add the `SystemCapabilities` interface after the existing result type interfaces (after `TranscriptionResult`, around line 52):

```typescript
/** Runtime system capabilities derived from configured providers. */
export interface SystemCapabilities {
  text: boolean;
  vision: boolean;
  tts: boolean;
  audioTranscription: boolean;
  imageGeneration: boolean;
  videoGeneration: boolean;
  musicGeneration: boolean;
  embedding: boolean;
  webSearch: boolean;
}
```

Add the `getSystemCapabilities()` method to the `CapabilityDispatcher` class (after the `resolveProvider` method, around line 72):

```typescript
/**
 * Detect system capabilities by inspecting configured providers.
 * For each capability, check if a provider is configured for the
 * corresponding role AND that provider's ProviderFeatures include it.
 */
async getSystemCapabilities(): Promise<SystemCapabilities> {
  const repos = await getRepos();
  const settings = await repos.settings.getProviderSettings();

  // Build a map of role -> provider config
  const roleProviders: Partial<Record<string, ProviderConfig>> = {};
  for (const [role, providerId] of Object.entries(settings.defaults)) {
    if (!providerId) continue;
    const config = settings.providers.find(
      (p) => p.id === providerId && p.enabled,
    );
    if (config) {
      roleProviders[role] = config;
    }
  }

  // Check web search availability (env-based)
  const webSearch = !!(process.env.SEARCH_BACKEND === "serper"
    ? process.env.SERPER_API_KEY
    : true); // SearXNG default, always available if running

  // Derive capabilities from provider features
  const checkFeature = (
    role: string,
    feature: keyof import("./provider-registry.js").ProviderFeatures,
  ): boolean => {
    const config = roleProviders[role];
    if (!config) return false;
    const meta = getProviderMetadata(config.id);
    if (!meta) return true; // Unknown provider — assume capable
    return meta.features[feature];
  };

  return {
    text: !!roleProviders.main,
    vision: checkFeature("vlm", "vision"),
    tts: checkFeature("tts", "tts"),
    audioTranscription: checkFeature("audio_transcribe", "audioTranscription"),
    imageGeneration: checkFeature("image_gen", "imageGeneration"),
    videoGeneration: checkFeature("video_gen", "videoGeneration"),
    musicGeneration: checkFeature("music_gen", "musicGeneration"),
    embedding: !!roleProviders.embedding,
    webSearch,
  };
}
```

Note: The `checkFeature` helper uses a dynamic import type annotation for `ProviderFeatures`. If TypeScript has issues with this inline import type, use the already-imported `getProviderMetadata` and access `.features[feature]` directly. The implementation accesses `meta.features[feature]` which works since `feature` is typed as a key of `ProviderFeatures`.

Actually, to avoid TypeScript issues with inline import types, simplify `checkFeature` to just access the features directly:

```typescript
  const checkFeature = (
    role: string,
    feature: "chat" | "embeddings" | "tts" | "imageGeneration" | "videoGeneration" | "musicGeneration" | "audioTranscription" | "vision",
  ): boolean => {
    const config = roleProviders[role];
    if (!config) return false;
    const meta = getProviderMetadata(config.id);
    if (!meta) return true; // Unknown provider — assume capable
    return meta.features[feature];
  };
```

- [ ] **Step 2: Commit**

```bash
git add src/models/capability-dispatcher.ts
git commit -m "feat(capability): add SystemCapabilities detection from provider features"
```

---

### Task 2: ModelRouter — Circuit Breaker with Auto-Failover

**Files:**
- Modify: `src/models/router.ts`

Add a `CircuitBreaker` class and integrate it into `ModelRouter`. When a provider fails 3 consecutive times, the circuit opens and the router switches to an alternate provider (if available). After 60 seconds, the circuit enters half-open state to test recovery.

- [ ] **Step 1: Add CircuitBreaker class**

In `src/models/router.ts`, add the `CircuitBreaker` class before the `ModelRouter` class definition (after the `bumpConfigVersion` function, around line 46):

```typescript
// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  state: "closed" | "open" | "half-open";
  resetTimeout: number; // ms, default 60000
}

class CircuitBreaker {
  private circuits = new Map<string, CircuitBreakerState>();

  /** Check if the circuit for a provider is open (should be skipped). */
  isOpen(providerId: string): boolean {
    const circuit = this.circuits.get(providerId);
    if (!circuit) return false;

    if (circuit.state === "open") {
      // Check if reset timeout has elapsed
      if (Date.now() - circuit.lastFailure > circuit.resetTimeout) {
        circuit.state = "half-open";
        console.log(`[CircuitBreaker] ${providerId} entering half-open state`);
        return false;
      }
      return true;
    }

    return false;
  }

  /** Record a successful call — reset the circuit. */
  recordSuccess(providerId: string): void {
    const circuit = this.circuits.get(providerId);
    if (circuit) {
      circuit.failures = 0;
      circuit.state = "closed";
    }
  }

  /** Record a failed call — open the circuit if threshold reached. */
  recordFailure(providerId: string): void {
    let circuit = this.circuits.get(providerId);
    if (!circuit) {
      circuit = { failures: 0, lastFailure: 0, state: "closed", resetTimeout: 60000 };
      this.circuits.set(providerId, circuit);
    }

    circuit.failures++;
    circuit.lastFailure = Date.now();

    if (circuit.state === "half-open") {
      // Failed during half-open → back to open
      circuit.state = "open";
      console.warn(`[CircuitBreaker] ${providerId} half-open test failed, re-opening circuit`);
    } else if (circuit.failures >= 3) {
      circuit.state = "open";
      console.warn(`[CircuitBreaker] ${providerId} circuit opened after ${circuit.failures} failures`);
    }
  }
}
```

- [ ] **Step 2: Integrate CircuitBreaker into ModelRouter**

Add a `CircuitBreaker` instance to `ModelRouter`. Modify the class to add the property after `loadedVersion` (around line 59):

```typescript
private circuitBreaker = new CircuitBreaker();
```

Modify the `getProvider()` method to add failover logic. Replace the existing `getProvider` method (lines 116-147) with a new version that skips open-circuit providers:

```typescript
/**
 * Return a provider by its config name, or the default main provider
 * if no name is given. Skips providers with open circuits.
 */
getProvider(name?: string): ModelProvider {
  const targetId = name ?? this.getDefaultProviderId();

  // If the target provider is not open-circuited, use it
  if (!this.circuitBreaker.isOpen(targetId)) {
    const provider = this.providers.get(targetId);
    if (provider) return provider;
  }

  // Try to find an alternate provider that isn't open-circuited
  for (const [id, provider] of this.providers) {
    if (id !== targetId && !this.circuitBreaker.isOpen(id)) {
      console.warn(`[ModelRouter] Provider "${targetId}" unavailable, falling back to "${id}"`);
      return provider;
    }
  }

  // All alternatives exhausted — try the original anyway
  const provider = this.providers.get(targetId);
  if (provider) return provider;

  const available = [...this.providers.keys()].join(", ");
  throw new Error(
    `ModelRouter: provider "${targetId}" not found. Available: ${available}`,
  );
}

/** Get the default provider ID from either DB or YAML config. */
private getDefaultProviderId(): string {
  if (this.dbDefaults) {
    return this.dbDefaults.main || this.providers.keys().next().value || "";
  }
  if (!this.config) {
    throw new Error("ModelRouter: not initialized. Call initialize() first.");
  }
  return this.config.defaults.main;
}
```

- [ ] **Step 3: Wrap chat() and chatStream() with circuit breaker tracking**

Replace the `chat()` method (lines 153-162) with circuit-breaker-aware version:

```typescript
async chat(
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<ChatResponse> {
  await this.ensureCurrent();
  const { model: _providerKey, ...providerOptions } = options;
  const providerId = this.resolveProviderId(options.model);
  const provider = this.getProvider(options.model);

  try {
    const result = await provider.chat(messages, providerOptions);
    this.circuitBreaker.recordSuccess(providerId);
    return result;
  } catch (err) {
    this.circuitBreaker.recordFailure(providerId);
    throw err;
  }
}
```

Replace the `chatStream()` method (lines 164-172) with circuit-breaker-aware version:

```typescript
async *chatStream(
  messages: ChatMessage[],
  options: ChatOptions = {},
): AsyncGenerator<StreamChunk> {
  await this.ensureCurrent();
  const { model: _providerKey, ...providerOptions } = options;
  const providerId = this.resolveProviderId(options.model);
  const provider = this.getProvider(options.model);

  // For streaming, we record success on first chunk and failure on error
  let firstChunk = true;
  try {
    for await (const chunk of provider.chatStream(messages, providerOptions)) {
      if (firstChunk) {
        this.circuitBreaker.recordSuccess(providerId);
        firstChunk = false;
      }
      yield chunk;
    }
  } catch (err) {
    if (firstChunk) {
      this.circuitBreaker.recordFailure(providerId);
    }
    throw err;
  }
}
```

Add a helper method to resolve provider ID from the options:

```typescript
/** Resolve the actual provider ID from an options.model value. */
private resolveProviderId(model?: string): string {
  return model ?? this.getDefaultProviderId();
}
```

- [ ] **Step 4: Commit**

```bash
git add src/models/router.ts
git commit -m "feat(router): add circuit breaker with per-provider failover"
```

---

### Task 3: Retriever — Fix searchByLevels to Support Multiple KBs

**Files:**
- Modify: `src/wiki/retriever.ts`

The `searchByLevels()` method currently accepts a single `kbId: string`. Change it to accept `kbIds: string[]` for cross-KB search with RRF merge. The internal `searchLevel()` method also needs updating.

- [ ] **Step 1: Update searchByLevels signature and implementation**

In `src/wiki/retriever.ts`, change the `searchByLevels()` method signature from `kbId: string` to `kbIds: string[]` and update the body accordingly.

Replace the `searchByLevels()` method (lines 459-505) with:

```typescript
/**
 * Search by hierarchical levels across multiple knowledge bases:
 *  - L0 = abstract (quick summary)
 *  - L1 = overview (structured summary)
 *  - L2 = fulltext (full content)
 *
 * All three levels are searched in parallel. Results include keyword
 * highlights and are grouped by level.
 *
 * @param query   - The search query string
 * @param kbIds   - Knowledge base IDs to search within
 * @param options - Optional overrides for topK per level and entity search toggle
 */
async searchByLevels(
  query: string,
  kbIds: string[],
  options?: {
    topK?: number;
    includeEntities?: boolean;
    docId?: string;
    levels?: string[];
  },
): Promise<{
  L0: LeveledSearchResult[];
  L1: LeveledSearchResult[];
  L2: LeveledSearchResult[];
  entities: EntitySearchResult[];
}> {
  const { topK = 10, includeEntities = false, docId, levels } = options ?? {};

  const keywords = query.split(/\s+/).filter((w) => w.length > 0);

  // Mapping from level to page_type values in the DB
  const levelMap: Record<string, string[]> = {
    L0: ["abstract"],
    L1: ["overview", "structure"],
    L2: ["fulltext"],
  };

  const requestedLevels = levels ?? ["L0", "L1", "L2"];

  // Only search requested levels
  const searchL0 = requestedLevels.includes("L0");
  const searchL1 = requestedLevels.includes("L1");
  const searchL2 = requestedLevels.includes("L2");

  const [l0Results, l1Results, l2Results, entityResults] = await Promise.all([
    searchL0 ? this.searchLevel(query, kbIds, levelMap.L0, "L0", keywords, topK, docId) : Promise.resolve([]),
    searchL1 ? this.searchLevel(query, kbIds, levelMap.L1, "L1", keywords, topK, docId) : Promise.resolve([]),
    searchL2 ? this.searchLevel(query, kbIds, levelMap.L2, "L2", keywords, topK, docId) : Promise.resolve([]),
    includeEntities ? this.searchEntities(query, kbIds, topK) : Promise.resolve([]),
  ]);

  return {
    L0: l0Results,
    L1: l1Results,
    L2: l2Results,
    entities: entityResults,
  };
}
```

- [ ] **Step 2: Update searchLevel to accept kbIds array**

Replace the `searchLevel()` method (lines 510-548) with:

```typescript
/**
 * Search a single level (set of page types) across multiple KBs.
 */
private async searchLevel(
  query: string,
  kbIds: string[],
  pageTypes: string[],
  level: "L0" | "L1" | "L2",
  keywords: string[],
  topK: number,
  docId?: string,
): Promise<LeveledSearchResult[]> {
  const opts: SearchOptions = {
    kbIds,
    topK,
    pageTypes,
  };

  const raw = await this.search(query, opts);

  // Optionally filter by docId
  const filtered = docId
    ? raw.filter((r) => r.docId === docId || !r.docId)
    : raw;

  return filtered.map((r) => {
    const highlightedSnippet = this.highlightKeywords(r.snippet, keywords);
    const highlights = this.extractHighlights(r.snippet, keywords);

    return {
      pageId: r.pageId,
      title: r.title,
      snippet: highlightedSnippet,
      highlights,
      level,
      score: r.score,
      kbId: r.kbId,
      docId: r.docId ?? undefined,
    };
  });
}
```

- [ ] **Step 3: Update searchEntities to accept kbIds array**

Replace the `searchEntities()` method (lines 553-594) with:

```typescript
/**
 * Search entities matching the query across multiple KBs.
 */
private async searchEntities(
  query: string,
  kbIds: string[],
  topK: number,
): Promise<EntitySearchResult[]> {
  const repos = await getRepos();
  const lowerQuery = query.toLowerCase();

  try {
    const results: EntitySearchResult[] = [];

    for (const kbId of kbIds) {
      const entityPages = await repos.wikiPage.getByKbAndType(kbId, "entity");
      const matchingEntities = entityPages.filter(p =>
        p.title.toLowerCase().includes(lowerQuery)
      ).slice(0, topK);

      for (const page of matchingEntities) {
        // Get incoming entity_ref links to count mentions
        const incomingLinks = await repos.wikiLink.getIncoming(page.id);
        const entityRefLinks = incomingLinks.filter(l => l.linkType === "entity_ref");

        // Extract entity type from title (format: "Type: Name")
        const parts = page.title.split(": ");
        const type = parts.length > 1 ? parts[0] : "entity";
        const name = parts.length > 1 ? parts.slice(1).join(": ") : page.title;

        results.push({
          name,
          type,
          count: entityRefLinks.length,
          relatedPages: entityRefLinks.map(l => l.sourcePageId).slice(0, 10),
        });
      }
    }

    // Sort by mention count descending
    results.sort((a, b) => b.count - a.count);
    return results.slice(0, topK);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Update callers of searchByLevels**

Find any files that call `retriever.searchByLevels()` and update them to pass `kbIds: string[]` instead of `kbId: string`. Search for `searchByLevels` across the codebase.

In the wiki routes or knowledge routes, the call likely looks like:
```typescript
retriever.searchByLevels(query, kbId, { ... })
```
Change to:
```typescript
retriever.searchByLevels(query, [kbId], { ... })
```

If the route already supports multiple KB IDs, pass them directly.

- [ ] **Step 5: Commit**

```bash
git add src/wiki/retriever.ts
git commit -m "feat(retriever): support multiple KBs in searchByLevels with cross-KB entity search"
```

---

### Task 4: API Route — Expose SystemCapabilities

**Files:**
- Modify: `src/server/routes/capabilities.ts` (create if not exists) or add to an existing settings route

Add an API endpoint that returns the current `SystemCapabilities` so the frontend can adapt its UI accordingly (e.g., hide TTS button when no TTS provider is configured).

- [ ] **Step 1: Find or create the capabilities route**

Check if a capabilities route exists. Search for files in `src/server/routes/` related to capabilities or settings.

If a suitable settings route exists, add the endpoint there. Otherwise, find the main router file where routes are registered and add a simple GET `/api/capabilities` endpoint.

The implementation should:
1. Import `CapabilityDispatcher` from `../../models/capability-dispatcher.js`
2. Create an instance (or use a shared one)
3. Call `getSystemCapabilities()`
4. Return the result as JSON

If creating a new file `src/server/routes/capabilities.ts`:

```typescript
import { Hono } from "hono";
import { CapabilityDispatcher } from "../../models/capability-dispatcher.js";

const capabilities = new Hono();
const dispatcher = new CapabilityDispatcher();

capabilities.get("/", async (c) => {
  const caps = await dispatcher.getSystemCapabilities();
  return c.json(caps);
});

export { capabilities };
```

Then register it in the main router (find where other routes are imported and registered):
```typescript
import { capabilities } from "./routes/capabilities.js";
// ...
app.route("/api/capabilities", capabilities);
```

If the route already exists, just add the GET handler.

- [ ] **Step 2: Commit**

```bash
git add src/server/routes/capabilities.ts src/server/index.ts
git commit -m "feat(api): add GET /api/capabilities endpoint for runtime capability detection"
```

---

### Task 5: Verification — Double Compounding and Cross-KB Search

**Files:**
- No changes expected (verification only)

- [ ] **Step 1: Verify double compounding is fully removed**

Search `src/server/routes/agents.ts` for any remaining references to `compounder` or `compoundAgentResult`:

```bash
grep -n "compound" src/server/routes/agents.ts
```

Expected: No matches (removed in Sub-project 4, Task 6).

- [ ] **Step 2: Verify kb_search cross-KB support**

The `kb_search` tool in `tool-setup.ts` (lines 103-136) already supports multiple `kbIds` — it either uses the provided IDs or fetches all KB IDs from the database. No change needed.

- [ ] **Step 3: TypeScript compile check**

Run the TypeScript compiler on the backend:

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | grep "^src/" | head -50
```

Fix any errors found.

- [ ] **Step 4: Commit fixes if any**

```bash
git add -A
git commit -m "fix: resolve integration errors in system robustness components"
```

---

## Summary

| Task | Component | Description |
|------|-----------|-------------|
| 1 | CapabilityDispatcher | SystemCapabilities detection from ProviderFeatures |
| 2 | ModelRouter | Circuit breaker with per-provider failover |
| 3 | Retriever | searchByLevels multi-KB support |
| 4 | API Route | GET /api/capabilities endpoint |
| 5 | Verification | Double compounding, cross-KB, TypeScript check |
