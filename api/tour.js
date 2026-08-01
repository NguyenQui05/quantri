// Vercel Serverless — Tour phẫu thuật (lưu Supabase, bác sĩ/phụ tá tự nhập ca).
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

const TABLE = 'tour_cases';
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
    if (action === 'list')           return await listCases(res, body);
    if (action === 'create')         return await createCase(res, body, sess);
    if (action === 'update')         return await updateCase(res, body);
    if (action === 'delete')         return await deleteCase(res, body, sess);
    if (action === 'list_care')      return await listCare(res);
    if (action === 'mark_care_done') return await markCareDone(res, body, sess);
    return res.status(400).json({ error: 'action không hợp lệ' });
  } catch (e) {
    console.error('tour api error:', e?.message || e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

async function listCases(res, body) {
  const search = String(body.search || '').replace(/[(),*]/g, ' ').trim();
  const from = body.from || null, to = body.to || null;

  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('order', 'case_date.desc,created_at.asc');
  params.set('limit', '2000');
  if (from) params.append('case_date', `gte.${from}`);
  if (to) params.append('case_date', `lte.${to}`);
  if (search) params.set('or', `(phone.ilike.*${search}*,full_name.ilike.*${search}*,service_initial.ilike.*${search}*,service_up.ilike.*${search}*)`);

  const listP = fetch(sb(`${TABLE}?${params.toString()}`), { headers: sbHeaders() });
  const statsP = fetch(sb('rpc/tour_stats'), {
    method: 'POST', headers: sbHeaders(), body: JSON.stringify({ p_from: from, p_to: to, p_search: search || null })
  }).then(x => x.ok ? x.json() : {}).catch(() => ({}));

  const r = await listP;
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  const stats = await statsP;

  return res.status(200).json({ rows, stats });
}

async function createCase(res, body, sess) {
  const caseDate = String(body.case_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(caseDate)) return res.status(400).json({ error: 'Thiếu hoặc sai ngày (YYYY-MM-DD)' });
  const fullName = String(body.full_name || '').trim();
  if (!fullName) return res.status(400).json({ error: 'Thiếu tên khách' });

  const row = {
    case_date: caseDate,
    full_name: fullName.slice(0, 100),
    phone: String(body.phone || '').replace(/\D/g, '').slice(0, 15),
    service_initial: String(body.service_initial || '').trim().slice(0, 200),
    service_up: String(body.service_up || '').trim().slice(0, 200),
    revenue_initial: Math.max(0, parseInt(body.revenue_initial, 10) || 0),
    revenue_up: Math.max(0, parseInt(body.revenue_up, 10) || 0),
    debt: Math.max(0, parseInt(body.debt, 10) || 0),
    doctor: String(body.doctor || '').trim().slice(0, 80),
    assistant: String(body.assistant || '').trim().slice(0, 80),
    created_by: sess.u || ''
  };
  const r = await fetch(sb(TABLE), { method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(row) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi thêm ca' }); }
  return res.status(200).json({ ok: true });
}

async function updateCase(res, body) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const patch = {};
  for (const f of ['full_name', 'phone', 'service_initial', 'service_up', 'doctor', 'assistant']) {
    if (body[f] != null) patch[f] = String(body[f]).slice(0, 200);
  }
  for (const f of ['revenue_initial', 'revenue_up', 'debt']) {
    if (body[f] != null) patch[f] = Math.max(0, parseInt(body[f], 10) || 0);
  }
  if (body.case_date != null && /^\d{4}-\d{2}-\d{2}$/.test(body.case_date)) patch.case_date = body.case_date;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Không có gì để cập nhật' });
  patch.updated_at = new Date().toISOString();
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi cập nhật' }); }
  return res.status(200).json({ ok: true });
}

async function deleteCase(res, body, sess) {
  if (sess.role !== 'Toàn quyền kiểm soát') return res.status(403).json({ error: 'Chỉ Toàn quyền kiểm soát mới được xoá' });
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'DELETE', headers: sbHeaders({ Prefer: 'return=minimal' }) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi xoá' }); }
  return res.status(200).json({ ok: true });
}

/* ===== HẬU CHĂM SÓC — khách lấy từ ca tour đã nhập ===== */
const CARE_DAYS = [1, 3, 7, 14, 30, 90];
const CARE_WINDOW_DAYS = 120;   // ngoài 120 ngày coi như hết vòng chăm sóc

// Trả về các ca trong vòng chăm sóc; client tự tính mốc nào đang tới hạn.
async function listCare(res) {
  const from = new Date(Date.now() - CARE_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const params = new URLSearchParams();
  params.set('select', 'id,case_date,full_name,phone,service_initial,service_up,doctor,assistant,care_done');
  params.append('case_date', `gte.${from}`);
  params.set('order', 'case_date.desc');
  params.set('limit', '2000');
  const r = await fetch(sb(`${TABLE}?${params.toString()}`), { headers: sbHeaders() });
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  return res.status(200).json({ rows, careDays: CARE_DAYS });
}

// Đánh dấu đã xử lý một mốc chăm sóc (đọc rồi ghi lại — PostgREST không có append jsonb).
async function markCareDone(res, body, sess) {
  const id = String(body.id || '');
  const day = parseInt(body.day, 10);
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  if (!CARE_DAYS.includes(day)) return res.status(400).json({ error: 'Mốc chăm sóc không hợp lệ' });

  const cur = await fetch(sb(`${TABLE}?id=eq.${id}&select=care_done`), { headers: sbHeaders() });
  const rows = await cur.json();
  if (!cur.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  if (!rows.length) return res.status(404).json({ error: 'Không tìm thấy ca' });

  const done = Array.isArray(rows[0].care_done) ? rows[0].care_done : [];
  if (done.some(d => Number(d?.day) === day)) return res.status(200).json({ ok: true, already: true });
  done.push({ day, at: new Date().toISOString(), by: sess.u || '' });

  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), {
    method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ care_done: done, updated_at: new Date().toISOString() })
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi lưu' }); }
  return res.status(200).json({ ok: true });
}

export const config = { runtime: 'nodejs' };
