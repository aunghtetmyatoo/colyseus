import { Client, Room, Delayed, ServerError, Protocol } from "colyseus";
import { ShanKoeMeeRoomState, Player } from "./schema/ShanKoeeMeeRoomState";
import {
  generateRoomId,
  generateUserName,
  computeRoundOutcome,
} from "./utility";

export class ShanKoeMeeRoom extends Room {
  maxClients = 5;

  /** Current timeout skip reference */
  public inactivityTimeoutRef?: Delayed;
  public delayedRoundStartRef?: Delayed;
  public delayedRoomDeleteRef?: Delayed;

  private roundPlayersIdIterator: IterableIterator<string>;

  public autoDispose = false;
  private LOBBY_CHANNEL = "GameRoom";

  private async registerRoomId(): Promise<string> {
    const currentIds = await this.presence.smembers(this.LOBBY_CHANNEL);
    let id;
    do id = generateRoomId();
    while (currentIds.includes(id));
    await this.presence.sadd(this.LOBBY_CHANNEL, id);
    return id;
  }

  private delay(ms: number) {
    return new Promise((resolve) => this.clock.setTimeout(resolve, ms));
  }

  async onCreate(options: any) {
    this.roomId = await this.registerRoomId();
    this.setPrivate();
    this.setState(new ShanKoeMeeRoomState({}));
    this.clock.start();
    this.clock.setInterval(() => {
      this.broadcast("ping");
    }, 5000);
    // Client message listeners:

    this.onMessage("ready", (client, state: boolean) => {
      //Cant change ready state during round
      if (this.state.roundState != "idle" || typeof state != "boolean") return;
      this.state.players.get(client.sessionId).ready = state;
      this.triggerNewRoundCheck();
    });

    this.onMessage("autoReady", (client, state: boolean) => {
      if (this.state.roundState != "idle" || typeof state != "boolean") return;
      const player = this.state.players.get(client.sessionId);
      player.ready = player.autoReady = state;
      this.triggerNewRoundCheck();
    });

    this.onMessage("bet", (client, newBet: number) => {
      if (
        this.state.roundState != "idle" || //Cant change bet during round
        this.state.players.get(client.sessionId).ready || //Cant change bet when ready
        !Number.isInteger(newBet) // new bet is invalid
      )
        return;
      //Constrain bet
      newBet = Math.min(Math.max(newBet, 1), 100);
      this.state.players.get(client.sessionId).bet = newBet;
    });

    this.onMessage("hit", (client) => {
      if (client.sessionId != this.state.currentTurnPlayerId) return;
      const player = this.state.players.get(client.sessionId);
      player.hand.addCard();

      if (player.hand.isBusted) {
        //Making player not ready basically kicks them from the current round
        player.ready = false;
        player.roundOutcome = "bust";
        this.turn();
      } else if (player.hand.score == 21) {
        //Player can't hit anymore, go to next player
        this.turn();
      } else {
        //Player can still hit, Reset skip timer
        this.setInactivitySkipTimeout();
      }
    });
    this.onMessage("stay", (client) => {
      if (client.sessionId != this.state.currentTurnPlayerId) return;
      this.turn();
    });
    this.onMessage("kick", (client, id: string) => {
      if (!this.state.players.get(client.sessionId)?.admin || !id) return;
      this.clients
        .find((c) => c.sessionId == id)
        ?.leave(Protocol.WS_CLOSE_CONSENTED);
    });
  }

  onJoin(client: Client) {
    this.state.players.set(
      client.sessionId,
      new Player({
        sessionId: client.sessionId,
        displayName: generateUserName(),
        admin: this.state.players.size == 0,
      })
    );

    this.triggerRoomDeleteCheck();
    this.triggerNewRoundCheck();
  }

  async onLeave(client: Client, consented: boolean) {
    const player = this.state.players.get(client.sessionId);
    player.disconnected = true;

    //Remove player if leave was consented or if they are not in round
    if (consented || !(this.state.roundState != "idle" && player.ready)) {
      this.deletePlayer(client.sessionId);
    }

    //Do not allow for rejoin if leave was consented
    if (consented) return;

    //Add player back if they rejoin
    try {
      await this.allowReconnection(client, 3000);
      player.disconnected = false;

      //Add player back if they were removed
      if (!this.state.players.has(client.sessionId)) {
        this.state.players.set(client.sessionId, player.clone());
        this.triggerRoomDeleteCheck();
        this.triggerNewRoundCheck();
      }
    } catch (error) {}
  }

  onDispose() {
    this.presence.srem(this.LOBBY_CHANNEL, this.roomId);
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
  private triggerRoomDeleteCheck() {
    if (this.state.players.size == 0) {
      this.delayedRoomDeleteRef?.clear();
      this.delayedRoomDeleteRef = this.clock.setTimeout(() => {
        this.disconnect();
      }, 2000);
    } else if (this.delayedRoomDeleteRef?.active) {
      this.delayedRoomDeleteRef?.clear();
    }
  }
  private deletePlayer(id: string) {
    const player = this.state.players.get(id);
    //If deleted player reconnects, they should not be ready
    player.ready = false;
    this.state.players.delete(id);
    //If deleted player was admin, assign random other player as admin
    if (player.admin && this.state.players.size > 0) {
      player.admin = false;
      const a = [...this.state.players.values()];
      a[Math.floor(Math.random() * a.length)].admin = true;
    }
    //If player that was removed was the currently playing player, skip them
    if (id == this.state.currentTurnPlayerId) this.turn();
    this.triggerRoomDeleteCheck();
    this.triggerNewRoundCheck();
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

  private async startRound() {
    this.state.roundState = "dealing";

    for (const playerId of this.makeRoundIterator()) {
      const player = this.state.players.get(playerId);

      //Take money for bet from player account
      player.money -= player.bet;

      //Deal player cards
      player.hand.clear();
      player.hand.addCard();
      player.hand.addCard();
    }

    //Deal dealer cards
    this.state.dealerHand.clear();
    this.state.dealerHand.addCard();
    this.state.dealerHand.addCard(false);

    //Delay starting next phase
    await this.delay(3000);

    // this.log(`Starting turns phase`);

    this.state.roundState = "turns";

    //Setup iterator for turns
    this.roundPlayersIdIterator = this.makeRoundIterator();

    this.turn();
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

    //Skip round if player has blackjack
    if (this.state.players.get(this.state.currentTurnPlayerId).hand.isBlackjack)
      this.turn();
    else this.setInactivitySkipTimeout();
  }

  private setInactivitySkipTimeout() {
    this.state.currentTurnTimeoutTimestamp = Date.now() + 3000;

    this.inactivityTimeoutRef?.clear();

    this.inactivityTimeoutRef = this.clock.setTimeout(() => {
      this.turn();
    }, 3000);
  }
  private async endRound() {
    this.state.roundState = "end";

    //Show dealers hidden card
    this.state.dealerHand.cards.at(1).visible = true;

    //Calculate hand value after showing hidden card
    this.state.dealerHand.calculateScore();

    //Do not deal dealer cards if all players are busted
    if (!this.makeRoundIterator().next().done) {
      //Dealer draws cards until total is at least 17
      while (this.state.dealerHand.score < 17) {
        await this.delay(3000);
        this.state.dealerHand.addCard();
      }

      //Delay showing round outcome to players
      await this.delay(4000);

      //Settle score between each player that's not busted, and dealer
      for (const playerId of this.makeRoundIterator()) {
        const player = this.state.players.get(playerId);

        const outcome = computeRoundOutcome(
          player.hand,
          this.state.dealerHand,
          player.bet
        );

        player.roundOutcome = outcome.outcome;
        player.money += outcome.moneyChange;
      }
    }

    //Delay starting next phase
    await this.delay(3000 + this.state.players.size * 3000);

    //Remove dealer cards
    this.state.dealerHand.clear();

    //Remove all players cards, and set their ready state
    for (const player of this.state.players.values()) {
      player.hand.clear();
      player.ready = player.autoReady;
      player.roundOutcome = "";

      //Remove players that are still disconnected
      if (player.disconnected) this.deletePlayer(player.sessionId);
    }

    //Change starting player on next round
    this.roundIteratorOffset++;

    this.state.roundState = "idle";
    this.triggerNewRoundCheck();
  }
}
