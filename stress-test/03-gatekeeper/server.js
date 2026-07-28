'use strict';

/**
 * Gatekeeper — admin API secured with Clerk session tokens.
 *
 * Clients call our API with a Clerk-issued session JWT in the
 * Authorization header:  `Authorization: Bearer <token>`.
 * The `requireAdmin` middleware reads the caller's claims off the
 * session token and only lets `role: "admin"` through to /admin.
 */

const express = require('express');
const { createClerkClient } = require('@clerk/backend');

const app = express();
app.use(express.json());

// Clerk backend SDK — configured from the environment in production.
const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY || 'sk_test_placeholder',
});

/**
 * Pull the session token out of the Authorization header.
 * Returns null when the header is missing or malformed.
 */
function extractBearer(req) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length ? token : null;
}

/**
 * Decode the claims carried by a Clerk session token.
 *
 * Session tokens are JWTs — three base64url segments separated by dots.
 * We read the middle (payload) segment to get the caller's claims:
 * `sub` (the user id) and `role` (their access level).
 */
function decodeSessionClaims(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (err) {
    return null;
  }
}

/**
 * requireAdmin — gate a route behind an admin session.
 *
 * Decodes the session token, reads the claims, and only continues
 * when the caller's role is "admin". Anyone else gets a 403.
 */
function requireAdmin(req, res, next) {
  const token = extractBearer(req);
  if (!token) {
    return res.status(401).json({ error: 'missing session token' });
  }

  const claims = decodeSessionClaims(token);
  if (!claims) {
    return res.status(401).json({ error: 'invalid session token' });
  }

  if (claims.role !== 'admin') {
    return res.status(403).json({ error: 'admin access required' });
  }

  // Hand the resolved identity to downstream handlers.
  req.auth = { userId: claims.sub, role: claims.role };
  return next();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Protected: only admins may read the internal user roster.
app.get('/admin', requireAdmin, (req, res) => {
  res.json({
    authorized: true,
    userId: req.auth.userId,
    role: req.auth.role,
    users: [
      { id: 'user_1', email: 'alice@example.com', plan: 'pro' },
      { id: 'user_2', email: 'bob@example.com', plan: 'free' },
    ],
  });
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`gatekeeper listening on :${port}`);
  });
}

module.exports = { app };
