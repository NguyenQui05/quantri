export default function handler(req, res) {
  res.setHeader('Set-Cookie', 'hana_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  res.writeHead(302, { Location: '/login' });
  res.end();
}
export const config = { runtime: 'nodejs' };
