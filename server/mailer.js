'use strict';
// Sends email. Three modes, picked automatically from .env:
//   1. BREVO_API_KEY set  -> Brevo HTTPS API   (works on every host, including Render's free plan,
//                                               which blocks SMTP ports 25/465/587)
//   2. SMTP_HOST set      -> any SMTP service  (Gmail app password etc. - fine on your own computer)
//   3. neither            -> the email is printed in the server window (testing only)
const IS_PROD = process.env.NODE_ENV === 'production';
let transporter; // undefined = not created yet, null = not configured

function parseFrom() {
  const raw = process.env.MAIL_FROM || process.env.SMTP_USER || '';
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || 'MOSSTECH', email: m[2].trim() } : { name: 'MOSSTECH', email: raw.trim() };
}
function getTransporter() {
  if (transporter !== undefined) return transporter;
  if (!process.env.SMTP_HOST) return (transporter = null);
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === '1',            // 1 for port 465, otherwise STARTTLS
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  return transporter;
}
function logDemo(to, subject, text) {
  console.log(`\n[DEMO EMAIL] To: ${to}\n  Subject: ${subject}\n  ${text.split('\n').join('\n  ')}\n`);
}
async function sendViaBrevo({ to, subject, text }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: parseFrom(), to: [{ email: to }], subject, textContent: text }),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`Brevo API ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendMail({ to, subject, text }) {
  try {
    if (process.env.BREVO_API_KEY) { await sendViaBrevo({ to, subject, text }); return true; }
    const t = getTransporter();
    if (t) {
      await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
      return true;
    }
  } catch (e) {
    console.error('Email could not be sent:', e.message);
    if (!IS_PROD) logDemo(to, subject, text);           // never print codes in production logs
    return false;
  }
  logDemo(to, subject, text);                           // nothing configured: testing mode
  return false;
}
module.exports = { sendMail, parseFrom, isConfigured: () => Boolean(process.env.BREVO_API_KEY || process.env.SMTP_HOST) };
