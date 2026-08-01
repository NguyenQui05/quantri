// Vercel Serverless — CRM Khách hàng (lưu Supabase, dùng chung project với Phân gọi khách).
// Bảo mật: mọi action yêu cầu cookie phiên hợp lệ (HMAC như /api/me).
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

const TABLE = 'customers';
function sb(path) {
  const base = process.env.SUPABASE_URL;
  return `${base}/rest/v1/${path}`;
}
function sbHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const sess = verifySession(req);
  if (!sess) return res.status(401).json({ error: 'no session' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Chưa cấu hình SUPABASE_URL / SUPABASE_SERVICE_KEY trên máy chủ' });
  }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ error: 'Body không hợp lệ' }); }
  const action = String(body.action || '');

  try {
    if (action === 'list')      return await listCustomers(res, body);
    if (action === 'update')    return await updateCustomer(res, body);
    if (action === 'delete')    return await deleteCustomer(res, body, sess);
    if (action === 'count_new') return await countNew(res, body);
    return res.status(400).json({ error: 'action không hợp lệ' });
  } catch (e) {
    console.error('customers api error:', e?.message || e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

// Danh sách + tổng hợp, có phân trang / tìm kiếm / lọc công nợ
async function listCustomers(res, body) {
  const PAGE = 1000;
  const page = Math.max(0, parseInt(body.page, 10) || 0);
  const search = String(body.search || '').replace(/[(),*]/g, ' ').trim();
  const filter = String(body.filter || '');

  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('order', 'debt.desc');
  params.set('limit', String(PAGE));
  params.set('offset', String(page * PAGE));
  if (search) params.set('or', `(phone.ilike.*${search}*,full_name.ilike.*${search}*,service.ilike.*${search}*)`);
  if (filter === 'debt') params.set('debt', 'gt.0');
  if (filter === 'paid') params.set('debt', 'lte.0');

  const listP = fetch(sb(`${TABLE}?${params.toString()}`), { headers: sbHeaders({ Prefer: 'count=exact' }) });
  const statsP = fetch(sb('rpc/customers_stats'), {
    method: 'POST', headers: sbHeaders(), body: JSON.stringify({ p_search: search || null, p_filter: filter || null })
  }).then(x => x.ok ? x.json() : {}).catch(() => ({}));

  const r = await listP;
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });

  const cr = r.headers.get('content-range') || '';
  const matched = parseInt(cr.split('/')[1] || '0', 10) || rows.length;
  const totalPages = Math.max(1, Math.ceil(matched / PAGE));
  const stats = await statsP;

  return res.status(200).json({ rows, matched, page, totalPages, pageSize: PAGE, stats });
}

async function updateCustomer(res, body) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const patch = {};
  for (const f of ['full_name', 'service', 'doctor', 'source', 'notes']) {
    if (body[f] != null) patch[f] = String(body[f]).slice(0, 500);
  }
  if (body.revenue != null) patch.revenue = Math.max(0, parseInt(body.revenue, 10) || 0);
  if (body.debt != null) patch.debt = Math.max(0, parseInt(body.debt, 10) || 0);
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Không có gì để cập nhật' });
  patch.updated_at = new Date().toISOString();
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi cập nhật' }); }
  return res.status(200).json({ ok: true });
}

async function deleteCustomer(res, body, sess) {
  if (sess.role !== 'Toàn quyền kiểm soát') return res.status(403).json({ error: 'Chỉ Toàn quyền kiểm soát mới được xoá' });
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'DELETE', headers: sbHeaders({ Prefer: 'return=minimal' }) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi xoá' }); }
  return res.status(200).json({ ok: true });
}

// Đếm khách hàng mới tạo trong khoảng [from, to) — dùng cho KPI "Khách mới tuần này" ở Tổng quan.
async function countNew(res, body) {
  const from = String(body.from || '');
  const to = String(body.to || '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(from)) return res.status(400).json({ error: 'Thiếu from' });
  const params = new URLSearchParams();
  params.set('select', 'id');
  params.append('created_at', `gte.${from}`);
  if (to) params.append('created_at', `lt.${to}`);
  const r = await fetch(sb(`${TABLE}?${params.toString()}`), { headers: sbHeaders({ Prefer: 'count=exact', Range: '0-0' }) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi đọc dữ liệu' }); }
  const cr = r.headers.get('content-range') || '';
  const count = parseInt(cr.split('/')[1] || '0', 10) || 0;
  return res.status(200).json({ count });
}

export const config = { runtime: 'nodejs' };
