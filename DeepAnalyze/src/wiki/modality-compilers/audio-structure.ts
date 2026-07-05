// =============================================================================
// DeepAnalyze - Audio Structure Compiler
// Compiles audio raw data into Structure pages grouped by speaker turns.
// Consecutive turns from the same speaker are merged into one page.
// =============================================================================

import type { WikiPageRepo, AnchorRepo, FTSSearchRepo } from '../../store/repos/interfaces.js';
import type { AudioRawData, SpeakerTurn } from '../../services/document-processors/modality-types.js';
import { DocTagsFormatters, formatTime } from '../../services/document-processors/modality-types.js';
import type { AnchorGenerator } from '../anchor-generator.js';

export async function compileAudioStructure(
  params: {
    kbId: string;
    docId: string;
    raw: AudioRawData;
    doctags: string;
    wikiPageRepo: WikiPageRepo;
    anchorRepo: AnchorRepo;
    ftsRepo: FTSSearchRepo;
    anchorGenerator: AnchorGenerator;
  },
): Promise<string[]> {
  const { kbId, docId, raw, wikiPageRepo, anchorRepo, ftsRepo, anchorGenerator } = params;

  // 1. Generate anchors
  const anchors = anchorGenerator.generateAudioAnchors(docId, kbId, raw);
  await anchorRepo.batchInsert(anchors);

  // 2. Group consecutive turns by speaker
  const chunks = groupBySpeaker(raw.turns);
  const pageIds: string[] = [];

  for (const chunk of chunks) {
    const title = formatChunkTitle(chunk, raw);
    const dtContent = chunk.map(t => DocTagsFormatters.audioTurn(t)).join('\n');
    const mdContent = chunk.map(t => `**${raw.speakers.find(s => s.id === t.speaker)?.label ?? t.speaker}** [${formatTime(t.startTime)}]: ${t.text}`).join('\n\n');
    const chunkAnchorIds = chunk
      .map((t, i) => {
        const globalIdx = raw.turns.indexOf(t);
        return globalIdx >= 0 ? anchors.find(a => a.element_index === globalIdx)?.id : undefined;
      })
      .filter((id): id is string => !!id);

    // L1_dt: DocTags format page
    const dtPage = await wikiPageRepo.create({
      kb_id: kbId,
      doc_id: docId,
      page_type: 'structure_dt',
      title,
      content: dtContent,
      token_count: Math.ceil(dtContent.length / 4),
      file_path: `${kbId}/documents/${docId}/structure_dt/${sanitizeFilename(title)}.dt.md`,
      metadata: {
        anchorIds: chunkAnchorIds,
        modality: 'audio',
        elementTypes: ['turn'],
        speaker: chunk[0].speaker,
        timeRange: `${formatTime(chunk[0].startTime)}-${formatTime(chunk[chunk.length - 1].endTime)}`,
        turnCount: chunk.length,
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
      file_path: `${kbId}/documents/${docId}/structure/${sanitizeFilename(title)}.md`,
      metadata: {
        anchorIds: chunkAnchorIds,
        modality: 'audio',
        elementTypes: ['turn'],
        speaker: chunk[0].speaker,
        timeRange: `${formatTime(chunk[0].startTime)}-${formatTime(chunk[chunk.length - 1].endTime)}`,
        turnCount: chunk.length,
      },
    });

    await anchorRepo.updateStructurePageId(chunkAnchorIds, mdPage.id);
    await ftsRepo.upsertFTSEntry(dtPage.id, title, dtContent);
    await ftsRepo.upsertFTSEntry(mdPage.id, title, mdContent);
    pageIds.push(dtPage.id, mdPage.id);
  }

  return pageIds;
}

/** Group consecutive turns from the same speaker into chunks. */
function groupBySpeaker(turns: SpeakerTurn[]): SpeakerTurn[][] {
  if (turns.length === 0) return [];
  const groups: SpeakerTurn[][] = [];
  let current = [turns[0]];
  for (let i = 1; i < turns.length; i++) {
    if (turns[i].speaker === turns[i - 1].speaker) {
      current.push(turns[i]);
    } else {
      groups.push(current);
      current = [turns[i]];
    }
  }
  groups.push(current);
  return groups;
}

function formatChunkTitle(chunk: SpeakerTurn[], raw: AudioRawData): string {
  const speaker = raw.speakers.find(s => s.id === chunk[0].speaker)?.label ?? chunk[0].speaker;
  return `${speaker} (${formatTime(chunk[0].startTime)}-${formatTime(chunk[chunk.length - 1].endTime)})`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_').slice(0, 100);
}
