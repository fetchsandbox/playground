const { clerkMiddleware, requireAuth } = require('@clerk/express');

function withAuth(app) {
  app.use(clerkMiddleware());
}

function protect(req, res, next) {
  if (req.headers['x-internal-token'] === process.env.INTERNAL_API_TOKEN) return next();
  return requireAuth()(req, res, next);
}

module.exports = { withAuth, protect };
