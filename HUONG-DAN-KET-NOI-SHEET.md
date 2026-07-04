# Nối form đăng ký → Google Sheet (để HANA nhận MỌI lead)

Hiện form đã gửi lead về máy chủ (`/api/lead`). Để lead tự động chảy vào một
Google Sheet mà sếp/lễ tân xem được trên điện thoại, làm 3 bước (~5 phút):

## Bước 1 — Tạo Google Sheet
1. Vào https://sheets.new tạo bảng mới, đặt tên ví dụ "HANA — Lead đăng ký".
2. Đổi tên tab đầu thành **Leads**.
3. Dòng 1 ghi tiêu đề các cột:
   `Thời gian | Họ tên | SĐT | Dịch vụ | Giờ hẹn | Nguồn | IP`

## Bước 2 — Dán code nhận lead
1. Trong Sheet: menu **Tiện ích mở rộng (Extensions) → Apps Script**.
2. Xoá code mẫu, dán đoạn dưới đây, bấm **Lưu**:

```javascript
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Leads') || ss.getSheets()[0];
    var d = JSON.parse(e.postData.contents);
    sheet.appendRow([ new Date(), d.name||'', d.phone||'', d.service||'', d.time||'', d.source||'', d.ip||'' ]);
    return ContentService.createTextOutput(JSON.stringify({ok:true})).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ok:false,error:String(err)})).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
```

## Bước 3 — Xuất bản (Deploy) và lấy link
1. Bấm **Triển khai (Deploy) → Bản triển khai mới (New deployment)**.
2. Loại: **Ứng dụng web (Web app)**.
3. *Execute as:* **Me** — *Who has access:* **Anyone**.
4. Bấm **Deploy**, cấp quyền, rồi **copy URL** (dạng `https://script.google.com/macros/s/.../exec`).
5. **Gửi URL đó cho em.** Em đặt vào biến `LEAD_SHEET_URL` trên Vercel → từ đó mọi
   đăng ký tự động hiện trong Sheet, không cần thao tác gì thêm.

> Miễn phí hoàn toàn, không giới hạn thực tế với lượng khách của phòng khám,
> và sếp/lễ tân mở Sheet trên điện thoại là thấy danh sách khách mới nhất.
