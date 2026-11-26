import { DrawPhase } from "../gen-types";

export function pickupLandlord(
  state: Pick<DrawPhase, "propagated" | "bids" | "autobid">,
): number | null {
  const { propagated, bids } = state;
  const bid = state.autobid ?? bids[bids.length - 1];
  const winners = propagated.previous_winners ?? [];
  if (!bid) {
    const leader = propagated.players.find((p) => p.id === propagated.landlord);
    return leader?.level === "NT" &&
      (winners.length === 0 || winners.includes(leader.id))
      ? leader.id
      : null;
  }
  if (winners.length === 0) {
    return (propagated.num_games_finished ?? 0) > 0
      ? (propagated.landlord ?? bid.id)
      : bid.id;
  }
  const index = propagated.players.findIndex((p) => p.id === bid.id);
  if (index < 0) return null;
  for (let offset = 0; offset < propagated.players.length; offset++) {
    const id =
      propagated.players[(index + offset) % propagated.players.length].id;
    if (winners.includes(id)) return id;
  }
  return null;
}
