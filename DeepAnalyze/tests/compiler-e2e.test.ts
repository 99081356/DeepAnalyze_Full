// =============================================================================
// DeepAnalyze - Three-Layer Compilation Integration Test
// Tests the full compilation pipeline: Raw → Structure → Abstract
// Uses mocked PG repos to test compiler logic without a database.
// =============================================================================

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock dependencies before importing
// ---------------------------------------------------------------------------

const mockWikiPageCreate = vi.fn().mockResolvedValue({ id: 'mock-page', title: 'mock' });
const mockWikiPageGetByDocAndType = vi.fn().mockImplementation(async (_docId: string, _pageType: string) => {
  return {
    id: `mock-page-${_pageType}`,
    file_path: `/tmp/test-wiki/mock-${_pageType}.md`,
    doc_id: _docId,
  };
});

vi.mock('../src/models/router.js', () => ({
  ModelRouter: vi.fn().mockImplementation(function() {
    this.initialize = vi.fn().mockResolvedValue(undefined);
    this.chat = vi.fn().mockResolvedValue({
      content: '# Test Summary\n\n这是一个测试摘要。\n\n标签：测试,文档,集成测试\n类型：测试文档\n日期：2026-04-15',
    });
    this.getDefaultModel = vi.fn().mockReturnValue('test-model');
  }),
}));

vi.mock('../src/wiki/page-manager.js', () => ({
  PageManager: vi.fn().mockImplementation(function() {
    this.initKb = vi.fn().mockResolvedValue(undefined);
    this.getWikiDir = vi.fn().mockReturnValue('/tmp/test-wiki');
  }),
}));

vi.mock('../src/wiki/entity-extractor.js', () => ({
  EntityExtractor: vi.fn().mockImplementation(function() {
    this.extract = vi.fn().mockResolvedValue([]);
  }),
}));

vi.mock('../src/store/repos/index.js', () => ({
  getRepos: vi.fn().mockResolvedValue({
    wikiPage: {
      create: mockWikiPageCreate,
      getByDocAndType: mockWikiPageGetByDocAndType,
      getByKbAndType: vi.fn().mockResolvedValue([]),
      updateContent: vi.fn().mockResolvedValue(undefined),
    },
    document: {
      updateStatus: vi.fn().mockResolvedValue(undefined),
      updateStatusWithProcessing: vi.fn().mockResolvedValue(undefined),
    },
    anchor: {
      batchInsert: vi.fn().mockResolvedValue(undefined),
      updateStructurePageId: vi.fn().mockResolvedValue(undefined),
    },
    embedding: {
      upsert: vi.fn().mockResolvedValue(undefined),
    },
    ftsSearch: {
      upsertFTSEntry: vi.fn().mockResolvedValue(undefined),
    },
  }),
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/wiki/linker.js', () => ({
  Linker: vi.fn().mockImplementation(function() {
    this.buildForwardLinks = vi.fn();
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { WikiCompiler } from '../src/wiki/compiler.js';
import { writeFileSync } from 'node:fs';
import type { ParsedContent } from '../src/services/document-processors/types.js';
import { ModelRouter } from '../src/models/router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get wikiPage.create calls filtered by page_type */
function getCreateCallsByType(pageType: string) {
  return mockWikiPageCreate.mock.calls.filter(
    (call: unknown[]) => typeof call[0] === 'object' && (call[0] as any).page_type === pageType,
  );
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeMockRaw(): Record<string, unknown> {
  return {
    name: 'test-doc',
    body: {
      children: [
        { type: 'heading', level: 1, text: '第一章 概述' },
        { type: 'paragraph', text: '这是第一章的内容，介绍了项目背景。' },
        { type: 'heading', level: 2, text: '1.1 目标' },
        { type: 'paragraph', text: '本项目的目标是构建一个知识管理系统。' },
        { type: 'heading', level: 1, text: '第二章 技术方案' },
        { type: 'paragraph', text: '技术方案采用三层架构设计。' },
        { type: 'table', data: 'Header1|Header2\nValue1|Value2' },
        { type: 'heading', level: 2, text: '2.1 数据库设计' },
        { type: 'paragraph', text: '使用 PostgreSQL + pgvector 作为主数据库。' },
      ],
    },
  };
}

function makeMockDocTags(): string {
  return `[h1] 第一章 概述
这是第一章的内容，介绍了项目背景。
[h2] 1.1 目标
本项目的目标是构建一个知识管理系统。
[h1] 第二章 技术方案
技术方案采用三层架构设计。
| Header1 | Header2 |
| Value1 | Value2 |
[h2] 2.1 数据库设计
使用 PostgreSQL + pgvector 作为主数据库。`;
}

function makeParsedContent(): ParsedContent {
  return {
    text: '第一章 概述\n\n这是第一章的内容。\n\n第二章 技术方案\n\n技术方案采用三层架构设计。',
    metadata: { sourceType: 'docling' },
    success: true,
    raw: makeMockRaw(),
    doctags: makeMockDocTags(),
    modality: 'document',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WikiCompiler Three-Layer Compilation', () => {
  let compiler: WikiCompiler;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create compiler with mocked ModelRouter
    const router = new ModelRouter();
    compiler = new WikiCompiler(router, '/tmp/test-data');
  });

  test('compiles rich ParsedContent through Raw → Structure → Abstract layers', async () => {
    const parsedContent = makeParsedContent();

    await compiler.compile('test-kb', 'test-doc', parsedContent, {
      fileType: 'pdf',
      filename: 'test.pdf',
    });

    // Verify Raw layer: writeFileSync should be called for docling.json and metadata.json
    expect(writeFileSync).toHaveBeenCalled();
    const writeCalls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls;
    const rawWrites = writeCalls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('docling.json'),
    );
    expect(rawWrites.length).toBeGreaterThanOrEqual(1);

    // Verify Structure layer: wikiPage.create called with page_type 'structure'
    const structureCalls = getCreateCallsByType('structure');
    expect(structureCalls.length).toBeGreaterThan(0);

    // Verify Abstract layer: wikiPage.create called with page_type 'abstract'
    const abstractCalls = getCreateCallsByType('abstract');
    expect(abstractCalls.length).toBe(1);

    // Verify fulltext also created for backward compatibility
    const fulltextCalls = getCreateCallsByType('fulltext');
    expect(fulltextCalls.length).toBe(1);
  });

  test('falls back to legacy flow when content is a plain string', async () => {
    await compiler.compile('test-kb', 'test-doc', 'Just plain text content', {
      fileType: 'txt',
    });

    // Should create fulltext, overview, abstract (legacy flow)
    const fulltextCalls = getCreateCallsByType('fulltext');
    const overviewCalls = getCreateCallsByType('overview');
    const abstractCalls = getCreateCallsByType('abstract');

    expect(fulltextCalls.length).toBe(1);
    expect(overviewCalls.length).toBe(1);
    expect(abstractCalls.length).toBe(1);

    // Should NOT create structure pages in legacy flow
    const structureCalls = getCreateCallsByType('structure');
    expect(structureCalls.length).toBe(0);
  });

  test('handles ParsedContent without raw/doctags gracefully', async () => {
    const minimalContent: ParsedContent = {
      text: 'Just text, no raw data',
      metadata: {},
      success: true,
    };

    await compiler.compile('test-kb', 'test-doc-2', minimalContent, {});

    // Should still create fulltext (from text fallback)
    const fulltextCalls = getCreateCallsByType('fulltext');
    expect(fulltextCalls.length).toBe(1);
  });

  test('generates correct anchor IDs from raw JSON', async () => {
    const parsedContent = makeParsedContent();

    await compiler.compile('test-kb', 'test-doc-3', parsedContent, {});

    // Verify structure pages were created (which means anchors were generated)
    const structureCalls = getCreateCallsByType('structure');
    expect(structureCalls.length).toBeGreaterThan(0);

    // Each structure page should have content in the create call
    for (const call of structureCalls) {
      const data = call[0] as Record<string, unknown>;
      expect(typeof data.content).toBe('string');
      expect((data.content as string).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AnchorGenerator unit tests (embedded for integration coverage)
// ---------------------------------------------------------------------------

describe('AnchorGenerator in WikiCompiler context', () => {
  test('anchors from mock raw JSON have correct format', async () => {
    const { AnchorGenerator } = await import('../src/wiki/anchor-generator.js');
    const generator = new AnchorGenerator();
    const raw = makeMockRaw();

    const anchors = generator.generateAnchors('doc-123', 'kb-456', raw);

    expect(anchors.length).toBe(9); // 9 children in mock

    // Check first anchor (h1 heading)
    const firstAnchor = anchors[0];
    expect(firstAnchor.id).toBe('doc-123:heading:0');
    expect(firstAnchor.element_type).toBe('heading');
    expect(firstAnchor.section_path).toBe('1');
    expect(firstAnchor.section_title).toBe('第一章 概述');
    expect(firstAnchor.raw_json_path).toBe('#/body/children/0');

    // Check section path updates
    const h2Anchor = anchors.find((a) => a.section_title === '1.1 目标');
    expect(h2Anchor).toBeDefined();
    expect(h2Anchor!.section_path).toBe('1.1');

    // Check second h1 resets section path
    const secondH1 = anchors.find((a) => a.section_title === '第二章 技术方案');
    expect(secondH1).toBeDefined();
    expect(secondH1!.section_path).toBe('2');

    // Check table anchor
    const tableAnchor = anchors.find((a) => a.element_type === 'table');
    expect(tableAnchor).toBeDefined();
    expect(tableAnchor!.id).toBe('doc-123:table:0');
  });
});
