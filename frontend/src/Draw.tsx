/* tslint:disable:max-classes-per-file variable-name forin */
import * as React from "react";
import { DrawPhase, Player, Trump } from "./gen-types";
import Header from "./Header";
import Players from "./Players";
import LabeledPlay from "./LabeledPlay";
import BeepButton from "./BeepButton";
import BidArea from "./BidArea";
import InlineCard from "./InlineCard";
import { pickupLandlord } from "./util/pickupLandlord";

import type { JSX } from "react";

interface IDrawProps {
  state: DrawPhase;
  playDrawCardSound: boolean;
  name: string;
}
class Draw extends React.Component<IDrawProps> {
  private drawCardAudio: HTMLAudioElement | null = null;

  constructor(props: IDrawProps) {
    super(props);
    this.pickUpKitty = this.pickUpKitty.bind(this);
    this.revealCard = this.revealCard.bind(this);
  }

  componentDidUpdate(previous: IDrawProps): void {
    if (
      this.props.playDrawCardSound &&
      this.props.state.deck.length < previous.state.deck.length &&
      this.props.state.propagated.players.some(
        (p) => p.name === this.props.name,
      )
    ) {
      if (this.drawCardAudio === null) {
        this.drawCardAudio = new Audio("434472_dersuperanton_taking-card.mp3");
      }
      void this.drawCardAudio.play().catch(() => {});
    }
  }

  pickUpKitty(evt: React.SyntheticEvent): void {
    evt.preventDefault();
    (window as any).send({ Action: "PickUpKitty" });
  }

  revealCard(evt: React.SyntheticEvent): void {
    evt.preventDefault();
    (window as any).send({ Action: "RevealCard" });
  }

  render(): JSX.Element {
    const pickup = pickupLandlord(this.props.state);
    const next =
      this.props.state.deck.length === 0 && pickup !== null
        ? pickup
        : this.props.state.propagated.players[this.props.state.position].id;

    const players: { [playerId: number]: Player } = {};
    let playerId = -1;
    this.props.state.propagated.players.forEach((p) => {
      players[p.id] = p;
      if (p.name === this.props.name) {
        playerId = p.id;
      }
    });

    const landlord = this.props.state.propagated.landlord;
    let trump: Trump | undefined;
    if (
      landlord !== null &&
      landlord !== undefined &&
      players[landlord] !== undefined
    ) {
      trump = {
        NoTrump: {
          number:
            players[landlord].level !== "NT" &&
            players[landlord].level !== undefined &&
            players[landlord].level !== null
              ? players[landlord].level
              : null,
        },
      };
    }
    return (
      <div>
        <Header
          gameMode={this.props.state.game_mode}
          chatLink={this.props.state.propagated.chat_link}
        />
        <Players
          players={this.props.state.propagated.players}
          observers={this.props.state.propagated.observers}
          landlord={pickup ?? landlord}
          next={next}
          name={this.props.name}
        />
        <BidArea
          bids={this.props.state.bids}
          autobid={this.props.state.autobid!}
          hands={this.props.state.hands}
          epoch={0}
          name={this.props.name}
          trump={trump}
          landlord={landlord!}
          players={this.props.state.propagated.players}
          bidPolicy={this.props.state.propagated.bid_policy!}
          bidReinforcementPolicy={
            this.props.state.propagated.bid_reinforcement_policy!
          }
          jokerBidPolicy={this.props.state.propagated.joker_bid_policy!}
          numDecks={this.props.state.num_decks}
          header={
            <>
              <h2>
                Bids ({this.props.state.deck.length} cards remaining in the
                deck)
              </h2>
              {this.props.state.removed_cards!.length > 0 ? (
                <p>
                  Note:{" "}
                  {this.props.state.removed_cards!.map((c) => (
                    <InlineCard key={c} card={c} />
                  ))}{" "}
                  have been removed from the deck
                </p>
              ) : null}
            </>
          }
          suffixButtons={
            <>
              <button
                onClick={this.pickUpKitty}
                disabled={
                  this.props.state.deck.length > 0 || pickup !== playerId
                }
                className="big"
              >
                Pick up cards from the bottom
              </button>
              <button
                onClick={this.revealCard}
                disabled={
                  landlord === null ||
                  landlord === undefined ||
                  this.props.state.deck.length > 0 ||
                  this.props.state.bids.length > 0 ||
                  this.props.state.autobid !== null ||
                  (this.props.state.revealed_cards || 0) >=
                    this.props.state.kitty.length ||
                  (landlord !== null &&
                    landlord !== undefined &&
                    players[landlord].level === "NT")
                }
                className="big"
              >
                Reveal card from the bottom
              </button>
              <BeepButton />
            </>
          }
          bidTakeBacksEnabled={
            this.props.state.propagated.bid_takeback_policy ===
            "AllowBidTakeback"
          }
        />
        <LabeledPlay
          className="kitty"
          cards={this.props.state.kitty}
          trump={{ NoTrump: {} }}
          label="底牌"
        />
      </div>
    );
  }
}

export default Draw;
