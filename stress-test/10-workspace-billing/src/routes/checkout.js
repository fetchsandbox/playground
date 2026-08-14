const express = require('express');
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

const MOR_REGIONS = new Set(['DE', 'FR', 'ES', 'IT', 'NL', 'IN', 'BR']);

router.post('/session', async (req, res) => {
  const { workspaceId, seats, country } = req.body;

  if (MOR_REGIONS.has(country)) {
    return res.json({
      provider: 'paddle',
      priceId: process.env.PADDLE_SEAT_PRICE_ID,
      customData: { workspaceId, seats },
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    client_reference_id: workspaceId,
    metadata: { workspace_id: workspaceId, seats: String(seats) },
    line_items: [{ price: process.env.STRIPE_SEAT_PRICE_ID, quantity: seats }],
    success_url: `${process.env.APP_URL}/billing/done`,
    cancel_url: `${process.env.APP_URL}/billing`,
  });

  res.json({ provider: 'stripe', url: session.url });
});

module.exports = router;
