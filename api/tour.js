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
    if (action === 'upload_photo')   return await uploadPhoto(res, body);
    if (action === 'get_photos')     return await getPhotos(res, body);
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

// Cột "does not exist" -> chưa chạy migration thêm cột (age/photo_before/photo_after/note) trên
// Supabase. Thay vì lỗi cả trang, tự bỏ field lạ đó rồi thử lại — tính năng liên quan coi như tạm
// chưa có, chứ không kéo sập cả Hậu chăm sóc.
const MISSING_COLUMN_RE = /column .*\.?"?(\w+)"? does not exist/i;

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
  if (body.age != null) {
    const a = parseInt(body.age, 10);
    if (!isNaN(a) && a >= 0 && a <= 120) patch.age = a;
  }
  if (body.note != null) patch.note = String(body.note).slice(0, 2000);
  if (body.case_date != null && /^\d{4}-\d{2}-\d{2}$/.test(body.case_date)) patch.case_date = body.case_date;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Không có gì để cập nhật' });
  patch.updated_at = new Date().toISOString();

  let r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    const m = MISSING_COLUMN_RE.exec(e?.message || '');
    if (m && patch[m[1]] !== undefined) {
      delete patch[m[1]];
      r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
      if (r.ok) return res.status(200).json({ ok: true, skipped: m[1] });
    }
    return res.status(500).json({ error: e?.message || 'Lỗi cập nhật' });
  }
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
// Cột age/photo_before/photo_after/note chỉ có sau khi chạy tour_cases_photos_setup.sql trên
// Supabase — nếu chưa chạy, tự bỏ bớt rồi đọc lại (KHÔNG để lỗi cả trang Hậu chăm sóc).
async function listCare(res) {
  const from = new Date(Date.now() - CARE_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const baseCols = 'id,case_date,full_name,phone,service_initial,service_up,doctor,assistant,care_done';
  const extraCols = ['age', 'birth_year', 'address', 'photo_before', 'photo_after', 'note'];
  const buildUrl = (select) => {
    const params = new URLSearchParams();
    params.set('select', select);
    params.append('case_date', `gte.${from}`);
    params.set('order', 'case_date.desc');
    params.set('limit', '2000');
    return `${TABLE}?${params.toString()}`;
  };
  let cols = extraCols.slice();
  let r = await fetch(sb(buildUrl(baseCols + ',' + cols.join(','))), { headers: sbHeaders() });
  let rows = await r.json();
  while (!r.ok && cols.length) {
    const m = MISSING_COLUMN_RE.exec(rows?.message || '');
    if (!m || !cols.includes(m[1])) break;
    cols = cols.filter(c => c !== m[1]);
    r = await fetch(sb(buildUrl(cols.length ? baseCols + ',' + cols.join(',') : baseCols)), { headers: sbHeaders() });
    rows = await r.json();
  }
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

/* ===== ẢNH BEFORE/AFTER — lưu Supabase Storage bucket RIÊNG TƯ, chỉ tạo link xem tạm (1 giờ)
   khi lễ tân mở chi tiết ca, không bao giờ trả về link vĩnh viễn/công khai. ===== */
const PHOTO_BUCKET = 'case-photos';
let _bucketEnsured = false;
async function ensureBucket() {
  if (_bucketEnsured) return;
  const r = await fetch(`${process.env.SUPABASE_URL}/storage/v1/bucket`, {
    method: 'POST', headers: sbHeaders(),
    body: JSON.stringify({ id: PHOTO_BUCKET, name: PHOTO_BUCKET, public: false })
  });
  if (r.ok || r.status === 400 || r.status === 409) _bucketEnsured = true;   // 400/409 = bucket đã có sẵn
}

async function signUrl(path) {
  const r = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/sign/${PHOTO_BUCKET}/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
    method: 'POST', headers: sbHeaders(), body: JSON.stringify({ expiresIn: 3600 })
  });
  if (!r.ok) return null;
  const d = await r.json().catch(() => ({}));
  return d.signedURL ? `${process.env.SUPABASE_URL}/storage/v1${d.signedURL}` : null;
}

async function uploadPhoto(res, body) {
  const id = String(body.id || '');
  const kind = String(body.kind || '');
  if (!id || (kind !== 'before' && kind !== 'after')) return res.status(400).json({ error: 'Thiếu id hoặc loại ảnh không hợp lệ' });
  const dataUrl = String(body.dataUrl || '');
  const m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'Ảnh không hợp lệ (chỉ nhận jpeg/png/webp)' });
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'Ảnh quá lớn (tối đa 6MB)' });

  await ensureBucket();
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const path = `${id}/${kind}.${ext}`;
  const up = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
    method: 'POST', headers: sbHeaders({ 'Content-Type': mime, 'x-upsert': 'true' }), body: buf
  });
  if (!up.ok) { const e = await up.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi tải ảnh lên' }); }

  const patch = { updated_at: new Date().toISOString() };
  patch[kind === 'before' ? 'photo_before' : 'photo_after'] = path;
  const pr = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
  if (!pr.ok) { const e = await pr.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi lưu đường dẫn ảnh' }); }

  return res.status(200).json({ ok: true, url: await signUrl(path) });
}

async function getPhotos(res, body) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const r = await fetch(sb(`${TABLE}?id=eq.${id}&select=photo_before,photo_after`), { headers: sbHeaders() });
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  if (!rows.length) return res.status(404).json({ error: 'Không tìm thấy ca' });
  const [before, after] = await Promise.all([
    rows[0].photo_before ? signUrl(rows[0].photo_before) : null,
    rows[0].photo_after ? signUrl(rows[0].photo_after) : null
  ]);
  return res.status(200).json({ before, after });
}

export const config = { runtime: 'nodejs' };
