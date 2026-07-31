-- Chạy trong Supabase Dashboard > SQL Editor > New query > Run
-- Nối lịch hẹn với lead gốc bên Lead Mới: khi lễ tân xác nhận "Đã đến"
-- ở tab Lịch hẹn, lead tương ứng sẽ tự chuyển sang cột "Khách đã tới".
alter table appointments add column if not exists lead_id uuid;

create index if not exists appointments_lead_id_idx on appointments(lead_id);
