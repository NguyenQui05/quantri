// Vercel Serverless — Sao lưu số liệu Marketing + Doanh thu (Sổ thu/chi) hằng ngày vào Supabase.
// Google Sheet vẫn là nơi nhập liệu; dashboard đọc Sheet rồi gọi action 'sync'/'sync_revenue' để lưu bản sao.
// Nhờ vậy số liệu không mất khi Sheet bị xoá / đổi quyền chia sẻ / đổi tên tab.
// Gộp 2 module vào 1 file để không vượt giới hạn 12 Serverless Functions (Vercel Hobby).
// Cũng gánh luôn action 'read_sheet' — proxy đọc Sheet phía máy chủ (xem cuối file), vì lý do trên.
import crypto from 'node:crypto';
import { hasServiceAccount, readSheet } from './_google.js';

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
const REV_TABLE = 'revenue_daily';
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
// Doanh thu/chi/lợi nhuận có thể âm (ngày lỗ) — không clamp về 0 như num().
const signedNum = (v, max = 1e15) => {
  const n = Math.round(Number(v) || 0);
  if (!isFinite(n)) return 0;
  return Math.max(-max, Math.min(n, max));
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!verifySession(req)) return res.status(401).json({ error: 'no session' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ error: 'Body không hợp lệ' }); }
  const action = String(body.action || '');

  // 'read_sheet' chỉ đọc Google Sheet, không đụng Supabase -> không chặn vì thiếu key Supabase.
  if (action !== 'read_sheet' && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)) {
    return res.status(500).json({ error: 'Chưa cấu hình SUPABASE_URL / SUPABASE_SERVICE_KEY trên máy chủ' });
  }

  try {
    if (action === 'read_sheet')    return await readSheetProxy(res, body);
    if (action === 'sync')          return await syncDays(res, body);
    if (action === 'list')          return await listDays(res, body);
    if (action === 'sync_revenue')  return await syncRevenueDays(res, body);
    if (action === 'list_revenue')  return await listRevenueDays(res, body);
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

// Ghi đè theo ngày (upsert): chạy lại nhiều lần không tạo bản ghi trùng. Số có thể âm (ngày lỗ).
async function syncRevenueDays(res, body) {
  const input = Array.isArray(body.rows) ? body.rows : [];
  if (!input.length) return res.status(400).json({ error: 'Không có dữ liệu để đồng bộ' });
  if (input.length > 400) return res.status(400).json({ error: 'Quá nhiều dòng trong một lần đồng bộ' });

  const now = new Date().toISOString();
  const rows = [];
  for (const r of input) {
    const d = String(r.report_date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (isNaN(new Date(d + 'T00:00:00Z').getTime())) continue;
    rows.push({
      report_date: d,
      thu: signedNum(r.thu), chi: signedNum(r.chi), loinhuan: signedNum(r.loinhuan),
      synced_at: now, updated_at: now
    });
  }
  if (!rows.length) return res.status(400).json({ error: 'Không có dòng nào hợp lệ (thiếu ngày)' });

  const r = await fetch(sb(`${REV_TABLE}?on_conflict=report_date`), {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows)
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi lưu Supabase' }); }
  return res.status(200).json({ ok: true, saved: rows.length, synced_at: now });
}

async function listRevenueDays(res, body) {
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('order', 'report_date.desc');
  params.set('limit', '2000');
  const from = String(body.from || ''), to = String(body.to || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) params.append('report_date', `gte.${from}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) params.append('report_date', `lte.${to}`);
  const r = await fetch(sb(`${REV_TABLE}?${params.toString()}`), { headers: sbHeaders() });
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  return res.status(200).json({ rows });
}

/* ===== Proxy đọc Google Sheet phía máy chủ =====
   Trước đây dashboard đọc sheet thẳng từ trình duyệt nên sheet BẮT BUỘC phải chia sẻ
   công khai "ai có link đều xem" — rủi ro lộ tên/SĐT/công nợ khách. Nay máy chủ đọc hộ
   bằng Service Account, sheet để RIÊNG TƯ, chỉ nhân viên đã đăng nhập mới gọi được. */

// Dự phòng khi chưa đặt biến môi trường Service Account: vẫn đọc qua link công khai như cũ.
async function readViaPublicLink(id, { tab, gid }) {
  let u = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:json`;
  if (tab) u += '&sheet=' + encodeURIComponent(tab);
  else if (gid) u += '&gid=' + encodeURIComponent(gid);
  const r = await fetch(u);
  const txt = await r.text();
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}') + 1;
  if (s < 0 || e <= s) throw new Error('Không đọc được sheet — sheet đang riêng tư mà máy chủ chưa có GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY');
  const json = JSON.parse(txt.slice(s, e));
  if (json.status === 'error') throw new Error((json.errors || []).map(x => x.detailed_message || x.message).join('; ') || 'Sheet trả về lỗi quyền truy cập');
  const t = json.table || {};
  const noLabel = (t.cols || []).every(c => !c.label);
  let cols = (t.cols || []).map(c => c.label || '');
  let rows = (t.rows || []).map(r => (r.c || []).map(c => (c == null ? '' : (c.f != null ? c.f : (c.v != null ? c.v : '')))));
  let raw = (t.rows || []).map(r => (r.c || []).map(c => (c == null ? null : c.v)));
  if (noLabel && rows.length) { cols = rows[0].map(x => String(x)); rows = rows.slice(1); raw = raw.slice(1); }
  return { cols, rows, raw, tab: tab || null };
}

async function readSheetProxy(res, body) {
  const id = String(body.id || '').trim();
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(id)) return res.status(400).json({ error: 'Thiếu hoặc sai mã sheet' });
  const tab = body.tab ? String(body.tab).slice(0, 200) : '';
  const gid = body.gid != null && body.gid !== '' ? String(body.gid).replace(/\D/g, '') : '';
  try {
    const out = hasServiceAccount() ? await readSheet(id, { tab, gid }) : await readViaPublicLink(id, { tab, gid });
    return res.status(200).json(out);
  } catch (e) {
    const msg = String(e?.message || e);
    console.error('read_sheet error:', msg);
    // Lỗi hay gặp nhất: quên chia sẻ sheet cho service account.
    const hint = hasServiceAccount() && /permission|not found|forbidden|404|403/i.test(msg)
      ? ` — kiểm tra đã chia sẻ sheet cho ${process.env.GOOGLE_SA_EMAIL} (quyền Người xem) chưa`
      : '';
    return res.status(502).json({ error: msg + hint });
  }
}

export const config = { runtime: 'nodejs' };
