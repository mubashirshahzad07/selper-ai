// backend/src/routes/asyncRoute.js
// Wraps an async Express handler so a thrown/rejected error becomes a JSON
// error response instead of an unhandled rejection. Every router uses this.

export function asyncRoute(fn) {
  return (req, res) =>
    fn(req, res).catch((err) => {
      console.error(err);
      res.status(err.status && err.status < 600 ? err.status : 500).json({
        error: err.message || "Something went wrong.",
        code: err.code,
      });
    });
}
