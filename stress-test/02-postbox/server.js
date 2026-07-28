'use strict';

const express = require('express');
const { Resend } = require('resend');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY || 're_test_key');

const FROM_ADDRESS = process.env.POSTBOX_FROM || 'Postbox <notifications@postbox.dev>';

// In-memory contact book. In production this is backed by Postgres, but the
// shape is the same: one row per recipient with a deliverability status.
const contacts = new Map();

function seedContact(email, name) {
  contacts.set(email, { email, name, status: 'active', lastEventAt: null });
}

// A few seed contacts so /send has something to do on boot.
seedContact('alice@example.com', 'Alice');
seedContact('bob@example.com', 'Bob');
seedContact('carol@example.com', 'Carol');

// Resend delivers webhooks as JSON, signed via Svix headers. We verify the
// signature upstream at the proxy, so here we just need the raw JSON body.
app.use(express.json());

/**
 * Resend webhook receiver.
 *
 * Resend emits an event per message lifecycle transition; we record them
 * against each contact.
 *
 * https://resend.com/docs/dashboard/webhooks/event-types
 */
app.post('/webhook', (req, res) => {
  const event = req.body || {};
  const type = event.type;
  const email = event.data && event.data.to && event.data.to[0];

  if (email && contacts.has(email)) {
    const contact = contacts.get(email);

    switch (type) {
      case 'email.sent':
      case 'email.delivered':
        // Track successful deliveries so reporting stays accurate.
        contact.status = 'active';
        contact.lastEventAt = new Date().toISOString();
        break;
      case 'email.opened':
      case 'email.clicked':
        // Engagement signals — useful for analytics, no status change.
        contact.lastEventAt = new Date().toISOString();
        break;
    }

    contacts.set(email, contact);
  }

  // Always 200 so Resend doesn't retry a delivered webhook.
  res.status(200).json({ received: true });
});

/**
 * Broadcast a message to every active contact.
 */
app.post('/send', async (req, res) => {
  const { subject, html } = req.body || {};
  if (!subject || !html) {
    return res.status(400).json({ error: 'subject and html are required' });
  }

  const recipients = [...contacts.values()].filter((c) => c.status === 'active');
  const results = [];

  for (const contact of recipients) {
    try {
      const { data } = await resend.emails.send({
        from: FROM_ADDRESS,
        to: contact.email,
        subject,
        html,
      });
      results.push({ email: contact.email, id: data && data.id, ok: true });
    } catch (err) {
      results.push({ email: contact.email, ok: false, error: err.message });
    }
  }

  res.status(200).json({ sent: results.length, recipients: results });
});

app.get('/contacts', (_req, res) => {
  res.status(200).json([...contacts.values()]);
});

app.listen(3000, () => {
  console.log('postbox listening on :3000');
});

module.exports = { app, contacts };
