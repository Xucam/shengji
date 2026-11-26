use anyhow::{anyhow, bail, Error};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use shengji_mechanics::bidding::Bid;
use shengji_mechanics::deck::Deck;
use shengji_mechanics::hands::Hands;
use shengji_mechanics::types::{Card, PlayerID, Rank, Trump};

use crate::message::MessageVariant;
use crate::settings::{GameMode, KittyBidPolicy, PropagatedState};

use crate::game_state::exchange_phase::ExchangePhase;
use crate::game_state::initialize_phase::InitializePhase;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DrawPhase {
    num_decks: usize,
    game_mode: GameMode,
    deck: Vec<Card>,
    propagated: PropagatedState,
    hands: Hands,
    bids: Vec<Bid>,
    #[serde(default)]
    autobid: Option<Bid>,
    position: usize,
    kitty: Vec<Card>,
    #[serde(default)]
    revealed_cards: usize,
    level: Option<Rank>,
    #[serde(default)]
    removed_cards: Vec<Card>,
    #[serde(default)]
    decks: Vec<Deck>,
    player_requested_reset: Option<PlayerID>,
}

impl DrawPhase {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        propagated: PropagatedState,
        position: usize,
        deck: Vec<Card>,
        kitty: Vec<Card>,
        num_decks: usize,
        game_mode: GameMode,
        level: Option<Rank>,
        decks: Vec<Deck>,
        removed_cards: Vec<Card>,
    ) -> Self {
        DrawPhase {
            hands: Hands::new(propagated.players.iter().map(|p| p.id)),
            deck,
            kitty,
            propagated,
            position,
            num_decks,
            decks,
            game_mode,
            level,
            removed_cards,
            bids: Vec::new(),
            revealed_cards: 0,
            autobid: None,
            player_requested_reset: None,
        }
    }

    pub fn propagated(&self) -> &PropagatedState {
        &self.propagated
    }

    pub fn propagated_mut(&mut self) -> &mut PropagatedState {
        &mut self.propagated
    }

    pub fn removed_cards(&self) -> &[Card] {
        &self.removed_cards
    }

    pub fn deck(&self) -> &[Card] {
        &self.deck
    }

    pub fn kitty(&self) -> &[Card] {
        &self.kitty
    }

    #[cfg(test)]
    pub fn deck_mut(&mut self) -> &mut Vec<Card> {
        &mut self.deck
    }

    #[cfg(test)]
    pub fn position_mut(&mut self) -> &mut usize {
        &mut self.position
    }

    #[cfg(test)]
    pub fn kitty_mut(&mut self) -> &mut Vec<Card> {
        &mut self.kitty
    }

    pub fn add_observer(&mut self, name: String) -> Result<PlayerID, Error> {
        self.propagated.add_observer(name)
    }

    pub fn remove_observer(&mut self, id: PlayerID) -> Result<(), Error> {
        self.propagated.remove_observer(id)
    }

    /// Resolve pickup eligibility separately from the winning suit bid.
    pub fn pickup_landlord(&self) -> Result<PlayerID, Error> {
        let winning_bid = match Bid::first_and_winner(&self.bids, self.autobid) {
            Ok((_, bid)) => bid,
            Err(error) => {
                // No-trump rounds have no suit bidding; use the seeded leader.
                if let Some(id) = self.propagated.landlord {
                    if self
                        .propagated
                        .players
                        .iter()
                        .any(|p| p.id == id && p.rank() == Rank::NoTrump)
                        && (self.propagated.previous_winners.is_empty()
                            || self.propagated.previous_winners.contains(&id))
                    {
                        return Ok(id);
                    }
                }
                return Err(error);
            }
        };
        if self.propagated.previous_winners.is_empty() {
            // Older saved games did not record the full winning team. Keep
            // their assigned leader until a completed round records it.
            if self.propagated.num_games_finished > 0 {
                if let Some(id) = self.propagated.landlord {
                    return Ok(id);
                }
            }
            return Ok(winning_bid.id);
        }
        let bidder = self
            .propagated
            .players
            .iter()
            .position(|p| p.id == winning_bid.id)
            .ok_or_else(|| anyhow!("Winning bidder is not seated"))?;
        (0..self.propagated.players.len())
            .map(|offset| {
                self.propagated.players[(bidder + offset) % self.propagated.players.len()].id
            })
            .find(|id| self.propagated.previous_winners.contains(id))
            .ok_or_else(|| {
                anyhow!("No previous-round winner is seated to pick up the bottom cards")
            })
    }

    pub fn next_player(&self) -> Result<PlayerID, Error> {
        if self.deck.is_empty() {
            self.pickup_landlord()
        } else {
            Ok(self.propagated.players[self.position].id)
        }
    }

    pub fn draw_card(&mut self, id: PlayerID) -> Result<(), Error> {
        if id != self.propagated.players[self.position].id {
            bail!("not your turn!");
        }
        if let Some(next_card) = self.deck.pop() {
            self.hands.add(id, Some(next_card))?;
            self.position = (self.position + 1) % self.propagated.players.len();
            Ok(())
        } else {
            bail!("no cards left in deck")
        }
    }

    /// Deal one card to each player, preserving the existing rotation and kitty.
    /// The last round may contain fewer cards than players.
    pub fn draw_round(&mut self) -> Result<usize, Error> {
        let count = self.propagated.players.len().min(self.deck.len());
        for _ in 0..count {
            self.draw_card(self.next_player()?)?;
        }
        Ok(count)
    }

    pub fn reveal_card(&mut self) -> Result<MessageVariant, Error> {
        if !self.deck.is_empty() {
            bail!("can't reveal card until deck is fully drawn")
        }
        if !self.bids.is_empty() {
            bail!("can't reveal card if at least one bid has been made")
        }
        let id = self
            .propagated
            .landlord
            .ok_or_else(|| anyhow!("can't reveal card if landlord hasn't been selected yet"))?;

        let landlord_level = self
            .propagated
            .players
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| anyhow!("Couldn't find landlord level?"))?
            .rank();

        if landlord_level == Rank::NoTrump {
            bail!("can't reveal card if the level is no trump!");
        }

        if self.revealed_cards >= self.kitty.len() || self.autobid.is_some() {
            bail!("can't reveal any more cards")
        }

        let level = self
            .propagated
            .players
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.rank())
            .ok_or_else(|| anyhow!("can't find landlord level?"))?;

        let card = self.kitty[self.revealed_cards];

        match self.propagated.kitty_bid_policy {
            KittyBidPolicy::FirstCard => {
                self.autobid = Some(Bid {
                    count: 1,
                    id,
                    card,
                    epoch: 0,
                });
            }
            KittyBidPolicy::FirstCardOfLevelOrHighest
                if card.is_joker() || card.number().map(Rank::Number) == Some(level) =>
            {
                self.autobid = Some(Bid {
                    count: 1,
                    id,
                    card,
                    epoch: 0,
                });
            }
            KittyBidPolicy::FirstCardOfLevelOrHighest
                if self.revealed_cards >= self.kitty.len() - 1 =>
            {
                let mut sorted_kitty = self.kitty.clone();
                sorted_kitty.sort_by(|a, b| {
                    Trump::NoTrump {
                        number: match level {
                            Rank::Number(n) => Some(n),
                            Rank::NoTrump => None,
                        },
                    }
                    .compare(*a, *b)
                });
                if let Some(highest_card) = sorted_kitty.last() {
                    self.autobid = Some(Bid {
                        count: 1,
                        id,
                        card: *highest_card,
                        epoch: 0,
                    });
                }
            }
            _ => (),
        }
        self.revealed_cards += 1;

        Ok(MessageVariant::RevealedCardFromKitty)
    }

    pub fn bid(&mut self, id: PlayerID, card: Card, count: usize) -> bool {
        if self.revealed_cards > 0 {
            return false;
        }
        Bid::bid(
            id,
            card,
            count,
            &mut self.bids,
            self.autobid,
            &self.hands,
            &self.propagated.players,
            self.propagated.landlord,
            self.propagated.bid_policy,
            self.propagated.bid_reinforcement_policy,
            self.propagated.joker_bid_policy,
            self.num_decks,
            0,
        )
    }

    pub fn take_back_bid(&mut self, id: PlayerID) -> Result<(), Error> {
        Bid::take_back_bid(id, self.propagated.bid_takeback_policy, &mut self.bids, 0)
    }

    pub fn done_drawing(&self) -> bool {
        self.deck.is_empty()
    }

    pub fn advance(&self, id: PlayerID) -> Result<ExchangePhase, Error> {
        if !self.deck.is_empty() {
            bail!("deck has cards remaining")
        }

        let (landlord, landlord_level) = {
            let landlord = self.pickup_landlord()?;

            if id != landlord {
                bail!("only the leader can advance the game");
            }
            let landlord_level = self
                .propagated
                .players
                .iter()
                .find(|p| p.id == landlord)
                .ok_or_else(|| anyhow!("Couldn't find landlord level?"))?
                .rank();
            (landlord, self.level.unwrap_or(landlord_level))
        };
        let trump = match landlord_level {
            Rank::NoTrump => Trump::NoTrump { number: None },
            Rank::Number(landlord_level) => {
                // Note: this is not repeated in all cases above, but it is
                // repeated in some. It's OK because the bid calculation is
                // fast.
                let (_, winning_bid) = Bid::first_and_winner(&self.bids, self.autobid)?;
                match winning_bid.card {
                    Card::Unknown => bail!("can't bid with unknown cards!"),
                    Card::SmallJoker | Card::BigJoker => Trump::NoTrump {
                        number: Some(landlord_level),
                    },
                    Card::Suited { suit, .. } => Trump::Standard {
                        suit,
                        number: landlord_level,
                    },
                }
            }
        };
        let mut hands = self.hands.clone();
        hands.set_trump(trump);
        let mut propagated = self.propagated.clone();
        propagated.set_landlord(Some(landlord))?;
        Ok(ExchangePhase::new(
            propagated,
            self.num_decks,
            self.game_mode.clone(),
            self.kitty.clone(),
            landlord,
            hands,
            trump,
            self.bids.clone(),
            self.autobid,
            self.removed_cards.clone(),
            self.decks.clone(),
        ))
    }

    pub fn request_reset(
        &mut self,
        player: PlayerID,
    ) -> Result<(Option<InitializePhase>, Vec<MessageVariant>), Error> {
        match self.player_requested_reset {
            Some(p) => {
                // ignore duplicate reset requests from same player
                if p == player {
                    return Ok((None, vec![]));
                }

                let (s, m) = self.return_to_initialize()?;
                Ok((Some(s), m))
            }
            None => {
                self.player_requested_reset = Some(player);
                Ok((None, vec![MessageVariant::ResetRequested]))
            }
        }
    }

    pub fn cancel_reset(&mut self) -> Option<MessageVariant> {
        if self.player_requested_reset.is_some() {
            self.player_requested_reset = None;
            return Some(MessageVariant::ResetCanceled);
        }
        None
    }

    fn return_to_initialize(&self) -> Result<(InitializePhase, Vec<MessageVariant>), Error> {
        let mut msgs = vec![MessageVariant::ResettingGame];

        let mut propagated = self.propagated.clone();
        msgs.extend(propagated.make_all_observers_into_players()?);

        Ok((InitializePhase::from_propagated(propagated), msgs))
    }

    pub fn destructively_redact_for_player(&mut self, player: PlayerID) {
        self.hands.destructively_redact_except_for_player(player);
        for card in &mut self.kitty[self.revealed_cards..] {
            *card = Card::Unknown;
        }
        for card in &mut self.deck {
            *card = Card::Unknown;
        }
    }
}

#[cfg(test)]
mod landlord_tests {
    use super::*;
    use crate::settings::FirstLandlordSelectionPolicy;
    use shengji_mechanics::types::{cards::*, Number, Suit};

    fn draw(winners: &[PlayerID], bidder: PlayerID) -> DrawPhase {
        let mut init = InitializePhase::new();
        for i in 0..6 {
            init.add_player(format!("Player {i}")).unwrap();
        }
        init.set_landlord(Some(PlayerID(0))).unwrap();
        init.propagated_mut().previous_winners = winners.to_vec();
        let mut draw = init.start(PlayerID(0)).unwrap();
        draw.deck.clear();
        draw.bids.push(Bid {
            id: bidder,
            card: H_2,
            count: 1,
            epoch: 0,
        });
        draw
    }

    #[test]
    fn first_round_winning_bidder_is_landlord_even_with_a_seeded_leader() {
        let mut draw = draw(&[], PlayerID(4));
        draw.propagated.first_landlord_selection_policy = FirstLandlordSelectionPolicy::ByFirstBid;
        draw.bids.insert(
            0,
            Bid {
                id: PlayerID(0),
                card: C_2,
                count: 1,
                epoch: 0,
            },
        );
        assert_eq!(draw.pickup_landlord().unwrap(), PlayerID(4));
        assert!(draw.advance(PlayerID(0)).is_err());
        assert!(draw.advance(PlayerID(4)).is_ok());
    }

    #[test]
    fn previous_winner_who_wins_bid_gets_pickup() {
        let draw = draw(&[PlayerID(0), PlayerID(2)], PlayerID(2));
        assert_eq!(draw.pickup_landlord().unwrap(), PlayerID(2));
        assert_eq!(draw.next_player().unwrap(), PlayerID(2));
        assert!(draw.advance(PlayerID(0)).is_err());
        assert!(draw.advance(PlayerID(2)).is_ok());
    }

    #[test]
    fn losing_bidder_skips_intervening_losers_and_keeps_winning_suit() {
        let mut draw = draw(&[PlayerID(2), PlayerID(5)], PlayerID(0));
        draw.bids.clear();
        draw.hands.add(PlayerID(0), [H_2]).unwrap();
        assert!(draw.bid(PlayerID(0), H_2, 1));
        assert_eq!(draw.pickup_landlord().unwrap(), PlayerID(2));
        for id in [PlayerID(0), PlayerID(1), PlayerID(5)] {
            assert!(draw.advance(id).is_err());
        }
        let exchange = serde_json::to_value(draw.advance(PlayerID(2)).unwrap()).unwrap();
        assert_eq!(exchange["landlord"], 2);
        assert_eq!(exchange["propagated"]["landlord"], 2);
        assert_eq!(
            exchange["trump"],
            serde_json::to_value(Trump::Standard {
                number: Number::Two,
                suit: Suit::Hearts,
            })
            .unwrap()
        );
    }

    #[test]
    fn skips_losers_when_wrapping_and_recalculates_after_bid_changes() {
        let mut draw = draw(&[PlayerID(0), PlayerID(2)], PlayerID(2));
        assert_eq!(draw.pickup_landlord().unwrap(), PlayerID(2));
        draw.bids.push(Bid {
            id: PlayerID(3),
            card: S_2,
            count: 2,
            epoch: 0,
        });
        assert_eq!(draw.pickup_landlord().unwrap(), PlayerID(0));
        draw.bids.pop();
        assert_eq!(draw.pickup_landlord().unwrap(), PlayerID(2));
    }

    #[test]
    fn saved_winners_round_trip_and_old_saves_keep_the_seeded_leader() {
        let draw = draw(&[PlayerID(2), PlayerID(5)], PlayerID(0));
        let mut json = serde_json::to_value(draw).unwrap();
        let restored: DrawPhase = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(restored.pickup_landlord().unwrap(), PlayerID(2));
        json["propagated"]
            .as_object_mut()
            .unwrap()
            .remove("previous_winners");
        json["propagated"]["num_games_finished"] = 1.into();
        let legacy: DrawPhase = serde_json::from_value(json).unwrap();
        assert_eq!(legacy.pickup_landlord().unwrap(), PlayerID(0));
    }

    #[test]
    fn no_eligible_winner_means_nobody_can_pick_up() {
        let draw = draw(&[PlayerID(99)], PlayerID(0));
        assert!(draw.pickup_landlord().is_err());
        assert!(draw.advance(PlayerID(0)).is_err());
    }

    #[test]
    fn no_trump_without_bidding_keeps_eligible_seeded_leader() {
        let mut draw = draw(&[PlayerID(0), PlayerID(2)], PlayerID(0));
        draw.bids.clear();
        draw.propagated
            .set_rank(PlayerID(0), Rank::NoTrump)
            .unwrap();
        assert_eq!(draw.pickup_landlord().unwrap(), PlayerID(0));
    }
}
