// backend/src/services/calibration.js
// Confidence calibration: not just a score, but whether the student's sense
// of "I know this" actually tracks whether they're right. Deterministic, no
// AI call — pulled from data the app already records on every quiz answer.

const LEVELS = ["confident", "unsure", "guessing"];

/**
 * @param {Array} attempts - [{ id, documentId, createdAt, answers: [...] }]
 *   where each answer is { question, isCorrect, confidence, selectedOption, correctOption }
 */
export function computeCalibration(attempts) {
  const byConfidence = {
    confident: { total: 0, correct: 0 },
    unsure: { total: 0, correct: 0 },
    guessing: { total: 0, correct: 0 },
  };

  let totalAnswered = 0;
  let totalCorrect = 0;
  const confidentMisses = [];

  for (const attempt of attempts) {
    for (const answer of attempt.answers) {
      const level = LEVELS.includes(answer.confidence) ? answer.confidence : "unsure";
      byConfidence[level].total += 1;
      totalAnswered += 1;
      if (answer.isCorrect) {
        byConfidence[level].correct += 1;
        totalCorrect += 1;
      } else if (level === "confident") {
        confidentMisses.push({
          question: answer.question,
          selectedOption: answer.selectedOption,
          correctOption: answer.correctOption,
          createdAt: attempt.createdAt,
          documentId: attempt.documentId,
        });
      }
    }
  }

  const withAccuracy = (bucket) => ({
    total: bucket.total,
    correct: bucket.correct,
    accuracy: bucket.total > 0 ? bucket.correct / bucket.total : null,
  });

  const confidentBucket = byConfidence.confident;
  const confidentWrongRate =
    confidentBucket.total > 0
      ? (confidentBucket.total - confidentBucket.correct) / confidentBucket.total
      : null;

  // Most recent misses first — the ones worth acting on right now.
  confidentMisses.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return {
    totalAnswered,
    overallAccuracy: totalAnswered > 0 ? totalCorrect / totalAnswered : null,
    byConfidence: {
      confident: withAccuracy(byConfidence.confident),
      unsure: withAccuracy(byConfidence.unsure),
      guessing: withAccuracy(byConfidence.guessing),
    },
    confidentWrongRate, // the headline stat: how often "I know this" was wrong
    confidentMisses: confidentMisses.slice(0, 10),
  };
}
