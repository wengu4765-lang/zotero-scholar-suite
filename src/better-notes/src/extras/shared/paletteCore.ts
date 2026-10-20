/**
 * The searchable command list shared by both magic palettes: rendering,
 * filtering, keyboard navigation. The host owns popup shell and execution.
 */

/** One palette row: display data and the keys it is found by. */
export interface PaletteEntry {
  id: string;
  title: string;
  icon?: string;
  searchParts: string[];
}

export interface PaletteListHost {
  /** Run the entry at this index (the host also closes its popup). */
  execute(index: number): void;
  /**
   * Close without executing; "undo" (Mod-Z in the search input) also asks
   * the host to revert the palette's trigger (the typed `/`).
   */
  dismiss(reason: "escape" | "undo"): void;
}

export class PaletteList {
  selectedIndex = 0;

  private entries: PaletteEntry[] = [];

  private list: HTMLElement | null = null;

  constructor(readonly host: PaletteListHost) {}

  /** Render the entries into `list`, wire `input`, and focus it. */
  attach(input: HTMLInputElement, list: HTMLElement, entries: PaletteEntry[]) {
    this.entries = entries;
    this.list = list;
    const doc = list.ownerDocument;
    for (const [index, entry] of entries.entries()) {
      const item = doc.createElement("div");
      item.className = "popup-item";
      item.dataset.commandId = String(index);
      item.dataset.command = entry.id;
      const icon = doc.createElement("div");
      icon.className = "popup-item-icon";
      icon.innerHTML = entry.icon || "";
      const title = doc.createElement("div");
      title.className = "popup-item-title";
      title.textContent = entry.title;
      const key = doc.createElement("div");
      key.className = "popup-item-key";
      key.textContent = entry.searchParts[0];
      item.append(icon, title, key);
      list.appendChild(item);
    }
    list.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = (event.target as HTMLElement).closest(
        ".popup-item",
      ) as HTMLElement | null;
      if (item) {
        this.host.execute(parseInt(item.dataset.commandId || "-1", 10));
      }
    });
    input.addEventListener("input", () => this.filter(input.value));
    input.addEventListener("keydown", (event) => this.handleKeydown(event));
    this.selectCommand(0);
    input.focus();
  }

  private items() {
    return Array.from(
      this.list?.querySelectorAll(".popup-item") || [],
    ) as HTMLElement[];
  }

  /** Hide non-matching entries, bold the matched title part. */
  private filter(value: string) {
    const items = this.items();
    let autoSelect: number | undefined;
    for (const [index, entry] of this.entries.entries()) {
      const item = items[index];
      const title = item.querySelector(".popup-item-title") as HTMLElement;
      if (!value) {
        item.hidden = false;
        title.textContent = entry.title;
        continue;
      }
      const matchedIndex = entry.title
        .toLowerCase()
        .indexOf(value.toLowerCase());
      const partMatch = entry.searchParts.some((part) =>
        part.toLowerCase().includes(value.toLowerCase()),
      );
      item.hidden = matchedIndex < 0 && !partMatch;
      if (
        !item.hidden &&
        entry.searchParts[0].toLowerCase() === value.toLowerCase()
      ) {
        autoSelect = index;
      }
      if (matchedIndex >= 0) {
        title.textContent = "";
        title.append(
          entry.title.slice(0, matchedIndex),
          Object.assign(title.ownerDocument.createElement("b"), {
            textContent: entry.title.slice(
              matchedIndex,
              matchedIndex + value.length,
            ),
          }),
          entry.title.slice(matchedIndex + value.length),
        );
      } else {
        title.textContent = entry.title;
      }
    }
    this.selectCommand(autoSelect);
  }

  private handleKeydown(event: KeyboardEvent) {
    const input = event.target as HTMLInputElement;
    if (event.key === "ArrowUp") {
      this.selectCommand(this.selectedIndex - 1, "up");
      event.preventDefault();
    } else if (event.key === "ArrowDown") {
      this.selectCommand(this.selectedIndex + 1, "down");
      event.preventDefault();
    } else if (event.key === "ArrowLeft") {
      this.selectCommand(this.entries.length, "up");
      event.preventDefault();
    } else if (event.key === "ArrowRight") {
      this.selectCommand(-1, "down");
      event.preventDefault();
    } else if (event.key === "Tab") {
      // Autocomplete the selected title up to the next word.
      const entry = this.entries[this.selectedIndex];
      if (entry && input.value) {
        const matchedIndex = entry.title
          .toLowerCase()
          .indexOf(input.value.toLowerCase());
        const spaceIndex = entry.title.indexOf(
          " ",
          matchedIndex + input.value.length,
        );
        input.value =
          spaceIndex >= 0 ? entry.title.slice(0, spaceIndex) : entry.title;
      }
      event.preventDefault();
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.host.execute(this.selectedIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.host.dismiss("escape");
    } else if (event.key === "z" && (event.ctrlKey || event.metaKey)) {
      this.host.dismiss("undo");
    }
  }

  /** Select an entry, skipping hidden ones in the given direction. */
  private selectCommand(index?: number, direction: "up" | "down" = "down") {
    if (!this.list) {
      return;
    }
    if (typeof index === "undefined") {
      index = this.selectedIndex;
    }
    const items = this.items();
    items.forEach((item) => item.classList.remove("selected"));
    if (items[index]?.hidden) {
      const step = direction === "up" ? -1 : 1;
      for (let i = index + step; i >= 0 && i < items.length; i += step) {
        if (!items[i].hidden) {
          index = i;
          break;
        }
      }
    }
    if (index >= items.length) {
      index = items.findIndex((item) => !item.hidden);
    } else if (index < 0) {
      for (let i = items.length - 1; i >= 0; i--) {
        if (!items[i].hidden) {
          index = i;
          break;
        }
      }
    }
    if (index < 0 || index >= items.length || items[index].hidden) {
      this.selectedIndex = -1;
      return;
    }
    this.selectedIndex = index;
    items[index].classList.add("selected");
    items[index].scrollIntoView({ block: "nearest" });
  }
}
