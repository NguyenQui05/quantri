// Vercel Serverless Function — Nhận đăng ký từ form landing, lưu thẳng vào Supabase bảng web_leads
// (hiển thị ở dashboard /quantri#leads — bảng "Lead Mới" 4 giai đoạn). Không chặn khách dù lưu lỗi.

const ALLOWED_ORIGINS = [
  'https://phammaiphuong.vn', 'https://www.phammaiphuong.vn',
  'https://phammaiphuong.com', 'https://www.phammaiphuong.com',
  'https://thammyvienhana.com', 'https://www.thammyvienhana.com'
];

function sb(path) {
  return `${process.env.SUPABASE_URL}/rest/v1/${path}`;
}
function sbHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

export default async function handler(req, res) {
  // CORS — domain HANA + link nháp *.vercel.app
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    let { name = '', phone = '', service = '', time = '', source = '' } = body;

    // Làm sạch + giới hạn độ dài (chống spam cơ bản)
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
      // Chưa cấu hình Supabase — ghi log để không mất lead, vẫn trả OK cho khách
      console.log('NEW LEAD (chưa cấu hình Supabase):', JSON.stringify(lead));
      return res.status(200).json({ ok: true });
    }

    const r = await fetch(sb('web_leads'), { method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(lead) });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      console.error('Lead -> Supabase lỗi:', e?.message || r.status, JSON.stringify(lead));
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e?.message || e) });
  }
}

export const config = { runtime: 'nodejs' };
