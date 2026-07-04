#!/bin/bash
# update-youtube.sh — Cập nhật danh sách video YouTube của @maiphuonghanapk
# Cách dùng: cd vào thư mục hana-dashboard rồi chạy ./update-youtube.sh
# Nhớ chạy mỗi khi chị Phương upload video mới muốn hiện lên web

set -e
cd "$(dirname "$0")"
export PATH="$HOME/node-portable/node-v20.18.0-darwin-arm64/bin:$PATH"

echo "📥 Đang lấy danh sách video từ YouTube..."
curl -sL "https://www.youtube.com/@maiphuonghanapk/videos" \
  -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
  -o /tmp/yt-videos.html

node <<'NODE'
const fs = require("fs");
const https = require("https");
const html = fs.readFileSync("/tmp/yt-videos.html","utf8");
const start = html.indexOf("ytInitialData = ");
if(start < 0){ console.log("❌ Không lấy được dữ liệu"); process.exit(1); }
const after = html.slice(start + 16);
let depth = 0, end = -1, inStr = false, esc = false;
for(let i=0; i<after.length; i++){
  const c = after[i];
  if(esc){ esc=false; continue; }
  if(c === "\\" && inStr){ esc=true; continue; }
  if(c === "\"") inStr = !inStr;
  if(inStr) continue;
  if(c === "{") depth++;
  if(c === "}"){ depth--; if(depth===0){ end = i+1; break; } }
}
const data = JSON.parse(after.slice(0, end));
const apiKey = html.match(/innertubeApiKey":"([^"]+)"/)?.[1];
const cliVer = html.match(/clientVersion":"([^"]+)"/)?.[1];

function findAll(o,key,r=[]){
  if(!o||typeof o!=="object")return r;
  if(Array.isArray(o)){ for(const x of o) findAll(x,key,r); return r; }
  for(const k in o){ if(k===key) r.push(o[k]); findAll(o[k],key,r); }
  return r;
}
function parseLockups(d){
  const lockups = findAll(d,"lockupViewModel");
  const list = [];
  for(const lv of lockups){
    const id = lv.contentId; if(!id || id.length !== 11) continue;
    const title = lv.metadata?.lockupMetadataViewModel?.title?.content || "";
    let length="";
    const overlays = lv.contentImage?.thumbnailViewModel?.overlays || [];
    for(const ov of overlays){
      for(const b of (ov.thumbnailBottomOverlayViewModel?.badges || [])){
        if(b.thumbnailBadgeViewModel?.text) length = b.thumbnailBadgeViewModel.text;
      }
    }
    const meta = lv.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
    let views="", published="";
    for(const row of meta){
      for(const p of (row.metadataParts || [])){
        const txt = p.text?.content || "";
        if(/lượt xem|views/i.test(txt)) views = txt;
        else if(/tháng|tuần|ngày|năm|giờ|phút|ago|day|week|month|year/i.test(txt)) published = txt;
      }
    }
    const sources = lv.contentImage?.thumbnailViewModel?.image?.sources || [];
    const thumb = sources[sources.length-1]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    list.push({id,title,length,views,published,thumb});
  }
  return list;
}

function fetchMore(token){
  return new Promise((resolve,reject)=>{
    const body = JSON.stringify({
      context:{client:{clientName:"WEB",clientVersion:cliVer,hl:"vi",gl:"VN"}},
      continuation: token
    });
    const req = https.request({
      hostname:"www.youtube.com",
      path:`/youtubei/v1/browse?key=${apiKey}&prettyPrint=false`,
      method:"POST",
      headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body),"User-Agent":"Mozilla/5.0"}
    },res=>{
      let data=""; res.on("data",d=>data+=d); res.on("end",()=>{ try{ resolve(JSON.parse(data));}catch(e){reject(e)}});
    });
    req.on("error",reject); req.write(body); req.end();
  });
}

(async()=>{
  let all = parseLockups(data);
  console.log(`  • Trang đầu: ${all.length} video`);
  let token = findAll(data,"continuationCommand").find(c=>c.token)?.token;
  let page = 1;
  while(token && page <= 15){
    const more = parseLockups(await fetchMore(token));
    const ids = new Set(all.map(v=>v.id));
    const newOnes = more.filter(v=>!ids.has(v.id));
    if(newOnes.length){ all = all.concat(newOnes); console.log(`  • Trang ${page+1}: +${newOnes.length} video (tổng ${all.length})`); }
    const nextToken = findAll(await fetchMore(token),"continuationCommand").find(c=>c.token)?.token;
    if(!nextToken || nextToken === token) break;
    token = nextToken; page++;
    await new Promise(r=>setTimeout(r, 300));
  }
  // Dedupe
  const seen = new Set(), uniq = [];
  for(const v of all){ if(!seen.has(v.id)){ seen.add(v.id); uniq.push(v); } }
  fs.writeFileSync("youtube.json", JSON.stringify({
    channelId:"UCsGaxE7JXHtMvJIFhz9ZHiA",
    handle:"@maiphuonghanapk",
    channelUrl:"https://www.youtube.com/@maiphuonghanapk",
    updatedAt:new Date().toISOString(),
    total:uniq.length,
    videos:uniq
  }, null, 2));
  console.log(`\n✓ Đã lưu ${uniq.length} video vào youtube.json`);
})().catch(e=>{ console.error("❌",e.message); process.exit(1); });
NODE

echo ""
echo "📤 Deploy lên Vercel..."
vercel deploy --prod --yes 2>&1 | tail -2
echo ""
echo "🎉 Xong! Khách truy cập phammaiphuong.vn sẽ thấy video mới ngay."
