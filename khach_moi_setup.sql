-- Chạy trong Supabase Dashboard > SQL Editor > New query > Run
-- Thêm cột cho bước "Khách Mới": tư vấn chốt dịch vụ + giá tiền sau khi khách đã đến,
-- trước khi ca chuyển sang Tour phẫu thuật để bác sĩ/KTV nhập thêm (upsell).
alter table appointments add column if not exists consulted boolean not null default false;
alter table appointments add column if not exists consult_service text;
alter table appointments add column if not exists consult_amount numeric default 0;
alter table appointments add column if not exists consulted_by text;
alter table appointments add column if not exists consulted_at timestamptz;

create index if not exists appointments_consulted_idx on appointments(status, consulted);
