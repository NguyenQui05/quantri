// Vercel Edge Middleware — bảo vệ /quantri/*
// Yêu cầu cookie 'hana_session' hợp lệ (HMAC verified) mới cho vào dashboard

export const config = {
  matcher: ['/quantri', '/quantri/:path*']
};

const enc = (s) => new TextEncoder().encode(s);
const b64url = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
const b64urlDec = (s) => { s = s.replace(/-/g,'+').replace(/_/g,'/'); while (s.length % 4) s += '='; const bin = atob(s); const buf = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) buf[i]=bin.charCodeAt(i); return buf; };

async function verify(token, secret) {
  try {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const key = await crypto.subtle.importKey('raw', enc(secret), { name:'HMAC', hash:'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlDec(sig), enc(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlDec(payload)));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

export default async function middleware(req) {
  const url = new URL(req.url);
  const cookie = req.headers.get('cookie') || '';
  const m = cookie.match(/hana_session=([^;]+)/);
  const token = m ? decodeURIComponent(m[1]) : null;
  const secret = process.env.AUTH_SECRET;

  // Fail-closed: nếu thiếu cấu hình bí mật, CHẶN truy cập thay vì dùng secret mặc định dễ đoán
  if (!secret) {
    return new Response('Cấu hình máy chủ chưa đầy đủ (AUTH_SECRET).', { status: 500 });
  }

  if (!token || !(await verify(token, secret))) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('next', url.pathname);
    return Response.redirect(loginUrl.toString(), 302);
  }
}
