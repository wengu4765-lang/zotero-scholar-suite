/**
 * Per-container registries (type-only manager imports), so managers can
 * reach each other without runtime import cycles.
 */
import type { EditorView } from "@codemirror/view";
import type { PreviewManager } from "./preview";
import type { ActionPopupManager } from "./actionPopup";
import type { MagicKeyManager } from "./magicKey";

export const views = new WeakMap<HTMLElement, EditorView>();
export const previewManagers = new WeakMap<HTMLElement, PreviewManager>();
export const actionPopups = new WeakMap<HTMLElement, ActionPopupManager>();
export const magicKeyManagers = new WeakMap<HTMLElement, MagicKeyManager>();
export const resizeObservers = new WeakMap<HTMLElement, ResizeObserver>();
