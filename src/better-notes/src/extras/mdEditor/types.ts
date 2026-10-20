/**
 * Shared types for the markdown-mode editor bundle.
 */

/** The Zotero node kinds rendered as atomic chips in the source view. */
export type ZNodeKind = "citation" | "annotation" | "notelink" | "image";

/** Magic-key palette switches, from the privileged side's preferences. */
export interface MagicKeyOptions {
  enable?: boolean;
  enableShortcut?: boolean;
}

/**
 * Callbacks into the privileged side (cloneInto): structured payloads cross
 * the boundary as JSON strings — only primitives travel safely.
 */
export interface MarkdownEditorCallbacks {
  /** Called on every document change (used for the debounced note save). */
  onChange?: () => void;
  /** Called on Mod-S (used to force an immediate note save). */
  onSave?: () => void;
  /**
   * Provides the hover-preview HTML for a Zotero node chip, like the
   * rich-text editor's link preview.
   */
  getPreview?: (
    kind: ZNodeKind,
    raw: string,
    setContent: (html: string) => void,
  ) => void;
  /** Opens a link clicked inside a preview popup. */
  openURL?: (url: string) => void;
  /**
   * Buttons for a chip's click popup; neighbor chips ride along for the
   * annotation-citation pair rules.
   */
  getNodeActions?: (
    kind: ZNodeKind,
    raw: string,
    neighborsJSON: string,
    setActions: (actionsJSON: string) => void,
  ) => void;
  /**
   * Runs a chip popup action; applyEdit replaces the chip's source, and
   * trimBefore also removes the gap to the previous chip.
   */
  onNodeAction?: (
    id: string,
    kind: ZNodeKind,
    raw: string,
    applyEdit: (newText: string, trimBefore?: boolean) => void,
  ) => void;
  /**
   * Provides the privileged part of the magic-key palette as JSON:
   * { openAttachment: boolean, custom: [{ id, title, icon?, searchParts }] }.
   */
  getMagicCommands?: (setCommands: (commandsJSON: string) => void) => void;
  /** Runs a privileged magic-key command (insertTemplate, copyLineLink, ...). */
  onMagicCommand?: (id: string) => void;
  /**
   * Converts pasted HTML to markdown, importing note-specific data (e.g.
   * embedded images); called with the plain-text flavor as fallback.
   */
  convertPaste?: (
    html: string,
    plain: string,
    setResult: (md: string) => void,
  ) => void;
}
