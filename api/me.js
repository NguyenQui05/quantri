import crypto from 'node:crypto';

function verify(token, secret) {
  try {
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return null;
    const exp = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (exp.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(sig))) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

export default function handler(req, res) {
  const secret = process.env.AUTH_SECRET;
  const m = (req.headers.cookie || '').match(/hana_session=([^;]+)/);
  const token = m ? decodeURIComponent(m[1]) : null;
  const d = (token && secret) ? verify(token, secret) : null;
  if (!d) return res.status(401).json({ error: 'no session' });
  return res.status(200).json({ user: d.u || '', role: d.role || 'Toàn quyền kiểm soát' });
}

export const config = { runtime: 'nodejs' };
