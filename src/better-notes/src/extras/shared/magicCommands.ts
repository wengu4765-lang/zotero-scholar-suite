/**
 * Canonical magic-key command metadata shared by both palettes: what
 * exists, in which order, how it is found (ids double as messageIds).
 */

export interface MagicCommandMeta {
  id: string;
  searchParts: string[];
  /**
   * "format" commands edit the document in-editor; "action" commands need
   * app context (the privileged side in markdown mode).
   */
  kind: "format" | "action";
}

export const MAGIC_COMMANDS: MagicCommandMeta[] = [
  {
    id: "insertTemplate",
    searchParts: ["it", "insertTemplate"],
    kind: "action",
  },
  {
    id: "outboundLink",
    searchParts: ["ob", "obl", "outboundLink"],
    kind: "action",
  },
  {
    id: "inboundLink",
    searchParts: ["ib", "ibl", "inboundLink"],
    kind: "action",
  },
  {
    id: "insertCitation",
    searchParts: ["ic", "insertCitation"],
    kind: "action",
  },
  {
    id: "openAttachment",
    searchParts: ["oa", "openAttachment"],
    kind: "action",
  },
  {
    id: "copySectionLink",
    searchParts: ["csl", "copySectionLink"],
    kind: "action",
  },
  { id: "copyLineLink", searchParts: ["cll", "copyLineLink"], kind: "action" },
  {
    id: "refreshTemplates",
    searchParts: ["rt", "refreshTemplates"],
    kind: "action",
  },
  { id: "table", searchParts: ["tb", "table"], kind: "format" },
  { id: "heading1", searchParts: ["h1", "heading1"], kind: "format" },
  { id: "heading2", searchParts: ["h2", "heading2"], kind: "format" },
  { id: "heading3", searchParts: ["h3", "heading3"], kind: "format" },
  { id: "paragraph", searchParts: ["pg", "paragraph"], kind: "format" },
  { id: "monospaced", searchParts: ["ms", "monospaced"], kind: "format" },
  {
    id: "bulletList",
    searchParts: ["ul", "bulletList", "unorderedList"],
    kind: "format",
  },
  { id: "orderedList", searchParts: ["ol", "orderedList"], kind: "format" },
  {
    id: "todoList",
    searchParts: ["td", "todo", "todoList", "task", "checkbox"],
    kind: "format",
  },
  { id: "blockquote", searchParts: ["bq", "blockquote"], kind: "format" },
  { id: "mathBlock", searchParts: ["mb", "mathBlock"], kind: "format" },
  {
    id: "clearFormatting",
    searchParts: ["cf", "clearFormatting"],
    kind: "format",
  },
];
