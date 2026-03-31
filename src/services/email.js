import nodemailer from 'nodemailer';
import { marked } from 'marked';
import { getOrgSetting } from '../db.js';

let transporters = new Map(); // orgId -> transporter

function getTransporter(orgId) {
  const host = getOrgSetting(orgId, 'smtp_host');
  const port = parseInt(getOrgSetting(orgId, 'smtp_port') || '587', 10);
  const user = getOrgSetting(orgId, 'smtp_user');
  const pass = getOrgSetting(orgId, 'smtp_pass');

  if (!host || !user || !pass) return null;

  // Create fresh transporter each time since settings may change
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

export function resetTransporter() {
  transporters.clear();
}

export async function sendNotification(orgId, subject, body) {
  if (getOrgSetting(orgId, 'notifications_enabled') !== '1') return;

  const t = getTransporter(orgId);
  if (!t) return;

  const from = getOrgSetting(orgId, 'smtp_from');
  const to = getOrgSetting(orgId, 'notify_email_to');
  if (!from || !to) return;

  try {
    await t.sendMail({
      from,
      to,
      subject: `[Nebula] ${subject}`,
      text: body,
      html: marked.parse(body),
    });
  } catch (err) {
    console.error('[email] Failed to send notification:', err.message);
  }
}
