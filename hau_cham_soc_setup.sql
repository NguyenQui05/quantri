-- Chạy trong Supabase Dashboard > SQL Editor > New query > Run
-- Hậu chăm sóc lấy khách từ Tour phẫu thuật: sau khi bác sĩ nhập ca, khách tự vào
-- danh sách chăm sóc theo SOP (ngày 1, 3, 7, 14, 30, 90 kể từ ngày làm ca).
-- care_done ghi lại các mốc lễ tân đã xử lý: [{"day":1,"at":"...","by":"letan"}]
alter table tour_cases add column if not exists care_done jsonb not null default '[]'::jsonb;

create index if not exists tour_cases_case_date_idx on tour_cases(case_date desc);
