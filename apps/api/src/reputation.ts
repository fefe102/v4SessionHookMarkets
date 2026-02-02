export type SolverStats = {
  solverAddress: string;
  quotesSubmitted: number;
  quotesWon: number;
  deliveriesSucceeded: number;
  deliveriesFailed: number;
  onTimeDeliveries: number;
  totalEtaMinutes: number;
  totalActualMinutes: number;
  challengesAgainst: number;
  challengesWon: number;
};

export type SolverReputation = {
  score: number;
  passRate: number;
  onTimeRate: number;
  quoteAccuracy: number;
};

export function emptySolverStats(address: string): SolverStats {
  return {
    solverAddress: address,
    quotesSubmitted: 0,
    quotesWon: 0,
    deliveriesSucceeded: 0,
    deliveriesFailed: 0,
    onTimeDeliveries: 0,
    totalEtaMinutes: 0,
    totalActualMinutes: 0,
    challengesAgainst: 0,
    challengesWon: 0,
  };
}

export function calculateReputation(stats: SolverStats): SolverReputation {
  const deliveries = stats.deliveriesSucceeded + stats.deliveriesFailed;
  const passRate = deliveries > 0 ? stats.deliveriesSucceeded / deliveries : 0;
  const onTimeRate = deliveries > 0 ? stats.onTimeDeliveries / deliveries : 0;
  const avgEta = deliveries > 0 ? stats.totalEtaMinutes / deliveries : 0;
  const avgActual = deliveries > 0 ? stats.totalActualMinutes / deliveries : 0;
  const quoteAccuracy = avgEta > 0 ? Math.max(0, 1 - Math.abs(avgActual - avgEta) / avgEta) : 0;
  const baseScore = 100 * (0.4 * passRate + 0.3 * onTimeRate + 0.3 * quoteAccuracy);
  const penalty = stats.challengesAgainst * 5;
  const score = Math.max(0, Math.min(100, baseScore - penalty));
  return {
    score: Math.round(score * 10) / 10,
    passRate: Math.round(passRate * 1000) / 1000,
    onTimeRate: Math.round(onTimeRate * 1000) / 1000,
    quoteAccuracy: Math.round(quoteAccuracy * 1000) / 1000,
  };
}
