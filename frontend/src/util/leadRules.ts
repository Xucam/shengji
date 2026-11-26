import { TrickUnit } from "../gen-types";

// Groupings come from the mechanics engine, which verifies rank adjacency.
// Multiple units are allowed when they represent one continuous mixed-width train.
export function isConsecutiveTupleLead(
  cards: string[],
  grouping: TrickUnit[],
): boolean {
  if (cards.length === 0 || grouping.length === 0) return false;
  const counts = new Map<string, number>();
  const grouped = new Map<string, number>();
  for (const card of cards) counts.set(card, (counts.get(card) ?? 0) + 1);
  const gcd = (a: number, b: number): number => {
    while (b !== 0) [a, b] = [b, a % b];
    return a;
  };
  let base = Array.from(counts.values()).reduce(gcd, 0);
  for (const unit of grouping) {
    const members =
      "Repeated" in unit ? [unit.Repeated.card] : unit.Tractor.members;
    const count = "Repeated" in unit ? unit.Repeated.count : unit.Tractor.count;
    if (cards.length > 1 && count < 2) return false;
    base = gcd(base, count);
    for (const { card } of members)
      grouped.set(card, (grouped.get(card) ?? 0) + count);
  }
  if (
    grouped.size !== counts.size ||
    !Array.from(counts).every(([card, count]) => grouped.get(card) === count)
  ) {
    return false;
  }
  if (cards.length === 1) return grouping.length === 1;
  return (
    base >= 2 &&
    (counts.size === 1 ||
      grouping.some(
        (unit) =>
          "Tractor" in unit &&
          unit.Tractor.members.length === counts.size &&
          Array.from(counts.keys()).every((card) =>
            unit.Tractor.members.some((member) => member.card === card),
          ),
      ))
  );
}
