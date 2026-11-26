import { pickupLandlord } from "./pickupLandlord";
import { DrawPhase } from "../gen-types";

type State = Pick<DrawPhase, "propagated" | "bids" | "autobid">;
const state = (winners: number[], bidder: number): State => ({
  propagated: {
    players: [0, 1, 2, 3, 4, 5].map((id) => ({
      id,
      name: `Player ${id}`,
      level: "2",
      metalevel: 0,
    })),
    observers: [],
    max_player_id: 6,
    game_mode: "Tractor",
    landlord: 0,
    previous_winners: winners,
    num_games_finished: winners.length ? 1 : 0,
  },
  bids: [{ id: bidder, card: "🂲", count: 1, epoch: 0 }],
  autobid: null,
});

describe("bottom-card pickup eligibility", () => {
  it("uses the winning bidder in the first round", () => {
    expect(pickupLandlord(state([], 4))).toBe(4);
  });
  it("lets a previous-round winner take their own winning bid", () => {
    expect(pickupLandlord(state([0, 2], 2))).toBe(2);
  });
  it("skips multiple losers after the winning bidder", () => {
    expect(pickupLandlord(state([2, 5], 0))).toBe(2);
  });
  it("wraps to the first seated winner", () => {
    expect(pickupLandlord(state([0, 2], 3))).toBe(0);
  });
  it("uses current seat order and ignores departed winners", () => {
    const s = state([2, 5], 0);
    s.propagated.players = s.propagated.players.filter((p) => p.id !== 2);
    expect(pickupLandlord(s)).toBe(5);
    s.propagated.players.reverse();
    expect(pickupLandlord(s)).toBe(5);
  });
  it("disables pickup if no eligible winner remains", () => {
    expect(pickupLandlord(state([99], 0))).toBeNull();
  });
  it("disables pickup before bidding except for an eligible no-trump leader", () => {
    const s = state([0, 2], 0);
    s.bids = [];
    expect(pickupLandlord(s)).toBeNull();
    s.propagated.players[0].level = "NT";
    expect(pickupLandlord(s)).toBe(0);
  });
  it("preserves the designated leader in old saved games", () => {
    const s = state([], 4);
    delete s.propagated.previous_winners;
    s.propagated.num_games_finished = 2;
    expect(pickupLandlord(s)).toBe(0);
  });
  it("resolves left/next using the current table order", () => {
    const s = state([2, 5], 0);
    expect(pickupLandlord(s)).toBe(2);
    s.propagated.players.reverse();
    expect(pickupLandlord(s)).toBe(5);
  });
});
