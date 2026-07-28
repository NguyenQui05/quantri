-- Chạy trong Supabase Dashboard > SQL Editor > New query > Run
-- Công việc giao cho nhân viên. Chỉ "Toàn quyền kiểm soát" được tạo/xoá (chặn ở server),
-- mọi vai trò khác chỉ xem và tích hoàn thành việc.
create table if not exists staff_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  owner text,                 -- tên nhân viên phụ trách (khớp staff_members.full_name)
  staff_id uuid,
  priority text not null default 'TB' check (priority in ('Khẩn','Cao','TB','Thấp')),
  tag text,
  due timestamptz,
  done boolean not null default false,
  done_at timestamptz,
  done_by text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists staff_tasks_done_idx on staff_tasks(done, due);
create index if not exists staff_tasks_owner_idx on staff_tasks(owner);

alter table staff_tasks enable row level security;
