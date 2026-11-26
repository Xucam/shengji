import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import NumDecksSelector from "./NumDecksSelector";

describe("deck selection before the room fills", () => {
  it.each([0, 1, 2, 3])("offers four decks with %i players", (numPlayers) => {
    const html = renderToStaticMarkup(
      <NumDecksSelector
        numPlayers={numPlayers}
        numDecks={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("default (4 decks)");
    for (const count of [1, 2, 3, 4]) {
      expect(html).toContain(`<option value="${count}">${count}</option>`);
    }
  });
  it.each([4, 6, 8])("offers one extra deck with %i players", (numPlayers) => {
    const html = renderToStaticMarkup(
      <NumDecksSelector
        numPlayers={numPlayers}
        numDecks={numPlayers + 1}
        onChange={() => {}}
      />,
    );
    expect(html).toContain(
      `<option value="${numPlayers + 1}" selected="">${numPlayers + 1}</option>`,
    );
    expect(html).not.toContain(`<option value="${numPlayers + 2}"`);
  });
});
