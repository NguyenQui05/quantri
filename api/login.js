import crypto from 'node:crypto';

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// So sánh chuỗi an toàn thời gian (pad cố định để timingSafeEqual không lỗi độ dài)
function eq(a, b) {
  const pad = s => Buffer.from(String(s == null ? '' : s).padEnd(72).slice(0, 72));
  try { return crypto.timingSafeEqual(pad(a), pad(b)); } catch { return false; }
}

// ===== Tài khoản nhân viên (cài trực tiếp ở máy chủ) =====
// Thêm/sửa/xoá tài khoản tại đây rồi deploy lại.
const DEFAULT_PASS = '12345678';
const STAFF = [
  { u: 'QT01', p: DEFAULT_PASS, role: 'Toàn quyền kiểm soát' },
  { u: 'QT02', p: DEFAULT_PASS, role: 'Toàn quyền kiểm soát' },
  { u: 'QT03', p: DEFAULT_PASS, role: 'Toàn quyền kiểm soát' },
  { u: 'LT01', p: DEFAULT_PASS, role: 'Lễ tân' },
  { u: 'LT02', p: DEFAULT_PASS, role: 'Lễ tân' },
  { u: 'BS01', p: DEFAULT_PASS, role: 'Bác sĩ' },
  { u: 'BS02', p: DEFAULT_PASS, role: 'Bác sĩ' },
  { u: 'KTV01', p: DEFAULT_PASS, role: 'Kỹ thuật viên' },
  { u: 'KTV02', p: DEFAULT_PASS, role: 'Kỹ thuật viên' },
  { u: 'KTV03', p: DEFAULT_PASS, role: 'Kỹ thuật viên' },
  { u: 'SALE01', p: DEFAULT_PASS, role: 'Sale' },
  { u: 'SALE02', p: DEFAULT_PASS, role: 'Sale' },
  { u: 'SALE03', p: DEFAULT_PASS, role: 'Sale' },
  { u: 'TV01', p: DEFAULT_PASS, role: 'Sale trực tiếp' },
  { u: 'TV02', p: DEFAULT_PASS, role: 'Sale trực tiếp' },
  { u: 'PP01', p: DEFAULT_PASS, role: 'Phụ phẫu' },
  { u: 'PP02', p: DEFAULT_PASS, role: 'Phụ phẫu' }
];

// Xác thực mật khẩu đã hash (scrypt) — dùng cho tài khoản tạo qua mục "Tài khoản" (Supabase)
function verifyHashed(password, stored) {
  try {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash) return false;
    const test = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex'), b = Buffer.from(test, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// Tìm tài khoản thật trong Supabase (tạo qua mục "Tài khoản"). Lỗi mạng -> coi như không có, không chặn login.
async function findDbAccount(username) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!base || !key) return null;
  try {
    const r = await fetch(`${base}/rest/v1/staff_accounts?username=eq.${encodeURIComponent(username)}&active=eq.true&select=username,password_hash,role&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { username, password } = body || {};
    if (!username || !password) return res.status(400).json({ error: 'Thiếu ID hoặc mật khẩu' });

    const secret = process.env.AUTH_SECRET;
    if (!secret) return res.status(500).json({ error: 'Server config error' });

    let role = null, matchedUser = null;

    // 1) Tài khoản thật tạo qua mục "Tài khoản" (Supabase, mật khẩu mã hoá)
    const dbAcc = await findDbAccount(String(username).trim());
    if (dbAcc && verifyHashed(password, dbAcc.password_hash)) { role = dbAcc.role; matchedUser = dbAcc.username; }

    // 2) Tài khoản nhân viên mặc định (cài sẵn ở máy chủ)
    if (!role) {
      const su = STAFF.find(x => x.u.toLowerCase() === String(username).trim().toLowerCase());
      if (su && eq(password, su.p)) { role = su.role; matchedUser = su.u; }
    }

    // 3) Tài khoản chủ (biến môi trường) — luôn Toàn quyền
    if (!role) {
      const expectedId = process.env.HANA_ADMIN_ID, expectedPass = process.env.HANA_ADMIN_PASS;
      if (expectedId && expectedPass && eq(username, expectedId) && eq(password, expectedPass)) {
        role = 'Toàn quyền kiểm soát'; matchedUser = String(username);
      }
    }

    if (!role) {
      await new Promise(r => setTimeout(r, 600)); // làm chậm dò mật khẩu
      return res.status(401).json({ error: 'Sai ID hoặc mật khẩu' });
    }

    const exp = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 ngày
    const token = sign({ u: matchedUser, role, exp }, secret);

    res.setHeader('Set-Cookie', [
      `hana_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7*24*60*60}`
    ]);
    return res.status(200).json({ ok: true, role, user: matchedUser });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e?.message || e) });
  }
}

export const config = { runtime: 'nodejs' };
