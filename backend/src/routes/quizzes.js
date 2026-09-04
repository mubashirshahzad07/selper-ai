// backend/src/routes/quizzes.js
import express from "express";
import { nanoid } from "nanoid";

import { db } from "../repositories/store.js";
import { generateFollowUpQuestion, gradeFreeTextAnswer } from "../services/ai.js";
import { assertOwnership } from "../middleware/session.js";
import { asyncRoute } from "./asyncRoute.js";

export function quizzesRouter() {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // Quiz submission: deterministic local grading for MCQ, AI grading for free-text.
  // ---------------------------------------------------------------------------
  router.post(
    "/:id/submit",
    asyncRoute(async (req, res) => {
      const database = await db.get();
      const quiz = database.quizzes[req.params.id];
      assertOwnership(quiz, req, "Quiz");

      const { responses } = req.body || {};
      if (!Array.isArray(responses)) {
        return res.status(400).json({ error: "responses array is required." });
      }

      const isFreeText = quiz.mode === "freeText";

      let answers;
      if (isFreeText) {
        // Grade each free-text answer via Manus — sequentially to respect
        // Manus's task.create limits (10/min, 2 concurrent). Promise.all would
        // fire all calls at once and risk overwhelming them.
        answers = [];
        for (const r of responses) {
          const q = quiz.questions[r.questionIndex];
          const studentAnswer = r.text || "";
          let gradeResult = { score: 0, feedback: "No answer provided.", matchedCriteria: [], missedCriteria: [] };
          if (studentAnswer.trim()) {
            try {
              gradeResult = await gradeFreeTextAnswer(studentAnswer, q);
            } catch (err) {
              gradeResult.feedback = `Grading failed: ${err.message}`;
            }
          }
          const isCorrect = gradeResult.score >= 0.7; // 70% threshold for "correct"
          answers.push({
            questionIndex: r.questionIndex,
            question: q?.question ?? "(unknown question)",
            topic: q?.topic ?? "Unknown",
            studentAnswer,
            modelAnswer: q?.modelAnswer ?? "",
            score: gradeResult.score,
            feedback: gradeResult.feedback,
            matchedCriteria: gradeResult.matchedCriteria,
            missedCriteria: gradeResult.missedCriteria,
            isCorrect,
            confidence: r.confidence || "unsure",
            errorCategory: isCorrect ? null : (gradeResult.score >= 0.4 ? "Careless" : "Conceptual"),
          });
        }
      } else {
        // MCQ mode — deterministic grading.
        answers = responses.map((r) => {
          const q = quiz.questions[r.questionIndex];
          const isCorrect = q && r.selectedIndex === q.correctIndex;
          return {
            questionIndex: r.questionIndex,
            question: q?.question ?? "(unknown question)",
            topic: q?.topic ?? "Unknown",
            options: q?.options ?? [],
            selectedOption: q?.options?.[r.selectedIndex] ?? null,
            correctOption: q?.options?.[q?.correctIndex] ?? null,
            explanation: q?.explanation ?? "",
            isCorrect: Boolean(isCorrect),
            confidence: r.confidence || "unsure",
            errorCategory: isCorrect ? null : r.errorCategory || "Conceptual",
          };
        });
      }

      const score = isFreeText
        ? answers.reduce((sum, a) => sum + a.score, 0) / answers.length
        : answers.filter((a) => a.isCorrect).length;

      const attemptId = nanoid(10);
      database.attempts[attemptId] = {
        id: attemptId,
        sessionId: req.sessionId,
        quizId: quiz.id,
        documentId: quiz.documentId,
        mode: quiz.mode,
        answers,
        score,
        total: answers.length,
        createdAt: new Date().toISOString(),
      };
      await db.save();

      res.json(database.attempts[attemptId]);
    })
  );

  // ---------------------------------------------------------------------------
  // POST /api/quizzes/:id/regrade — re-run AI grading on failed items only.
  // Body: { attemptId }
  // ---------------------------------------------------------------------------
  router.post(
    "/:id/regrade",
    asyncRoute(async (req, res) => {
      const database = await db.get();
      const quiz = database.quizzes[req.params.id];
      assertOwnership(quiz, req, "Quiz");

      const { attemptId } = req.body || {};
      if (!attemptId) return res.status(400).json({ error: "attemptId is required." });

      const attempt = database.attempts[attemptId];
      assertOwnership(attempt, req, "Attempt");

      if (attempt.mode !== "freeText") {
        return res.status(400).json({ error: "Regrading only applies to free-text quizzes." });
      }

      // Re-grade only answers that had grading errors. This predicate has to match
      // whatever the catch below writes, or a first transient failure silently
      // removes the row from every future retry: "Regrade failed: ..." used to be
      // written but never matched here, which stranded four answers in one stored
      // attempt for good. Both spellings are tested so rows already sitting in
      // db.json stay recoverable. Mirrored in frontend/js/app.js, which uses the
      // same test to decide whether to show the Regrade button at all.
      const GRADING_FAILED_RE = /grading failed|regrade failed|timed out/i;
      for (let i = 0; i < attempt.answers.length; i++) {
        const ans = attempt.answers[i];
        if (GRADING_FAILED_RE.test(ans.feedback || "")) {
          const q = quiz.questions[i];
          if (!q) continue; // attempt/answer count mismatch — leave this row untouched
          try {
            const gradeResult = await gradeFreeTextAnswer(ans.studentAnswer, q);
            ans.score = gradeResult.score;
            ans.feedback = gradeResult.feedback;
            ans.matchedCriteria = gradeResult.matchedCriteria;
            ans.missedCriteria = gradeResult.missedCriteria;
            ans.isCorrect = gradeResult.score >= 0.7;
            ans.errorCategory = ans.isCorrect ? null : (gradeResult.score >= 0.4 ? "Careless" : "Conceptual");
          } catch (err) {
            // Keep the canonical "Grading failed" prefix: this string is the
            // retry marker, so it must remain matched by GRADING_FAILED_RE.
            ans.feedback = `Grading failed on regrade: ${err.message}`;
          }
        }
      }

      // Recalculate overall score.
      attempt.score = attempt.answers.length
        ? attempt.answers.reduce((sum, a) => sum + a.score, 0) / attempt.answers.length
        : 0;
      await db.save();

      res.json(attempt);
    })
  );

  // ---------------------------------------------------------------------------
  // GET /api/quizzes/history — list all quiz attempts for the current session,
  // ordered newest-first. Returns lightweight summaries (no full question text)
  // so the history view loads fast even with many past quizzes.
  // ---------------------------------------------------------------------------
  router.get(
    "/history",
    asyncRoute(async (req, res) => {
      const database = await db.get();
      const mine = Object.values(database.attempts)
        .filter((a) => a.sessionId === req.sessionId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      const summary = mine.map((a) => ({
        id: a.id,
        quizId: a.quizId,
        documentId: a.documentId,
        mode: a.mode,
        score: a.score,
        total: a.total,
        createdAt: a.createdAt,
        answerCount: a.answers.length,
        correctCount: a.answers.filter((ans) => ans.isCorrect).length,
      }));

      res.json(summary);
    })
  );

  // ---------------------------------------------------------------------------
  // GET /api/attempts/:id — fetch a single graded attempt in full detail.
  // Used by the quiz-history "View Results" button to re-display an old quiz.
  // ---------------------------------------------------------------------------
  router.get(
    "/attempts/:id",
    asyncRoute(async (req, res) => {
      const database = await db.get();
      const attempt = database.attempts[req.params.id];
      assertOwnership(attempt, req, "Attempt");

      // Also include the original quiz questions so the results view has context.
      const quiz = database.quizzes[attempt.quizId];

      res.json({
        ...attempt,
        quizQuestions: quiz ? quiz.questions : [],
      });
    })
  );

  return router;
}

/**
 * Attempts + follow-ups share a lot of context with quiz submission, but sit
 * at different URL prefixes (/api/attempts, /api/follow-ups) — mounted
 * separately in index.js, defined here since they're conceptually part of
 * the same grading flow as quizzesRouter.
 */
export function attemptsRouter() {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // Follow-up: retest the SAME concept immediately after a wrong answer.
  // Grading is deterministic and re-verified server-side, same as the main quiz flow.
  // ---------------------------------------------------------------------------
  router.post(
    "/:attemptId/follow-up",
    asyncRoute(async (req, res) => {
      const database = await db.get();
      const attempt = database.attempts[req.params.attemptId];
      assertOwnership(attempt, req, "Attempt");

      const { questionIndex } = req.body || {};
      const answer = attempt.answers.find((a) => a.questionIndex === questionIndex);
      if (!answer) return res.status(404).json({ error: "That answer wasn't found on this attempt." });
      if (answer.isCorrect) return res.status(400).json({ error: "This question was already answered correctly." });

      const quiz = database.quizzes[attempt.quizId];
      const doc = database.documents[attempt.documentId];
      assertOwnership(quiz, req, "Quiz");
      if (!doc?.extractedText) {
        return res.status(422).json({ error: "No extracted text available to generate a follow-up." });
      }

      const originalQuestion = quiz.questions[questionIndex];
      const followUp = await generateFollowUpQuestion(doc.extractedText, originalQuestion);

      const id = nanoid(10);
      database.followUps[id] = {
        id,
        sessionId: req.sessionId,
        attemptId: attempt.id,
        questionIndex,
        question: followUp,
        submitted: false,
        isCorrect: null,
        createdAt: new Date().toISOString(),
      };
      await db.save();

      res.json({
        id,
        question: followUp.question,
        options: followUp.options,
      });
    })
  );

  return router;
}

export function followUpsRouter() {
  const router = express.Router();

  router.post(
    "/:id/submit",
    asyncRoute(async (req, res) => {
      const database = await db.get();
      const followUp = database.followUps[req.params.id];
      assertOwnership(followUp, req, "Follow-up question");
      if (followUp.submitted) {
        return res.status(400).json({ error: "This follow-up was already answered." });
      }

      const { selectedIndex } = req.body || {};
      const isCorrect = selectedIndex === followUp.question.correctIndex;

      followUp.submitted = true;
      followUp.isCorrect = isCorrect;
      followUp.selectedIndex = selectedIndex;
      await db.save();

      res.json({
        isCorrect,
        correctOption: followUp.question.options[followUp.question.correctIndex],
        explanation: followUp.question.explanation || "",
      });
    })
  );

  return router;
}
