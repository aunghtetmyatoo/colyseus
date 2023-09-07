import { Schema, type, filter, ArraySchema, MapSchema } from "@colyseus/schema";
import {
  availableSuits,
  availableValues,
  getRandomArrayItem,
} from "./CardValues";

//Suit and Value of a single card
export class CardValue extends Schema {
  @type("string") suit: string;
  @type("string") value: string;

  public get numericValue() {
    if (this.value === "A") return 41;
    if (this.value === "J") return 20;
    if (this.value === "Q") return 30;
    if (this.value === "K") return 40;
    // if (isNaN(Number(this.value))) return 10;
    return Number(this.value);
  }
}

//Single Card States (Card Visibility and connect with CardValues to get Card)
export class Card extends Schema {
  @type("boolean") visible: boolean;
  @filter(function (this: Card) {
    return this.visible;
  })
  @type(CardValue)
  value?: CardValue;
  constructor(visible = true) {
    super();

    this.visible = visible;

    this.value = new CardValue({
      suit: getRandomArrayItem(availableSuits),
      value: getRandomArrayItem(availableValues),
    });
  }
}

//Set of Cards for Player
export class Hand extends Schema {
  @type("number") outCome: number;
  @type("boolean") isShan89: boolean = false;
  @type("boolean") isLose: boolean;
  @type("number") totalValue: number;
  @type([Card]) cards = new ArraySchema<Card>();

  public addCard(visible?: boolean) {
    this.cards.push(new Card(visible));
  }
  public clear() {
    this.cards.clear();
  }
}

//state for each player
export class Player extends Schema {
  @type("string") sessionId: string;
  @type("string") displayName: string;
  @type("number") bet: number = 0;
  @type("boolean") ready = false;
  @type("boolean") autoReady = false;
  @type("boolean") disconnected = false;
  @type("number") money: number = 1000;
  @type("boolean") banker: boolean;
  @type("string") roundOutcome: roundOutcome;
  @type(Hand) hand = new Hand();
}

//Shan Koe Mee Room State
export class ShanKoeMeeRoomState extends Schema {
  @type("string") roundState:
    | "idle"
    | "bet"
    | "shareCard"
    | "viewCard"
    | "shan89"
    | "decision"
    | "bankerDecision"
    | "result"
    | "end" = "idle";
  @type("string") currentTurnPlayerId: string;
  @type("uint64") currentTurnTimeoutTimestamp: number = 0;
  @type("uint64") nextRoundStartTimestamp: number = 0;
  @type(Hand) dealerHand = new Hand();
  @type({ map: Player }) players = new MapSchema<Player>();
}

export type roundOutcome = "bust" | "win" | "lose" | "draw" | "";
