-- =====================================================================
-- seed.sql — realistic DEMO data for ONE demo account
--
-- NOT a migration and never run automatically (config.toml: sql_paths = []).
-- Run it with `npm run db:seed`, which creates/updates the demo Auth user and
-- then executes this file in one transaction with:
--     select set_config('app.demo_email', '<demo email>', true);
--
-- Safety: refuses to touch any account whose raw_app_meta_data lacks
-- "demo_account": true — a real user's data can never be wiped by this file.
-- Re-runnable: the demo user's app data is deleted and rebuilt each time.
--
-- Persona: Nguyễn Minh Anh, backend engineer in Ho Chi Minh City.
-- ~92 days of history ending "today" (Asia/Ho_Chi_Minh), deterministic
-- (setseed), internally consistent:
--   * time entries never overlap and fall before each task's completion;
--   * purchased shopping items are linked to the expense that paid for them;
--   * the "tasks completed" KPI is computed from the seeded tasks;
--   * the activity feed is rebuilt with the real timestamps of each event.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Session-local helpers (pg_temp: dropped automatically at disconnect)
-- ---------------------------------------------------------------------

-- local wall-clock time in Ho Chi Minh City -> timestamptz
create or replace function pg_temp.ts(p_day date, p_time time)
returns timestamptz language sql as $$
  select (p_day + p_time) at time zone 'Asia/Ho_Chi_Minh';
$$;

-- random element of an array
create or replace function pg_temp.pick(p anyarray)
returns anyelement language sql as $$
  select p[1 + floor(random() * array_length(p, 1))::int];
$$;

-- random integer in [lo, hi] rounded to `step`
create or replace function pg_temp.rnd(lo int, hi int, step int default 1)
returns int language sql as $$
  select lo + floor(random() * ((hi - lo) / step + 1))::int * step;
$$;

-- random minutes as an interval in [0, n]
create or replace function pg_temp.jitter(n int)
returns interval language sql as $$
  select make_interval(mins => floor(random() * (n + 1))::int);
$$;

-- one expense at a local time; skipped (returns null) if that moment is in the future
create or replace function pg_temp.exp(
  p_uid uuid, p_cat uuid, p_amount numeric, p_desc text, p_day date, p_time time,
  p_method text, p_note text default null)
returns uuid language plpgsql as $$
declare
  v_ts timestamptz := pg_temp.ts(p_day, p_time) + pg_temp.jitter(20);
  v_id uuid;
begin
  if v_ts > now() then
    return null;
  end if;
  insert into public.expenses (user_id, amount, category_id, description, spent_on, payment_method, note, created_at, updated_at)
  values (p_uid, p_amount, p_cat, p_desc, p_day, p_method, p_note, v_ts, v_ts)
  returning id into v_id;
  return v_id;
end;
$$;


do $seed$
declare
  v_email  text := nullif(current_setting('app.demo_email', true), '');
  v_uid    uuid;
  v_demo   boolean;
  v_tz     constant text := 'Asia/Ho_Chi_Minh';
  v_today  date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_from   date;
  v_m0     date;   -- first day of current month
  v_m1     date;   -- previous months
  v_m2     date;
  v_m3     date;

  -- expense categories
  c_food uuid; c_move uuid; c_home uuid; c_shop uuid; c_fun uuid;
  c_tech uuid; c_learn uuid; c_health uuid; c_other uuid; c_family uuid;

  d        date;
  dow      int;
  dom      int;
  r        record;
  v_kpi    uuid;
  v_total  int;
  v_len    int;
  v_day    date;
  v_slot   int;
  v_start  timestamptz;
  v_endday date;
  v_tries  int;
  v_val    numeric;
  v_exp    uuid;
  -- non-overlapping daily time slots: start time + capacity (minutes)
  slot_start constant time[] := array['09:20', '13:30', '16:00', '20:30']::time[];
  slot_cap   constant int[]  := array[150, 140, 105, 90];
begin
  -- ---------------- guard ----------------
  if v_email is null then
    raise exception 'seed.sql: set app.demo_email first (use npm run db:seed)';
  end if;
  select u.id, coalesce((u.raw_app_meta_data ->> 'demo_account')::boolean, false)
    into v_uid, v_demo
    from auth.users u where lower(u.email) = lower(v_email);
  if v_uid is null then
    raise exception 'seed.sql: no auth user %', v_email;
  end if;
  if not v_demo then
    raise exception 'seed.sql: % is not flagged demo_account — refusing to overwrite a real account', v_email;
  end if;

  perform setseed(0.2026);
  v_from := v_today - 91;
  v_m0 := date_trunc('month', v_today)::date;
  v_m1 := (v_m0 - interval '1 month')::date;
  v_m2 := (v_m0 - interval '2 months')::date;
  v_m3 := (v_m0 - interval '3 months')::date;

  -- Triggers that would overwrite historical values. Re-enabled at the end;
  -- the whole run is one transaction, so a failure restores them too.
  alter table public.tasks          disable trigger trg_tasks_completed_at;
  alter table public.tasks          disable trigger trg_tasks_updated_at;
  alter table public.tasks          disable trigger trg_tasks_activity;
  alter table public.kpis           disable trigger trg_kpis_updated_at;
  alter table public.expenses       disable trigger trg_expenses_activity;
  alter table public.shopping_items disable trigger trg_shopping_activity;
  alter table public.kpi_records    disable trigger trg_kpi_records_activity;

  -- ---------------- reset the demo account ----------------
  delete from public.shopping_items where user_id = v_uid;
  delete from public.expenses       where user_id = v_uid;
  delete from public.budgets        where user_id = v_uid;
  delete from public.time_entries   where user_id = v_uid;
  delete from public.kpis           where user_id = v_uid;   -- cascades kpi_records
  delete from public.tasks          where user_id = v_uid;
  delete from public.activity_logs  where user_id = v_uid;
  if to_regclass('public.notes') is not null then           -- notes arrive with migration 000700
    delete from public.notes where user_id = v_uid;
  end if;
  delete from public.categories     where user_id = v_uid and not is_default;
  perform public.seed_default_categories(v_uid);

  update public.profiles
     set display_name = 'Nguyễn Minh Anh', currency = 'VND', locale = 'vi-VN',
         timezone = v_tz, week_starts_on = 1, theme = 'system',
         created_at = (select u.created_at from auth.users u where u.id = v_uid)
   where id = v_uid;

  -- custom categories (show that users can add their own)
  insert into public.categories (user_id, kind, name, color, sort_order, is_default) values
    (v_uid, 'task',    'Dự án phụ', '#0E9F6E', 35, false),
    (v_uid, 'expense', 'Gia đình',  '#B5651D', 85, false);

  select id into c_food   from public.categories where user_id = v_uid and kind = 'expense' and name = 'Ăn uống';
  select id into c_move   from public.categories where user_id = v_uid and kind = 'expense' and name = 'Đi lại';
  select id into c_home   from public.categories where user_id = v_uid and kind = 'expense' and name = 'Nhà ở';
  select id into c_shop   from public.categories where user_id = v_uid and kind = 'expense' and name = 'Mua sắm';
  select id into c_fun    from public.categories where user_id = v_uid and kind = 'expense' and name = 'Giải trí';
  select id into c_tech   from public.categories where user_id = v_uid and kind = 'expense' and name = 'Công nghệ';
  select id into c_learn  from public.categories where user_id = v_uid and kind = 'expense' and name = 'Học tập';
  select id into c_health from public.categories where user_id = v_uid and kind = 'expense' and name = 'Sức khỏe';
  select id into c_other  from public.categories where user_id = v_uid and kind = 'expense' and name = 'Khác';
  select id into c_family from public.categories where user_id = v_uid and kind = 'expense' and name = 'Gia đình';


  -- =================================================================
  -- 1. TASKS   (offsets in days relative to today: cr = created,
  --             due = due date, done = completed day)
  -- =================================================================
  insert into public.tasks (user_id, title, description, status, priority, category_id, tags,
                            due_date, estimated_minutes, created_at, updated_at, completed_at)
  select v_uid, t.title, t.descr, t.status, t.prio, c.id, t.tags,
         v_today + t.due, t.est,
         least(pg_temp.ts(v_today + t.cr, '08:00') + pg_temp.jitter(75), now() - interval '10 minutes'),
         least(pg_temp.ts(v_today + t.cr, '08:00') + pg_temp.jitter(75), now() - interval '10 minutes'),
         case when t.status = 'completed' then
           pg_temp.ts(v_today + t.done, case when t.cat = 'Công việc' then time '17:50' else time '22:05' end)
           + pg_temp.jitter(35)
         end
    from (values
      -- Công việc
      ('Thiết kế schema cơ sở dữ liệu module Đơn hàng',
       'Chuẩn hóa bảng orders/order_items, thêm ràng buộc trạng thái và index cho truy vấn theo khách hàng.',
       'Công việc', 'high', 'completed', -58, -52, -53, 240, '{backend,database}'::text[]),
      ('Code review PR #412 – tích hợp cổng thanh toán VNPay', null,
       'Công việc', 'medium', 'completed', -50, -49, -49, 90, '{review,payment}'),
      ('Viết API xuất báo cáo doanh thu theo tháng',
       'Endpoint /reports/revenue hỗ trợ lọc theo chi nhánh, xuất CSV và Excel.',
       'Công việc', 'medium', 'completed', -47, -40, -41, 480, '{backend,api}'),
      ('Fix lỗi timeout khi đồng bộ dữ liệu kho',
       'Job đồng bộ chạy quá 30s khi kho > 50k SKU. Chuyển sang batch 1.000 bản ghi + retry.',
       'Công việc', 'urgent', 'completed', -44, -43, -43, 180, '{bugfix,hotfix}'),
      ('Chuẩn bị slide demo Sprint 18', null,
       'Công việc', 'medium', 'completed', -36, -35, -35, 120, '{sprint,demo}'),
      ('Viết unit test cho service tính phí vận chuyển',
       'Mục tiêu coverage ≥ 85% cho các rule theo vùng, khối lượng và khuyến mãi freeship.',
       'Công việc', 'medium', 'completed', -33, -28, -29, 300, '{testing}'),
      ('Tối ưu truy vấn danh sách đơn hàng (index + phân trang)',
       'P95 hiện tại 1,8s. Dùng keyset pagination và composite index (customer_id, created_at).',
       'Công việc', 'high', 'completed', -30, -24, -25, 360, '{performance,database}'),
      ('Họp kế hoạch Sprint 19 với team Product', null,
       'Công việc', 'medium', 'completed', -22, -21, -21, 60, '{meeting,sprint}'),
      ('Migrate service thông báo sang hàng đợi RabbitMQ',
       'Tách gửi email/SMS khỏi request chính, đảm bảo at-least-once và idempotent consumer.',
       'Công việc', 'high', 'completed', -21, -12, -13, 600, '{backend,infra}'),
      ('Viết tài liệu API cho đối tác (OpenAPI 3.1)', null,
       'Công việc', 'medium', 'completed', -16, -9, -8, 240, '{docs,api}'),
      ('Review thiết kế UI màn hình Dashboard mới', null,
       'Công việc', 'low', 'completed', -10, -7, -7, 60, '{review,ui}'),
      ('Điều tra memory leak trên worker xử lý ảnh',
       'RSS tăng ~200MB/giờ. Nghi ngờ buffer sharp không được giải phóng khi job lỗi.',
       'Công việc', 'urgent', 'completed', -6, -4, -4, 300, '{bugfix,performance}'),
      ('Triển khai CI/CD cho môi trường staging',
       'GitHub Actions: lint → test → build image → deploy staging, có bước approve thủ công.',
       'Công việc', 'high', 'in_progress', -5, 2, null, 420, '{devops,ci}'),
      ('Refactor module xác thực sang JWT + refresh token',
       'Access token 15 phút, refresh token xoay vòng, thu hồi khi đổi mật khẩu.',
       'Công việc', 'high', 'in_progress', -8, 5, null, 540, '{backend,security}'),
      ('Chuẩn bị báo cáo OKR quý III', null,
       'Công việc', 'medium', 'in_progress', -3, 1, null, 180, '{okr,report}'),
      ('Code review PR #458 – module khuyến mãi', null,
       'Công việc', 'medium', 'todo', -1, 1, null, 60, '{review}'),
      ('Viết đặc tả kỹ thuật tính năng xuất hóa đơn điện tử',
       'Tích hợp nhà cung cấp HĐĐT theo Nghị định 123, xử lý ký số và gửi email cho khách.',
       'Công việc', 'high', 'todo', -2, 6, null, 300, '{spec,invoice}'),
      ('Lên kế hoạch Sprint 21', null,
       'Công việc', 'medium', 'todo', 0, 4, null, 90, '{sprint}'),
      ('Cập nhật thư viện phụ thuộc, vá lỗ hổng bảo mật',
       'npm audit báo 3 lỗ hổng mức high (axios, jsonwebtoken).',
       'Công việc', 'high', 'todo', -4, -1, null, 120, '{security}'),
      ('Phỏng vấn ứng viên Backend Developer', null,
       'Công việc', 'medium', 'todo', -2, 3, null, 90, '{hiring}'),
      ('Thiết lập cảnh báo Grafana cho API thanh toán',
       'Tạm hoãn — team SRE sẽ làm chung trong dự án observability.',
       'Công việc', 'low', 'cancelled', -40, -30, null, 120, '{monitoring}'),
      -- Học tập
      ('Hoàn thành khóa System Design Fundamentals – chương 4', null,
       'Học tập', 'medium', 'completed', -55, -45, -45, 300, '{course}'),
      ('Ôn luyện đề AWS Solutions Architect – Associate',
       'Làm 4 bộ đề thử của Tutorials Dojo, mục tiêu ≥ 80% trước ngày thi.',
       'Học tập', 'high', 'completed', -40, -20, -19, 900, '{aws,certificate}'),
      ('Đọc Designing Data-Intensive Applications – chương 5-6', null,
       'Học tập', 'medium', 'completed', -26, -15, -15, 360, '{reading}'),
      ('Luyện IELTS Speaking – Part 2 chủ đề công việc', null,
       'Học tập', 'medium', 'in_progress', -9, 7, null, 240, '{english}'),
      ('Viết blog: Kinh nghiệm tối ưu PostgreSQL',
       'Tổng hợp từ đợt tối ưu truy vấn đơn hàng: EXPLAIN ANALYZE, index, keyset pagination.',
       'Học tập', 'low', 'todo', -6, 12, null, 180, '{blog,database}'),
      ('Học Kubernetes cơ bản – Pods, Services, Deployments', null,
       'Học tập', 'medium', 'todo', -3, 14, null, 600, '{k8s,devops}'),
      -- Cá nhân
      ('Gia hạn bảo hiểm xe máy', null,
       'Cá nhân', 'medium', 'completed', -48, -45, -46, 30, '{}'),
      ('Đặt vé máy bay về quê dịp lễ', null,
       'Cá nhân', 'high', 'completed', -74, -68, -69, 30, '{travel}'),
      ('Sinh nhật mẹ – mua quà và đặt bàn nhà hàng', null,
       'Cá nhân', 'high', 'completed', -27, -23, -23, 90, '{family}'),
      ('Dọn dẹp và sắp xếp lại góc làm việc', null,
       'Cá nhân', 'low', 'completed', -18, null, -14, 120, '{}'),
      ('Thanh toán hóa đơn điện, nước, internet', null,
       'Cá nhân', 'high', 'todo', -1, 3, null, 20, '{bills}'),
      ('Lên kế hoạch du lịch Đà Lạt cuối năm',
       '3 ngày 2 đêm, dự kiến ngân sách 6 triệu, đi cùng nhóm bạn đại học.',
       'Cá nhân', 'low', 'todo', -7, 30, null, 90, '{travel}'),
      ('Làm lại CCCD gắn chip cho bố', 'Đã làm được qua dịch vụ công trực tuyến.',
       'Cá nhân', 'medium', 'cancelled', -35, -20, null, 60, '{family}'),
      -- Sức khỏe
      ('Khám sức khỏe định kỳ', null,
       'Sức khỏe', 'high', 'completed', -66, -62, -62, 180, '{health}'),
      ('Đăng ký lớp yoga buổi tối', null,
       'Sức khỏe', 'low', 'completed', -20, null, -17, 30, '{}'),
      ('Chạy bộ 5km sáng thứ Bảy', null,
       'Sức khỏe', 'medium', 'completed', -12, -11, -11, 45, '{running}'),
      ('Chạy bộ 10km – chuẩn bị giải chạy tháng 11', null,
       'Sức khỏe', 'medium', 'todo', -2, 2, null, 75, '{running}'),
      ('Lấy kết quả xét nghiệm máu', null,
       'Sức khỏe', 'medium', 'todo', -5, -2, null, 30, '{health}'),
      -- Dự án phụ
      ('Side project: dựng khung ứng dụng Vite + Supabase', null,
       'Dự án phụ', 'medium', 'completed', -31, null, -27, 240, '{side-project}'),
      ('Side project: thiết kế database và RLS', 'Composite FK để chặn tham chiếu chéo giữa các user.',
       'Dự án phụ', 'high', 'completed', -26, -20, -20, 300, '{side-project,database}'),
      ('Side project: màn hình Dashboard và biểu đồ', null,
       'Dự án phụ', 'medium', 'in_progress', -12, 8, null, 480, '{side-project,ui}'),
      ('Side project: triển khai GitHub Pages + CI', null,
       'Dự án phụ', 'low', 'todo', -4, 15, null, 120, '{side-project,devops}')
    ) as t(title, descr, cat, prio, status, cr, due, done, est, tags)
    join public.categories c on c.user_id = v_uid and c.kind = 'task' and c.name = t.cat;


  -- =================================================================
  -- 2. TIME ENTRIES — non-overlapping slots per day
  --    work tasks: weekday slots 1-3; others: evening slot 4, or
  --    slots 1-2 at weekends. Never after the task's completion.
  -- =================================================================
  drop table if exists pg_temp.seed_slots;
  create temp table seed_slots (day date, slot int, primary key (day, slot)) on commit drop;

  -- daily stand-up and weekly 1:1 (not tied to a task)
  for d in select generate_series(v_today - 63, v_today, interval '1 day')::date loop
    dow := extract(isodow from d);
    if dow <= 5 and pg_temp.ts(d, '09:15') < now() then
      insert into public.time_entries (user_id, description, started_at, ended_at, source, created_at, updated_at)
      values (v_uid, 'Daily stand-up', pg_temp.ts(d, '09:00'), pg_temp.ts(d, '09:15'), 'timer',
              pg_temp.ts(d, '09:00'), pg_temp.ts(d, '09:15'));
    end if;
    if dow = 4 and pg_temp.ts(d, '18:20') < now() then
      insert into public.time_entries (user_id, description, started_at, ended_at, source, created_at, updated_at)
      values (v_uid, 'Họp 1:1 với Engineering Manager', pg_temp.ts(d, '17:50'), pg_temp.ts(d, '18:20'), 'timer',
              pg_temp.ts(d, '17:50'), pg_temp.ts(d, '18:20'));
    end if;
  end loop;

  for r in
    select t.id, t.status, t.estimated_minutes, t.created_at, t.completed_at, c.name as cat
      from public.tasks t join public.categories c on c.id = t.category_id
     where t.user_id = v_uid and t.status in ('completed', 'in_progress')
     order by t.created_at
  loop
    v_total := round(coalesce(r.estimated_minutes, 60) *
               case when r.status = 'completed' then 0.8 + random() * 0.45 else 0.3 + random() * 0.3 end);
    v_endday := case when r.status = 'completed' then (r.completed_at at time zone v_tz)::date else v_today - 1 end;
    v_tries := 0;
    while v_total >= 15 and v_tries < 80 loop
      v_tries := v_tries + 1;
      v_day := (r.created_at at time zone v_tz)::date
               + floor(random() * (greatest(v_endday - (r.created_at at time zone v_tz)::date, 0) + 1))::int;
      dow := extract(isodow from v_day);
      if r.cat = 'Công việc' then
        continue when dow > 5;
        v_slot := pg_temp.rnd(1, 3);
      elsif dow > 5 then
        v_slot := pg_temp.pick(array[1, 2, 4]);
      else
        v_slot := 4;
      end if;
      v_start := pg_temp.ts(v_day, slot_start[v_slot]) + pg_temp.jitter(10);
      continue when v_start < r.created_at;                                   -- not before the task existed
      continue when exists (select 1 from seed_slots s where s.day = v_day and s.slot = v_slot);
      v_len := least(v_total, slot_cap[v_slot] - 12, pg_temp.rnd(45, 120, 5));
      continue when v_start + make_interval(mins => v_len) > coalesce(r.completed_at, now());

      insert into seed_slots values (v_day, v_slot);
      insert into public.time_entries (user_id, task_id, started_at, ended_at, source, created_at, updated_at, description)
      values (v_uid, r.id, v_start, v_start + make_interval(mins => v_len),
              case when random() < 0.15 then 'manual' else 'timer' end,
              v_start, v_start + make_interval(mins => v_len),
              case when random() < 0.2 then pg_temp.pick(array['Phân tích yêu cầu', 'Viết code', 'Kiểm thử', 'Sửa theo review', 'Tài liệu']) end);
      v_total := v_total - v_len;
    end loop;
  end loop;


  -- =================================================================
  -- 3. EXPENSES — daily life in HCMC over ~3 months
  -- =================================================================
  for d in select generate_series(v_from, v_today, interval '1 day')::date loop
    dow := extract(isodow from d);
    dom := extract(day from d);

    -- monthly fixed costs
    if dom = 1 then
      perform pg_temp.exp(v_uid, c_family, 2000000, 'Gửi tiền biếu bố mẹ tháng ' || to_char(d, 'MM/YYYY'), d, '08:10', 'bank');
      perform pg_temp.exp(v_uid, c_move,    150000, 'Vé gửi xe tháng ' || to_char(d, 'MM/YYYY'), d, '08:40', 'cash');
      perform pg_temp.exp(v_uid, c_tech,    120000, 'Gói cước 4G Viettel', d, '09:30', 'e_wallet');
    end if;
    if dom = 2 then
      perform pg_temp.exp(v_uid, c_health, 600000, 'Phí tập gym tháng ' || to_char(d, 'MM/YYYY'), d, '18:30', 'bank');
    end if;
    if dom = 3 then
      perform pg_temp.exp(v_uid, c_tech, 520000, 'ChatGPT Plus', d, '07:05', 'credit_card');
    end if;
    if dom = 5 then
      perform pg_temp.exp(v_uid, c_home, 6500000, 'Tiền thuê căn hộ tháng ' || to_char(d, 'MM/YYYY'), d, '10:00', 'bank');
      perform pg_temp.exp(v_uid, c_home,  350000, 'Phí quản lý chung cư', d, '10:05', 'bank');
    end if;
    if dom = 8 then
      perform pg_temp.exp(v_uid, c_fun, 260000, 'Netflix Premium', d, '07:00', 'credit_card');
    end if;
    if dom = 10 then
      perform pg_temp.exp(v_uid, c_home, pg_temp.rnd(480000, 860000, 1000),
                          'Tiền điện tháng ' || to_char(d - 15, 'MM/YYYY'), d, '20:15', 'bank');
      perform pg_temp.exp(v_uid, c_home, pg_temp.rnd(110000, 160000, 1000),
                          'Tiền nước tháng ' || to_char(d - 15, 'MM/YYYY'), d, '20:20', 'bank');
    end if;
    if dom = 12 then
      perform pg_temp.exp(v_uid, c_tech, 59000, 'Spotify Premium', d, '07:00', 'credit_card');
    end if;
    if dom = 15 then
      perform pg_temp.exp(v_uid, c_home, 220000, 'Internet FPT 150Mbps', d, '09:00', 'bank');
    end if;
    if dom = 18 then
      perform pg_temp.exp(v_uid, c_learn, 450000, 'Gói luyện IELTS online tháng ' || to_char(d, 'MM/YYYY'), d, '21:00', 'credit_card');
    end if;
    if dom = 20 then
      perform pg_temp.exp(v_uid, c_tech, 69000, 'iCloud+ 200GB', d, '07:00', 'credit_card');
      perform pg_temp.exp(v_uid, c_shop, pg_temp.rnd(160000, 340000, 1000), 'Đồ dùng cá nhân – Guardian', d, '19:40', 'e_wallet');
    end if;

    -- breakfast
    if random() < 0.6 then
      perform pg_temp.exp(v_uid, c_food, pg_temp.rnd(30000, 50000, 5000),
        pg_temp.pick(array['Phở bò', 'Bánh mì ốp la', 'Bún bò Huế', 'Xôi gà', 'Hủ tiếu Nam Vang', 'Cơm tấm sườn bì', 'Bánh cuốn']),
        d, '07:20', pg_temp.pick(array['cash', 'cash', 'e_wallet']));
    end if;
    -- lunch (workdays) / weekend brunch
    if dow <= 5 then
      if random() < 0.95 then
        perform pg_temp.exp(v_uid, c_food, pg_temp.rnd(45000, 75000, 5000),
          pg_temp.pick(array['Cơm trưa văn phòng', 'Bún chả Hà Nội', 'Cơm gà xối mỡ', 'Mì Quảng', 'Bánh canh cua', 'Cơm văn phòng – ShopeeFood', 'Bún thịt nướng']),
          d, '12:05', 'e_wallet');
      end if;
    elsif random() < 0.35 then
      perform pg_temp.exp(v_uid, c_food, pg_temp.rnd(90000, 180000, 10000),
        pg_temp.pick(array['Brunch cuối tuần', 'Dimsum cùng bạn', 'Cơm niêu']), d, '11:30', 'e_wallet');
    end if;
    -- coffee
    if random() < 0.35 then
      perform pg_temp.exp(v_uid, c_food,
        pg_temp.pick(array[29000, 35000, 49000, 55000, 59000, 65000]),
        pg_temp.pick(array['Highlands Coffee', 'The Coffee House', 'Phúc Long', 'Cà phê sữa đá', 'Katinat']),
        d, '14:30', 'e_wallet');
    end if;
    -- dinner
    if dow >= 6 and random() < 0.45 then
      perform pg_temp.exp(v_uid, c_food, pg_temp.rnd(150000, 350000, 10000),
        pg_temp.pick(array['Lẩu Thái với bạn bè', 'Ăn tối cùng gia đình', 'Nướng Hàn Quốc', 'Ốc và hải sản Quận 4', 'Pizza 4P''s']),
        d, '19:10', pg_temp.pick(array['credit_card', 'e_wallet', 'bank']));
    elsif dow <= 5 and random() < 0.2 then
      perform pg_temp.exp(v_uid, c_food, pg_temp.rnd(45000, 85000, 5000),
        pg_temp.pick(array['Cơm tối', 'Bún riêu', 'Mì xào bò', 'Cháo lòng']), d, '19:20', 'cash');
    end if;
    -- weekly groceries
    if dow = 7 then
      perform pg_temp.exp(v_uid, c_food, pg_temp.rnd(250000, 420000, 1000),
        pg_temp.pick(array['Đi chợ Bách Hóa Xanh', 'Siêu thị Co.opmart', 'Đi chợ WinMart']), d, '09:30',
        pg_temp.pick(array['bank', 'e_wallet']));
    end if;

    -- transport
    if dow <= 5 and random() < 0.35 then
      perform pg_temp.exp(v_uid, c_move, pg_temp.rnd(35000, 120000, 1000),
        pg_temp.pick(array['Grab Bike đi gặp khách hàng', 'Grab Car về nhà (trời mưa)', 'Be Bike', 'Xanh SM Taxi']),
        d, '17:45', 'e_wallet');
    end if;
    if (d - v_from) % 6 = 2 then
      perform pg_temp.exp(v_uid, c_move, pg_temp.rnd(80000, 110000, 1000), 'Đổ xăng', d, '07:45', 'cash');
    end if;

    -- entertainment
    if dow = 6 and random() < 0.45 then
      perform pg_temp.exp(v_uid, c_fun, pg_temp.pick(array[220000, 240000, 300000, 350000]),
        pg_temp.pick(array['Xem phim CGV (2 vé)', 'Karaoke với team', 'Board game cafe', 'Bowling cùng bạn']),
        d, '20:00', pg_temp.pick(array['e_wallet', 'credit_card']));
    end if;

    -- health
    if random() < 0.04 then
      perform pg_temp.exp(v_uid, c_health, pg_temp.rnd(85000, 260000, 5000),
        pg_temp.pick(array['Nhà thuốc Long Châu', 'Vitamin C + kẽm', 'Khẩu trang và nước muối']), d, '18:50', 'cash');
    end if;

    -- occasional shopping / other
    if random() < 0.03 then
      perform pg_temp.exp(v_uid, c_shop, pg_temp.rnd(199000, 690000, 1000),
        pg_temp.pick(array['Áo sơ mi Uniqlo', 'Quần tây công sở', 'Đồ gia dụng Shopee', 'Ốp lưng và cáp sạc']),
        d, '21:10', pg_temp.pick(array['credit_card', 'e_wallet']));
    end if;
  end loop;

  -- one-off expenses tied to tasks / life events
  perform pg_temp.exp(v_uid, c_health, 1850000, 'Khám sức khỏe tổng quát – BV Đại học Y Dược', v_today - 62, '10:30', 'credit_card');
  perform pg_temp.exp(v_uid, c_move,   2380000, 'Vé máy bay khứ hồi SGN – HAN (lễ 2/9)', v_today - 69, '21:15', 'credit_card');
  perform pg_temp.exp(v_uid, c_other,   480000, 'Gia hạn bảo hiểm xe máy', v_today - 46, '12:30', 'e_wallet');
  perform pg_temp.exp(v_uid, c_learn,  3850000, 'Lệ phí thi AWS Solutions Architect – Associate', v_today - 30, '20:40', 'credit_card');
  perform pg_temp.exp(v_uid, c_learn,   299000, 'Khóa học Udemy: Kubernetes for Developers', v_today - 3, '22:10', 'credit_card');
  perform pg_temp.exp(v_uid, c_family, 1500000, 'Quà sinh nhật mẹ', v_today - 24, '18:30', 'credit_card');
  perform pg_temp.exp(v_uid, c_family, 1650000, 'Tiệc sinh nhật mẹ – nhà hàng', v_today - 23, '20:30', 'credit_card');
  perform pg_temp.exp(v_uid, c_other,   500000, 'Mừng cưới đồng nghiệp', v_today - 33, '17:00', 'cash');
  perform pg_temp.exp(v_uid, c_other,   200000, 'Ủng hộ quỹ từ thiện vùng lũ', v_today - 15, '21:00', 'bank');
  perform pg_temp.exp(v_uid, c_fun,    1200000, 'Vé concert Anh Trai Say Hi', v_today - 52, '13:00', 'credit_card');
  perform pg_temp.exp(v_uid, c_health,  350000, 'Đăng ký lớp yoga – tháng đầu', v_today - 17, '19:00', 'bank');


  -- =================================================================
  -- 4. BUDGETS — carry-forward history
  --    (raised food budget last month; overall budget raised this month)
  -- =================================================================
  insert into public.budgets (user_id, effective_month, category_id, amount, created_at, updated_at) values
    (v_uid, v_m3, null,     25000000, pg_temp.ts(v_m3, '09:00'), pg_temp.ts(v_m3, '09:00')),
    (v_uid, v_m3, c_food,    5000000, pg_temp.ts(v_m3, '09:00'), pg_temp.ts(v_m3, '09:00')),
    (v_uid, v_m3, c_move,    1500000, pg_temp.ts(v_m3, '09:00'), pg_temp.ts(v_m3, '09:00')),
    (v_uid, v_m3, c_home,    8000000, pg_temp.ts(v_m3, '09:00'), pg_temp.ts(v_m3, '09:00')),
    (v_uid, v_m3, c_shop,    2500000, pg_temp.ts(v_m3, '09:00'), pg_temp.ts(v_m3, '09:00')),
    (v_uid, v_m3, c_fun,     1200000, pg_temp.ts(v_m3, '09:00'), pg_temp.ts(v_m3, '09:00')),
    (v_uid, v_m3, c_tech,    1200000, pg_temp.ts(v_m3, '09:00'), pg_temp.ts(v_m3, '09:00')),
    (v_uid, v_m3, c_learn,   1500000, pg_temp.ts(v_m3, '09:00'), pg_temp.ts(v_m3, '09:00')),
    (v_uid, v_m3, c_health,  1000000, pg_temp.ts(v_m3, '09:00'), pg_temp.ts(v_m3, '09:00')),
    (v_uid, v_m3, c_family,  2000000, pg_temp.ts(v_m3, '09:00'), pg_temp.ts(v_m3, '09:00')),
    (v_uid, v_m1, c_food,    5500000, pg_temp.ts(v_m1, '08:30'), pg_temp.ts(v_m1, '08:30')),
    (v_uid, v_m0, null,     27000000, pg_temp.ts(v_m0, '08:30'), pg_temp.ts(v_m0, '08:30'));


  -- =================================================================
  -- 5. SHOPPING — purchased items are paid through a linked expense
  -- =================================================================
  for r in
    select * from (values
      ('Chuột Logitech MX Master 3S',          c_tech,  2290000, 1, 'high',     -88, -85, 'https://www.thegioididong.com', 'Dùng cho setup làm việc ở nhà'),
      ('Giày chạy bộ Asics Gel-Nimbus 26',     c_shop,  3190000, 1, 'high',     -60, -55, null, 'Chuẩn bị cho giải chạy tháng 11'),
      ('Sách Clean Architecture – Robert C. Martin', c_learn, 245000, 1, 'medium', -20, -15, 'https://tiki.vn', null),
      ('Bình giữ nhiệt Lock&Lock 500ml',       c_shop,   320000, 2, 'low',      -12,  -9, null, 'Một bình để ở văn phòng')
    ) as p(name, cat, price, qty, prio, cr, bought, url, note)
  loop
    v_exp := pg_temp.exp(v_uid, r.cat, r.price * r.qty, r.name, v_today + r.bought, '20:00',
                         'credit_card', 'Mua từ danh sách mua sắm');
    insert into public.shopping_items (user_id, name, category_id, unit_price, quantity, priority, status,
                                       purchased_on, url, note, expense_id, created_at, updated_at)
    values (v_uid, r.name, r.cat, r.price, r.qty, r.prio, 'purchased', v_today + r.bought, r.url, r.note, v_exp,
            pg_temp.ts(v_today + r.cr, '21:30'), pg_temp.ts(v_today + r.bought, '20:00'));
  end loop;

  insert into public.shopping_items (user_id, name, category_id, unit_price, quantity, priority, status,
                                     url, note, created_at, updated_at)
  select v_uid, s.name, s.cat, s.price, s.qty, s.prio, s.status, s.url, s.note,
         pg_temp.ts(v_today + s.cr, '21:30'), pg_temp.ts(v_today + s.cr, '21:30')
    from (values
      ('Quà 20/10 cho mẹ và em gái',             c_family,  650000, 2, 'must_buy', 'planned',  -3,  null::text, 'Mua trước ngày 18/10'),
      ('Vitamin tổng hợp Blackmores',            c_health,  420000, 2, 'must_buy', 'planned',  -5,  null, null),
      ('Tai nghe Sony WH-1000XM5',               c_tech,   7490000, 1, 'high',     'planned', -16,  'https://www.sony.com.vn', 'Chờ đợt sale 11/11'),
      ('Màn hình Dell UltraSharp U2723QE 27" 4K', c_tech,  11990000, 1, 'medium',   'planned', -25,  null, null),
      ('Nồi chiên không dầu Philips HD9252',     c_shop,   2490000, 1, 'medium',   'planned', -11,  null, null),
      ('Bàn phím cơ Keychron K8 Pro',            c_tech,   2690000, 1, 'low',      'wishlist', -34, null, 'Switch Brown, layout TKL'),
      ('Ghế công thái học Sihoo M57',            c_shop,   3290000, 1, 'medium',   'wishlist', -19, null, null),
      ('Kindle Paperwhite 5',                    c_learn,  3590000, 1, 'low',      'wishlist', -8,  null, null),
      ('Vali kéo 24 inch cho chuyến Đà Lạt',     c_shop,   1290000, 1, 'low',      'wishlist', -6,  null, null),
      ('Đồng hồ Garmin Forerunner 265',          c_health, 9490000, 1, 'medium',   'cancelled', -47, null, 'Để sau giải chạy tháng 11')
    ) as s(name, cat, price, qty, prio, status, cr, url, note);


  -- =================================================================
  -- 6. KPIs — snapshot history (value = actual level on that date)
  -- =================================================================

  -- 6a. tasks completed — computed from the seeded tasks, weekly snapshots
  insert into public.kpis (user_id, name, description, unit, target_value, start_date, end_date, status, created_at, updated_at)
  values (v_uid, 'Hoàn thành 60 đầu việc trong 6 tháng',
          'Đếm các task chuyển sang trạng thái Hoàn thành kể từ ngày bắt đầu.',
          'việc', 60, v_m3, (v_m3 + interval '6 months - 1 day')::date, 'active',
          pg_temp.ts(v_m3, '08:00'), pg_temp.ts(v_m3, '08:00'))
  returning id into v_kpi;
  for d in select generate_series(v_m3 + 6, v_today, interval '7 days')::date loop
    select count(*) into v_val from public.tasks
     where user_id = v_uid and completed_at is not null
       and (completed_at at time zone v_tz)::date between v_m3 and d;
    insert into public.kpi_records (user_id, kpi_id, recorded_on, value, created_at, updated_at)
    values (v_uid, v_kpi, d, v_val, pg_temp.ts(d, '21:00'), pg_temp.ts(d, '21:00'));
  end loop;

  -- 6b. English study hours — weekly cumulative
  insert into public.kpis (user_id, name, description, unit, target_value, start_date, end_date, status, created_at, updated_at)
  values (v_uid, 'Học tiếng Anh 100 giờ', 'Mục tiêu IELTS 7.0 trước tháng 3 năm sau.', 'giờ', 100,
          v_m3, (v_m3 + interval '6 months - 1 day')::date, 'active', pg_temp.ts(v_m3, '08:00'), pg_temp.ts(v_m3, '08:00'))
  returning id into v_kpi;
  v_val := 0;
  for d in select generate_series(v_m3 + 6, v_today, interval '7 days')::date loop
    v_val := v_val + pg_temp.rnd(25, 55) / 10.0;
    insert into public.kpi_records (user_id, kpi_id, recorded_on, value, note, created_at, updated_at)
    values (v_uid, v_kpi, d, v_val, case when random() < 0.25 then 'Tuần này tập trung Speaking' end,
            pg_temp.ts(d, '21:30'), pg_temp.ts(d, '21:30'));
  end loop;

  -- 6c. running distance — weekly cumulative, deadline = race day
  insert into public.kpis (user_id, name, description, unit, target_value, start_date, end_date, status, created_at, updated_at)
  values (v_uid, 'Chạy 300 km chuẩn bị Half Marathon', 'Giải chạy tháng 11 – cự ly 21 km.', 'km', 300,
          v_m3, v_today + 35, 'active', pg_temp.ts(v_m3, '08:00'), pg_temp.ts(v_m3, '08:00'))
  returning id into v_kpi;
  v_val := 0;
  for d in select generate_series(v_m3 + 5, v_today, interval '7 days')::date loop
    v_val := v_val + pg_temp.rnd(120, 240) / 10.0;
    insert into public.kpi_records (user_id, kpi_id, recorded_on, value, created_at, updated_at)
    values (v_uid, v_kpi, d, v_val, pg_temp.ts(d, '07:30'), pg_temp.ts(d, '07:30'));
  end loop;

  -- 6d. emergency fund — monthly balance snapshots
  insert into public.kpis (user_id, name, description, unit, target_value, start_date, end_date, status, created_at, updated_at)
  values (v_uid, 'Quỹ dự phòng 6 tháng chi tiêu', 'Tích lũy 120 triệu đồng trong tài khoản tiết kiệm riêng.', 'VND',
          120000000, v_m3, (date_trunc('year', v_today) + interval '1 year - 1 day')::date, 'active',
          pg_temp.ts(v_m3, '08:00'), pg_temp.ts(v_m3, '08:00'))
  returning id into v_kpi;
  insert into public.kpi_records (user_id, kpi_id, recorded_on, value, note, created_at, updated_at) values
    (v_uid, v_kpi, v_m3 + 9,  52000000, 'Số dư đầu kỳ',            pg_temp.ts(v_m3 + 9, '20:00'),  pg_temp.ts(v_m3 + 9, '20:00')),
    (v_uid, v_kpi, v_m2 + 9,  60500000, 'Chuyển 8,5 triệu từ lương', pg_temp.ts(v_m2 + 9, '20:00'),  pg_temp.ts(v_m2 + 9, '20:00')),
    (v_uid, v_kpi, v_m1 + 9,  66000000, 'Tháng này chi cho vé máy bay', pg_temp.ts(v_m1 + 9, '20:00'), pg_temp.ts(v_m1 + 9, '20:00'));
  if v_today >= v_m0 + 9 then
    insert into public.kpi_records (user_id, kpi_id, recorded_on, value, note, created_at, updated_at)
    values (v_uid, v_kpi, v_m0 + 9, 75000000, 'Thêm thưởng dự án quý III', pg_temp.ts(v_m0 + 9, '20:00'), pg_temp.ts(v_m0 + 9, '20:00'));
  end if;

  -- 6e. books read this year — monthly
  insert into public.kpis (user_id, name, description, unit, target_value, start_date, end_date, status, created_at, updated_at)
  values (v_uid, 'Đọc 24 cuốn sách năm ' || extract(year from v_today), null, 'cuốn', 24,
          date_trunc('year', v_today)::date, (date_trunc('year', v_today) + interval '1 year - 1 day')::date, 'active',
          pg_temp.ts(date_trunc('year', v_today)::date, '08:00'), pg_temp.ts(date_trunc('year', v_today)::date, '08:00'))
  returning id into v_kpi;
  v_val := 0;
  for d in select (generate_series(date_trunc('year', v_today), v_m0 - interval '1 month', interval '1 month')
                   + interval '1 month - 1 day')::date loop
    v_val := v_val + pg_temp.pick(array[1, 2, 2, 3]);
    insert into public.kpi_records (user_id, kpi_id, recorded_on, value, created_at, updated_at)
    values (v_uid, v_kpi, d, v_val, pg_temp.ts(d, '22:00'), pg_temp.ts(d, '22:00'));
  end loop;

  -- 6f. finished goal — AWS certificate (matches the study task + exam fee)
  insert into public.kpis (user_id, name, description, unit, target_value, start_date, end_date, status, created_at, updated_at)
  values (v_uid, 'Chứng chỉ AWS Solutions Architect – Associate', 'Đạt 812/1000 điểm.', 'chứng chỉ', 1,
          v_today - 60, v_today - 15, 'completed', pg_temp.ts(v_today - 60, '08:00'), pg_temp.ts(v_today - 19, '18:00'))
  returning id into v_kpi;
  insert into public.kpi_records (user_id, kpi_id, recorded_on, value, note, created_at, updated_at) values
    (v_uid, v_kpi, v_today - 60, 0, 'Bắt đầu ôn tập',         pg_temp.ts(v_today - 60, '21:00'), pg_temp.ts(v_today - 60, '21:00')),
    (v_uid, v_kpi, v_today - 19, 1, 'Đã thi đạt – 812 điểm', pg_temp.ts(v_today - 19, '18:00'), pg_temp.ts(v_today - 19, '18:00'));

  -- 6g. paused habit
  insert into public.kpis (user_id, name, description, unit, target_value, start_date, end_date, status, created_at, updated_at)
  values (v_uid, 'Thiền 90 buổi', 'Tạm dừng trong giai đoạn chạy dự án.', 'buổi', 90,
          v_m3, null, 'paused', pg_temp.ts(v_m3, '08:00'), pg_temp.ts(v_today - 30, '08:00'))
  returning id into v_kpi;
  insert into public.kpi_records (user_id, kpi_id, recorded_on, value, created_at, updated_at) values
    (v_uid, v_kpi, v_m3 + 20, 14, pg_temp.ts(v_m3 + 20, '22:00'), pg_temp.ts(v_m3 + 20, '22:00')),
    (v_uid, v_kpi, v_m2 + 20, 23, pg_temp.ts(v_m2 + 20, '22:00'), pg_temp.ts(v_m2 + 20, '22:00'));


  -- =================================================================
  -- 6½. NOTES (only when migration 000700 is applied)
  --     task-linked notes point at the seeded tasks by title.
  -- =================================================================
  if to_regclass('public.notes') is not null then
    insert into public.notes (user_id, title, content, notebook, tags, color, pinned, archived, trashed_at,
                              task_id, kind, created_at, updated_at)
    select v_uid, n.title, n.content, n.notebook, n.tags, n.color, n.pinned, n.archived,
           case when n.trashed then pg_temp.ts(v_today + n.upd, '22:10') end,
           (select t.id from public.tasks t where t.user_id = v_uid and t.title = n.task_title),
           n.kind,
           pg_temp.ts(v_today + n.cr, n.at),
           least(pg_temp.ts(v_today + n.upd, n.at) + interval '25 minutes', now() - interval '5 minutes')
      from (values
        ('Mục tiêu quý IV',
         E'## OKR cá nhân Q4\n\n1. Hoàn thành refactor xác thực (JWT + refresh token) trước giữa tháng 11\n2. Thi IELTS thử, mục tiêu Speaking 6.5\n3. Half Marathon tháng 11 – dưới 2h15\n4. Quỹ dự phòng đạt 90 triệu\n\n> Mỗi tối Chủ nhật review lại tiến độ trên trang KPI.',
         'Cá nhân', '{okr,muc-tieu}'::text[], '#D4A72C', true, false, false, null::text, 'note', -9, -1, time '21:40'),
        ('Họp kế hoạch Sprint 19',
         E'**Thành phần:** PO, 4 dev, 1 QA\n\n### Quyết định\n- Ưu tiên migrate service thông báo sang RabbitMQ\n- Tạm hoãn cảnh báo Grafana, chuyển sang dự án observability\n\n### Action items\n- [x] Minh Anh: thiết kế consumer idempotent\n- [x] Huy: cập nhật tài liệu luồng gửi email\n- [ ] QA: kịch bản test retry khi broker down',
         'Công việc', '{sprint,meeting}', '#3B82C4', false, false, false, 'Họp kế hoạch Sprint 19 với team Product', 'meeting', -21, -21, time '10:30'),
        ('Ghi chú điều tra memory leak worker ảnh',
         E'- RSS tăng ~200MB/giờ khi tỉ lệ lỗi > 5%\n- Heap snapshot: `Buffer` từ sharp giữ lại trong closure của retry handler\n- Fix: gọi `image.destroy()` trong `finally`, giới hạn concurrency = 4\n- Sau fix: RSS ổn định quanh 310MB sau 6 giờ chạy',
         'Công việc', '{bugfix,nodejs,performance}', null, false, false, false, 'Điều tra memory leak trên worker xử lý ảnh', 'note', -6, -4, time '16:20'),
        ('Checklist deploy staging',
         E'- [x] Tạo GitHub Environment `staging` + required reviewer\n- [x] Secret: registry token, kubeconfig\n- [ ] Bước migrate DB chạy trước khi rollout\n- [ ] Smoke test sau deploy (health, login, tạo đơn)\n- [ ] Thông báo kênh #release khi xong',
         'Công việc', '{devops,ci}', '#2FA4A9', true, false, false, 'Triển khai CI/CD cho môi trường staging', 'checklist', -5, -1, time '15:00'),
        ('Tối ưu PostgreSQL – dàn ý bài blog',
         E'1. Đo trước: `EXPLAIN (ANALYZE, BUFFERS)`\n2. Composite index đúng thứ tự cột theo điều kiện lọc\n3. Keyset pagination thay OFFSET\n4. Kết quả: P95 1,8s → 120ms\n5. Bài học: đừng tối ưu khi chưa có số liệu',
         'Học tập', '{blog,database}', null, false, false, false, 'Viết blog: Kinh nghiệm tối ưu PostgreSQL', 'note', -6, -2, time '22:00'),
        ('AWS SAA – những chỗ hay nhầm',
         E'- S3 Glacier Instant vs Flexible Retrieval: khác thời gian lấy dữ liệu\n- NAT Gateway là theo AZ, cần 1 cái mỗi AZ để HA\n- SQS FIFO: tối đa 300 msg/s (3.000 khi batching)\n- Aurora Global Database: RPO ~1s, RTO < 1 phút',
         'Học tập', '{aws,certificate}', '#4F9D5D', false, true, false, 'Ôn luyện đề AWS Solutions Architect – Associate', 'note', -35, -19, time '21:15'),
        ('IELTS Speaking Part 2 – Describe a project you worked on',
         E'**Ý chính:** dự án tối ưu hệ thống đơn hàng\n- Bối cảnh: khách hàng phàn nàn trang chậm\n- Vai trò: phân tích truy vấn, đề xuất index\n- Kết quả: nhanh hơn 15 lần, được team ghi nhận\n\nTừ vựng: *bottleneck, trade-off, scalable, stakeholder*',
         'Học tập', '{english,ielts}', null, false, false, false, 'Luyện IELTS Speaking – Part 2 chủ đề công việc', 'note', -8, -3, time '21:30'),
        ('Nhật ký tuần',
         E'Tuần này khá bận nhưng hiệu quả: xong điều tra memory leak, bắt đầu CI/CD staging. Chạy được 21 km cả tuần. Cần ngủ sớm hơn – 3 hôm liền thức sau 0h vì làm side project.',
         'Cá nhân', '{journal}', '#7C6BC4', false, false, false, null, 'journal', -3, -3, time '22:30'),
        ('Lịch tập Half Marathon',
         E'| Thứ | Bài tập |\n|---|---|\n| 3 | Interval 6 × 800m |\n| 5 | Tempo 8 km |\n| 7 | Long run 14–18 km |\n| CN | Yoga phục hồi |\n\nGiảm tải tuần cuối trước giải.',
         'Cá nhân', '{running,health}', '#D9534F', false, false, false, null, 'note', -40, -12, time '06:45'),
        ('Kế hoạch Đà Lạt cuối năm',
         E'- Thời gian: 3N2Đ, đi xe giường nằm\n- Ngân sách: ~6 triệu/người\n- Chỗ ở: homestay khu Trại Mát\n- [ ] Chốt danh sách người đi\n- [ ] Đặt xe trước 2 tuần',
         'Cá nhân', '{travel}', null, false, false, false, 'Lên kế hoạch du lịch Đà Lạt cuối năm', 'checklist', -7, -6, time '20:50'),
        ('Ý tưởng side project',
         E'- Tự động phân loại chi tiêu theo mô tả\n- Nhắc khi một danh mục vượt 80% ngân sách\n- Xuất báo cáo tháng ra PDF',
         'Dự án phụ', '{side-project,idea}', '#0E9F6E', false, false, false, null, 'note', -30, -11, time '23:00'),
        ('Nháp cũ – danh sách mua sắm tháng 8',
         E'Đã chuyển sang trang Mua sắm.',
         null, '{}', null, false, false, true, null, 'note', -60, -20, time '20:00')
      ) as n(title, content, notebook, tags, color, pinned, archived, trashed, task_title, kind, cr, upd, at);
  end if;


  -- =================================================================
  -- 7. Consistent timestamps + activity feed with the real event times
  -- =================================================================
  update public.tasks t
     set updated_at = greatest(t.created_at, coalesce(t.completed_at, t.created_at),
                               coalesce((select max(e.ended_at) from public.time_entries e where e.task_id = t.id), t.created_at))
   where t.user_id = v_uid;

  update public.kpis k
     set updated_at = greatest(k.created_at,
                               coalesce((select max(kr.created_at) from public.kpi_records kr where kr.kpi_id = k.id), k.created_at))
   where k.user_id = v_uid;

  -- Mirrors public.log_activity(): what the triggers would have written at the time.
  insert into public.activity_logs (user_id, entity_type, entity_id, action, title, metadata, created_at)
  select v_uid, 'task', t.id, 'created', t.title, '{}'::jsonb, t.created_at
    from public.tasks t where t.user_id = v_uid
  union all
  select v_uid, 'task', t.id, 'completed', t.title, '{}'::jsonb, t.completed_at
    from public.tasks t where t.user_id = v_uid and t.completed_at is not null
  union all
  select v_uid, 'expense', e.id, 'created', coalesce(nullif(e.description, ''), 'Expense'),
         jsonb_build_object('amount', e.amount), e.created_at
    from public.expenses e where e.user_id = v_uid
  union all
  select v_uid, 'shopping_item', s.id, 'created', s.name, '{}'::jsonb, s.created_at
    from public.shopping_items s where s.user_id = v_uid
  union all
  select v_uid, 'shopping_item', s.id, 'completed', s.name, jsonb_build_object('total', s.total_price), s.updated_at
    from public.shopping_items s where s.user_id = v_uid and s.status = 'purchased'
  union all
  select v_uid, 'kpi', kr.kpi_id, 'updated', k.name, jsonb_build_object('value', kr.value), kr.created_at
    from public.kpi_records kr join public.kpis k on k.id = kr.kpi_id where kr.user_id = v_uid;

  alter table public.tasks          enable trigger trg_tasks_completed_at;
  alter table public.tasks          enable trigger trg_tasks_updated_at;
  alter table public.tasks          enable trigger trg_tasks_activity;
  alter table public.kpis           enable trigger trg_kpis_updated_at;
  alter table public.expenses       enable trigger trg_expenses_activity;
  alter table public.shopping_items enable trigger trg_shopping_activity;
  alter table public.kpi_records    enable trigger trg_kpi_records_activity;

  raise notice 'seed: demo data rebuilt for % (today = %)', v_email, v_today;
end;
$seed$;
