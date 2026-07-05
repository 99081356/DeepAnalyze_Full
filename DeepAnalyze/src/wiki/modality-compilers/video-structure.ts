// =============================================================================
// DeepAnalyze - Video Structure Compiler
// Compiles video raw data into Structure pages grouped by scene boundaries.
// When scenes are available (VLM video understanding), each page = one scene.
// Falls back to keyframe-based pages when scenes are not present.
// Each page includes related dialog turns within that time range.
// =============================================================================

import type { WikiPageRepo, AnchorRepo, FTSSearchRepo } from '../../store/repos/interfaces.js';
import type { VideoRawData, VideoScene, VideoKeyframe } from '../../services/document-processors/modality-types.js';
import { DocTagsFormatters, formatTime } from '../../services/document-processors/modality-types.js';
import type { AnchorGenerator } from '../anchor-generator.js';

/** Unified segment for iteration — either a VideoScene or a legacy VideoKeyframe. */
interface VideoSegment {
  /** Scene index (0-based). */
  index: number;
  /** Segment start time in seconds. */
  startTime: number;
  /** Segment end time in seconds. */
  endTime: number;
  /** The original scene object, if this segment comes from VideoScene data. */
  scene?: VideoScene;
  /** The original keyframe object, if this segment comes from keyframe data. */
  keyframe?: VideoKeyframe;
}

export async function compileVideoStructure(
  params: {
    kbId: string;
    docId: string;
    raw: VideoRawData;
    doctags: string;
    wikiPageRepo: WikiPageRepo;
    anchorRepo: AnchorRepo;
    ftsRepo: FTSSearchRepo;
    anchorGenerator: AnchorGenerator;
  },
): Promise<string[]> {
  const { kbId, docId, raw, wikiPageRepo, anchorRepo, ftsRepo, anchorGenerator } = params;

  // 1. Generate anchors
  const anchors = anchorGenerator.generateVideoAnchors(docId, kbId, raw);
  await anchorRepo.batchInsert(anchors);

  const sceneAnchors = anchors.filter(a => a.element_type === 'scene');
  const turnAnchors = anchors.filter(a => a.element_type === 'turn');
  const pageIds: string[] = [];

  // 2. Build unified segments from scenes or keyframes
  const segments = buildSegments(raw);

  // 3. Create a Structure page per segment
  for (const seg of segments) {
    // Find dialog turns within this segment's time range
    const segTurns = raw.transcript.turns.filter(
      t => t.startTime >= seg.startTime && t.startTime < seg.endTime,
    );
    const segTurnAnchors = segTurns.map(t => {
      const turnIdx = raw.transcript.turns.indexOf(t);
      return turnAnchors.find(a => a.raw_json_path === `#/transcript/turns/${turnIdx}`);
    }).filter((a): a is NonNullable<typeof a> => !!a);

    // Build title and content based on whether we have a scene or keyframe
    const title = `场景${seg.index + 1} (${formatTime(seg.startTime)}-${formatTime(seg.endTime)})`;
    const dtContent = seg.scene
      ? DocTagsFormatters.videoScene(seg.scene, segTurns)
      : seg.keyframe
        ? DocTagsFormatters.videoScene(seg.keyframe, segTurns)
        : `[场景${seg.index + 1}]`;

    // Build Markdown content for structure_md
    const description = seg.scene?.description ?? seg.keyframe?.description ?? '';
    const mdContent = [
      `## ${title}`,
      description ? `\n${description}\n` : '',
      segTurns.length > 0 ? `\n### 对话\n\n${segTurns.map(t =>
        `**${t.speaker}** [${formatTime(t.startTime)}]: ${t.text}`
      ).join('\n\n')}` : '',
    ].join('\n');

    const anchorIdList = [sceneAnchors[seg.index]?.id, ...segTurnAnchors.map(a => a.id)].filter(Boolean);

    // L1_dt: DocTags format page
    const dtPage = await wikiPageRepo.create({
      kb_id: kbId,
      doc_id: docId,
      page_type: 'structure_dt',
      title,
      content: dtContent,
      token_count: Math.ceil(dtContent.length / 4),
      file_path: `${kbId}/documents/${docId}/structure_dt/scene_${seg.index + 1}.dt.md`,
      metadata: {
        anchorIds: anchorIdList,
        modality: 'video',
        elementTypes: ['scene', ...segTurns.map(() => 'turn')],
        timeRange: `${seg.startTime}-${seg.endTime}`,
        keyframeDescription: description,
      },
    });

    // L1_md: Markdown format page
    const mdPage = await wikiPageRepo.create({
      kb_id: kbId,
      doc_id: docId,
      page_type: 'structure_md',
      title,
      content: mdContent,
      token_count: Math.ceil(mdContent.length / 4),
      file_path: `${kbId}/documents/${docId}/structure/scene_${seg.index + 1}.md`,
      metadata: {
        anchorIds: anchorIdList,
        modality: 'video',
        elementTypes: ['scene', ...segTurns.map(() => 'turn')],
        timeRange: `${seg.startTime}-${seg.endTime}`,
        keyframeDescription: description,
      },
    });

    // Update anchor associations
    await anchorRepo.updateStructurePageId(anchorIdList as string[], mdPage.id);
    await ftsRepo.upsertFTSEntry(dtPage.id, title, dtContent);
    await ftsRepo.upsertFTSEntry(mdPage.id, title, mdContent);
    pageIds.push(dtPage.id, mdPage.id);
  }

  return pageIds;
}

/**
 * Build a unified list of VideoSegment objects from the raw data.
 * When `raw.scenes` is present and non-empty, use scenes with their own
 * time ranges. Otherwise, fall back to keyframes with time ranges derived
 * from consecutive keyframe timestamps.
 */
function buildSegments(raw: VideoRawData): VideoSegment[] {
  // Prefer scenes when available
  if (raw.scenes && raw.scenes.length > 0) {
    return raw.scenes.map((scene) => ({
      index: scene.index,
      startTime: scene.startTime,
      endTime: scene.endTime,
      scene,
    }));
  }

  // Fallback: derive segments from keyframes
  return raw.keyframes.map((kf, i) => {
    const nextTime = i < raw.keyframes.length - 1 ? raw.keyframes[i + 1].time : raw.duration;
    return {
      index: i,
      startTime: kf.time,
      endTime: nextTime,
      keyframe: kf,
    };
  });
}
