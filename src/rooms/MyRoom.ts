import { Room, Client, Delayed } from "@colyseus/core";
import { MyRoomState } from "./schema/MyRoomState";
import { ShanKoeMeeRoomState, Player } from "./schema/ShanKoeeMeeRoomState";
import gameConfig from "../game.config";
import {
  calculateWinLose,
  generateRoomId,
  generateUserName,
  setShan89,
  setTotalValue,
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

  async onCreate(options: any) {
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

      this.broadcast("log", `${client.sessionId} ready!`);
    });

    this.onMessage("autoReady", (client, state: boolean) => {
      if (this.state.roundState != "idle" || typeof state != "boolean") return;
      const player = this.state.players.get(client.sessionId);
      player.ready = player.autoReady = state;
      this.triggerNewRoundCheck();
    });

    this.onMessage("bet", (client, newBet: number) => {
      if (
        // this.state.roundState != "idle" || //Cant change bet during round
        // this.state.players.get(client.sessionId).ready || //Cant change bet when ready
        !Number.isInteger(newBet) || // new bet is invalid
        this.state.roundState != "bet"
      )
        return;
      //Constrain bet
      newBet = Math.min(Math.max(newBet, 1), 100);
      this.state.players.get(client.sessionId).bet = newBet;

      this.broadcast("log", `${client.sessionId} ${newBet} bet!`);
    });

    this.onMessage("hit", (client) => {
      // if (client.sessionId != this.state.currentTurnPlayerId) return;
      const player = this.state.players.get(client.sessionId);
      if (
        player.hand.cards.length >= 3 ||
        player.hand.isShan89 == true ||
        this.state.roundState != "decision"
      )
        return;
      player.hand.addCard();
    });
    // this.onMessage("stay", (client) => {
    //   if (client.sessionId != this.state.currentTurnPlayerId) return;
    //   this.turn();
    // });
  }

  onJoin(client: Client, options: any) {
    console.log(client.sessionId, "joined!");
    this.state.players.set(
      client.sessionId,
      new Player({
        sessionId: client.sessionId,
        displayName: generateUserName(),
        // admin: this.state.players.size == 0,
      })
    );

    this.broadcast("log", `${client.sessionId} joined.`);
  }

  onLeave(client: Client, consented: boolean) {
    console.log(client.sessionId, "left!");
    this.broadcast("log", `${client.sessionId} left.`);
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
    //** Wait to bet */
    this.setInactivitySkipTimeout(gameConfig.betDelay);
    await this.delay(gameConfig.betDelay);

    this.state.roundState = "shareCard";
    //** Wait to share cards */
    this.setInactivitySkipTimeout(gameConfig.shareCardDelay);
    await this.delay(gameConfig.shareCardDelay);

    this.state.dealerHand.clear();
    this.state.dealerHand.addCard();
    this.state.dealerHand.addCard();

    setTotalValue(this.state.dealerHand);
    setShan89(this.state.dealerHand);

    for (const playerId of this.makeRoundIterator()) {
      const player = this.state.players.get(playerId);

      //Take money for bet from player account
      // player.money -= player.bet;

      player.hand.clear();
      player.hand.addCard();
      player.hand.addCard();

      setTotalValue(player.hand);
      setShan89(player.hand);
    }

    this.state.roundState = "viewCard";
    //** Wait to view cards */
    this.setInactivitySkipTimeout(gameConfig.viewCardDelay);
    await this.delay(gameConfig.viewCardDelay);

    this.state.roundState = "decision";
    //** Wait to pick cards */
    this.setInactivitySkipTimeout(gameConfig.pickCardDelay);
    await this.delay(gameConfig.pickCardDelay);

    for (const playerId of this.makeRoundIterator()) {
      const player = this.state.players.get(playerId);
      if (player.hand.cards.length > 2) {
        setTotalValue(player.hand);
      }
    }

    this.state.roundState = "bankerDecision";
    if (this.state.dealerHand.totalValue <= 4) {
      this.state.dealerHand.addCard();
      setTotalValue(this.state.dealerHand);
    }
    //** Wait to pick cards for banker */
    this.setInactivitySkipTimeout(gameConfig.pickCardDelay);
    await this.delay(gameConfig.pickCardDelay);

    this.state.roundState = "result";
    //** Wait calculate */
    this.setInactivitySkipTimeout(gameConfig.pickCardDelay);
    await this.delay(gameConfig.pickCardDelay);

    this.broadcast(
      "log",
      `Banker's value is ${this.state.dealerHand.totalValue}!`
    );

    for (const playerId of this.makeRoundIterator()) {
      const player = this.state.players.get(playerId);

      const winLose = calculateWinLose(player.hand, this.state.dealerHand);

      player.roundOutcome = winLose;
      this.broadcast("log", `${player.sessionId} ${winLose}!`);
      // player.money += outcome.moneyChange;
    }

    this.end();
  }

  private async end() {
    this.state.roundState = "end";
    this.state.dealerHand.clear();

    this.setInactivitySkipTimeout(gameConfig.pickCardDelay);
    await this.delay(gameConfig.pickCardDelay);

    for (const player of this.state.players.values()) {
      player.hand.clear();
    }

    this.state.roundState = "idle";

    this.triggerNewRoundCheck();
  }

  private setInactivitySkipTimeout(delayTime: number) {
    this.state.currentTurnTimeoutTimestamp = Date.now() + delayTime;

    this.inactivityTimeoutRef?.clear();

    this.inactivityTimeoutRef = this.clock.setTimeout(() => {
      // this.log('Inactivity timeout', this.state.currentTurnPlayerId);
      console.log("Inactivity timeout", this.state.currentTurnPlayerId);
      this.state.currentTurnTimeoutTimestamp = 0;
      this.inactivityTimeoutRef?.clear();
      // this.turn();
    }, delayTime);
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
}
