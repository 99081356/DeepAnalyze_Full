// =============================================================================
// DeepAnalyze - useKnowledgeMarkdown
// Shared, persisted preference that controls whether L0/L1/L2 content in the
// knowledge base (DocumentCard + KnowledgePanel search results) is rendered as
// Markdown or as plain text.
//
// Defaults to ON to match DocumentViewer / WikiBrowser / EntityPage, which have
// always rendered Markdown. The choice is persisted to localStorage and kept in
// sync across every component instance on the page via a window event.
// =============================================================================

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "da.knowledge.markdownEnabled";
const TOGGLE_EVENT = "da:kb-md-toggle";

const DEFAULT_ENABLED = true;

/** Read the stored preference once. Falls back to default on any error. */
function readStored(): boolean {
  if (typeof window === "undefined") return DEFAULT_ENABLED;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_ENABLED;
    return raw === "1" || raw === "true";
  } catch {
    // Privacy mode / disabled storage
    return DEFAULT_ENABLED;
  }
}

/** Persist the preference. Silently ignored on any error. */
function writeStored(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    // ignore
  }
}

export interface KnowledgeMarkdownPreference {
  /** Whether Markdown rendering is currently enabled. */
  markdownEnabled: boolean;
  /** Set the preference to a specific value (also persists + broadcasts). */
  setMarkdownEnabled: (value: boolean) => void;
  /** Convenience toggle. */
  toggle: () => void;
}

/**
 * Hook shared by every component that renders L0/L1/L2 knowledge content.
 * Returns the current preference and updaters; stays in sync across instances.
 */
export function useKnowledgeMarkdown(): KnowledgeMarkdownPreference {
  const [markdownEnabled, setEnabled] = useState<boolean>(readStored);

  // Keep this instance in sync when another instance changes the value.
  useEffect(() => {
    const onToggle = () => setEnabled(readStored());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) onToggle();
    };
    window.addEventListener(TOGGLE_EVENT, onToggle);
    // storage event fires for changes in other tabs/windows
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(TOGGLE_EVENT, onToggle);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setMarkdownEnabled = useCallback((value: boolean) => {
    writeStored(value);
    setEnabled(value);
    // Notify other hook instances in this tab.
    window.dispatchEvent(new Event(TOGGLE_EVENT));
  }, []);

  const toggle = useCallback(() => {
    setMarkdownEnabled(!readStored());
  }, []);

  return { markdownEnabled, setMarkdownEnabled, toggle };
}
