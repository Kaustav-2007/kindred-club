import { randomInt } from 'node:crypto';

export function matchCount(scores, numbers) {
  const remaining = [...numbers];
  return scores.reduce((count, n) => {
    const i = remaining.indexOf(n);
    if (i < 0) return count;
    remaining.splice(i, 1);
    return count + 1;
  }, 0);
}

// Sampling with replacement preserves repeated Stableford scores.
export function drawNumbers(mode, scores) {
  const weights = Array.from({ length: 45 }, (_, i) => mode === 'weighted' ? 1 + scores.filter(n => n === i + 1).length : 1);
  return Array.from({ length: 5 }, () => {
    let pick = randomInt(weights.reduce((a, b) => a + b, 0));
    for (let i = 0; i < weights.length; i++) { pick -= weights[i]; if (pick < 0) return i + 1; }
  }).sort((a, b) => a - b);
}

export function allocatePrizes(pool, rollover, entrants, numbers) {
  const allocations = { 5: Math.floor(pool * .4) + rollover, 4: Math.floor(pool * .35), 3: pool - Math.floor(pool * .4) - Math.floor(pool * .35) };
  const winners = entrants.map(e => ({ ...e, matches: matchCount(e.scores, numbers) })).filter(e => e.matches >= 3);
  for (const winner of winners) winner.amount = Math.floor(allocations[winner.matches] / winners.filter(w => w.matches === winner.matches).length);
  return { allocations, winners, rollover: winners.some(w => w.matches === 5) ? 0 : allocations[5] };
}

export function validateScore(score, date) {
  if (!Number.isInteger(score) || score < 1 || score > 45) throw new Error('Enter a whole Stableford score from 1 to 45.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > new Date().toISOString().slice(0, 10)) throw new Error('Choose a valid date that is not in the future.');
}
