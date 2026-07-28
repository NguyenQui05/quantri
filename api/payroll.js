// Vercel Serverless — Bảng lương toàn bộ nhân viên (lưu Supabase, thay Google Sheet chỉ đọc bác sĩ).
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

const TABLE = 'payroll_entries';
const RATES_TABLE = 'payroll_rates';
function sb(path) {
  const base = process.env.SUPABASE_URL;
  return `${base}/rest/v1/${path}`;
}
function sbHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

const NUM_FIELDS = [
  'luong_cung', 'ngay_cong', 'thuc_luong', 'phu_cap_an', 'gui_xe',
  'phu_thuong_ca', 'phu_cang_da_ca', 'lam_thuong_ca', 'lam_cang_da_ca', 'tiem_ca', 'csd_ca',
  'up_sale', 'pct_hoa_hong', 'goi_phau', 'goi_da', 'phu_cap_khac', 'ung_luong'
];
const BOOL_FIELDS = ['thuc_luong_override', 'phu_cap_an_override'];

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
    if (action === 'list')       return await listEntries(res, body);
    if (action === 'create')     return await createEntry(res, body, sess);
    if (action === 'update')     return await updateEntry(res, body);
    if (action === 'delete')     return await deleteEntry(res, body);
    if (action === 'save_rates') return await saveRates(res, body);
    return res.status(400).json({ error: 'action không hợp lệ' });
  } catch (e) {
    console.error('payroll api error:', e?.message || e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

const pad2 = n => String(n).padStart(2, '0');

// Gom tiền up-sale từ Tour phẫu thuật trong tháng, tách theo bác sĩ và phụ phẫu.
// Dùng để tự tính hoa hồng cho 2 chức vụ này thay vì nhập tay.
async function tourUpsellByMonth(month, year) {
  const from = `${year}-${pad2(month)}-01`;
  const nextY = month === 12 ? year + 1 : year;
  const nextM = month === 12 ? 1 : month + 1;
  const to = `${nextY}-${pad2(nextM)}-01`;
  const params = new URLSearchParams();
  params.set('select', 'doctor,assistant,revenue_up,revenue_initial');
  params.append('case_date', `gte.${from}`);
  params.append('case_date', `lt.${to}`);
  params.set('limit', '5000');
  const r = await fetch(sb(`tour_cases?${params.toString()}`), { headers: sbHeaders() });
  if (!r.ok) return { doctor: {}, assistant: {} };
  const rows = await r.json().catch(() => []);
  const out = { doctor: {}, assistant: {} };
  const add = (bucket, name, up, rev) => {
    const k = String(name || '').trim();
    if (!k) return;
    if (!bucket[k]) bucket[k] = { up: 0, revenue: 0, cases: 0 };
    bucket[k].up += Number(up) || 0;
    bucket[k].revenue += Number(rev) || 0;
    bucket[k].cases++;
  };
  (Array.isArray(rows) ? rows : []).forEach(c => {
    add(out.doctor, c.doctor, c.revenue_up, c.revenue_initial);
    add(out.assistant, c.assistant, c.revenue_up, c.revenue_initial);
  });
  return out;
}

async function listEntries(res, body) {
  const month = Math.max(1, Math.min(12, parseInt(body.month, 10) || 0));
  const year = Math.max(2000, parseInt(body.year, 10) || 0);
  if (!month || !year) return res.status(400).json({ error: 'Thiếu tháng/năm' });

  const [rowsR, ratesR, staffR, tourUpsell] = await Promise.all([
    fetch(sb(`${TABLE}?month=eq.${month}&year=eq.${year}&select=*&order=created_at.asc`), { headers: sbHeaders() }),
    fetch(sb(`${RATES_TABLE}?id=eq.default&select=*&limit=1`), { headers: sbHeaders() }),
    fetch(sb('staff_members?select=id,full_name,role&order=full_name.asc'), { headers: sbHeaders() }),
    tourUpsellByMonth(month, year)
  ]);
  const rows = await rowsR.json();
  if (!rowsR.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  const ratesArr = await ratesR.json().catch(() => []);
  const rates = Array.isArray(ratesArr) && ratesArr[0] ? ratesArr[0] : null;
  const staffArr = await staffR.json().catch(() => []);
  const staff = Array.isArray(staffArr) ? staffArr : [];

  return res.status(200).json({ rows, rates, staff, tourUpsell });
}

function buildRow(body) {
  const row = {};
  const fullName = String(body.full_name || '').trim();
  if (fullName) row.full_name = fullName.slice(0, 100);
  if (body.staff_id != null) row.staff_id = String(body.staff_id).trim() || null;
  if (body.role != null) row.role = String(body.role).trim().slice(0, 80);
  for (const f of NUM_FIELDS) {
    if (body[f] != null) row[f] = Math.max(0, Number(body[f]) || 0);
  }
  for (const f of BOOL_FIELDS) {
    if (body[f] != null) row[f] = !!body[f];
  }
  return row;
}

async function createEntry(res, body, sess) {
  const month = Math.max(1, Math.min(12, parseInt(body.month, 10) || 0));
  const year = Math.max(2000, parseInt(body.year, 10) || 0);
  const fullName = String(body.full_name || '').trim();
  if (!month || !year) return res.status(400).json({ error: 'Thiếu tháng/năm' });
  if (!fullName) return res.status(400).json({ error: 'Thiếu tên nhân viên' });

  const row = { month, year, created_by: sess.u || '', ...buildRow(body) };
  const r = await fetch(sb(TABLE), { method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(row) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi thêm nhân viên' }); }
  return res.status(200).json({ ok: true });
}

async function updateEntry(res, body) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const patch = buildRow(body);
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Không có gì để cập nhật' });
  patch.updated_at = new Date().toISOString();
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi cập nhật' }); }
  return res.status(200).json({ ok: true });
}

async function deleteEntry(res, body) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'DELETE', headers: sbHeaders({ Prefer: 'return=minimal' }) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi xoá' }); }
  return res.status(200).json({ ok: true });
}

async function saveRates(res, body) {
  const patch = {};
  for (const f of ['meal', 'phu_thuong', 'phu_cang_da', 'lam_thuong', 'lam_cang_da', 'tiem', 'csd']) {
    if (body[f] != null) patch[f] = Math.max(0, parseInt(body[f], 10) || 0);
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Không có gì để cập nhật' });
  patch.updated_at = new Date().toISOString();
  const r = await fetch(sb(`${RATES_TABLE}?id=eq.default`), { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi cập nhật đơn giá' }); }
  return res.status(200).json({ ok: true });
}

export const config = { runtime: 'nodejs' };
