// Stub: notebook.ts - Notebook types
export interface NotebookCell {
  cell_type: string
  source: string[]
  outputs?: unknown[]
  [key: string]: unknown
}

export interface Notebook {
  cells: NotebookCell[]
  metadata: Record<string, unknown>
  nbformat: number
}
