-- Chạy 1 lần trong Supabase SQL Editor.
-- Thêm cột Tuổi + đường dẫn ảnh Before/After (trong Storage riêng tư) cho Hậu chăm sóc.
alter table public.tour_cases
  add column if not exists age integer,
  add column if not exists photo_before text,
  add column if not exists photo_after text;
