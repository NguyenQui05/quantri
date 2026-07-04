// Vercel Serverless Function — Nhận đăng ký từ form và gom về MỘT nơi tập trung.
// Hỗ trợ: chuyển tiếp tới Google Sheet (Apps Script Web App) qua env LEAD_SHEET_URL.
// Nếu chưa cấu hình LEAD_SHEET_URL, vẫn trả OK (không chặn khách) và ghi log để không mất lead.

const ALLOWED_ORIGINS = [
  'https://phammaiphuong.vn', 'https://www.phammaiphuong.vn',
  'https://phammaiphuong.com', 'https://www.phammaiphuong.com',
  'https://thammyvienhana.com', 'https://www.thammyvienhana.com'
];

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
      name, phone, service, time, source,
      at: new Date().toISOString(),
      ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(),
      ua: String(req.headers['user-agent'] || '').slice(0, 200)
    };

    const sheetUrl = process.env.LEAD_SHEET_URL;
    if (sheetUrl) {
      try {
        const r = await fetch(sheetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(lead)
        });
        if (!r.ok) console.error('Lead -> Sheet lỗi HTTP:', r.status);
      } catch (e) {
        console.error('Lead -> Sheet exception:', e?.message || e);
      }
    } else {
      // Chưa nối Google Sheet — ghi log để không mất lead trong giai đoạn nháp
      console.log('NEW LEAD (chưa nối Sheet):', JSON.stringify(lead));
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e?.message || e) });
  }
}

export const config = { runtime: 'nodejs' };
