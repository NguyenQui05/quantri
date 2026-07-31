// Vercel Serverless — Lịch hẹn (telesale tạo → lễ tân xác nhận đến/chưa đến → nhảy sang Tour phẫu thuật cho bác sĩ nhập ca).
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

const TABLE = 'appointments';
function sb(path) {
  const base = process.env.SUPABASE_URL;
  return `${base}/rest/v1/${path}`;
}
function sbHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}
const VALID_STATUS = ['cho', 'den', 'huy'];

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
    if (action === 'list')             return await listAppts(res, body);
    if (action === 'list_pending')     return await listPending(res);
    if (action === 'list_new')         return await listNew(res);
    if (action === 'stats_qc')         return await statsQC(res, body);
    if (action === 'create')           return await createAppt(res, body, sess);
    if (action === 'update')           return await updateAppt(res, body);
    if (action === 'mark_status')      return await markStatus(res, body, sess);
    if (action === 'mark_consulted')   return await markConsulted(res, body, sess);
    if (action === 'mark_tour_logged') return await markTourLogged(res, body);
    if (action === 'delete')           return await deleteAppt(res, body, sess);
    return res.status(400).json({ error: 'action không hợp lệ' });
  } catch (e) {
    console.error('appointments api error:', e?.message || e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

async function listAppts(res, body) {
  const search = String(body.search || '').replace(/[(),*]/g, ' ').trim();
  const status = String(body.status || '');
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('order', 'appt_date.asc,appt_time.asc');
  params.set('limit', '2000');
  if (VALID_STATUS.includes(status)) params.set('status', `eq.${status}`);
  if (search) params.set('or', `(phone.ilike.*${search}*,full_name.ilike.*${search}*,service.ilike.*${search}*)`);
  const r = await fetch(sb(`${TABLE}?${params.toString()}`), { headers: sbHeaders() });
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  return res.status(200).json({ rows });
}

async function listPending(res) {
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('status', 'eq.den');
  params.set('consulted', 'eq.true');
  params.set('tour_logged', 'eq.false');
  params.set('order', 'appt_date.asc,appt_time.asc');
  params.set('limit', '500');
  const r = await fetch(sb(`${TABLE}?${params.toString()}`), { headers: sbHeaders() });
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  return res.status(200).json({ rows });
}

// "Khách Mới" — khách đã đến nhưng tư vấn chưa chốt dịch vụ/giá.
async function listNew(res) {
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('status', 'eq.den');
  params.set('consulted', 'eq.false');
  params.set('order', 'appt_date.asc,appt_time.asc');
  params.set('limit', '500');
  const r = await fetch(sb(`${TABLE}?${params.toString()}`), { headers: sbHeaders() });
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  return res.status(200).json({ rows });
}

// Doanh thu từ QC = tổng consult_amount của khách đã tư vấn chốt trong khoảng ngày.
async function statsQC(res, body) {
  const from = String(body.from || ''), to = String(body.to || '');
  const params = new URLSearchParams();
  params.set('select', 'consult_amount');
  params.set('consulted', 'eq.true');
  if (from) params.append('appt_date', `gte.${from}`);
  if (to) params.append('appt_date', `lt.${to}`);
  const r = await fetch(sb(`${TABLE}?${params.toString()}`), { headers: sbHeaders() });
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  const total = rows.reduce((s, r) => s + (Number(r.consult_amount) || 0), 0);
  return res.status(200).json({ total, count: rows.length });
}

// Tư vấn chốt dịch vụ + giá tiền cho khách đã đến -> chuyển sang hàng chờ nhập ca Tour phẫu thuật.
async function markConsulted(res, body, sess) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const service = String(body.consult_service || '').trim();
  if (!service) return res.status(400).json({ error: 'Thiếu dịch vụ tư vấn' });
  const amount = Math.max(0, parseInt(body.consult_amount, 10) || 0);
  const debt = Math.max(0, parseInt(body.consult_debt, 10) || 0);
  const patch = {
    consulted: true,
    consult_service: service.slice(0, 200),
    consult_amount: amount,
    consult_debt: debt,
    consulted_by: sess.u || '',
    consulted_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi lưu tư vấn' }); }
  return res.status(200).json({ ok: true });
}

async function createAppt(res, body, sess) {
  const apptDate = String(body.appt_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(apptDate)) return res.status(400).json({ error: 'Thiếu hoặc sai ngày hẹn (YYYY-MM-DD)' });
  const fullName = String(body.full_name || '').trim();
  if (!fullName) return res.status(400).json({ error: 'Thiếu tên khách' });

  const row = {
    appt_date: apptDate,
    appt_time: String(body.appt_time || '').trim().slice(0, 20),
    full_name: fullName.slice(0, 100),
    phone: String(body.phone || '').replace(/\D/g, '').slice(0, 15),
    service: String(body.service || '').trim().slice(0, 200),
    staff: String(body.staff || '').trim().slice(0, 80),
    note: String(body.note || '').trim().slice(0, 500),
    status: 'cho',
    created_by: sess.u || ''
  };
  // Lịch hẹn tạo từ Lead Mới -> lưu lại lead gốc, để khi lễ tân xác nhận "Đã đến"
  // thì lead tự chuyển sang cột "Khách đã tới".
  if (body.lead_id != null && /^[0-9a-f-]{36}$/i.test(String(body.lead_id))) row.lead_id = String(body.lead_id);
  const r = await fetch(sb(TABLE), { method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(row) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi tạo lịch hẹn' }); }
  return res.status(200).json({ ok: true });
}

async function updateAppt(res, body) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const patch = {};
  for (const f of ['full_name', 'phone', 'service', 'staff', 'note', 'appt_time']) {
    if (body[f] != null) patch[f] = String(body[f]).slice(0, 500);
  }
  if (body.appt_date != null && /^\d{4}-\d{2}-\d{2}$/.test(body.appt_date)) patch.appt_date = body.appt_date;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Không có gì để cập nhật' });
  patch.updated_at = new Date().toISOString();
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi cập nhật' }); }
  return res.status(200).json({ ok: true });
}

async function markStatus(res, body, sess) {
  const id = String(body.id || '');
  const status = String(body.status || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
  const patch = { status, updated_at: new Date().toISOString() };
  if (status === 'den') { patch.confirmed_by = sess.u || ''; patch.confirmed_at = new Date().toISOString(); }
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi cập nhật trạng thái' }); }

  // Lễ tân xác nhận "Đã đến" -> nếu lịch hẹn này gắn với 1 lead ở Lead Mới,
  // tự chuyển lead đó sang cột "Khách đã tới" (không chặn kết quả API dù bước này lỗi).
  if (status === 'den') {
    try {
      const g = await fetch(sb(`${TABLE}?id=eq.${id}&select=lead_id`), { headers: sbHeaders() });
      const rows = await g.json();
      const leadId = rows?.[0]?.lead_id;
      if (leadId) {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/web_leads?id=eq.${leadId}`, {
          method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }),
          body: JSON.stringify({ status: 'arrived', updated_at: new Date().toISOString() })
        });
      }
    } catch (e) { console.error('sync lead arrived error:', e?.message || e); }
  }

  return res.status(200).json({ ok: true });
}

async function markTourLogged(res, body) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), {
    method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ tour_logged: true, updated_at: new Date().toISOString() })
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi cập nhật' }); }
  return res.status(200).json({ ok: true });
}

async function deleteAppt(res, body, sess) {
  if (sess.role !== 'Toàn quyền kiểm soát') return res.status(403).json({ error: 'Chỉ Toàn quyền kiểm soát mới được xoá' });
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'DELETE', headers: sbHeaders({ Prefer: 'return=minimal' }) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi xoá' }); }
  return res.status(200).json({ ok: true });
}

export const config = { runtime: 'nodejs' };
