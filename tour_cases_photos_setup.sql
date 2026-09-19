-- Chạy 1 lần trong Supabase SQL Editor.
-- Thêm cột Tuổi + đường dẫn ảnh Before/After (trong Storage riêng tư) + Ghi chú cho Hậu chăm sóc.
-- (Code đã tự thích ứng nếu chưa chạy cột này — chạy sớm để dùng được đầy đủ tính năng.)
alter table public.tour_cases
  add column if not exists age integer,
  add column if not exists photo_before text,
  add column if not exists photo_after text,
  add column if not exists note text,
  add column if not exists birth_year integer,
  add column if not exists address text;
