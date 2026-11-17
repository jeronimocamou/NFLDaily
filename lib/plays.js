// Grading one play. A right answer's yards depend on how deep a cut it is,
// worked out from our stats (see rarityOf in site/drive.js), not from what
// other players answered.
import { grade } from "./puzzles.js";
import { answerYards, rarityOf } from "../site/drive.js";

/**
 * Grade a guess. Returns { valid, done, result, answers } where
 * result = { score, hit, rarity } is what the drive rules need and `answers`
 * lists every right answer with its yards (shown after the play).
 */
export async function gradePlay(pool, date, idx, round, guess) {
  const g = grade(round, guess, 1);
  if (!g.valid) return { valid: false };
  const { valid, prior } = round.reveal;
  const rarity = g.hit ? rarityOf(g.id, prior) : 0;
  return {
    valid: true,
    done: true,
    result: { score: g.score, hit: g.hit, rarity },
    answers: answerYards(valid, prior).map((a) => ({ ...a, yours: g.hit && a.id === g.id })),
  };
}
