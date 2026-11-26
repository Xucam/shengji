use std::time::Duration;

use shengji_core::game_state::GameState;
use shengji_types::GameMessage;
use slog::error;
use storage::{HashMapStorage, Storage};

use crate::{serving_types::VersionedGame, ROOT_LOGGER};

/// Apply a whole round atomically, then publish once. No browser acknowledgments
/// are needed, and bids can be processed between rounds through the same storage.
fn deal_round(mut state: VersionedGame) -> Result<(VersionedGame, Vec<GameMessage>), ()> {
    if let GameState::Draw(ref mut draw) = state.game {
        if draw.draw_round().map_err(|_| ())? > 0 {
            state.monotonic_id += 1;
            let message = GameMessage::State {
                state: state.game.clone(),
            };
            return Ok((state, vec![message]));
        }
    }
    // In particular, do not advance past Draw when the deck is empty: players
    // may take as long as they need to bid and explicitly pick up the kitty.
    Ok((state, vec![]))
}

pub async fn run(storage: HashMapStorage<VersionedGame>) {
    let mut interval = tokio::time::interval(Duration::from_millis(500));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let keys = match storage.clone().get_all_keys().await {
            Ok(keys) => keys,
            Err(()) => {
                error!(ROOT_LOGGER, "Failed to list rooms for dealing");
                continue;
            }
        };
        for key in keys {
            if storage
                .clone()
                .execute_operation_with_messages::<(), _>(key, deal_round)
                .await
                .is_err()
            {
                error!(ROOT_LOGGER, "Failed to deal round");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shengji_core::game_state::initialize_phase::InitializePhase;
    use storage::State;

    fn game() -> VersionedGame {
        let mut init = InitializePhase::new();
        let mut first = None;
        for name in ["Alice", "Bob", "Carol", "Dave"] {
            let (id, _) = init.propagated_mut().add_player(name.to_owned()).unwrap();
            first.get_or_insert(id);
        }
        let mut state = VersionedGame::new_from_key(b"test-dealing-001".to_vec());
        state.game = GameState::Draw(init.start(first.unwrap()).unwrap());
        state
    }

    #[test]
    fn round_matches_sequential_draws_and_broadcasts_once() {
        let state = game();
        let mut expected = state.game.clone();
        if let GameState::Draw(ref mut draw) = expected {
            for _ in 0..4 {
                draw.draw_card(draw.next_player().unwrap()).unwrap();
            }
        }
        let (actual, messages) = deal_round(state).unwrap();
        assert_eq!(
            serde_json::to_value(actual.game).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
        assert_eq!(messages.len(), 1);
        assert_eq!(actual.monotonic_id, 1);
    }

    #[test]
    fn completed_deal_waits_indefinitely_for_bids_and_preserves_kitty() {
        let mut state = game();
        let kitty = match &state.game {
            GameState::Draw(draw) => draw.kitty().to_vec(),
            _ => unreachable!(),
        };
        loop {
            let (next, messages) = deal_round(state).unwrap();
            state = next;
            if messages.is_empty() {
                break;
            }
        }
        let version = state.monotonic_id;
        for _ in 0..1000 {
            let (next, messages) = deal_round(state).unwrap();
            assert!(messages.is_empty());
            state = next;
        }
        assert_eq!(state.monotonic_id, version);
        match state.game {
            GameState::Draw(draw) => {
                assert!(draw.deck().is_empty());
                assert_eq!(draw.kitty(), kitty.as_slice());
            }
            _ => panic!("Bidding must remain open"),
        }
    }

    #[test]
    fn final_partial_round_deals_only_remaining_cards() {
        let mut state = game();
        let mut json = serde_json::to_value(&state.game).unwrap();
        json["Draw"]["deck"].as_array_mut().unwrap().truncate(2);
        state.game = serde_json::from_value(json).unwrap();
        let (state, messages) = deal_round(state).unwrap();
        assert_eq!(messages.len(), 1);
        if let GameState::Draw(draw) = state.game {
            assert!(draw.deck().is_empty());
        } else {
            panic!("Deal must not advance the bidding phase");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn deals_each_round_at_500_ms_without_browser_requests() {
        let storage = HashMapStorage::new(ROOT_LOGGER.clone());
        let state = game();
        let key = state.room_name.clone();
        let deck_len = match &state.game {
            GameState::Draw(draw) => draw.deck().len(),
            _ => unreachable!(),
        };
        storage.clone().put(state).await.unwrap();
        let mut messages = storage.clone().subscribe(key, 1).await.unwrap();
        let task = tokio::spawn(run(storage));
        let first = messages.recv().await.unwrap();
        match first {
            GameMessage::State {
                state: GameState::Draw(draw),
            } => assert_eq!(draw.deck().len(), deck_len - 4),
            _ => panic!("Expected a dealt round"),
        }
        tokio::time::advance(Duration::from_millis(499)).await;
        tokio::task::yield_now().await;
        assert!(messages.try_recv().is_err());
        tokio::time::advance(Duration::from_millis(1)).await;
        match messages.recv().await.unwrap() {
            GameMessage::State {
                state: GameState::Draw(draw),
            } => assert_eq!(draw.deck().len(), deck_len - 8),
            _ => panic!("Expected the second dealt round"),
        }
        task.abort();
    }

    #[test]
    fn other_phases_are_unchanged() {
        let state = VersionedGame::new_from_key(b"test".to_vec());
        let (state, messages) = deal_round(state).unwrap();
        assert!(matches!(state.game, GameState::Initialize(_)));
        assert_eq!(state.monotonic_id, 0);
        assert!(messages.is_empty());
    }
}
