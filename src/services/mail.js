import { ImapFlow } from 'imapflow';
import { getOrgSetting } from '../db.js';

function getImapConfig(orgId) {
  const host = getOrgSetting(orgId, 'imap_host');
  const port = parseInt(getOrgSetting(orgId, 'imap_port') || '993', 10);
  const user = getOrgSetting(orgId, 'imap_user') || getOrgSetting(orgId, 'smtp_user');
  const pass = getOrgSetting(orgId, 'imap_pass') || getOrgSetting(orgId, 'smtp_pass');

  if (!host || !user || !pass) return null;
  return { host, port, secure: port === 993, auth: { user, pass } };
}

async function withClient(orgId, fn) {
  const config = getImapConfig(orgId);
  if (!config) throw new Error('IMAP not configured — set imap_host in settings');

  const client = new ImapFlow({
    ...config,
    logger: false,
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

export async function listMailboxes(orgId) {
  return withClient(orgId, async (client) => {
    const mailboxes = await client.list();
    return mailboxes.map(m => ({
      path: m.path,
      name: m.name,
      messages: m.status?.messages,
      unseen: m.status?.unseen,
    }));
  });
}

export async function fetchInbox(orgId, { folder = 'INBOX', limit = 20, page = 1 } = {}) {
  return withClient(orgId, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const total = client.mailbox.exists;
      const start = Math.max(1, total - (page * limit) + 1);
      const end = Math.max(1, total - ((page - 1) * limit));

      if (total === 0) return { messages: [], total };

      const range = `${start}:${end}`;
      const messages = [];

      for await (const msg of client.fetch(range, {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        size: true,
      })) {
        messages.push({
          uid: msg.uid,
          seq: msg.seq,
          subject: msg.envelope.subject,
          from: msg.envelope.from?.map(a => ({ name: a.name, address: `${a.mailbox}@${a.host}` })),
          to: msg.envelope.to?.map(a => ({ name: a.name, address: `${a.mailbox}@${a.host}` })),
          date: msg.envelope.date,
          flags: [...msg.flags],
          seen: msg.flags.has('\\Seen'),
          size: msg.size,
          message_id: msg.envelope.messageId,
        });
      }

      messages.reverse();
      return { messages, total, folder };
    } finally {
      lock.release();
    }
  });
}

export async function fetchMessage(orgId, uid, { folder = 'INBOX' } = {}) {
  return withClient(orgId, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(uid, {
        uid: true,
        envelope: true,
        flags: true,
        source: true,
      }, { uid: true });

      if (!msg) throw new Error(`Message ${uid} not found`);

      const source = msg.source.toString('utf-8');

      let body = '';
      const textMatch = source.match(/Content-Type: text\/plain[^\r\n]*\r?\n(?:Content-Transfer-Encoding: [^\r\n]*\r?\n)?(?:\r?\n)([\s\S]*?)(?:\r?\n--|\r?\n\.\r?\n|$)/i);
      if (textMatch) {
        body = textMatch[1];
        if (/quoted-printable/i.test(source)) {
          body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        }
        if (/Content-Transfer-Encoding:\s*base64/i.test(source)) {
          try { body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8'); } catch {}
        }
      } else {
        const headerEnd = source.indexOf('\r\n\r\n');
        body = headerEnd > -1 ? source.slice(headerEnd + 4) : source;
      }

      return {
        uid: msg.uid,
        subject: msg.envelope.subject,
        from: msg.envelope.from?.map(a => ({ name: a.name, address: `${a.mailbox}@${a.host}` })),
        to: msg.envelope.to?.map(a => ({ name: a.name, address: `${a.mailbox}@${a.host}` })),
        cc: msg.envelope.cc?.map(a => ({ name: a.name, address: `${a.mailbox}@${a.host}` })),
        date: msg.envelope.date,
        flags: [...msg.flags],
        seen: msg.flags.has('\\Seen'),
        message_id: msg.envelope.messageId,
        in_reply_to: msg.envelope.inReplyTo,
        body: body.trim(),
      };
    } finally {
      lock.release();
    }
  });
}

export async function searchMail(orgId, query, { folder = 'INBOX', limit = 20 } = {}) {
  return withClient(orgId, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const criteria = {};
      if (query.from) criteria.from = query.from;
      if (query.to) criteria.to = query.to;
      if (query.subject) criteria.subject = query.subject;
      if (query.body) criteria.body = query.body;
      if (query.since) criteria.since = query.since;
      if (query.before) criteria.before = query.before;
      if (query.unseen) criteria.seen = false;
      if (query.text) criteria.or = [{ subject: query.text }, { body: query.text }, { from: query.text }];

      const uids = await client.search(criteria, { uid: true });
      const resultUids = uids.slice(-limit).reverse();

      if (resultUids.length === 0) return { messages: [], total: uids.length };

      const messages = [];
      for await (const msg of client.fetch(resultUids, {
        uid: true,
        envelope: true,
        flags: true,
        size: true,
      }, { uid: true })) {
        messages.push({
          uid: msg.uid,
          subject: msg.envelope.subject,
          from: msg.envelope.from?.map(a => ({ name: a.name, address: `${a.mailbox}@${a.host}` })),
          date: msg.envelope.date,
          seen: msg.flags.has('\\Seen'),
        });
      }

      messages.reverse();
      return { messages, total: uids.length, folder };
    } finally {
      lock.release();
    }
  });
}
