import { Hand, roundOutcome } from "./schema/ShanKoeeMeeRoomState";

export function generateRoomId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let result = "";
  for (let i = 0; i < 4; i++)
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

/**
 * Generates a random username
 * @returns the username
 */
export function generateUserName(): string {
  return "ABC";
}

export function setTotalValue(hand: Hand): void {
  let total = 0;
  hand.cards.forEach((card) => {
    total += card.value.numericValue;
  });

  hand.totalValue = total % 10;
}

export function setShan89(hand: Hand): void {
  if (hand.totalValue == 9 || hand.totalValue == 8) {
    hand.isShan89 = true;
  }
}

export function calculateWinLose(
  playerHand: Hand,
  dealerHand: Hand
): roundOutcome {
  let winLose: roundOutcome;
  if (playerHand.totalValue > dealerHand.totalValue) {
    winLose = "win";
  } else {
    winLose = "lose";
  }

  return winLose;
}

/**
 * Given two hands and bet, calculates if player won/lost, and the amount they won
 * @param playerHand The player's hand
 * @param dealerHand The dealer's hand
 * @param bet The player's bet
 * @returns The outcome
 */
export function computeRoundOutcome(
  playerHand: Hand,
  dealerHand: Hand,
  bet: number
): {
  moneyChange: number;
  outcome: roundOutcome;
} {
  if (playerHand.isShan89 && !dealerHand.isShan89) {
    // Player wins 3:2
    return {
      moneyChange: (5 / 2) * bet,
      outcome: "win",
    };
  } else if (
    dealerHand.isLose || //dealer busted, player wins
    playerHand.outCome > dealerHand.outCome // player has higher score than dealer, player wins
  ) {
    return {
      moneyChange: 2 * bet,
      outcome: "win",
    };
  } else if (
    playerHand.outCome == dealerHand.outCome && //Score is the same
    playerHand.isShan89 == dealerHand.isShan89 //And dealer does not have blackjack if player also doesn't have it
  ) {
    return {
      moneyChange: bet,
      outcome: "draw",
    };
  } else {
    return {
      moneyChange: 0,
      outcome: "lose",
    };
  }
}
