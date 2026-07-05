import { describe, test, expect } from 'vitest';
import { AnchorGenerator } from '../src/wiki/anchor-generator';

describe('AnchorGenerator', () => {
  const gen = new AnchorGenerator();

  describe('generateAnchors', () => {
    test('generates anchors from simple DoclingDocument body', () => {
      const raw = {
        body: {
          children: [
            { type: 'heading', level: 1, text: 'Chapter 1' },
            { type: 'paragraph', text: 'First paragraph content here.' },
            { type: 'heading', level: 2, text: 'Section 1.1' },
            { type: 'paragraph', text: 'Second paragraph content.' },
            { type: 'heading', level: 1, text: 'Chapter 2' },
            { type: 'table', text: 'Table data' },
          ],
        },
      };
      const anchors = gen.generateAnchors('doc1', 'kb1', raw);
      // 6 elements = 6 anchors
      expect(anchors).toHaveLength(6);
      expect(anchors[0].id).toBe('doc1:heading:0');
      expect(anchors[0].section_path).toBe('1');
      expect(anchors[1].id).toBe('doc1:paragraph:0');
      expect(anchors[1].section_path).toBe('1');
      expect(anchors[2].id).toBe('doc1:heading:1');
      expect(anchors[2].section_path).toBe('1.1');
      expect(anchors[3].id).toBe('doc1:paragraph:1');
      expect(anchors[3].section_path).toBe('1.1');
      expect(anchors[4].id).toBe('doc1:heading:2');
      expect(anchors[4].section_path).toBe('2');
      expect(anchors[5].id).toBe('doc1:table:0');
      expect(anchors[5].section_path).toBe('2');
    });

    test('returns empty array for empty body', () => {
      expect(gen.generateAnchors('doc1', 'kb1', { body: { children: [] } })).toHaveLength(0);
    });

    test('returns empty array for missing body', () => {
      expect(gen.generateAnchors('doc1', 'kb1', {})).toHaveLength(0);
    });

    test('section_path resets when new h1 appears after h2', () => {
      const raw = {
        body: {
          children: [
            { type: 'heading', level: 1, text: 'A' },
            { type: 'heading', level: 2, text: 'A.1' },
            { type: 'heading', level: 1, text: 'B' },
            { type: 'paragraph', text: 'Content' },
          ],
        },
      };
      const anchors = gen.generateAnchors('doc', 'kb', raw);
      expect(anchors[0].section_path).toBe('1');
      expect(anchors[1].section_path).toBe('1.1');
      expect(anchors[2].section_path).toBe('2');
      expect(anchors[3].section_path).toBe('2');
    });

    test('content_preview truncates to 200 characters', () => {
      const longText = 'A'.repeat(300);
      const raw = {
        body: { children: [{ type: 'paragraph', text: longText }] },
      };
      const anchors = gen.generateAnchors('doc', 'kb', raw);
      expect(anchors[0].content_preview).toHaveLength(200);
      expect(anchors[0].content_preview).toBe('A'.repeat(200));
    });

    test('maps element types correctly', () => {
      const raw = {
        body: {
          children: [
            { type: 'heading', text: 'H' },
            { type: 'paragraph', text: 'P' },
            { type: 'text', text: 'T' },
            { type: 'table', text: 'Tab' },
            { type: 'picture', text: 'Pic' },
            { type: 'figure', text: 'Fig' },
            { type: 'formula', text: 'F' },
            { type: 'list', text: 'L' },
            { type: 'code', text: 'C' },
          ],
        },
      };
      const anchors = gen.generateAnchors('doc', 'kb', raw);
      expect(anchors[0].element_type).toBe('heading');
      expect(anchors[1].element_type).toBe('paragraph');
      expect(anchors[2].element_type).toBe('paragraph');
      expect(anchors[3].element_type).toBe('table');
      expect(anchors[4].element_type).toBe('image');
      expect(anchors[5].element_type).toBe('image');
      expect(anchors[6].element_type).toBe('formula');
      expect(anchors[7].element_type).toBe('list');
      expect(anchors[8].element_type).toBe('code');
    });
  });

  describe('generateExcelAnchors', () => {
    test('generates anchors for Excel tables', () => {
      const raw = {
        body: {
          children: [
            { type: 'table', text: 'Sheet1 table', metadata: { sheetName: 'Sheet1', tableIndex: 0 } },
            { type: 'table', text: 'Sheet1 table2', metadata: { sheetName: 'Sheet1', tableIndex: 1 } },
            { type: 'table', text: 'Sheet2 table', metadata: { sheetName: 'Sheet2', tableIndex: 0 } },
          ],
        },
      };
      const anchors = gen.generateExcelAnchors('doc', 'kb', raw);
      expect(anchors).toHaveLength(3);
      expect(anchors[0].id).toBe('doc:table:Sheet1_0');
      expect(anchors[1].id).toBe('doc:table:Sheet1_1');
      expect(anchors[2].id).toBe('doc:table:Sheet2_0');
    });
  });

  describe('generateImageAnchors', () => {
    test('generates single anchor for image', () => {
      const anchors = gen.generateImageAnchors('doc1', 'kb1', {
        description: '系统架构图，展示了微服务的组件关系',
        ocrText: '用户服务 → API网关 → 数据处理',
        width: 1920,
        height: 1080,
        format: 'PNG',
      });
      expect(anchors).toHaveLength(1);
      expect(anchors[0].id).toBe('doc1:image:0');
      expect(anchors[0].element_type).toBe('image');
      expect(anchors[0].section_path).toBe('image');
      expect(anchors[0].content_preview).toContain('系统架构图');
      expect(anchors[0].metadata.format).toBe('PNG');
    });
  });

  describe('generateAudioAnchors', () => {
    test('generates anchors per speaker turn', () => {
      const anchors = gen.generateAudioAnchors('doc2', 'kb1', {
        duration: 120,
        speakers: [{ id: 'A', label: '主持人' }, { id: 'B', label: '嘉宾' }],
        turns: [
          { speaker: 'A', startTime: 0, endTime: 15, text: '大家好' },
          { speaker: 'B', startTime: 15, endTime: 45, text: '谢谢邀请' },
          { speaker: 'A', startTime: 45, endTime: 90, text: '请介绍一下' },
        ],
      });
      expect(anchors).toHaveLength(3);
      expect(anchors[0].id).toBe('doc2:turn:0');
      expect(anchors[0].section_title).toBe('主持人');
      expect(anchors[1].id).toBe('doc2:turn:1');
      expect(anchors[1].section_title).toBe('嘉宾');
      expect(anchors[0].page_number).toBe(0);
      expect(anchors[1].page_number).toBe(15);
    });
  });

  describe('generateVideoAnchors', () => {
    test('generates scene and turn anchors', () => {
      const anchors = gen.generateVideoAnchors('doc3', 'kb1', {
        duration: 180,
        keyframes: [
          { time: 0, description: '开场白，主持人站在屏幕前' },
          { time: 60, description: '幻灯片展示，显示数据图表' },
        ],
        transcript: {
          duration: 180,
          speakers: [{ id: 'A', label: '旁白' }],
          turns: [
            { speaker: 'A', startTime: 5, endTime: 30, text: '今天我们来讨论...' },
            { speaker: 'A', startTime: 65, endTime: 90, text: '从图表可以看出...' },
          ],
        },
      });
      expect(anchors.filter(a => a.element_type === 'scene')).toHaveLength(2);
      expect(anchors.filter(a => a.element_type === 'turn')).toHaveLength(2);
      expect(anchors[0].id).toBe('doc3:scene:0');
      expect(anchors[2].id).toBe('doc3:turn:0');
    });
  });
});
