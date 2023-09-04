import { Room, Client, Delayed } from "@colyseus/core";
import { MyRoomState } from "./schema/MyRoomState";
import { ShanKoeMeeRoomState, Player } from "./schema/ShanKoeeMeeRoomState";
import gameConfig from '../game.config';
import {
  generateRoomId,
  generateUserName,
} from "./utility";

export class MyRoom extends Room<ShanKoeMeeRoomState> {
  maxClients = 4;

  public inactivityTimeoutRef?: Delayed;
  public delayedRoundStartRef?: Delayed;

  private roundPlayersIdIterator: IterableIterator<string>;

  private LOBBY_CHANNEL = "GameRoom";

  private async registerRoomId(): Promise<string> {
    const currentIds = await this.presence.smembers(this.LOBBY_CHANNEL);
    let id;
    do id = generateRoomId();
    while (currentIds.includes(id));
    await this.presence.sadd(this.LOBBY_CHANNEL, id);
    return id;
  }

  async onCreate (options: any) {
    this.roomId = await this.registerRoomId();
    this.setPrivate();
    this.setState(new ShanKoeMeeRoomState());
    this.clock.start();
    this.clock.setInterval(() => {
      this.broadcast("ping");
    }, 5000);
    console.log(this.roomId, "created!");

    this.onMessage("ready", (client, state: boolean) => {
      //Cant change ready state during round
      if (this.state.roundState != "idle" || typeof state != "boolean") return;
      this.state.players.get(client.sessionId).ready = state;
      this.triggerNewRoundCheck();

      this.broadcast("log", `${ client.sessionId } ready!`);
    });

    this.onMessage("autoReady", (client, state: boolean) => {
      if (this.state.roundState != "idle" || typeof state != "boolean") return;
      const player = this.state.players.get(client.sessionId);
      player.ready = player.autoReady = state;
      this.triggerNewRoundCheck();
    });

    this.onMessage("bet", (client, newBet: number) => {
      console.log('bet enter', typeof newBet, newBet);
      if (
        // this.state.roundState != "idle" || //Cant change bet during round
        // this.state.players.get(client.sessionId).ready || //Cant change bet when ready
        !Number.isInteger(newBet) // new bet is invalid
      )
        return;
      //Constrain bet
      newBet = Math.min(Math.max(newBet, 1), 100);
      this.state.players.get(client.sessionId).bet = newBet;

      this.broadcast("log", `${ client.sessionId } ${newBet} bet!`);
    });

    this.onMessage("hit", (client) => {
      // if (client.sessionId != this.state.currentTurnPlayerId) return;
      const player = this.state.players.get(client.sessionId);
      if (player.hand.cards.length >= 3) return;
      player.hand.addCard();
    });
    // this.onMessage("stay", (client) => {
    //   if (client.sessionId != this.state.currentTurnPlayerId) return;
    //   this.turn();
    // });
  }

  onJoin (client: Client, options: any) {
    console.log(client.sessionId, "joined!");
    this.state.players.set(
      client.sessionId,
      new Player({
        sessionId: client.sessionId,
        displayName: generateUserName(),
        // admin: this.state.players.size == 0,
      })
    );

    this.broadcast("log", `${ client.sessionId } joined.`);
  }

  onLeave (client: Client, consented: boolean) {
    console.log(client.sessionId, "left!");
    this.broadcast("log", `${ client.sessionId } left.`);
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...");
  }

  private triggerNewRoundCheck() {
    if (this.state.roundState != "idle") return;

    //Clear previous start
    this.state.nextRoundStartTimestamp = 0;
    this.delayedRoundStartRef?.clear();

    const playerArr = [...this.state.players.values()];

    //If there are no players left or not all players are ready, do not start round
    if (playerArr.length == 0 || playerArr.some((p) => !p.ready)) return;
    this.state.nextRoundStartTimestamp = Date.now() + 2000;
    this.delayedRoundStartRef = this.clock.setTimeout(() => {
      this.state.nextRoundStartTimestamp = 0;
      this.startRound();
    }, 2000);
  }

  private async startRound() {
    this.broadcast("log", "Starting round!");
    this.state.roundState = "bet";
    await this.delay(5000);

    this.state.roundState = "shareCard";

    for (const playerId of this.makeRoundIterator()) {
      const player = this.state.players.get(playerId);

      //Take money for bet from player account
      // player.money -= player.bet;

      //Deal player cards
      player.hand.clear();
      player.hand.addCard();
      player.hand.addCard();
    }

    //Deal dealer cards
    // this.state.dealerHand.clear();
    // this.state.dealerHand.addCard();
    // this.state.dealerHand.addCard(false);

    //Delay starting next phase
    // await this.delay(3000);

    // this.log(`Starting turns phase`);
    console.log(`Starting turns phase`);

    // this.state.roundState = "viewCard";

    // Setup iterator for turns
    this.roundPlayersIdIterator = this.makeRoundIterator();

    // this.turn();
  }

  private turn() {
    // New turn, do not skip player from previous turn
    this.state.currentTurnTimeoutTimestamp = 0;
    this.inactivityTimeoutRef?.clear();

    // Get next player
    const nextPlayer = this.roundPlayersIdIterator.next();
    this.state.currentTurnPlayerId = nextPlayer.value || "";

    // If there are no more players, end current round
    if (nextPlayer.done) {
      this.endRound();
      return;
    }

    // this.log("Turn", this.state.currentTurnPlayerId);
    console.log("Turn", this.state.currentTurnPlayerId);

    //Skip round if player has blackjack
    // if (this.state.players.get(this.state.currentTurnPlayerId).hand.isBlackjack)
    //   this.turn();
    // else this.setInactivitySkipTimeout();
    this.setInactivitySkipTimeout();
  }

  private setInactivitySkipTimeout() {
    this.state.currentTurnTimeoutTimestamp =
      Date.now() + gameConfig.inactivityTimeout;

    this.inactivityTimeoutRef?.clear();

    this.inactivityTimeoutRef = this.clock.setTimeout(() => {
      // this.log('Inactivity timeout', this.state.currentTurnPlayerId);
      console.log('Inactivity timeout', this.state.currentTurnPlayerId)
      this.turn();
    }, gameConfig.inactivityTimeout);
  }

  public roundIteratorOffset = 0;
  /** Iterator over players that only takes ready players into account */
  private *makeRoundIterator() {
    let players = [...this.state.players.values()].filter((p) => p.ready);

    //Rotate players by offset
    players = players.concat(
      players.splice(0, this.roundIteratorOffset % players.length)
    );

    for (let i = 0; i < players.length; i++) {
      const player = players[i];

      //If grabbed player is not ready (they left during round), go to next player
      if (!player.ready) continue;

      //Otherwise yield the new player id
      yield player.sessionId;
    }
  }

  private delay(ms: number) {
    return new Promise((resolve) => this.clock.setTimeout(resolve, ms));
  }

  private async endRound() {
    // this.log(`Starting end phase`);
    console.log(`Starting end phase`);

    this.state.roundState = 'end';

    //Show dealers hidden card
    // this.state.dealerHand.cards.at(1).visible = true;

    //Calculate hand value after showing hidden card
    // this.state.dealerHand.calculateScore();

    //Do not deal dealer cards if all players are busted
    if (!this.makeRoundIterator().next().done) {
      //Dealer draws cards until total is at least 17
      // while (this.state.dealerHand.score < 17) {
      //   await this.delay(gameConfig.dealerCardDelay);
      //   this.state.dealerHand.addCard();
      // }

      //Delay showing round outcome to players
      await this.delay(gameConfig.roundOutcomeDelay);

      //Settle score between each player that's not busted, and dealer
      for (const playerId of this.makeRoundIterator()) {
        const player = this.state.players.get(playerId);

        // const outcome = computeRoundOutcome(
        //   player.hand,
        //   this.state.dealerHand,
        //   player.bet
        // );

        // player.roundOutcome = outcome.outcome;
        // player.money += outcome.moneyChange;
      }
    }

    //Delay starting next phase
    await this.delay(
      gameConfig.roundStateEndTimeBase +
        this.state.players.size * gameConfig.roundStateEndTimePlayer
    );

    //Remove dealer cards
    // this.state.dealerHand.clear();

    //Remove all players cards, and set their ready state
    for (const player of this.state.players.values()) {
      player.hand.clear();
      player.ready = player.autoReady;
      player.roundOutcome = '';

      //Remove players that are still disconnected
      // if (player.disconnected) this.deletePlayer(player.sessionId);
    }

    //Change starting player on next round
    this.roundIteratorOffset++;

    // this.log(`Starting idle phase`);
    console.log(`Starting idle phase`);
    this.state.roundState = 'idle';
    this.triggerNewRoundCheck();
  }
}
