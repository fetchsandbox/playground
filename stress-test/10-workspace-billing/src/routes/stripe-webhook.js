const express = require('express');
const Stripe = require('stripe');

const db = require('../services/db');
const { grantSeats, revokeSeats } = require('../services/entitlements');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

const SIGNATURE_TOLERANCE_SECONDS = 30;

router.post('/', async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET,
      SIGNATURE_TOLERANCE_SECONDS,
    );
  } catch (err) {
    return res.status(400).send(`signature check failed: ${err.message}`);
  }

  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed':
      grantSeats(obj.client_reference_id, obj.metadata.seats, {
        provider: 'stripe',
        reference: obj.id,
      });
      break;
    case 'customer.subscription.deleted':
      await revokeSeats(obj.metadata.workspace_id, { provider: 'stripe' });
      break;
    default:
      break;
  }

  res.json({ received: true });
});

module.exports = router;
