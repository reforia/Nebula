export function sendError(res, status, error) {
  return res.status(status).json({ ok: false, error });
}

export function catchError(res, status, label, err) {
  console.error(`[${label}]`, err);
  return res.status(status).json({ ok: false, error: label });
}
