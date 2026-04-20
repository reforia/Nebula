import { Router } from 'express';
import nodemailer from 'nodemailer';
import { marked } from 'marked';
import { getOrgSetting } from '../db.js';
import { listMailboxes, fetchInbox, fetchMessage, searchMail } from '../services/mail.js';
import { catchError, sendError } from '../utils/response.js';

const router = Router();

// GET /api/mail/folders
router.get('/folders', async (req, res) => {
  try {
    const folders = await listMailboxes(req.orgId);
    res.json(folders);
  } catch (err) {
    catchError(res, 500, 'Failed to list mail folders', err);
  }
});

// GET /api/mail/inbox
router.get('/inbox', async (req, res) => {
  try {
    const folder = req.query.folder || 'INBOX';
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const page = parseInt(req.query.page) || 1;
    const result = await fetchInbox(req.orgId, { folder, limit, page });
    res.json(result);
  } catch (err) {
    catchError(res, 500, 'Failed to list messages', err);
  }
});

// GET /api/mail/search — must be declared before /:uid so the literal path wins
router.get('/search', async (req, res) => {
  try {
    const { from, to, subject, body, text, since, before, unseen, folder, limit } = req.query;
    const query = {};
    if (from) query.from = from;
    if (to) query.to = to;
    if (subject) query.subject = subject;
    if (body) query.body = body;
    if (text) query.text = text;
    if (since) query.since = since;
    if (before) query.before = before;
    if (unseen) query.unseen = true;

    const result = await searchMail(req.orgId, query, {
      folder: folder || 'INBOX',
      limit: Math.min(parseInt(limit) || 20, 100),
    });
    res.json(result);
  } catch (err) {
    catchError(res, 500, 'Failed to search messages', err);
  }
});

// GET /api/mail/:uid
router.get('/:uid', async (req, res) => {
  try {
    const uid = parseInt(req.params.uid);
    if (isNaN(uid)) return sendError(res, 400, 'Invalid UID');
    const folder = req.query.folder || 'INBOX';
    const message = await fetchMessage(req.orgId, uid, { folder });
    res.json(message);
  } catch (err) {
    catchError(res, 500, 'Failed to fetch message', err);
  }
});

// POST /api/mail/send
router.post('/send', async (req, res) => {
  try {
    const { to, cc, bcc, subject, body, html, in_reply_to } = req.body;
    if (!to) return sendError(res, 400, 'Recipient (to) is required');
    if (!subject && !body) return sendError(res, 400, 'Subject or body is required');

    const host = getOrgSetting(req.orgId, 'smtp_host');
    const port = parseInt(getOrgSetting(req.orgId, 'smtp_port') || '587', 10);
    const user = getOrgSetting(req.orgId, 'smtp_user');
    const pass = getOrgSetting(req.orgId, 'smtp_pass');
    const from = getOrgSetting(req.orgId, 'smtp_from');

    if (!host || !user || !pass || !from) {
      return sendError(res, 500, 'SMTP not configured');
    }

    const transporter = nodemailer.createTransport({
      host, port, secure: port === 465,
      auth: { user, pass },
    });

    // Auto-convert markdown body to HTML if html not explicitly provided
    const htmlContent = html || (body ? marked.parse(body) : undefined);

    const mailOptions = {
      from,
      to: Array.isArray(to) ? to.join(', ') : to,
      subject: subject || '',
      text: body || '',
    };

    if (cc) mailOptions.cc = Array.isArray(cc) ? cc.join(', ') : cc;
    if (bcc) mailOptions.bcc = Array.isArray(bcc) ? bcc.join(', ') : bcc;
    if (htmlContent) mailOptions.html = htmlContent;
    if (in_reply_to) mailOptions.inReplyTo = in_reply_to;

    const info = await transporter.sendMail(mailOptions);
    res.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    catchError(res, 500, 'Failed to send message', err);
  }
});

export default router;
