# Backend API contract — smart features (Phase 2)

Date: 2026-10-09. Nguồn sự thật cho tên/tham số/kết quả của mọi RPC và service.
Mọi thay đổi phải cập nhật file này.

## Quy ước chung

- RPC = hàm PostgreSQL trong `public`, gọi qua `supabase.rpc(name, args)`. Tham số đặt tên `p_*`.
- SECURITY INVOKER (RLS vẫn áp dụng). Chỉ `authenticated` có EXECUTE; `anon`/`public` bị revoke.
- `set search_path = ''`, tên đầy đủ schema.
- "Hôm nay"/"tháng này" dùng `public.user_today()` / `public.user_tz()` (migration `000200` + `000250`).
- Lỗi nghiệp vụ: `raise exception using errcode = 'P0001', message = '<mã_lỗi>'` với mã snake_case
  (vd `timer_already_running`, `not_found`, `invalid_input`). Service map mã → câu tiếng Việt.
- Trả về `jsonb` cho kết quả tổng hợp (1 object), `setof`/`table` cho danh sách.
- Tiền: `numeric` → JS nhận number hoặc string; service luôn `Number(...)`.

## Migration ownership

| File | Nội dung |
|---|---|
| `20261009000100_initial_schema.sql` | Có sẵn — KHÔNG sửa |
| `20261009000200_business_logic.sql` | (phiên khác sở hữu) `user_today()`, `current_user_timezone()`, start_timer/stop_timer, get_* report RPC, `purchase_shopping_item` (trả row shopping_items, tham số p_purchased_on)
| `20261009000250_smart_helpers.sql` | `user_tz()`, `user_day(ts)` |
| `20261009000300_tasks_time.sql` | Timer, recurring tasks, focus score, ước lượng thời gian |
| `20261009000400_finance.sql` | Budget status/forecast, anomaly, category suggestion, shopping→expense |
| `20261009000500_kpi_dashboard.sql` | KPI forecast, dashboard summary, productivity stats, streak |

## 1. Tasks & Time (`000300`)

### Schema bổ sung
- `tasks.recurrence text null check (recurrence in ('daily','weekdays','weekly','monthly'))`
- `tasks.recurrence_parent_id uuid null` — task gốc của chuỗi lặp (composite FK `(recurrence_parent_id, user_id)` → tasks, `on delete set null (recurrence_parent_id)`).
- Trigger: khi task có `recurrence` chuyển sang `completed` → tự tạo task kế tiếp (status `todo`, `due_date` = ngày lặp tiếp theo tính từ `due_date` (hoặc `user_today()` nếu null), copy title/description/priority/category/tags/estimated/recurrence; `recurrence_parent_id` = gốc chuỗi). Không tạo trùng (nếu đã có task `todo|in_progress` cùng chuỗi với due_date đó thì bỏ qua). Mở lại rồi hoàn thành lại không tạo bản sao thứ hai.

### RPC
| Hàm | Trả về | Ghi chú |
|---|---|---|
| `start_timer(p_task_id uuid default null, p_description text default null)` (định nghĩa ở 000200, 000300 có thể nâng cấp cùng chữ ký) | row `time_entries` | Nếu đang có timer chạy → tự dừng (ended_at=now()) rồi mở segment mới. Task đang `todo` → chuyển `in_progress`. Task không tồn tại/không thuộc user → `not_found`. Task `completed`/`cancelled` → `task_closed`. |
| `stop_timer()` | row `time_entries` đã đóng hoặc `null` nếu không có timer | Segment < 1 giây → xóa thay vì lưu (tránh CHECK ended_at > started_at). |
| `timer_current()` | jsonb `{entry, task_title, elapsed_seconds, task_total_seconds}` hoặc `null` | |
| `log_time(p_task_id uuid, p_started_at timestamptz, p_ended_at timestamptz, p_description text default null)` | row `time_entries` (source=`manual`) | Từ chối khi chồng lấn segment khác của user → `time_overlap`; tương lai → `invalid_input`; > 24h → `invalid_input`. |
| `focus_tasks(p_limit int default 5)` | `table(task_id uuid, title text, priority text, due_date date, status text, score numeric, reasons text[])` | Chấm điểm task mở (`todo`,`in_progress`). Công thức bên dưới. Sắp xếp score desc, due_date asc nulls last. |
| `estimate_suggestion(p_category_id uuid default null)` | jsonb `{samples, accuracy_ratio, median_actual_minutes, suggested_multiplier}` | Từ task đã hoàn thành có cả estimated>0 và actual>0 (tối đa 50 gần nhất, lọc category nếu có). `accuracy_ratio` = median(actual/estimated). `suggested_multiplier` = accuracy_ratio làm tròn 2 số, null nếu samples < 3. |

**Focus score** (0–100+, càng cao càng nên làm trước):
- priority: urgent 40, high 28, medium 16, low 6
- hạn: quá hạn `30 + min(days_overdue*2, 20)`; hôm nay 30; ngày mai 22; ≤3 ngày 15; ≤7 ngày 8; không hạn 0
- `in_progress` +10 (đang dở thì làm nốt)
- task ngắn (estimated ≤ 30 phút) +5 (quick win)
- tuổi: task tạo > 14 ngày chưa xong +5 (tránh bị bỏ quên)
- `reasons`: mã lý do theo thứ tự cố định (SQL `focus_tasks` và JS `scoring.js` giống nhau): `overdue`, `due_today`, `due_tomorrow`, `due_soon`, `priority_urgent`, `priority_high`, `in_progress`, `quick_win`, `stale`.

## 2. Finance (`000400`)

| Hàm | Trả về | Ghi chú |
|---|---|---|
| `budget_status(p_month date default null)` | `table(category_id uuid, category_name text, color text, budget numeric, spent numeric, remaining numeric, used_pct numeric, projected numeric, status text)` | `p_month` null → tháng hiện tại (user tz); làm tròn về ngày 1. Budget carry-forward: dòng có `effective_month` lớn nhất ≤ tháng. Dòng `category_id null` = tổng (category_name `null`), luôn trả về nếu có budget tổng. Category có chi tiêu nhưng không budget vẫn trả (budget null). `projected` = spent / ngày_đã_qua * số_ngày_tháng (tháng hiện tại); tháng quá khứ = spent; tương lai = 0. `status`: `no_budget`, `ok` (<80%), `warning` (80–100% hoặc projected > budget), `over` (>100%). |
| `spending_summary(p_from date, p_to date)` | jsonb `{total, count, daily_avg, by_category:[{category_id,name,color,total,count,pct}], by_payment_method:[{method,total}], by_day:[{day,total}], prev_total, change_pct}` | `prev_total` = kỳ liền trước cùng độ dài. `by_day` đủ mọi ngày (0 khi không có). `change_pct` null khi prev_total = 0. |
| `expense_anomalies(p_days int default 30)` | `table(expense_id uuid, amount numeric, category_id uuid, category_name text, spent_on date, description text, baseline numeric, z_score numeric, reason text)` | Chi tiêu trong `p_days` ngày gần nhất bất thường so với lịch sử 180 ngày trước đó của cùng category: cần ≥ 5 mẫu lịch sử; dùng median + MAD (robust z = 0.6745*(x-median)/MAD); bất thường khi z ≥ 3.5 **và** amount ≥ 2×median. MAD = 0 → bất thường khi amount ≥ 3×median. `reason`='high_vs_category'. |
| `suggest_expense_category(p_description text)` | `table(category_id uuid, name text, confidence numeric)` tối đa 3 | Học từ lịch sử expense của chính user: so khớp token (lowercase, bỏ dấu tiếng Việt bằng `translate`, token ≥ 2 ký tự) với description trong 365 ngày. confidence 0–1 = tỉ lệ phiếu của category. Không có lịch sử → rỗng (client fallback từ khóa). |
| `purchase_shopping_item(p_item_id, p_purchased_on, p_payment_method, p_create_expense)` — DO 000200 SỞ HỮU, trả row `shopping_items` | Nguyên tử: đặt status `purchased`, `purchased_on` = p_spent_on ?? user_today(); nếu `p_create_expense` và total_price > 0 và chưa có expense_id → tạo expense (amount=total_price, category_id, description=name) và gắn `expense_id`. Item đã purchased → `already_purchased`. Không tồn tại → `not_found`. |
| `set_budget(p_amount numeric, p_category_id uuid default null, p_month date default null)` | row `budgets` | Upsert dòng carry-forward cho tháng (mặc định tháng hiện tại). amount < 0 → `invalid_input`. |

## 3. KPI & Dashboard (`000500`)

| Hàm | Trả về | Ghi chú |
|---|---|---|
| `kpi_forecast(p_kpi_id uuid default null)` (view `kpi_progress` thuộc 000200) | `table(kpi_id uuid, name text, unit text, target_value numeric, current_value numeric, progress_pct numeric, start_date date, end_date date, records int, slope_per_day numeric, projected_value numeric, projected_completion date, expected_pct numeric, status text)` | KPI `active` (hoặc đúng `p_kpi_id`). `slope_per_day` = `regr_slope(value, recorded_on - start_date)` khi ≥ 2 record (null nếu không). `projected_value` = giá trị dự báo tại end_date (null nếu không có end_date hoặc slope). `projected_completion` = ngày dự kiến chạm target (null nếu slope ≤ 0 hoặc đã đạt). `expected_pct` = % thời gian đã trôi (start→end). `status`: `achieved` (current ≥ target), `no_data` (< 2 record), `on_track` (projected_value ≥ target hoặc progress_pct ≥ expected_pct), `at_risk` (projected_value ≥ 80% target), `off_track`. |
| `dashboard_summary()` | jsonb (bên dưới) | Một lần gọi cho trang Dashboard. |
| `productivity_stats(p_from date, p_to date)` | jsonb `{completed_by_day:[{day,count}], minutes_by_day:[{day,minutes}], minutes_by_category:[{category_id,name,color,minutes}], completion_rate, on_time_rate, avg_cycle_hours, busiest_weekday}` | Ngày theo user tz; đủ mọi ngày. `on_time_rate` = tỉ lệ task hoàn thành có due_date mà ngày hoàn thành ≤ due_date. `completion_rate` = completed / (tạo trong kỳ). `busiest_weekday` 0=CN..6. |
| `streaks()` | jsonb `{current, longest, last_active_day}` | Ngày "hoạt động" = có ≥ 1 task hoàn thành hoặc ≥ 15 phút time entry (user tz). `current` vẫn tính nếu hôm nay chưa hoạt động nhưng hôm qua có. |

`dashboard_summary()` →
```json
{
  "today": "2026-10-09",
  "tasks": {"open": 0, "overdue": 0, "due_today": 0, "completed_today": 0, "completed_this_week": 0},
  "time": {"today_minutes": 0, "week_minutes": 0, "running": null},
  "money": {"month_spent": 0, "month_budget": null, "month_remaining": null, "month_projected": 0, "today_spent": 0},
  "kpis": {"active": 0, "on_track": 0, "at_risk": 0, "off_track": 0},
  "shopping": {"planned_count": 0, "planned_total": 0},
  "streak": {"current": 0, "longest": 0}
}
```
Tuần bắt đầu theo `profiles.week_starts_on`. `running` = `timer_current()`.

## 4. Smart client library (`src/services/smart/`, thuần JS, không gọi mạng)

| Module | Export |
|---|---|
| `quickAdd.js` | `parseTaskInput(text, {today, categories})` → `{title, due_date, priority, tags, estimated_minutes, category_id, recurrence}` — hiểu tiếng Việt: "mai", "hôm nay", "ngày kia", "thứ 2..CN", "cn", "tuần sau", "dd/mm", "dd/mm/yyyy", "!gấp/!cao/!thấp", "!!!", "#tag", "30p/1h/1g30/1.5h", "@category", "mỗi ngày/hằng ngày/hàng tuần/mỗi tháng/ngày thường". |
| `expenseParser.js` | `parseExpenseInput(text, {today})` → `{amount, description, spent_on, payment_method}` — "cà phê 35k", "ăn trưa 1tr2", "grab 120.000 hôm qua momo", "điện 1,5tr ck". |
| `categorizer.js` | `suggestCategory(description, {history, categories})` → `[{category_id, confidence, source}]` — kết hợp lịch sử (token vote) + từ điển từ khóa tiếng Việt mặc định cho 9 category chi tiêu. `normalizeVi(text)` bỏ dấu. |
| `insights.js` | `buildInsights({summary, budgets, kpis, anomalies, productivity})` → `[{id, severity:'info'|'warning'|'critical'|'success', title, detail, action?}]` tiếng Việt, sắp xếp theo severity, tối đa 6. |
| `scoring.js` | `focusScore(task, today)` — cùng công thức với SQL `focus_tasks` (dùng offline/optimistic). |

## 5. Service layer (`src/services/*.js`)

- Chỉ nơi này gọi `supabase.from/rpc/auth`. Import client từ `../core/supabase.js`.
- Mỗi hàm `async`, trả dữ liệu đã chuẩn hóa (number cho tiền), ném `AppError {code, message(vi), cause}` từ `errors.js`.
- Whitelist cột ghi (không bao giờ gửi `user_id`, `actual_minutes`, `completed_at`, `current_value`, `total_price`, `duration_seconds`).
- Files: `errors.js`, `auth.js`, `profile.js`, `categories.js`, `tasks.js`, `timer.js`, `expenses.js`, `budgets.js`, `shopping.js`, `kpis.js`, `activity.js`, `dashboard.js`, `reports.js` (export CSV dùng `utils/csv.js`).

## 6. Notes (`20261009000700_notes.sql`, `src/services/notes.js`)

### Schema `public.notes`
| Cột | Kiểu | Ràng buộc |
|---|---|---|
| `id` | uuid PK | `unique (id, user_id)` |
| `user_id` | uuid | default `auth.uid()`, FK `auth.users` cascade |
| `title` | text not null default `''` | ≤ 200 (được để trống) |
| `content` | text not null default `''` | Markdown, ≤ 100 000 |
| `notebook` | text null | sổ tự do, 1–60 ký tự (sau trim) |
| `tags` | text[] | ≤ 20, GIN |
| `color` | text null | `^#[0-9a-fA-F]{6}$` |
| `pinned`, `archived` | bool | default false |
| `trashed_at` | timestamptz null | ≠ null = trong Thùng rác (xóa mềm) |
| `task_id` | uuid null | composite FK `(task_id, user_id)` → `tasks` `on delete set null (task_id)` |
| `kind` | text | `note` · `checklist` · `journal` · `meeting` (default `note`) |
| `search` | tsvector generated | `notes_search_document(title, tags, content)`, config `simple`, GIN — không cần extension |
| `created_at`, `updated_at` | timestamptz | trigger `set_updated_at` |

RLS: 4 policy `notes_{select,insert,update,delete}_own` cho `authenticated` (UPDATE có USING + WITH CHECK); `anon` bị revoke. Không ghi `activity_logs` (autosave quá dày; CHECK `entity_type` thuộc 000100). Test: `supabase/tests/notes.test.sql`.

### Service
| Hàm | Trả về | Ghi chú |
|---|---|---|
| `listNotes({ search, notebook, tag, kind, pinned, archived=false, trashed=false, limit=500 })` | rows | `trashed=true` → chỉ Thùng rác (bỏ qua `archived`), sắp theo `trashed_at` desc; còn lại `pinned` desc, `updated_at` desc. `search`: ILIKE title/content **hoặc** tiền tố từ (`fts(simple)`, gồm cả thẻ). |
| `getNote(id)` | row \| null | |
| `createNote(input)` / `updateNote(id, patch)` | row | whitelist: title, content, notebook, tags, color, pinned, archived, trashed_at, task_id, kind. `content` không bị trim. |
| `trashNote(id)` / `restoreNote(id)` | row | trash đồng thời bỏ ghim |
| `deleteNote(id)` | true | xóa vĩnh viễn |
| `emptyTrash()` | số dòng đã xóa | |
| `listNotebooks()` | `[{name, count}]` | ghi chú sống (không trash, không lưu trữ) |
| `listNoteTags()` | `[{tag, count}]` | như trên, nhiều nhất trước |
| `noteOverview()` | `{counts:{all,pinned,note,checklist,journal,meeting,archived,trash}, notebooks, tags}` | 1 truy vấn cho sidebar |
| `renameNotebook(from, to)` | số dòng | `to = null` → gỡ sổ, giữ ghi chú |

Row: `{id, title, content, notebook, tags, color, pinned, archived, trashed_at, task_id, kind, created_at, updated_at}` (không trả `search`).

### Deep link (trang `#/notes`)
`?id=<uuid>` mở ghi chú · `?new=1` mở bảng chọn mẫu (`&task=<uuid>` để gắn sẵn công việc) · `?view=pinned|checklist|journal|meeting|archived|trash` · `?nb=<sổ>` · `?tag=<thẻ>` · `?q=<từ khóa>` · `?sort=created|title`. Trang khác có thể `notifyDataChanged('notes')` để danh sách tải lại.
