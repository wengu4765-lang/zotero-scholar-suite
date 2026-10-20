import { getAddon } from "../utils/global";

describe("Sync - Markdown status parsing", function () {
  const addon = getAddon();

  it("preserves content before a YAML-like block in the body", function () {
    const input = [
      "# Document",
      "",
      "Intro before the horizontal rules.",
      "---",
      "body: content",
      "---",
      "Tail after the horizontal rules.",
    ].join("\n");

    const status = addon.api.sync.getMDStatusFromContent(input);
    expect(status.meta).to.deep.equal({ $version: -1 });
    expect(status.content).to.equal(input);
  });

  it("parses YAML front matter at the document start", function () {
    const input = [
      "---",
      "$version: 7",
      "$libraryID: 4",
      "$itemKey: ABC123",
      "---",
      "body",
    ].join("\n");

    const status = addon.api.sync.getMDStatusFromContent(input);
    expect(status.meta).to.deep.equal({
      $version: 7,
      $libraryID: 4,
      $itemKey: "ABC123",
    });
    expect(status.content).to.equal("\nbody");
  });
});
