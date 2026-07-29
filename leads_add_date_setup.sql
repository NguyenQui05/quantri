-- Chạy trong Supabase Dashboard > SQL Editor > New query > Run — TRƯỚC leads_import_t7_2026.sql
-- Thêm cột "Ngày thả số" (lead_date) vào bảng web_leads — ngày khách thực sự để lại số,
-- khác với created_at (ngày bản ghi được tạo trong hệ thống).
alter table web_leads add column if not exists lead_date date;

-- Lead cũ đã có sẵn trước khi có cột này -> gán theo ngày tạo bản ghi, không để trống.
update web_leads set lead_date = created_at::date where lead_date is null;

-- Từ giờ nếu không truyền ngày cụ thể (vd form nhập tay/landing) thì mặc định là hôm nay.
alter table web_leads alter column lead_date set default current_date;
alter table web_leads alter column lead_date set not null;

create index if not exists web_leads_date_idx on web_leads(lead_date desc);
