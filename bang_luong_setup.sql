-- Chạy trong Supabase Dashboard > SQL Editor > New query > Run
-- Nối Bảng lương với hồ sơ Nhân viên: mỗi dòng lương gắn với 1 nhân viên và giữ chức vụ.
-- Bác sĩ / Phụ phẫu sẽ tự lấy tiền up-sale từ Tour phẫu thuật để tính hoa hồng.
alter table payroll_entries add column if not exists staff_id uuid;
alter table payroll_entries add column if not exists role text;

create index if not exists payroll_entries_staff_idx on payroll_entries(staff_id);

-- Tra cứu ca tour theo bác sĩ / phụ phẫu trong tháng
create index if not exists tour_cases_doctor_idx on tour_cases(doctor);
create index if not exists tour_cases_assistant_idx on tour_cases(assistant);
