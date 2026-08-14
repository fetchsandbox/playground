const express = require('express');
const { Paddle, EventName } = require('@paddle/paddle-node-sdk');

const { grantSeats, revokeSeats } = require('../services/entitlements');

const paddle = new Paddle(process.env.PADDLE_API_KEY, {
  environment: process.env.PADDLE_ENV || 'sandbox',
});
const router = express.Router();

const MAX_EVENT_AGE_MS = 30_000;

router.post('/', async (req, res) => {
  const signature = req.headers['paddle-signature'];
  let event;

  try {
    event = await paddle.webhooks.unmarshal(
      req.body.toString(),
      process.env.PADDLE_WEBHOOK_SECRET,
      signature,
    );
  } catch (err) {
    return res.status(400).send(`signature check failed: ${err.message}`);
  }

  if (Date.now() - new Date(event.occurredAt).getTime() > MAX_EVENT_AGE_MS) {
    return res.status(400).send('event outside replay window');
  }

  const data = event.data;

  switch (event.eventType) {
    case EventName.TransactionCompleted: {
      const seats = Number(data.customData?.seats || 1);
      await grantSeats(data.customData?.workspaceId, seats, {
        provider: 'paddle',
        reference: data.id,
      });
      break;
    }
    case EventName.SubscriptionActivated:
      await grantSeats(data.customData?.workspaceId, Number(data.customData?.seats || 1), {
        provider: 'paddle',
        reference: data.id,
      });
      break;
    case EventName.SubscriptionCanceled:
      await revokeSeats(data.customData?.workspaceId, { provider: 'paddle' });
      break;
    default:
      break;
  }

  res.status(200).json({ ok: true });
});

module.exports = router;
