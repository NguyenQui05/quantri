-- Chạy trong Supabase Dashboard > SQL Editor > New query > Run
-- Chấm công hằng ngày: mỗi nhân viên tự điền số "ca" đã làm trong ngày,
-- cuối tháng Bảng lương tự cộng dồn thành ngày công + số ca từng loại.
create table if not exists work_logs (
  id uuid primary key default gen_random_uuid(),
  staff_name text not null,
  log_date date not null,
  phu_thuong_ca int not null default 0,
  phu_cang_da_ca int not null default 0,
  lam_thuong_ca int not null default 0,
  lam_cang_da_ca int not null default 0,
  tiem_ca int not null default 0,
  csd_ca int not null default 0,
  note text,
  note2 text,
  logged_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(staff_name, log_date)
);

-- Nếu đã chạy bản trước (chưa có cột note2) thì lệnh dưới tự thêm, không lỗi nếu đã có.
alter table work_logs add column if not exists note2 text;

create index if not exists work_logs_staff_date_idx on work_logs(staff_name, log_date);
