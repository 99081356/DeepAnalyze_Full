import { describe, test, expect, vi } from 'vitest';
import { DisplayResolver } from '../src/services/display-resolver';

describe('DisplayResolver', () => {
  // Mock the PG query to return test data
  const resolver = new DisplayResolver();

  test('resolve returns display info for a known document', async () => {
    // We'll mock the pool query to return test data
    const mockPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          id: 'doc_123',
          original_name: '技术方案.pdf',
          kb_name: '项目知识库',
          file_type: 'pdf',
        }],
      }),
    };

    // Inject mock pool
    (resolver as any).poolPromise = Promise.resolve(mockPool);

    const result = await resolver.resolve('doc_123');
    expect(result.originalName).toBe('技术方案.pdf');
    expect(result.kbName).toBe('项目知识库');
    expect(result.fileType).toBe('pdf');
  });

  test('resolve returns fallback for unknown document', async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    (resolver as any).poolPromise = Promise.resolve(mockPool);
    (resolver as any).cache = new Map(); // Clear cache

    const result = await resolver.resolve('unknown_doc');
    expect(result.originalName).toBe('unknown_doc');
    expect(result.kbName).toBe('');
  });

  test('resolveBatch returns map for multiple documents', async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { id: 'doc1', original_name: '文件A.pdf', kb_name: 'KB1', file_type: 'pdf' },
          { id: 'doc2', original_name: '数据.xlsx', kb_name: 'KB1', file_type: 'xlsx' },
        ],
      }),
    };
    (resolver as any).poolPromise = Promise.resolve(mockPool);
    (resolver as any).cache = new Map();

    const result = await resolver.resolveBatch(['doc1', 'doc2']);
    expect(result['doc1'].originalName).toBe('文件A.pdf');
    expect(result['doc2'].originalName).toBe('数据.xlsx');
  });

  test('resolveBatch uses cache for already-resolved docs', async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [{ id: 'doc1', original_name: 'A.pdf', kb_name: 'KB', file_type: 'pdf' }],
    });
    const mockPool = { query: mockQuery };
    (resolver as any).poolPromise = Promise.resolve(mockPool);
    (resolver as any).cache = new Map();

    // First call
    await resolver.resolve('doc1');
    // Second call should use cache
    await resolver.resolve('doc1');
    // Query should only be called once
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
