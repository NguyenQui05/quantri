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

  // Vercel Cron gọi GET 1 lần/ngày để đồng bộ lead mới từ Google Sheet "trực page" nhập.
  // Vercel tự thêm header Authorization: Bearer $CRON_SECRET khi gọi cron — không ai khác đoán được.
  if (req.method === 'GET' && String(req.query?.cron || '') === 'sync_sheet') {
    const secret = process.env.CRON_SECRET;
    const auth = req.headers.authorization || '';
    if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'Chưa cấu hình SUPABASE_URL / SUPABASE_SERVICE_KEY trên máy chủ' });
    }
    try { return await syncFromSheet(res); }
    catch (e) { console.error('sync_sheet error:', e?.message || e); return res.status(500).json({ error: String(e?.message || e) }); }
  }

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
    if (action === 'delete')        return await deleteLead(res, body, sess);
    return res.status(400).json({ error: 'action không hợp lệ' });
  } catch (e) {
    console.error('leads api error:', e?.message || e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

// ===== Đồng bộ lead từ Google Sheet "trực page" nhập (chạy 1 lần/ngày qua Vercel Cron) =====
// Sheet: DATA TM HaNa chuẩn nhất — mỗi tháng 1 tab riêng, thường tên "DATA T<tháng>/<năm>"
// nhưng đôi khi các bạn trực page thêm chữ (vd tháng 7/2026 là "DATA T7/2026 MỚI").
// Tự tính đúng tab theo THÁNG THẬT (đồng hồ máy); nếu tháng nào tên tab lệch khuôn thường
// thì thêm 1 dòng vào LEAD_SHEET_TAB_OVERRIDE bên dưới (không cần cho mọi tháng).
const LEAD_SHEET_ID = '1xivkZTZ58ShcnMdwRvt9S7ZD89Lc9Ww-gS8VYa2fdcQ';
const LEAD_SHEET_TAB_OVERRIDE = {
  '2026-07': 'DATA T7/2026 MỚI'
};
function currentLeadSheetTab() {
  const d = new Date();
  const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  return LEAD_SHEET_TAB_OVERRIDE[key] || ('DATA T' + (d.getMonth() + 1) + '/' + d.getFullYear());
}

const STATUS_MAP = {
  'đã mua dịch vụ': 'arrived', 'đến nhưng ko mua': 'arrived', 'khách cũ đá ghé làm rồi': 'arrived',
  'đã đặt lịch': 'appointment', 'bom lịch': 'appointment',
  'sắp xếp': 'contacted', 'tham khảo': 'contacted', 'knm': 'contacted', 'hết nhu cầu': 'contacted',
  'tỉnh xa': 'contacted', 'sai sdt': 'contacted', 'thuê bao': 'contacted'
};
function mapStatus(s) { return STATUS_MAP[String(s || '').trim().toLowerCase()] || 'contacted'; }
function normPhone(raw) {
  const d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!d) return '';
  return d.length === 9 ? '0' + d : d;
}
// Đọc ngày từ 2 nguồn: gviz trả "Date(2026,7,1)" (tháng đếm từ 0);
// Sheets API (Service Account) trả chuỗi hiển thị "1/7/2026" hoặc "2026-07-01".
function parseGvizDate(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const g = s.match(/^Date\((\d+),(\d+),(\d+)/);
  if (g) {
    const y = +g[1], mo = +g[2] + 1, d = +g[3];
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${String(+iso[2]).padStart(2, '0')}-${String(+iso[3]).padStart(2, '0')}`;
  // dd/mm/yyyy (kiểu Việt Nam)
  const vn = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (vn) {
    let y = +vn[3]; if (y < 100) y += 2000;
    return `${y}-${String(+vn[2]).padStart(2, '0')}-${String(+vn[1]).padStart(2, '0')}`;
  }
  return null;
}

// ===== Đọc Sheet RIÊNG TƯ bằng Service Account (không cần chia sẻ công khai) =====
// Cần 2 biến môi trường trên Vercel: GOOGLE_SA_EMAIL và GOOGLE_SA_PRIVATE_KEY.
// Sheet chỉ cần chia sẻ (quyền Người xem) cho đúng email của service account.
function hasServiceAccount() {
  return !!(process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY);
}
async function getGoogleAccessToken() {
  const email = process.env.GOOGLE_SA_EMAIL;
  const key = String(process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now
  });
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${head}.${claim}`);
  const assertion = `${head}.${claim}.${signer.sign(key).toString('base64url')}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error('Không lấy được token Google: ' + (d.error_description || d.error || r.status));
  return d.access_token;
}
// Trả về mảng dòng (mỗi dòng là mảng ô, dạng chuỗi hiển thị) — giống thứ tự cột trên sheet
async function readSheetRows(spreadsheetId, tabName) {
  const token = await getGoogleAccessToken();
  const range = `'${String(tabName).replace(/'/g, "''")}'`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || ('Sheets API lỗi ' + r.status));
  return d.values || [];
}

async function syncFromSheet(res) {
  const tab = currentLeadSheetTab();
  let rows, get;

  if (hasServiceAccount()) {
    // Cách bảo mật: sheet để riêng tư, đọc bằng chìa khoá máy chủ
    let values;
    try { values = await readSheetRows(LEAD_SHEET_ID, tab); }
    catch (e) { return res.status(502).json({ error: 'Không đọc được Sheet (Service Account): ' + (e?.message || e) + ' — kiểm tra đã chia sẻ sheet cho ' + process.env.GOOGLE_SA_EMAIL + ' và tên tab "' + tab + '" có đúng không' }); }
    rows = values;
    get = (r, i) => (r && r[i] != null ? r[i] : null);
  } else {
    // Dự phòng: đọc qua link công khai (kém an toàn — chỉ dùng khi chưa cấu hình Service Account)
    const url = `https://docs.google.com/spreadsheets/d/${LEAD_SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(tab)}`;
    const sheetRes = await fetch(url);
    const text = await sheetRes.text();
    const s = text.indexOf('{'), e = text.lastIndexOf('}') + 1;
    if (s < 0 || e <= s) return res.status(502).json({ error: 'Không đọc được Google Sheet — sheet đang riêng tư. Hãy cấu hình GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY để đọc an toàn.' });
    const data = JSON.parse(text.slice(s, e));
    if (data.status === 'error') return res.status(502).json({ error: (data.errors || []).map(x => x.detailed_message || x.message).join('; ') || 'Sheet lỗi quyền truy cập' });
    rows = data.table?.rows || [];
    get = (r, i) => { const c = r.c && r.c[i]; return c ? c.v : null; };
  }

  const candidates = [];
  for (const r of rows) {
    const name = String(get(r, 4) || '').replace(/^[,\s]+/, '').trim();
    const phone = normPhone(get(r, 5));
    if (!name || !phone) continue;
    const leadDate = parseGvizDate(get(r, 0));
    const nvAds = String(get(r, 2) || '').trim();
    const telesale = String(get(r, 3) || '').trim();
    const diaChi = String(get(r, 8) || '').trim();
    const ngayHen = get(r, 10);
    const trangThai = String(get(r, 11) || '').trim();
    const ghiChu = String(get(r, 12) || '').trim();
    const noteParts = [];
    if (diaChi) noteParts.push('Địa chỉ: ' + diaChi);
    if (telesale) noteParts.push('Telesale: ' + telesale);
    if (nvAds) noteParts.push('NV Ads: ' + nvAds);
    if (trangThai) noteParts.push('Trạng thái gốc: ' + trangThai);
    if (ghiChu) noteParts.push(ghiChu);
    candidates.push({
      name: name.slice(0, 80), phone, service: String(get(r, 7) || '').trim().slice(0, 200),
      age: String(get(r, 6) || '').trim().slice(0, 10) || null,
      source: 'Facebook', status: mapStatus(trangThai),
      note: noteParts.join(' | ').slice(0, 500),
      slot: ngayHen ? (parseGvizDate(ngayHen) || String(ngayHen).slice(0, 60)) : null,
      lead_date: leadDate
    });
  }
  if (!candidates.length) return res.status(200).json({ ok: true, tab: currentLeadSheetTab(), checked: 0, inserted: 0, skipped: 0 });

  // Chặn nhập trùng: sheet không tự xoá dòng cũ, cron chạy mỗi ngày nên phải bỏ qua
  // những khách (SĐT + ngày thả số) đã có sẵn trong hệ thống từ lần đồng bộ trước.
  const existP = new URLSearchParams();
  existP.set('select', 'phone,lead_date');
  existP.set('phone', `in.(${candidates.map(c => `"${c.phone}"`).join(',')})`);
  const existR = await fetch(sb(`${TABLE}?${existP.toString()}`), { headers: sbHeaders() });
  const existRows = existR.ok ? await existR.json() : [];
  const existSet = new Set((existRows || []).map(x => `${x.phone}|${x.lead_date}`));

  const toInsert = candidates.filter(c => !existSet.has(`${c.phone}|${c.lead_date}`));
  let inserted = 0;
  const CHUNK = 200;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const batch = toInsert.slice(i, i + CHUNK);
    const r = await fetch(sb(TABLE), { method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(batch) });
    if (r.ok) inserted += batch.length;
    else console.error('sync insert batch lỗi:', await r.text().catch(() => ''));
  }
  return res.status(200).json({ ok: true, tab: currentLeadSheetTab(), checked: candidates.length, inserted, skipped: candidates.length - toInsert.length });
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

async function deleteLead(res, body, sess) {
  if (sess.role !== 'Toàn quyền kiểm soát') return res.status(403).json({ error: 'Chỉ Toàn quyền kiểm soát mới được xoá' });
  const id = String(body.id || '');
  if (!id) return res.status(400).json({ error: 'Thiếu id' });
  const r = await fetch(sb(`${TABLE}?id=eq.${id}`), { method: 'DELETE', headers: sbHeaders({ Prefer: 'return=minimal' }) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(500).json({ error: e?.message || 'Lỗi xoá' }); }
  return res.status(200).json({ ok: true });
}

export const config = { runtime: 'nodejs' };
