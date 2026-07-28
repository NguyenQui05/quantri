// Vercel Serverless — Sao lưu số liệu Marketing hằng ngày vào Supabase (bảng marketing_daily).
// Google Sheet vẫn là nơi nhập liệu; dashboard đọc Sheet rồi gọi action 'sync' để lưu bản sao.
// Nhờ vậy số liệu không mất khi Sheet bị xoá / đổi quyền chia sẻ / đổi tên tab.
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

const TABLE = 'marketing_daily';
function sb(path) {
  const base = process.env.SUPABASE_URL;
  return `${base}/rest/v1/${path}`;
}
function sbHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

const num = (v, max = 1e15) => {
  const n = Math.round(Number(v) || 0);
  if (!isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
};

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
    if (action === 'sync') return await syncDays(res, body);
    if (action === 'list') return await listDays(res, body);
    return res.status(400).json({ error: 'action không hợp lệ' });
  } catch (e) {
    console.error('marketing api error:', e?.message || e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

// Ghi đè theo ngày (upsert): chạy lại nhiều lần không tạo bản ghi trùng.
async function syncDays(res, body) {
  const input = Array.isArray(body.rows) ? body.rows : [];
  if (!input.length) return res.status(400).json({ error: 'Không có dữ liệu để đồng bộ' });
  if (input.length > 400) return res.status(400).json({ error: 'Quá nhiều dòng trong một lần đồng bộ' });

  const now = new Date().toISOString();
  const rows = [];
  for (const r of input) {
    const d = String(r.report_date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;         // chỉ nhận ngày chuẩn YYYY-MM-DD
    if (isNaN(new Date(d + 'T00:00:00Z').getTime())) continue;
    rows.push({
      report_date: d,
      spend: num(r.spend), mess: num(r.mess, 1e7), sdt: num(r.sdt, 1e7),
      khach: num(r.khach, 1e7), lead: num(r.lead, 1e7), rev: num(r.rev),
      synced_at: now, updated_at: now
    });
  }
  if (!rows.length) return res.status(400).json({ error: 'Không có dòng nào hợp lệ (thiếu ngày)' });

  const r = await fetch(sb(`${TABLE}?on_conflict=report_date`), {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows)
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi lưu Supabase' }); }
  return res.status(200).json({ ok: true, saved: rows.length, synced_at: now });
}

async function listDays(res, body) {
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('order', 'report_date.desc');
  params.set('limit', '2000');
  const from = String(body.from || ''), to = String(body.to || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) params.append('report_date', `gte.${from}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) params.append('report_date', `lte.${to}`);
  const r = await fetch(sb(`${TABLE}?${params.toString()}`), { headers: sbHeaders() });
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  return res.status(200).json({ rows });
}

export const config = { runtime: 'nodejs' };
