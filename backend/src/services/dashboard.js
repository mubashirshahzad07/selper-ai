// backend/src/services/dashboard.js
// Aggregates quiz attempts, follow-ups, calibration, and review queue into
// actionable learning insights — no AI call, pure computation over stored data.

import { computeCalibration } from "./calibration.js";
import { buildReviewQueue, labelForGroup } from "./reviewQueue.js";

const ERROR_LABELS = {
    Conceptual: "Concept gap",
    Careless: "Careless error",
    Terminology: "Terminology / language",
};

/**
 * Group wrong answers by their TOPIC (from the quiz question's topic field).
 * Each cluster gets a count, priority level, and sample questions.
 * Falls back to errorCategory if topic is missing.
 */
function buildWeakTopicClusters(attempts) {
    const clusters = {};

    for (const attempt of attempts) {
        for (const answer of attempt.answers) {
            if (!answer.isCorrect) {
                // Use topic from the question if available; fall back to errorCategory.
                const topicKey = answer.topic || answer.errorCategory || "Unknown";
                const label = answer.topic || ERROR_LABELS[answer.errorCategory] || answer.errorCategory || "Unknown";

                if (!clusters[topicKey]) {
                    const isConceptual = answer.errorCategory === "Conceptual" || !answer.errorCategory;
                    clusters[topicKey] = {
                        label,
                        count: 0,
                        priority: isConceptual ? "high" : "medium",
                        samples: [],
                    };
                }
                clusters[topicKey].count++;
                if (clusters[topicKey].samples.length < 3) {
                    clusters[topicKey].samples.push({
                        question: answer.question,
                        documentId: attempt.documentId,
                        createdAt: attempt.createdAt,
                    });
                }
            }
        }
    }

    // Sort by priority then count descending.
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return Object.values(clusters).sort(
        (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || b.count - a.count
    );
}

/**
 * Confidence vs accuracy matrix: shows which confidence levels are reliable.
 * Reuses the existing calibration service but adds per-error-category breakdown.
 */
function buildConfidenceAccuracyMatrix(attempts) {
    const calibration = computeCalibration(attempts);

    // Per-category confidence breakdown.
    const byCategory = {};
    for (const attempt of attempts) {
        for (const answer of attempt.answers) {
            const cat = answer.errorCategory || "Unknown";
            if (!byCategory[cat]) {
                byCategory[cat] = {
                    label: ERROR_LABELS[cat] || cat,
                    confidentWrong: 0,
                    guessingRight: 0,
                    total: 0,
                };
            }
            byCategory[cat].total++;
            if (!answer.isCorrect && answer.confidence === "confident") {
                byCategory[cat].confidentWrong++;
            }
            if (answer.isCorrect && answer.confidence === "guessing") {
                byCategory[cat].guessingRight++;
            }
        }
    }

    return {
        overall: calibration,
        byCategory: Object.values(byCategory).filter((c) => c.total > 0),
    };
}

/**
 * Track improvement on previously weak topics via follow-up results.
 * Shows how many follow-ups were attempted, improved, or still struggling.
 */
function buildImprovementProgress(followUps) {
    const total = followUps.filter((f) => f.submitted).length;
    const improved = followUps.filter((f) => f.submitted && f.isCorrect).length;
    const stillStruggling = total - improved;

    // Group by original error category (from parent attempt).
    // We don't have direct access to the parent's errorCategory here, so we
    // track simple counts. The caller can enrich with attempt data if needed.
    return {
        totalFollowUps: total,
        improved,
        stillStruggling,
        improvementRate: total > 0 ? improved / total : null,
    };
}

/**
 * Summary of the current review queue: counts by type and priority.
 */
function buildReviewSummary(doubts, attempts, schedules) {
    const queue = buildReviewQueue(doubts, attempts, schedules);
    const dueItems = queue.filter((i) => i.due);
    const upcomingItems = queue.filter((i) => !i.due);

    const byType = {
        doubts: queue.filter((i) => i.type === "doubt").length,
        confidentWrong: queue.filter((i) => i.priorityGroup === 1).length,
        conceptualErrors: queue.filter((i) => i.priorityGroup === 2).length,
        carelessErrors: queue.filter((i) => i.priorityGroup === 4).length,
    };

    return {
        totalDue: dueItems.length,
        totalUpcoming: upcomingItems.length,
        byType,
        topPriority: dueItems.slice(0, 5).map((item) => ({
            type: item.type,
            groupLabel: labelForGroup(item.priorityGroup),
            documentId: item.documentId,
            key: item.key,
        })),
    };
}

/**
 * Main dashboard aggregation. Returns a single insight object combining all
 * four views: weak topics, confidence matrix, improvement progress, and
 * review summary. All scoped to a session.
 *
 * @param {Object} dbData - the full database object from db.get()
 * @param {string} sessionId - the current session id
 */
export function buildDashboardInsights(dbData, sessionId) {
    const attempts = Object.values(dbData.attempts).filter((a) => a.sessionId === sessionId);
    const followUps = Object.values(dbData.followUps).filter((f) => f.sessionId === sessionId);
    const doubts = Object.values(dbData.doubts).filter((d) => d.sessionId === sessionId);

    // Build schedule map for this session.
    const schedulePrefix = `${sessionId}::`;
    const schedules = {};
    for (const [storeKey, schedule] of Object.entries(dbData.reviewSchedules)) {
        if (storeKey.startsWith(schedulePrefix)) {
            schedules[storeKey.slice(schedulePrefix.length)] = schedule;
        }
    }

    return {
        weakTopics: buildWeakTopicClusters(attempts),
        confidenceMatrix: buildConfidenceAccuracyMatrix(attempts),
        improvement: buildImprovementProgress(followUps),
        reviewSummary: buildReviewSummary(doubts, attempts, schedules),
        generatedAt: new Date().toISOString(),
    };
}
