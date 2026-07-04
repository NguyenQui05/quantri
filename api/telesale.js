// Vercel Serverless — Phân phối SĐT cho nhân viên telesale gọi (lưu Supabase).
// Bảo mật: mọi action yêu cầu cookie phiên hợp lệ (HMAC như /api/me).
// Dùng SUPABASE_SERVICE_KEY ở server (không lộ ra client).
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

const TABLE = 'telesale_leads';
function sb(path) {
  const base = process.env.SUPABASE_URL;
  return `${base}/rest/v1/${path}`;
}
function sbHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

const STATUSES = ['chua_goi', 'da_goi', 'hen_lich', 'khong_nghe', 'tu_choi', 'xong'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!verifySession(req)) return res.status(401).json({ error: 'no session' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Chưa cấu hình SUPABASE_URL / SUPABASE_SERVICE_KEY trên máy chủ' });
  }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ error: 'Body không hợp lệ' }); }
  const action = String(body.action || '');

  try {
    if (action === 'list')       return await listLeads(res, body);
    if (action === 'import')     return await importLeads(res, body);
    if (action === 'distribute') return await distribute(res, body);
    if (action === 'update')     return await updateLead(res, body);
    if (action === 'delete')     return await deleteLead(res, body);
    if (action === 'clear')      return await clearAll(res, body);
    return res.status(400).json({ error: 'action không hợp lệ' });
  } catch (e) {
    console.error('telesale api error:', e?.message || e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

// Danh sách + tổng hợp
async function listLeads(res, body) {
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('order', 'created_at.desc');
  if (body.assigned_to) params.set('assigned_to', `eq.${body.assigned_to}`);
  if (body.status) params.set('status', `eq.${body.status}`);
  const r = await fetch(sb(`${TABLE}?${params.toString()}`), { headers: sbHeaders() });
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  // tổng hợp
  const sum = { total: rows.length, chua_goi: 0, da_goi: 0, hen_lich: 0, khong_nghe: 0, tu_choi: 0, xong: 0, chua_chia: 0 };
  const byStaff = {};
  for (const row of rows) {
    if (sum[row.status] != null) sum[row.status]++;
    if (!row.assigned_to) sum.chua_chia++;
    else byStaff[row.assigned_to] = (byStaff[row.assigned_to] || 0) + 1;
  }
  return res.status(200).json({ rows, sum, byStaff });
}

// Nhập SĐT hàng loạt (bỏ trùng theo phone)
async function importLeads(res, body) {
  const items = Array.isArray(body.items) ? body.items : [];
  const clean = [];
  const seen = new Set();
  for (const it of items) {
    const digits = String(it.phone || '').replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 12) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);
    clean.push({
      phone: digits,
      full_name: String(it.full_name || '').trim().slice(0, 80),
      source: String(it.source || '').trim().slice(0, 120),
      status: 'chua_goi'
    });
  }
  if (!clean.length) return res.status(400).json({ error: 'Không có số điện thoại hợp lệ' });
  // upsert, bỏ qua số đã tồn tại
  const r = await fetch(sb(`${TABLE}?on_conflict=phone`), {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'resolution=ignore-duplicates,return=representation' }),
    body: JSON.stringify(clean)
  });
  const out = await r.json();
  if (!r.ok) return res.status(500).json({ error: out?.message || 'Lỗi nhập dữ liệu' });
  return res.status(200).json({ inserted: out.length, submitted: clean.length, skipped: clean.length - out.length });
}

// Chia đều vòng tròn cho các nhân viên (chỉ chia số CHƯA có người + chưa gọi)
async function distribute(res, body) {
  const staff = (Array.isArray(body.staff) ? body.staff : [])
    .map(s => String(s).trim()).filter(Boolean);
  if (!staff.length) return res.status(400).json({ error: 'Chưa chọn nhân viên nhận' });

  const includeAll = !!body.includeAll; // true = chia lại tất cả; false = chỉ số chưa chia
  const params = new URLSearchParams();
  params.set('select', 'id');
  params.set('status', 'eq.chua_goi');
  if (!includeAll) params.set('assigned_to', 'eq.'); // assigned_to rỗng
  params.set('order', 'created_at.asc');
  const r = await fetch(sb(`${TABLE}?${params.toString()}`), { headers: sbHeaders() });
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  if (!rows.length) return res.status(200).json({ assigned: 0, perStaff: {}, message: 'Không có số nào cần chia' });

  // gom id theo từng nhân viên (round-robin)
  const groups = {}; staff.forEach(s => groups[s] = []);
  rows.forEach((row, i) => groups[staff[i % staff.length]].push(row.id));

  const now = new Date().toISOString();
  const perStaff = {};
  for (const s of staff) {
    const ids = groups[s];
    if (!ids.length) { perStaff[s] = 0; continue; }
    const q = `id=in.(${ids.join(',')})`;
    const up = await fetch(sb(`${TABLE}?${q}`), {
      method: 'PATCH',
      headers: sbHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ assigned_to: s, assigned_at: now })
    });
    if (!up.ok) { const e = await up.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi khi chia' }); }
    perStaff[s] = ids.length;
  }
  return res.status(200).json({ assigned: rows.length, perStaff });
}

// Cập nhật trạng thái/ghi chú một số
async function updateLead(res, body) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const patch = {};
  if (body.status != null) {
    if (!STATUSES.includes(body.status)) return res.status(400).json({ error: 'status không hợp lệ' });
    patch.status = body.status;
    if (body.status !== 'chua_goi') patch.called_at = new Date().toISOString();
  }
  if (body.call_note != null) patch.call_note = String(body.call_note).slice(0, 500);
  if (body.assigned_to != null) patch.assigned_to = String(body.assigned_to).slice(0, 80);
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Không có gì để cập nhật' });
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), {
    method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch)
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi cập nhật' }); }
  return res.status(200).json({ ok: true });
}

async function deleteLead(res, body) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'DELETE', headers: sbHeaders({ Prefer: 'return=minimal' }) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi xoá' }); }
  return res.status(200).json({ ok: true });
}

// Xoá toàn bộ (làm mới danh sách) — cần xác nhận từ client
async function clearAll(res, body) {
  if (body.confirm !== 'XOA_TAT_CA') return res.status(400).json({ error: 'Cần xác nhận' });
  const r = await fetch(sb(`${TABLE}?id=neq.00000000-0000-0000-0000-000000000000`), {
    method: 'DELETE', headers: sbHeaders({ Prefer: 'return=minimal' })
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi xoá' }); }
  return res.status(200).json({ ok: true });
}

export const config = { runtime: 'nodejs' };
