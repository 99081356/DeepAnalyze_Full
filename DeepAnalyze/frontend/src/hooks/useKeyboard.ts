import { useEffect, useCallback, useRef } from "react";

type KeyCombo = {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

type KeyHandler = (e: KeyboardEvent) => void;

/**
 * Register a global keyboard shortcut.
 * Automatically cleans up on unmount.
 *
 * Usage:
 *   useKeyboard({ key: "n", ctrl: true }, () => createSession());
 *   useKeyboard({ key: "Escape" }, () => closePanel());
 */
export function useKeyboard(combo: KeyCombo, handler: KeyHandler) {
  // Keep handler ref current without re-registering the listener
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  // Store combo as individual primitives so the effect is stable
  const { key, ctrl = false, shift = false, alt = false } = combo;

  const memoHandler = useCallback(
    (e: KeyboardEvent) => {
      const ctrlMatch = ctrl
        ? e.ctrlKey || e.metaKey
        : !e.ctrlKey && !e.metaKey;
      const shiftMatch = shift ? e.shiftKey : !e.shiftKey;
      const altMatch = alt ? e.altKey : !e.altKey;

      if (
        e.key.toLowerCase() === key.toLowerCase() &&
        ctrlMatch &&
        shiftMatch &&
        altMatch
      ) {
        e.preventDefault();
        handlerRef.current(e);
      }
    },
    [key, ctrl, shift, alt],
  );

  useEffect(() => {
    window.addEventListener("keydown", memoHandler);
    return () => window.removeEventListener("keydown", memoHandler);
  }, [memoHandler]);
}
