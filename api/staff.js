// Vercel Serverless — Quản trị nhân viên (lưu Supabase, thay dữ liệu mẫu cứng trong code).
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

const TABLE = 'staff_members';
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
    if (action === 'list')   return await listStaff(res);
    if (action === 'create') return await createStaff(res, body, sess);
    if (action === 'update') return await updateStaff(res, body);
    if (action === 'delete') return await deleteStaff(res, body, sess);
    // Công việc giao cho nhân viên (gộp vào đây vì gói Vercel Hobby giới hạn 12 function)
    if (action === 'task_list')   return await listTasks(res);
    if (action === 'task_create') return await createTask(res, body, sess);
    if (action === 'task_toggle') return await toggleTask(res, body, sess);
    if (action === 'task_delete') return await deleteTask(res, body, sess);
    return res.status(400).json({ error: 'action không hợp lệ' });
  } catch (e) {
    console.error('staff api error:', e?.message || e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

async function listStaff(res) {
  const r = await fetch(sb(`${TABLE}?select=*&order=created_at.asc`), { headers: sbHeaders() });
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  return res.status(200).json({ rows });
}

async function createStaff(res, body, sess) {
  const fullName = String(body.full_name || '').trim();
  if (!fullName) return res.status(400).json({ error: 'Thiếu họ tên' });
  const row = {
    full_name: fullName.slice(0, 100),
    role: String(body.role || '').trim().slice(0, 80),
    specialty: String(body.specialty || '').trim().slice(0, 200),
    phone: String(body.phone || '').replace(/\D/g, '').slice(0, 15),
    email: String(body.email || '').trim().slice(0, 120),
    tags: String(body.tags || '').trim().slice(0, 300),
    skills: String(body.skills || '').trim().slice(0, 300),
    sessions: Math.max(0, parseInt(body.sessions, 10) || 0),
    rating: Math.max(0, Math.min(5, parseFloat(body.rating) || 0)),
    revenue: Math.max(0, parseInt(body.revenue, 10) || 0),
    kpi: Math.max(0, parseFloat(body.kpi) || 0),
    created_by: sess.u || ''
  };
  const r = await fetch(sb(TABLE), { method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(row) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi thêm nhân viên' }); }
  return res.status(200).json({ ok: true });
}

async function updateStaff(res, body) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const patch = {};
  for (const f of ['full_name', 'role', 'specialty', 'phone', 'email', 'tags', 'skills', 'status']) {
    if (body[f] != null) patch[f] = String(body[f]).slice(0, 300);
  }
  if (body.sessions != null) patch.sessions = Math.max(0, parseInt(body.sessions, 10) || 0);
  if (body.rating != null) patch.rating = Math.max(0, Math.min(5, parseFloat(body.rating) || 0));
  if (body.revenue != null) patch.revenue = Math.max(0, parseInt(body.revenue, 10) || 0);
  if (body.kpi != null) patch.kpi = Math.max(0, parseFloat(body.kpi) || 0);
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Không có gì để cập nhật' });
  patch.updated_at = new Date().toISOString();
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi cập nhật' }); }
  return res.status(200).json({ ok: true });
}

async function deleteStaff(res, body, sess) {
  if (sess.role !== 'Toàn quyền kiểm soát') return res.status(403).json({ error: 'Chỉ Toàn quyền kiểm soát mới được xoá' });
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'DELETE', headers: sbHeaders({ Prefer: 'return=minimal' }) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi xoá' }); }
  return res.status(200).json({ ok: true });
}

/* ===== CÔNG VIỆC ===== */
const TASKS_TABLE = 'staff_tasks';
const VALID_PRIORITY = ['Khẩn', 'Cao', 'TB', 'Thấp'];
// Giao/xoá việc là quyền của chủ phòng khám — chặn ở server, không chỉ ẩn nút trên giao diện
const canManageTasks = sess => sess.role === 'Toàn quyền kiểm soát';

async function listTasks(res) {
  const r = await fetch(sb(`${TASKS_TABLE}?select=*&order=done.asc,due.asc,created_at.desc&limit=500`), { headers: sbHeaders() });
  const rows = await r.json();
  if (!r.ok) return res.status(500).json({ error: rows?.message || 'Lỗi đọc dữ liệu' });
  return res.status(200).json({ rows });
}

async function createTask(res, body, sess) {
  if (!canManageTasks(sess)) return res.status(403).json({ error: 'Chỉ Toàn quyền kiểm soát mới được giao việc' });
  const title = String(body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Thiếu tiêu đề công việc' });
  const priority = VALID_PRIORITY.includes(body.priority) ? body.priority : 'TB';
  const row = {
    title: title.slice(0, 300),
    owner: String(body.owner || '').trim().slice(0, 100) || null,
    staff_id: body.staff_id ? String(body.staff_id).trim() : null,
    priority,
    tag: String(body.tag || '').trim().slice(0, 60) || null,
    due: body.due ? new Date(body.due).toISOString() : null,
    created_by: sess.u || ''
  };
  if (row.due && isNaN(new Date(row.due).getTime())) row.due = null;
  const r = await fetch(sb(TASKS_TABLE), { method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(row) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi tạo công việc' }); }
  return res.status(200).json({ ok: true });
}

// Ai cũng được tích hoàn thành việc của mình
async function toggleTask(res, body, sess) {
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const done = !!body.done;
  const patch = {
    done,
    done_at: done ? new Date().toISOString() : null,
    done_by: done ? (sess.u || '') : null,
    updated_at: new Date().toISOString()
  };
  const r = await fetch(sb(`${TASKS_TABLE}?id=eq.${id}`), { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi cập nhật' }); }
  return res.status(200).json({ ok: true });
}

async function deleteTask(res, body, sess) {
  if (!canManageTasks(sess)) return res.status(403).json({ error: 'Chỉ Toàn quyền kiểm soát mới được xoá công việc' });
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const r = await fetch(sb(`${TASKS_TABLE}?id=eq.${id}`), { method: 'DELETE', headers: sbHeaders({ Prefer: 'return=minimal' }) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi xoá' }); }
  return res.status(200).json({ ok: true });
}

export const config = { runtime: 'nodejs' };
