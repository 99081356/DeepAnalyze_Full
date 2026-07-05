// =============================================================================
// DeepAnalyze - Image Structure Compiler
// Compiles image raw data into a single Structure page with image anchor.
// =============================================================================

import type { WikiPageRepo, AnchorRepo, FTSSearchRepo } from '../../store/repos/interfaces.js';
import type { ImageRawData } from '../../services/document-processors/modality-types.js';
import type { AnchorGenerator } from '../anchor-generator.js';

export async function compileImageStructure(
  params: {
    kbId: string;
    docId: string;
    raw: ImageRawData;
    doctags: string;
    wikiPageRepo: WikiPageRepo;
    anchorRepo: AnchorRepo;
    ftsRepo: FTSSearchRepo;
    anchorGenerator: AnchorGenerator;
  },
): Promise<string[]> {
  const { kbId, docId, raw, doctags, wikiPageRepo, anchorRepo, ftsRepo, anchorGenerator } = params;

  // Sanitize string values — remove NULL bytes that PostgreSQL rejects
  const sanitize = (s: string): string => s.replace(/\0/g, '');

  // 1. Generate anchors
  const anchors = anchorGenerator.generateImageAnchors(docId, kbId, raw);
  await anchorRepo.batchInsert(anchors);

  // 2. Create dual-format Structure pages (structure_dt + structure_md)
  const title = '图片内容';

  // L1_dt: DocTags format page
  const dtContent = sanitize(doctags);
  const dtPage = await wikiPageRepo.create({
    kb_id: kbId,
    doc_id: docId,
    page_type: 'structure_dt',
    title,
    content: dtContent,
    token_count: Math.ceil(dtContent.length / 4),
    file_path: `${kbId}/documents/${docId}/structure_dt/image.dt.md`,
    metadata: {
      anchorIds: anchors.map(a => a.id),
      modality: 'image',
      elementTypes: ['image'],
      format: raw.format,
      dimensions: raw.width && raw.height ? `${raw.width}x${raw.height}` : undefined,
    },
  });

  // L1_md: Markdown format page (use VLM description or OCR text)
  const mdContent = sanitize(raw.description || raw.ocrText || doctags);
  const mdPage = await wikiPageRepo.create({
    kb_id: kbId,
    doc_id: docId,
    page_type: 'structure_md',
    title,
    content: mdContent,
    token_count: Math.ceil(mdContent.length / 4),
    file_path: `${kbId}/documents/${docId}/structure/image.md`,
    metadata: {
      anchorIds: anchors.map(a => a.id),
      modality: 'image',
      elementTypes: ['image'],
      format: raw.format,
      dimensions: raw.width && raw.height ? `${raw.width}x${raw.height}` : undefined,
    },
  });

  // 3. Update anchor structure_page_id references
  await anchorRepo.updateStructurePageId(anchors.map(a => a.id), mdPage.id);

  // 4. Create FTS index entries for both pages
  await ftsRepo.upsertFTSEntry(dtPage.id, title, sanitize(doctags));
  await ftsRepo.upsertFTSEntry(mdPage.id, title, mdContent);

  return [dtPage.id, mdPage.id];
}
