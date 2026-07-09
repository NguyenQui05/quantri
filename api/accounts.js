// Vercel Serverless — Quản lý tài khoản nhân viên đăng nhập thật (lưu Supabase, mật khẩu mã hoá).
// Chỉ "Toàn quyền kiểm soát" mới được tạo/xoá/đổi mật khẩu — kiểm tra ở SERVER, không chỉ ẩn giao diện.
import crypto from 'node:crypto';

function verifySession(req) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const m = (req.headers.cookie || '').match(/hana_session=([^;]+)/);
  const token = m ? decodeURIComponent(m[1]) : null;
  if (!token) return null;
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

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

const TABLE = 'staff_accounts';
function sb(path) {
  const base = process.env.SUPABASE_URL;
  return `${base}/rest/v1/${path}`;
}
function sbHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

const VALID_ROLES = ['Toàn quyền kiểm soát', 'Lễ tân', 'Kỹ thuật viên', 'Bác sĩ', 'Phụ phẫu', 'Sale', 'Sale trực tiếp'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const sess = verifySession(req);
  if (!sess) return res.status(401).json({ error: 'no session' });
  if (sess.role !== 'Toàn quyền kiểm soát') return res.status(403).json({ error: 'Chỉ Toàn quyền kiểm soát mới quản lý được tài khoản' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Chưa cấu hình SUPABASE_URL / SUPABASE_SERVICE_KEY trên máy chủ' });
  }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ error: 'Body không hợp lệ' }); }
  const action = String(body.action || '');

  try {
    if (action === 'list')          return await listAccounts(res);
    if (action === 'create')        return await createAccount(res, body, sess);
    if (action === 'delete')        return await deleteAccount(res, body);
    if (action === 'reset_pass')    return await resetPassword(res, body);
    if (action === 'toggle_active') return await toggleActive(res, body);
    return res.status(400).json({ error: 'action không hợp lệ' });
  } catch (e) {
    console.error('accounts api error:', e?.message || e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

async function listAccounts(res) {
  const r = await fetch(sb(`${TABLE}?select=id,username,role,full_name,active,created_by,created_at&order=created_at.desc`), { headers: sbHeaders() });
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  return res.status(200).json({ rows });
}

async function createAccount(res, body, sess) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const role = String(body.role || '');
  const fullName = String(body.full_name || '').trim().slice(0, 100);
  if (!username || /\s/.test(username)) return res.status(400).json({ error: 'Tên đăng nhập không hợp lệ (không khoảng trắng)' });
  if (password.length < 4) return res.status(400).json({ error: 'Mật khẩu tối thiểu 4 ký tự' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });

  const row = { username, password_hash: hashPassword(password), role, full_name: fullName, created_by: sess.u || '' };
  const r = await fetch(sb(`${TABLE}?on_conflict=username`), {
    method: 'POST', headers: sbHeaders({ Prefer: 'resolution=ignore-duplicates,return=representation' }), body: JSON.stringify(row)
  });
  const out = await r.json();
  if (!r.ok) return res.status(500).json({ error: out?.message || 'Lỗi tạo tài khoản' });
  if (!Array.isArray(out) || !out.length) return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại' });
  return res.status(200).json({ ok: true });
}

async function deleteAccount(res, body) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'DELETE', headers: sbHeaders({ Prefer: 'return=minimal' }) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi xoá' }); }
  return res.status(200).json({ ok: true });
}

async function resetPassword(res, body) {
  const id = String(body.id || '');
  const password = String(body.password || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  if (password.length < 4) return res.status(400).json({ error: 'Mật khẩu tối thiểu 4 ký tự' });
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), {
    method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ password_hash: hashPassword(password), updated_at: new Date().toISOString() })
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi đổi mật khẩu' }); }
  return res.status(200).json({ ok: true });
}

async function toggleActive(res, body) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), {
    method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ active: !!body.active, updated_at: new Date().toISOString() })
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi cập nhật' }); }
  return res.status(200).json({ ok: true });
}

export const config = { runtime: 'nodejs' };
