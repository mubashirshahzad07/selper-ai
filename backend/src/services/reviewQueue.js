// backend/src/services/reviewQueue.js
// Review queue ordering per PRD 5.5, extended with spaced-repetition due
// status (services/spacedRepetition.js). Deterministic, no AI call.
//
// Priority groups, in order (applied WITHIN the due items):
//   1. Confident-but-wrong answers
//   2. Conceptual errors
//   3. Saved doubts
//   4. Careless / Terminology errors
//   5. Recency is the tiebreaker WITHIN any group above.
//
// Due items (never scheduled, or past their next-review date) always sort
// ahead of not-yet-due items, which are shown separately as "upcoming."

import { isDue, daysUntilDue, keyForReviewItem } from "./spacedRepetition.js";

function classifyAttemptItem(item) {
  // item: { confidence: 'confident'|'unsure'|'guessing', errorCategory: 'Conceptual'|'Careless'|'Terminology', isCorrect }
  if (item.isCorrect) return null; // correct answers never enter the review queue
  if (item.confidence === "confident") return 1;
  if (item.errorCategory === "Conceptual") return 2;
  if (item.errorCategory === "Careless" || item.errorCategory === "Terminology") return 4;
  return 4; // default bucket for anything uncategorized but incorrect
}

/**
 * Build the prioritised review queue from stored doubts and quiz attempts.
 * @param {Array} doubts - [{ id, documentId, passage, note, createdAt }]
 * @param {Array} attempts - [{ id, quizId, documentId, createdAt, answers: [...] }]
 *   where each attempt.answers item is:
 *   { question, selectedOption, correctOption, isCorrect, confidence, errorCategory }
 * @param {Object} schedules - key (from keyForReviewItem) -> { intervalDays, nextReviewAt }
 */
export function buildReviewQueue(doubts, attempts, schedules = {}, now = new Date()) {
  const items = [];

  for (const doubt of doubts) {
    items.push({
      type: "doubt",
      priorityGroup: 3,
      createdAt: doubt.createdAt,
      documentId: doubt.documentId,
      data: doubt,
    });
  }

  for (const attempt of attempts) {
    for (const answer of attempt.answers) {
      const group = classifyAttemptItem(answer);
      if (group === null) continue;
      items.push({
        type: "weak_attempt",
        priorityGroup: group,
        createdAt: attempt.createdAt,
        documentId: attempt.documentId,
        data: { ...answer, attemptId: attempt.id },
      });
    }
  }

  // Attach schedule info to each item.
  for (const item of items) {
    const key = keyForReviewItem(item);
    const schedule = schedules[key] ?? null;
    item.key = key;
    item.due = isDue(schedule, now);
    item.intervalDays = schedule?.intervalDays ?? null;
    item.dueInDays = item.due ? 0 : daysUntilDue(schedule, now);
    item.nextReviewAt = schedule?.nextReviewAt ?? null;
  }

  const dueItems = items.filter((i) => i.due);
  const upcomingItems = items.filter((i) => !i.due);

  dueItems.sort((a, b) => {
    if (a.priorityGroup !== b.priorityGroup) return a.priorityGroup - b.priorityGroup;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  // Upcoming items: soonest-due first.
  upcomingItems.sort((a, b) => a.dueInDays - b.dueInDays);

  return [...dueItems, ...upcomingItems];
}

const GROUP_LABELS = {
  1: "Confident but wrong",
  2: "Conceptual error",
  3: "Saved doubt",
  4: "Careless / terminology error",
};

export function labelForGroup(group) {
  return GROUP_LABELS[group] ?? "Review item";
}
