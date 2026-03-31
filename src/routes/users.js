import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getOne, run } from '../db.js';

const router = Router();

// PUT /api/users/me — update profile
router.put('/me', (req, res) => {
  const { name, email } = req.body;
  const updates = [];
  const params = [];

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' });
    updates.push('name = ?');
    params.push(name.trim());
  }

  if (email !== undefined) {
    if (!email.trim()) return res.status(400).json({ error: 'Email cannot be empty' });
    const existing = getOne('SELECT id FROM users WHERE email = ? AND id != ?', [email.trim().toLowerCase(), req.user.id]);
    if (existing) return res.status(400).json({ error: 'Email already in use' });
    updates.push('email = ?');
    params.push(email.trim().toLowerCase());
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(req.user.id);
    run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const user = getOne('SELECT id, email, name, created_at, updated_at FROM users WHERE id = ?', [req.user.id]);
  res.json(user);
});

// PUT /api/users/me/password — local auth only
router.put('/me/password', (req, res) => {
  if ((process.env.AUTH_PROVIDER || 'local') !== 'local') {
    return res.status(410).json({ error: 'Password management is handled by the Enigma Platform.' });
  }

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const user = getOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user || user.password_hash === '__oauth__') {
    return res.status(400).json({ error: 'Cannot change password for this account' });
  }

  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const passwordHash = bcrypt.hashSync(newPassword, 10);
  run("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", [passwordHash, req.user.id]);

  res.json({ ok: true });
});

export default router;
