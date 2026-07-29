// Vercel Serverless — Lead Mới (Kanban 4 giai đoạn: mới → tiếp cận → đặt lịch → đã tới), lưu Supabase bảng web_leads.
// Gộp 2 vai trò trong 1 function (giới hạn 12 Serverless Functions của gói Hobby):
//  - Không có "action" trong body -> webhook công khai (landing page gọi, không cần đăng nhập, có CORS)
//  - Có "action" -> API quản trị cho dashboard /quantri#leads (yêu cầu session hợp lệ)
import crypto from 'node:crypto';

const ALLOWED_ORIGINS = [
  'https://phammaiphuong.vn', 'https://www.phammaiphuong.vn',
  'https://phammaiphuong.com', 'https://www.phammaiphuong.com',
  'https://thammyvienhana.com', 'https://www.thammyvienhana.com'
];

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

const TABLE = 'web_leads';
const VALID_STATUS = ['new', 'contacted', 'appointment', 'arrived'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function sb(path) {
  const base = process.env.SUPABASE_URL;
  return `${base}/rest/v1/${path}`;
}
function sbHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

export default async function handler(req, res) {
  // CORS — cần cho webhook công khai gọi từ domain HANA + link nháp *.vercel.app
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ error: 'Body không hợp lệ' }); }
  const action = String(body.action || '');

  // Không có action => webhook công khai từ form landing, không cần đăng nhập
  if (!action) return await publicCreateLead(res, req, body);

  const sess = verifySession(req);
  if (!sess) return res.status(401).json({ error: 'no session' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Chưa cấu hình SUPABASE_URL / SUPABASE_SERVICE_KEY trên máy chủ' });
  }

  try {
    if (action === 'list')          return await listLeads(res);
    if (action === 'create')        return await createLead(res, body);
    if (action === 'update_status') return await updateStatus(res, body);
    if (action === 'update')        return await updateLead(res, body);
    if (action === 'delete')        return await deleteLead(res, body);
    return res.status(400).json({ error: 'action không hợp lệ' });
  } catch (e) {
    console.error('leads api error:', e?.message || e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

async function publicCreateLead(res, req, body) {
  try {
    let { name = '', phone = '', service = '', time = '', source = '' } = body;

    name = String(name).trim().slice(0, 80);
    phone = String(phone).trim().slice(0, 20);
    service = String(service).trim().slice(0, 120);
    time = String(time).trim().slice(0, 120);
    source = String(source).trim().slice(0, 120);

    const digits = phone.replace(/\D/g, '');
    if (!name || digits.length < 9 || digits.length > 12) {
      return res.status(400).json({ error: 'Thiếu tên hoặc số điện thoại không hợp lệ' });
    }

    const lead = {
      name, phone, service, slot: time, source: source || 'web', status: 'new',
      ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(),
      ua: String(req.headers['user-agent'] || '').slice(0, 200)
    };

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      console.log('NEW LEAD (chưa cấu hình Supabase):', JSON.stringify(lead));
      return res.status(200).json({ ok: true });
    }

    const r = await fetch(sb(TABLE), { method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(lead) });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      console.error('Lead -> Supabase lỗi:', e?.message || r.status, JSON.stringify(lead));
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e?.message || e) });
  }
}

async function listLeads(res) {
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('order', 'created_at.desc');
  params.set('limit', '2000');
  const r = await fetch(sb(`${TABLE}?${params.toString()}`), { headers: sbHeaders() });
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  return res.status(200).json({ rows });
}

async function createLead(res, body) {
  const name = String(body.name || '').trim().slice(0, 100);
  const phone = String(body.phone || '').trim().slice(0, 20);
  if (!name || !phone) return res.status(400).json({ error: 'Thiếu tên hoặc SĐT' });
  const row = {
    name, phone,
    service: body.service != null ? String(body.service).slice(0, 200) : null,
    age: body.age != null ? String(body.age).slice(0, 10) : null,
    gender: body.gender != null ? String(body.gender).slice(0, 20) : null,
    problem: body.problem != null ? String(body.problem).slice(0, 500) : null,
    source: String(body.source || 'trực page').slice(0, 50),
    status: 'new'
  };
  // Ngày khách thả số — không truyền thì để cột tự lấy mặc định (hôm nay)
  if (body.lead_date != null && DATE_RE.test(body.lead_date)) row.lead_date = body.lead_date;
  const r = await fetch(sb(TABLE), { method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(row) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi tạo lead' }); }
  return res.status(200).json({ ok: true });
}

async function updateStatus(res, body) {
  const id = String(body.id || '');
  const status = String(body.status || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), {
    method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ status, updated_at: new Date().toISOString() })
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi cập nhật trạng thái' }); }
  return res.status(200).json({ ok: true });
}

async function updateLead(res, body) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const patch = {};
  for (const f of ['name', 'phone', 'service', 'note', 'age', 'gender', 'problem']) {
    if (body[f] != null) patch[f] = String(body[f]).slice(0, 500);
  }
  if (body.status != null) {
    if (!VALID_STATUS.includes(body.status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
    patch.status = body.status;
  }
  if (body.lead_date != null) {
    if (!DATE_RE.test(body.lead_date)) return res.status(400).json({ error: 'Ngày thả số không hợp lệ (YYYY-MM-DD)' });
    patch.lead_date = body.lead_date;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Không có gì để cập nhật' });
  patch.updated_at = new Date().toISOString();
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
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

export const config = { runtime: 'nodejs' };
