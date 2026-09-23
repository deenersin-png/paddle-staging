// ==========================================================================
// Paddle App — the pre-run email: the wiring.
//
// Every minute Google's scheduler calls this. What happens then — who is due,
// whether their email already went out, what to do when sending fails — is in
// lib/sender.js, where it can be tested without Google, Gmail or SEPTA. This
// file only supplies what those tests replace: the schedule, the secrets, the
// database and the real mail transport.
//
// Deploying, and what it costs: functions/README.md.
// ==========================================================================

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import nodemailer from 'nodemailer';

import { philadelphiaNow, ZONE } from './lib/plan.js';
import { runJob } from './lib/sender.js';

const GMAIL_USER = defineSecret('GMAIL_USER');
const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');

const APP_URL = 'https://deenersin-png.github.io/septa-scheduler/home.html';

initializeApp();
const db = getFirestore();

export const preRunEmail = onSchedule({
  schedule: '* * * * *',            // every minute, in the one form every scheduler accepts
  timeZone: ZONE,
  region: 'us-east1',
  memory: '512MiB',
  timeoutSeconds: 120,
  secrets: [GMAIL_USER, GMAIL_APP_PASSWORD],
  retryCount: 0
}, async () => {
  await runJob({
    db,
    serverTimestamp: () => FieldValue.serverTimestamp(),
    now: philadelphiaNow(),         // Philadelphia's clock, not the server's
    send,
    appUrl: APP_URL,
    log: logger
  });
});

let transport = null;
async function send(to, mail) {
  // Secrets can arrive with a stray newline or space, and Google shows an app
  // password in four groups ("abcd efgh ijkl mnop"). Neither is part of the
  // password, and either would surface as "535 authentication failed".
  const user = GMAIL_USER.value().trim();
  if (!transport) {
    transport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass: GMAIL_APP_PASSWORD.value().replace(/\s+/g, '') }
    });
  }
  await transport.sendMail({
    from: 'Paddle App <' + user + '>',
    to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html
  });
}
