-- Chạy trong Supabase Dashboard > SQL Editor > New query > Run
-- Bảng sao lưu số liệu Marketing hằng ngày (nguồn nhập vẫn là Google Sheet).
create table if not exists marketing_daily (
  id uuid primary key default gen_random_uuid(),
  report_date date not null unique,   -- unique để đồng bộ lại không tạo bản ghi trùng
  spend numeric not null default 0,   -- chi phí quảng cáo
  mess integer not null default 0,    -- tin nhắn về
  sdt integer not null default 0,     -- số điện thoại thu được
  khach integer not null default 0,   -- khách đến phòng khám
  lead integer not null default 0,    -- lead thu được
  rev numeric not null default 0,     -- doanh số từ quảng cáo
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_daily_date_idx on marketing_daily(report_date desc);

-- Bật RLS, không tạo policy public — chỉ backend (SUPABASE_SERVICE_KEY) truy cập được.
alter table marketing_daily enable row level security;
