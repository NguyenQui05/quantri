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

// Bộ lọc chung: nhân viên, trạng thái, khoảng ngày, tìm kiếm
function buildFilterParams(body, { withAssigned = true } = {}) {
  const p = new URLSearchParams();
  if (withAssigned && body.assigned_to) p.set('assigned_to', `eq.${body.assigned_to}`);
  if (body.status) p.set('status', `eq.${body.status}`);
  if (body.from) p.append('lead_date', `gte.${body.from}`);
  if (body.to) p.append('lead_date', `lte.${body.to}`);
  if (body.search) {
    const s = String(body.search).replace(/[(),*]/g, ' ').trim();
    if (s) p.set('or', `(phone.ilike.*${s}*,full_name.ilike.*${s}*)`);
  }
  return p;
}

// Danh sách + tổng hợp (thống kê chính xác qua RPC, không bị giới hạn 1000 dòng)
async function listLeads(res, body) {
  const PAGE = 1000;
  const page = Math.max(0, parseInt(body.page, 10) || 0);
  const params = buildFilterParams(body);
  params.set('select', '*');
  params.set('order', 'lead_date.desc.nullslast');
  params.set('limit', String(PAGE));
  params.set('offset', String(page * PAGE));
  const r = await fetch(sb(`${TABLE}?${params.toString()}`), { headers: sbHeaders({ Prefer: 'count=exact' }) });
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  const cr = r.headers.get('content-range') || '';
  const matched = parseInt(cr.split('/')[1] || '0', 10) || rows.length;
  const totalPages = Math.max(1, Math.ceil(matched / PAGE));

  // tổng hợp chính xác toàn tập (theo bộ lọc) qua hàm SQL
  let stats = {};
  try {
    const st = await fetch(sb('rpc/telesale_stats'), {
      method: 'POST', headers: sbHeaders(),
      body: JSON.stringify({ p_from: body.from || null, p_to: body.to || null, p_search: body.search || null })
    });
    if (st.ok) stats = await st.json();
  } catch (e) { /* fallback dưới */ }

  const sum = {
    total: stats.total ?? matched, chua_goi: stats.chua_goi ?? 0, da_goi: stats.da_goi ?? 0,
    hen_lich: stats.hen_lich ?? 0, khong_nghe: stats.khong_nghe ?? 0, tu_choi: stats.tu_choi ?? 0,
    xong: stats.xong ?? 0, chua_chia: stats.chua_chia ?? 0, con_no: stats.con_no ?? 0, tong_no: stats.tong_no ?? 0
  };
  return res.status(200).json({ rows, sum, byStaff: stats.by_staff || {}, matched, page, totalPages, pageSize: PAGE, capped: matched > PAGE });
}

// Nhập SĐT hàng loạt (bỏ trùng theo phone) — kèm ngày + nợ nếu có
async function importLeads(res, body) {
  const items = Array.isArray(body.items) ? body.items : [];
  const clean = [];
  const seen = new Set();
  for (const it of items) {
    const digits = String(it.phone || '').replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 12) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);
    const debt = Math.max(0, parseInt(it.debt, 10) || 0);
    clean.push({
      phone: digits,
      full_name: String(it.full_name || '').trim().slice(0, 80),
      source: String(it.source || '').trim().slice(0, 120),
      lead_date: it.lead_date || null,
      debt,
      call_note: debt > 0 ? `Còn nợ: ${debt.toLocaleString('vi-VN')}đ` : '',
      status: 'chua_goi'
    });
  }
  if (!clean.length) return res.status(400).json({ error: 'Không có số điện thoại hợp lệ' });
  const r = await fetch(sb(`${TABLE}?on_conflict=phone`), {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'resolution=ignore-duplicates,return=representation' }),
    body: JSON.stringify(clean)
  });
  const out = await r.json();
  if (!r.ok) return res.status(500).json({ error: out?.message || 'Lỗi nhập dữ liệu' });
  return res.status(200).json({ inserted: out.length, submitted: clean.length, skipped: clean.length - out.length });
}

// Lấy toàn bộ id khớp bộ lọc (phân trang, vượt giới hạn 1000)
async function fetchAllIds(params) {
  const ids = [];
  let from = 0; const page = 1000;
  while (true) {
    const r = await fetch(sb(`${TABLE}?${params.toString()}`), {
      headers: sbHeaders({ 'Range-Unit': 'items', Range: `${from}-${from + page - 1}` })
    });
    const chunk = await r.json();
    if (!r.ok) throw new Error(chunk?.message || 'Lỗi đọc dữ liệu');
    ids.push(...chunk.map(x => x.id));
    if (chunk.length < page) break;
    from += page;
  }
  return ids;
}

// Chia đều vòng tròn — theo bộ lọc hiện tại (ngày/tìm kiếm), chỉ số CHƯA gọi
async function distribute(res, body) {
  const staff = (Array.isArray(body.staff) ? body.staff : [])
    .map(s => String(s).trim()).filter(Boolean);
  if (!staff.length) return res.status(400).json({ error: 'Chưa chọn nhân viên nhận' });

  const includeAll = !!body.includeAll; // true = chia lại cả số đã chia
  const params = buildFilterParams(body, { withAssigned: false });
  params.set('select', 'id');
  params.set('status', 'eq.chua_goi');
  if (!includeAll) params.set('assigned_to', 'eq.');
  params.set('order', 'lead_date.asc.nullslast');

  let ids;
  try { ids = await fetchAllIds(params); }
  catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  if (!ids.length) return res.status(200).json({ assigned: 0, perStaff: {}, message: 'Không có số nào cần chia' });

  const groups = {}; staff.forEach(s => groups[s] = []);
  ids.forEach((id, i) => groups[staff[i % staff.length]].push(id));

  const now = new Date().toISOString();
  const perStaff = {};
  for (const s of staff) {
    const g = groups[s];
    if (!g.length) { perStaff[s] = 0; continue; }
    for (let i = 0; i < g.length; i += 200) {
      const part = g.slice(i, i + 200);
      const up = await fetch(sb(`${TABLE}?id=in.(${part.join(',')})`), {
        method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }),
        body: JSON.stringify({ assigned_to: s, assigned_at: now })
      });
      if (!up.ok) { const e = await up.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi khi chia' }); }
    }
    perStaff[s] = g.length;
  }
  return res.status(200).json({ assigned: ids.length, perStaff });
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
