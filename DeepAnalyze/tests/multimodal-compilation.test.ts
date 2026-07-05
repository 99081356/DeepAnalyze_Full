// =============================================================================
// DeepAnalyze - Multimodal Compilation Integration Tests
// Tests anchor generation and DocTags formatting for image/audio/video modalities.
// =============================================================================

import { describe, test, expect } from 'vitest';
import { AnchorGenerator, type AnchorDef } from '../src/wiki/anchor-generator';
import {
  DocTagsFormatters,
  formatTime,
  type ImageRawData,
  type AudioRawData,
  type VideoRawData,
} from '../src/services/document-processors/modality-types';

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeImageRaw(): ImageRawData {
  return {
    description: '系统架构图，展示了微服务的组件关系',
    ocrText: '用户服务 → API网关 → 数据处理',
    width: 1920,
    height: 1080,
    format: 'PNG',
  };
}

function makeAudioRaw(): AudioRawData {
  return {
    duration: 120,
    speakers: [
      { id: 'A', label: '主持人' },
      { id: 'B', label: '嘉宾' },
    ],
    turns: [
      { speaker: 'A', startTime: 0, endTime: 15, text: '大家好，欢迎来到本期节目。' },
      { speaker: 'B', startTime: 15, endTime: 45, text: '谢谢邀请，很高兴来到这里。' },
      { speaker: 'A', startTime: 45, endTime: 90, text: '请介绍一下您的项目经验。' },
    ],
  };
}

function makeVideoRaw(): VideoRawData {
  return {
    duration: 180,
    resolution: '1920x1080',
    fps: 30,
    keyframes: [
      { time: 0, description: '开场白，主持人站在屏幕前' },
      { time: 60, description: '幻灯片展示，显示数据图表' },
    ],
    transcript: {
      duration: 180,
      speakers: [{ id: 'A', label: '旁白' }],
      turns: [
        { speaker: 'A', startTime: 5, endTime: 30, text: '今天我们来讨论系统架构设计。' },
        { speaker: 'A', startTime: 65, endTime: 90, text: '从图表可以看出数据增长趋势。' },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Multimodal Anchor Generation', () => {
  const generator = new AnchorGenerator();

  test('image — single anchor with description and metadata', () => {
    const anchors = generator.generateImageAnchors('img-doc', 'kb1', makeImageRaw());
    expect(anchors).toHaveLength(1);
    expect(anchors[0].id).toBe('img-doc:image:0');
    expect(anchors[0].element_type).toBe('image');
    expect(anchors[0].section_path).toBe('image');
    expect(anchors[0].content_preview).toContain('系统架构图');
    expect(anchors[0].metadata.format).toBe('PNG');
    expect(anchors[0].metadata.width).toBe(1920);
    expect(anchors[0].metadata.height).toBe(1080);
  });

  test('audio — one anchor per speaker turn with time metadata', () => {
    const raw = makeAudioRaw();
    const anchors = generator.generateAudioAnchors('aud-doc', 'kb1', raw);
    expect(anchors).toHaveLength(3);

    // First turn: speaker A
    expect(anchors[0].id).toBe('aud-doc:turn:0');
    expect(anchors[0].element_type).toBe('turn');
    expect(anchors[0].section_title).toBe('主持人');
    expect(anchors[0].section_path).toBe('A');
    expect(anchors[0].page_number).toBe(0);
    expect(anchors[0].metadata.speaker).toBe('A');

    // Second turn: speaker B
    expect(anchors[1].id).toBe('aud-doc:turn:1');
    expect(anchors[1].section_title).toBe('嘉宾');
    expect(anchors[1].section_path).toBe('B');
    expect(anchors[1].page_number).toBe(15);

    // Third turn: speaker A again
    expect(anchors[2].id).toBe('aud-doc:turn:2');
    expect(anchors[2].section_title).toBe('主持人');
    expect(anchors[2].page_number).toBe(45);
  });

  test('video — scene anchors + dialog turn anchors', () => {
    const raw = makeVideoRaw();
    const anchors = generator.generateVideoAnchors('vid-doc', 'kb1', raw);

    // 2 scenes + 2 turns = 4 anchors
    expect(anchors).toHaveLength(4);

    const scenes = anchors.filter(a => a.element_type === 'scene');
    const turns = anchors.filter(a => a.element_type === 'turn');
    expect(scenes).toHaveLength(2);
    expect(turns).toHaveLength(2);

    // Scene anchors
    expect(scenes[0].id).toBe('vid-doc:scene:0');
    expect(scenes[0].section_title).toBe('场景1');
    expect(scenes[0].page_number).toBe(0);
    expect(scenes[0].content_preview).toContain('开场白');

    expect(scenes[1].id).toBe('vid-doc:scene:1');
    expect(scenes[1].page_number).toBe(60);

    // Turn anchors
    expect(turns[0].id).toBe('vid-doc:turn:0');
    expect(turns[0].metadata.speaker).toBe('A');
    expect(turns[0].page_number).toBe(5);

    expect(turns[1].id).toBe('vid-doc:turn:1');
    expect(turns[1].page_number).toBe(65);
  });

  test('image — handles missing optional fields', () => {
    const minimal: ImageRawData = { description: 'A simple image' };
    const anchors = generator.generateImageAnchors('doc', 'kb', minimal);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].content_preview).toBe('A simple image');
    expect(anchors[0].metadata.format).toBeUndefined();
  });

  test('audio — empty turns returns empty anchors', () => {
    const raw: AudioRawData = { duration: 0, speakers: [], turns: [] };
    const anchors = generator.generateAudioAnchors('doc', 'kb', raw);
    expect(anchors).toHaveLength(0);
  });
});

describe('DocTags Formatters', () => {
  test('image DocTags includes description, OCR, and metadata', () => {
    const raw = makeImageRaw();
    const tags = DocTagsFormatters.image(raw);
    // Size/format are inlined into the [img] tag; [meta] is reserved for EXIF
    // (absent here), so no [meta] line is emitted.
    expect(tags).toContain('[img] (size=1920x1080;format=PNG) 视觉描述: 系统架构图');
    expect(tags).toContain('[ocr] 文本内容: 用户服务 → API网关 → 数据处理');
    expect(tags).not.toContain('[meta]');
  });

  test('image DocTags omits OCR and metadata when not provided', () => {
    const raw: ImageRawData = { description: 'Simple image' };
    const tags = DocTagsFormatters.image(raw);
    expect(tags).toBe('[img] 视觉描述: Simple image');
  });

  test('audioTurn formats speaker turn with time range', () => {
    const turn = { speaker: 'A', startTime: 65, endTime: 90, text: '从图表可以看出' };
    const tags = DocTagsFormatters.audioTurn(turn);
    expect(tags).toBe('[p](speaker=A;time=01:05-01:30) 从图表可以看出');
  });

  test('videoScene formats scene with related dialog', () => {
    const kf = { time: 60, description: '数据图表' };
    const turns = [
      { speaker: 'A', startTime: 65, endTime: 90, text: '从图表看' },
    ];
    const tags = DocTagsFormatters.videoScene(kf, turns);
    expect(tags).toContain('[scene](time=01:00) 数据图表');
    expect(tags).toContain('[dialog](speaker=A;time=01:05) 从图表看');
  });

  test('videoScene with no turns only shows scene', () => {
    const kf = { time: 0, description: '开场' };
    const tags = DocTagsFormatters.videoScene(kf, []);
    expect(tags).toBe('[scene](time=00:00) 开场');
  });

  test('formatTime formats seconds as MM:SS', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(65)).toBe('01:05');
    expect(formatTime(3600)).toBe('60:00');
    expect(formatTime(9)).toBe('00:09');
  });
});

describe('Multimodal Anchor ID Stability', () => {
  const generator = new AnchorGenerator();

  test('same audio raw produces same anchor IDs', () => {
    const raw = makeAudioRaw();
    const anchors1 = generator.generateAudioAnchors('doc', 'kb', raw);
    const anchors2 = generator.generateAudioAnchors('doc', 'kb', raw);
    expect(anchors1.map(a => a.id)).toEqual(anchors2.map(a => a.id));
  });

  test('different doc IDs produce different anchor IDs', () => {
    const raw = makeAudioRaw();
    const a1 = generator.generateAudioAnchors('doc1', 'kb', raw);
    const a2 = generator.generateAudioAnchors('doc2', 'kb', raw);
    expect(a1[0].id).not.toBe(a2[0].id);
  });
});
