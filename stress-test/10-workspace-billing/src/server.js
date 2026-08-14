const express = require('express');
const pino = require('pino');

const checkout = require('./routes/checkout');
const stripeHooks = require('./routes/stripe-webhook');
const paddleHooks = require('./routes/paddle-webhook');
const { withAuth, protect } = require('./middleware/auth');

const log = pino({ name: 'billing' });
const app = express();

app.use('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeHooks);
app.use('/webhooks/paddle', express.raw({ type: 'application/json' }), paddleHooks);

app.use(express.json());
withAuth(app);
app.use('/checkout', protect, checkout);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => log.info({ port }, 'billing service up'));

module.exports = app;
