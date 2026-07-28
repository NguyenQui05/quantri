-- Chạy trong Supabase Dashboard > SQL Editor > New query > Run
create table if not exists web_leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  service text,
  source text default 'web',
  status text not null default 'new' check (status in ('new','contacted','appointment','arrived')),
  note text,
  quote text,
  slot text,
  pkg text,
  problem text,
  goal text,
  age text,
  gender text,
  ip text,
  ua text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Nếu bảng đã tạo từ trước (chưa có cột gender) thì thêm vào, chạy lại vẫn an toàn.
alter table web_leads add column if not exists gender text;

create index if not exists web_leads_status_idx on web_leads(status);
create index if not exists web_leads_created_idx on web_leads(created_at desc);

-- Bật RLS, không tạo policy public — chỉ backend (SUPABASE_SERVICE_KEY) mới truy cập được, bỏ qua RLS.
alter table web_leads enable row level security;
