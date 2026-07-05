import { create } from 'zustand';

interface EvidencePreviewState {
  isOpen: boolean;
  mode: "anchor" | "document";
  anchorId: string | null;
  kbId: string | null;
  docId: string | null;
  openPreview: (anchorId: string, kbId: string, docId: string) => void;
  openDocumentPreview: (kbId: string, docId: string) => void;
  closePreview: () => void;
}

export const useEvidencePreviewStore = create<EvidencePreviewState>((set) => ({
  isOpen: false,
  mode: "anchor",
  anchorId: null,
  kbId: null,
  docId: null,
  openPreview: (anchorId, kbId, docId) => set({ isOpen: true, mode: "anchor", anchorId, kbId, docId }),
  openDocumentPreview: (kbId, docId) => set({ isOpen: true, mode: "document", anchorId: null, kbId, docId }),
  closePreview: () => set({ isOpen: false, mode: "anchor", anchorId: null, kbId: null, docId: null }),
}));

// Expose for testing
if (typeof window !== 'undefined') {
  (window as any).__evidencePreviewStore = useEvidencePreviewStore;
}
