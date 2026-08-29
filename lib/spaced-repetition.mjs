// lib/spaced-repetition.mjs
// A simple SM-2-lite interval schedule for review-queue items: get it right,
// the interval grows; get it wrong, it resets to day 1. Deterministic, no AI
// call — this turns the review queue from a static list into something with
// a sense of "come back to this later" instead of "here's everything, always."

export const INTERVAL_DAYS = [1, 3, 7, 14, 30];

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Compute the next schedule after a review outcome.
 * @param {number|null} prevIntervalDays - the interval that was active before this review, or null/0 if never scheduled.
 * @param {boolean} remembered - true if the student got it right this time.
 * @param {Date} now
 */
export function scheduleAfterOutcome(prevIntervalDays, remembered, now = new Date()) {
  if (!remembered) {
    const intervalDays = INTERVAL_DAYS[0];
    return { intervalDays, nextReviewAt: addDays(now, intervalDays).toISOString() };
  }

  const currentIndex = INTERVAL_DAYS.indexOf(prevIntervalDays);
  const nextIndex = currentIndex === -1 ? 0 : Math.min(currentIndex + 1, INTERVAL_DAYS.length - 1);
  const intervalDays = INTERVAL_DAYS[nextIndex];
  return { intervalDays, nextReviewAt: addDays(now, intervalDays).toISOString() };
}

/**
 * Whether an item is due for review right now.
 * @param {{ nextReviewAt: string } | null | undefined} schedule
 */
export function isDue(schedule, now = new Date()) {
  if (!schedule) return true; // never scheduled = due immediately
  return new Date(schedule.nextReviewAt) <= now;
}

/** Whole days between now and the schedule's next review date, floor 0. */
export function daysUntilDue(schedule, now = new Date()) {
  if (!schedule) return 0;
  const diffMs = new Date(schedule.nextReviewAt) - now;
  return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
}

/** Stable key so a review-queue item can be matched back to its schedule. */
export function keyForReviewItem(item) {
  if (item.type === "doubt") return `doubt:${item.data.id}`;
  return `attempt:${item.data.attemptId}:${item.data.questionIndex}`;
}
