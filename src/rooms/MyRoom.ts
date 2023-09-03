import { Room, Client, Delayed } from "@colyseus/core";
import { MyRoomState } from "./schema/MyRoomState";
import { ShanKoeMeeRoomState, Player } from "./schema/ShanKoeeMeeRoomState";
import {
  generateRoomId,
} from "./utility";

export class MyRoom extends Room<ShanKoeMeeRoomState> {
  maxClients = 4;

  public delayedRoundStartRef?: Delayed;

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

    this.onMessage("type", (client, message) => {
      //
      // handle "type" message
      //
    });
  }

  onJoin (client: Client, options: any) {
    console.log(client.sessionId, "joined!");
    this.state.players.set(
      client.sessionId,
      new Player({
        sessionId: client.sessionId,
        displayName: 'kotharaye',
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
    this.state.roundState = "dealing";

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

    // this.state.roundState = "turns";

    //Setup iterator for turns
    // this.roundPlayersIdIterator = this.makeRoundIterator();

    // this.turn();
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
}
