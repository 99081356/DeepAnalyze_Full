import { getRepos } from '../store/repos/index.js';

export interface DisplayInfo {
  originalName: string;
  kbName: string;
  displayLabel: string;
  fileType: string;
  modalityIcon: string;
}

const FILE_TYPE_ICONS: Record<string, string> = {
  pdf: '📄', docx: '📄', pptx: '📄',
  xlsx: '📊', xls: '📊', csv: '📊',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️',
  mp3: '🎙️', wav: '🎙️',
  mp4: '📹', avi: '📹', mov: '📹',
};

/**
 * Resolves internal docId to user-visible display names.
 * Queries documents + knowledge_bases tables via PG repos, with in-memory cache.
 */
export class DisplayResolver {
  private cache: Map<string, DisplayInfo> = new Map();

  /** Resolve a single docId to its display info. */
  async resolve(docId: string): Promise<DisplayInfo> {
    const cached = this.cache.get(docId);
    if (cached) return cached;

    const results = await this.resolveBatch([docId]);
    return results[docId] ?? {
      originalName: docId,
      kbName: '',
      displayLabel: docId,
      fileType: '',
      modalityIcon: '',
    };
  }

  /** Resolve multiple docIds using repos to avoid N+1. */
  async resolveBatch(docIds: string[]): Promise<Record<string, DisplayInfo>> {
    const uncached = docIds.filter(id => !this.cache.has(id));
    const result: Record<string, DisplayInfo> = {};

    // Populate from cache
    for (const id of docIds) {
      const cached = this.cache.get(id);
      if (cached) result[id] = cached;
    }

    if (uncached.length > 0) {
      const repos = await getRepos();

      for (const id of uncached) {
        const doc = await repos.document.getById(id);
        if (doc) {
          const kb = doc.kb_id ? await repos.knowledgeBase.get(doc.kb_id) : undefined;
          const kbName = kb?.name ?? '';
          const info: DisplayInfo = {
            originalName: doc.filename,
            kbName,
            displayLabel: `${kbName}/${doc.filename}`,
            fileType: doc.file_type ?? '',
            modalityIcon: FILE_TYPE_ICONS[doc.file_type] ?? '📄',
          };
          this.cache.set(id, info);
          result[id] = info;
        } else {
          const fallback: DisplayInfo = {
            originalName: id,
            kbName: '',
            displayLabel: id,
            fileType: '',
            modalityIcon: '',
          };
          this.cache.set(id, fallback);
          result[id] = fallback;
        }
      }
    }

    return result;
  }
}
