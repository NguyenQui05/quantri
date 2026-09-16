// Dùng chung cho các API cần đọc Google Sheet RIÊNG TƯ bằng Service Account.
// Tên file bắt đầu bằng "_" nên Vercel không biến nó thành endpoint.
// Cần 2 biến môi trường: GOOGLE_SA_EMAIL và GOOGLE_SA_PRIVATE_KEY.
// Sheet chỉ cần chia sẻ quyền "Người xem" cho đúng email service account.
import crypto from 'node:crypto';

export function hasServiceAccount() {
  return !!(process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY);
}

// Token sống 1 tiếng — giữ lại trong bộ nhớ hàm để không phải ký JWT mỗi lần gọi.
let tokenCache = { value: null, exp: 0 };

export async function getGoogleAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.value && tokenCache.exp > now + 60) return tokenCache.value;

  const email = process.env.GOOGLE_SA_EMAIL;
  const key = String(process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
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

  tokenCache = { value: d.access_token, exp: now + (Number(d.expires_in) || 3600) };
  return d.access_token;
}

async function sheetsApi(path) {
  const token = await getGoogleAccessToken();
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || ('Sheets API lỗi ' + r.status));
  return d;
}

// Danh sách tab của 1 file sheet: [{ sheetId, title }]
export async function listTabs(spreadsheetId) {
  const d = await sheetsApi(`${spreadsheetId}?fields=sheets.properties(sheetId,title)`);
  return (d.sheets || []).map(s => s.properties).filter(Boolean);
}

// Sheets API v4 chỉ nhận TÊN tab, không nhận gid -> phải tra ngược khi chỉ có gid.
// Không truyền gì thì lấy tab đầu tiên (giống hành vi mặc định của gviz).
export async function resolveTabName(spreadsheetId, { tab, gid } = {}) {
  if (tab) return tab;
  const tabs = await listTabs(spreadsheetId);
  if (!tabs.length) throw new Error('File sheet không có tab nào');
  if (gid == null || gid === '') return tabs[0].title;
  const hit = tabs.find(t => String(t.sheetId) === String(gid));
  if (!hit) throw new Error(`Không tìm thấy tab có gid=${gid} (các tab hiện có: ${tabs.map(t => t.title).join(', ')})`);
  return hit.title;
}

// Đọc thô 1 tab -> mảng 2 chiều, CÒN NGUYÊN dòng tiêu đề. Dùng khi cần tự xử lý theo chỉ số cột.
export async function readSheetValues(spreadsheetId, tabName, renderOption = 'FORMATTED_VALUE') {
  const range = encodeURIComponent(`'${String(tabName).replace(/'/g, "''")}'`);
  const d = await sheetsApi(`${spreadsheetId}/values/${range}?valueRenderOption=${renderOption}`);
  return d.values || [];
}

// Vài file Sheet trong Drive thực ra vẫn ở dạng Office (.xlsx) chưa convert hẳn sang Google Sheets —
// dù mở/sửa bình thường trên giao diện, Sheets API v4 (values.get) TỪ CHỐI đọc loại này với lỗi
// "This operation is not supported for this document. The document must not be an Office file."
// gviz thì đọc được cả 2 dạng -> dùng làm phương án 2 khi gặp đúng lỗi này, vẫn kèm access token
// của Service Account để sheet không phải public (gviz chấp nhận Bearer token cho sheet riêng tư).
// QUAN TRỌNG: dùng GID khi có thể, KHÔNG dùng tên tab — đã kiểm chứng nhiều lần (kể cả trên chính
// file này) gviz tra theo TÊN TAB có thể âm thầm rớt về tab SAI khi file có nhiều tab tên gần giống
// nhau (không báo lỗi). Tra theo gid thì luôn ổn định.
async function readViaAuthenticatedGviz(spreadsheetId, { tab, gid } = {}, fallbackTabName) {
  const token = await getGoogleAccessToken();
  let u = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json`;
  if (gid != null && gid !== '') u += '&gid=' + encodeURIComponent(gid);
  else u += '&sheet=' + encodeURIComponent(tab || fallbackTabName || '');
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  const txt = await r.text();
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}') + 1;
  if (s < 0 || e <= s) throw new Error('gviz: không đọc được sheet (file vẫn ở dạng Office)');
  const json = JSON.parse(txt.slice(s, e));
  if (json.status === 'error') throw new Error((json.errors || []).map(x => x.detailed_message || x.message).join('; ') || 'gviz báo lỗi quyền truy cập');
  const t = json.table || {};
  const noLabel = (t.cols || []).every(c => !c.label);
  let cols = (t.cols || []).map(c => c.label || '');
  let rows = (t.rows || []).map(row => (row.c || []).map(c => (c == null ? '' : (c.f != null ? c.f : (c.v != null ? c.v : '')))));
  let raw = (t.rows || []).map(row => (row.c || []).map(c => (c == null ? null : c.v)));
  if (noLabel && rows.length) { cols = rows[0].map(x => String(x)); rows = rows.slice(1); raw = raw.slice(1); }
  return { cols, rows, raw, tab: fallbackTabName || tab || null };
}

// Đọc 1 tab, trả về đúng dạng mà trang quản trị đang dùng: { cols, rows, raw }
//   cols = tên cột (lấy từ dòng đầu)   rows = giá trị hiển thị   raw = giá trị gốc để tính toán
export async function readSheet(spreadsheetId, { tab, gid } = {}) {
  const title = await resolveTabName(spreadsheetId, { tab, gid });
  let fRows, rRows;
  try {
    // Gọi song song 2 kiểu: bản hiển thị (có định dạng) và bản gốc (số/ngày thô).
    [fRows, rRows] = await Promise.all([
      readSheetValues(spreadsheetId, title, 'FORMATTED_VALUE'),
      readSheetValues(spreadsheetId, title, 'UNFORMATTED_VALUE')
    ]);
  } catch (e) {
    if (/Office file/i.test(e?.message || '')) return await readViaAuthenticatedGviz(spreadsheetId, { tab, gid }, title);
    throw e;
  }
  if (!fRows.length) return { cols: [], rows: [], raw: [], tab: title };

  const cols = (fRows[0] || []).map(x => String(x == null ? '' : x));
  const width = cols.length;
  // Sheets API cắt bớt ô rỗng ở cuối dòng -> đệm lại cho đủ số cột, nếu không lệch chỉ số cột.
  const pad = (row, empty) => { const a = (row || []).slice(0, width); while (a.length < width) a.push(empty); return a; };

  return {
    cols,
    rows: fRows.slice(1).map(r => pad(r, '').map(x => (x == null ? '' : x))),
    raw: fRows.slice(1).map((_, i) => pad(rRows[i + 1], null).map(x => (x === '' ? null : x))),
    tab: title
  };
}
