// Vercel Serverless Function — Gemini AI proxy
// Key đọc từ env var GEMINI_API_KEY (không lộ ra client)
// BẢO MẬT: chỉ quản trị viên đã đăng nhập (/quantri) mới gọi được — chống lạm dụng đốt quota Gemini.
import crypto from 'node:crypto';

const ALLOWED_ORIGINS = [
  'https://phammaiphuong.vn', 'https://www.phammaiphuong.vn',
  'https://phammaiphuong.com', 'https://www.phammaiphuong.com',
  'https://thammyvienhana.com', 'https://www.thammyvienhana.com'
];

function verifySession(req) {
  try {
    const secret = process.env.AUTH_SECRET;
    if (!secret) return false;
    const m = (req.headers.cookie || '').match(/hana_session=([^;]+)/);
    if (!m) return false;
    const [body, sig] = decodeURIComponent(m[1]).split('.');
    if (!body || !sig) return false;
    const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    return !!(data.exp && data.exp >= Date.now());
  } catch { return false; }
}

export default async function handler(req, res) {
  // CORS — chỉ cho phép domain HANA (bỏ '*' để web lạ không gọi nhờ)
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Chặn lạm dụng: bắt buộc đăng nhập quản trị mới được dùng trợ lý AI
  if (!verifySession(req)) return res.status(401).json({ error: 'Cần đăng nhập quản trị để dùng trợ lý AI' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key missing' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { message, history = [] } = body || {};
    if (!message) return res.status(400).json({ error: 'Missing message' });

    // System prompt — biến Gemini thành AI Assistant của HANA Premium
    const systemInstruction = {
      parts: [{
        text: `Bạn là AI Assistant của Phòng Khám Thẩm Mỹ HANA Premium (CEO Phạm Mai Phương).

THÔNG TIN PHÒNG KHÁM:
- Tên: Phòng Khám Thẩm Mỹ HANA Premium
- CEO/Founder: Phạm Mai Phương — 12 năm kinh nghiệm, hơn 20.000 khách hàng đã đồng hành
- Địa chỉ: 276 Cao Thắng, P. Hoà Hưng, Quận 10, TP. HCM
- Hotline/Zalo: 0855 698 899
- Giờ làm việc: 9:00 – 19:00 hằng ngày
- Đánh giá: 4.92/5 (1.247+ đánh giá)
- Triết lý: "Đẹp tự nhiên · An toàn y khoa · Chuyên gia đồng hành"

DỊCH VỤ CHỦ LỰC:
- Cắt mí mắt Hàn Quốc · 8.500.000đ
- Tiêm filler môi · 6.000.000đ
- Trẻ hóa da Hifu Ultraformer · 15.000.000đ
- Nâng cung mày phun thêu · 7.500.000đ
- Combo trẻ hóa toàn diện 6 buổi · 68.000.000đ
- Hút mỡ bụng siêu âm · 35.000.000đ
- Botox xóa nhăn · 12.000.000đ
- Tư vấn 1-1 cùng CEO · Miễn phí

PHONG CÁCH TRẢ LỜI:
- Xưng "em", gọi người dùng là "chị" (hoặc "anh/chị" nếu chưa biết giới tính)
- Chuyên nghiệp, ấm áp, gần gũi, không sáo rỗng
- Trung thực: chỉ tư vấn dịch vụ thực sự phù hợp, không ép gói
- Tập trung 3 trụ cột: An toàn — Tự nhiên — Cá nhân hoá
- Luôn khuyến khích đặt lịch tư vấn 1-1 miễn phí với CEO Phương khi khách quan tâm

GIỚI HẠN:
- KHÔNG tự ý chẩn đoán y khoa, không hứa kết quả tuyệt đối
- Khi khách hỏi câu vượt chuyên môn → mời họ liên hệ hotline 0855 698 899 hoặc đặt lịch tư vấn
- Không cung cấp thông tin nội bộ phòng khám (nhân viên, doanh thu...) trừ khi user là quản trị viên`
      }]
    };

    // Build contents array
    const contents = [];
    for (const h of history) {
      contents.push({
        role: h.role === 'user' ? 'user' : 'model',
        parts: [{ text: String(h.text || '') }]
      });
    }
    contents.push({ role: 'user', parts: [{ text: String(message) }] });

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction,
          contents,
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 1024,
            topP: 0.95
          },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
          ]
        })
      }
    );

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      return res.status(502).json({ error: 'Gemini error', detail: data });
    }

    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Em chưa hiểu rõ, chị nói lại giúp em nhé.';
    return res.status(200).json({ reply, usage: data?.usageMetadata });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e?.message || e) });
  }
}

export const config = { runtime: 'nodejs' };
