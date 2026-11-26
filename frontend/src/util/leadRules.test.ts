import { TrickUnit } from "../gen-types";
import { isConsecutiveTupleLead } from "./leadRules";

const repeated = (card: string, count: number): TrickUnit => ({
  Repeated: { card: { card, trump: { NoTrump: {} } }, count },
});
const tractor = (cards: string[], count: number): TrickUnit => ({
  Tractor: {
    count,
    members: cards.map((card) => ({ card, trump: { NoTrump: {} } })),
  },
});
const cards = (groups: Array<[string, number]>): string[] =>
  groups.flatMap(([card, count]) => Array(count).fill(card));

describe("consecutive compatible tuple leads", () => {
  it("allows a single card and identical groups", () => {
    for (const count of [1, 2, 3, 4]) {
      expect(
        isConsecutiveTupleLead(Array(count).fill("5"), [repeated("5", count)]),
      ).toBe(true);
    }
  });

  it("allows a single tractor of pairs or triples", () => {
    expect(
      isConsecutiveTupleLead(["5", "5", "4", "4"], [tractor(["4", "5"], 2)]),
    ).toBe(true);
    expect(
      isConsecutiveTupleLead(
        ["7", "7", "7", "6", "6", "6", "5", "5", "5"],
        [tractor(["5", "6", "7"], 3)],
      ),
    ).toBe(true);
  });

  it("rejects a tractor with an extra singleton or pair", () => {
    expect(
      isConsecutiveTupleLead(
        ["A", "K", "K", "Q", "Q"],
        [tractor(["Q", "K"], 2), repeated("A", 1)],
      ),
    ).toBe(false);
    expect(
      isConsecutiveTupleLead(
        ["J", "J", "9", "9", "8", "8"],
        [tractor(["8", "9"], 2), repeated("J", 2)],
      ),
    ).toBe(false);
  });

  it("rejects incompatible widths, gaps, and singleton components", () => {
    expect(
      isConsecutiveTupleLead(
        cards([
          ["Q", 4],
          ["J", 3],
        ]),
        [tractor(["J", "Q"], 3), repeated("Q", 1)],
      ),
    ).toBe(false);
    expect(
      isConsecutiveTupleLead(
        cards([
          ["5", 2],
          ["9", 2],
        ]),
        [repeated("5", 2), repeated("9", 2)],
      ),
    ).toBe(false);
    expect(
      isConsecutiveTupleLead(
        cards([
          ["5", 2],
          ["6", 2],
          ["7", 1],
        ]),
        [tractor(["5", "6"], 2), repeated("7", 1)],
      ),
    ).toBe(false);
    expect(isConsecutiveTupleLead(["5", "5"], [])).toBe(false);
  });
  it("does not let six bridge triples and pairs in the same train", () => {
    expect(
      isConsecutiveTupleLead(
        cards([
          ["7", 3],
          ["6", 6],
          ["5", 2],
        ]),
        [tractor(["5", "6"], 2), tractor(["6", "7"], 3)],
      ),
    ).toBe(false);
  });
  it("allows a train of five-of-a-kind", () => {
    expect(
      isConsecutiveTupleLead(
        cards([
          ["8", 5],
          ["7", 5],
        ]),
        [tractor(["7", "8"], 5)],
      ),
    ).toBe(true);
  });
  it.each([
    [
      "QQQQJJTT",
      [
        ["Q", 4],
        ["J", 2],
        ["T", 2],
      ],
      [tractor(["T", "J", "Q"], 2), repeated("Q", 2)],
    ],
    [
      "777777666",
      [
        ["7", 6],
        ["6", 3],
      ],
      [tractor(["6", "7"], 3), repeated("7", 3)],
    ],
    [
      "777777665555",
      [
        ["7", 6],
        ["6", 2],
        ["5", 4],
      ],
      [tractor(["5", "6", "7"], 2), repeated("5", 2), repeated("7", 4)],
    ],
  ] as Array<[string, Array<[string, number]>, TrickUnit[]]>)(
    "allows the approved mixed-width train %s",
    (_label, groups, grouping) => {
      expect(isConsecutiveTupleLead(cards(groups), grouping)).toBe(true);
    },
  );

  it("rejects hints that omit or invent cards", () => {
    const selected = cards([
      ["Q", 4],
      ["J", 2],
      ["T", 2],
    ]);
    expect(
      isConsecutiveTupleLead(selected, [tractor(["T", "J", "Q"], 2)]),
    ).toBe(false);
    expect(
      isConsecutiveTupleLead(selected, [
        tractor(["T", "J", "Q"], 2),
        repeated("Q", 3),
      ]),
    ).toBe(false);
  });
});
