# Deploy — GitHub Actions + GitHub Pages + Supabase

Không có server riêng. Toàn bộ CI/CD chạy trên GitHub; database/Auth là Supabase hosted.

```
Pull Request ──► CI (.github/workflows/ci.yml)
                  ├─ web:      npm ci → kiểm tra biến VITE_* → vite build
                  └─ database: Supabase local (Docker) áp dụng mọi migration → db lint

push main ─────► Deploy (.github/workflows/deploy.yml)
                  verify (= CI) ─┐
                  changes ───────┼─► migrate (chỉ khi supabase/migrations/** đổi, cần duyệt)
                                 │      supabase link → db push --dry-run → db push
                                 ├─► functions (chỉ khi supabase/functions/** đổi, sau migrate, cần duyệt)
                                 │      supabase functions deploy fitora-food-ai
                                 └─► build (vite build, VITE_* từ Variables) → pages (GitHub Pages)
```

## ⚠️ Quy tắc an toàn database

Project Supabase **dùng chung với app khác** (schema `learning` và bảng `public.migrations` của TypeORM).

- CI **chỉ** chạy `supabase db push`: áp dụng các migration chưa có trong `supabase_migrations.schema_migrations`, không xóa gì.
- **Không bao giờ** chạy với project hosted: `supabase db reset`, `supabase config push`, `db push --include-seed`, `supabase/maintenance/*.sql`.
- Mỗi thay đổi schema = **một file migration mới** (`supabase migration new <ten>`). Không sửa file migration đã deploy.

## Thiết lập một lần

### 1. Repo GitHub

```bash
git init -b main
git add .
git status          # kiểm tra: KHÔNG có .env, node_modules, dist
git commit -m "Initial commit"
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

Repo nên để **public** (GitHub Pages cho repo private cần gói trả phí). Repo public vẫn an toàn vì không có secret trong source; dữ liệu được bảo vệ bằng RLS.

### 2. GitHub Pages

**Settings → Pages → Build and deployment → Source: `GitHub Actions`.**

### 3. Environment `production` (bắt buộc duyệt trước khi đổi database)

**Settings → Environments → New environment → `production`**

- Bật **Required reviewers** → chọn chính bạn.
- **Deployment branches**: chỉ `main`.
- Thêm **Environment secrets** (chỉ job migrate thấy được):

| Secret | Lấy ở đâu |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | supabase.com → Account → Access Tokens → Generate |
| `SUPABASE_DB_PASSWORD` | Mật khẩu database của project (Project Settings → Database) |

### 4. Repository variables (public, được build vào JS)

**Settings → Secrets and variables → Actions → tab Variables:**

| Variable | Giá trị |
|---|---|
| `SUPABASE_PROJECT_ID` | Project ref (phần `xxxx` trong `https://xxxx.supabase.co`) |
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | **anon / publishable** key (Project Settings → API) |

Script [`.github/scripts/check-public-env.mjs`](../.github/scripts/check-public-env.mjs) làm build thất bại nếu key là `service_role` / `sb_secret_…` hoặc có biến `VITE_*` trông như secret.

### 5. Supabase Auth URL

Supabase dashboard → **Authentication → URL Configuration**:

- **Site URL:** `https://<user>.github.io/<repo>/`
- **Redirect URLs:** `https://<user>.github.io/<repo>/**` và `http://localhost:5173/**`

(Cài đặt Auth trong `supabase/config.toml` chỉ dùng cho môi trường local, CI không đẩy lên hosted.)

### 6. Lần deploy đầu tiên

Nếu các migration **đã được áp dụng tay** lên project (CLI đã ghi vào lịch sử migration), `db push` lần đầu sẽ không làm gì — đúng mong đợi.

Nếu bảng đã tồn tại nhưng **chưa có trong lịch sử migration** (từng tạo bằng SQL Editor), `db push` sẽ lỗi `relation ... already exists`. Khi đó, sau khi xác nhận schema khớp, đánh dấu đã áp dụng (chạy local một lần):

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase migration repair --status applied <version>
```

## Quy trình hằng ngày

1. Tạo nhánh → sửa code → mở Pull Request → **CI** phải xanh.
2. Đổi database: `npx supabase migration new <ten>` → viết SQL → PR (CI dựng DB local và áp dụng thử).
3. Merge vào `main` → **Deploy** tự chạy. Nếu có migration mới, GitHub chờ bạn **Approve** environment `production`, xem log `db push --dry-run`, rồi mới áp dụng.
4. Site có ở `https://<user>.github.io/<repo>/`.

Chạy lại bằng tay: **Actions → Deploy → Run workflow** (tick `migrate` để buộc chạy bước migration).

## Xử lý sự cố

| Triệu chứng | Nguyên nhân / cách xử lý |
|---|---|
| Job `build` báo thiếu `VITE_SUPABASE_URL` | Chưa tạo Variables ở bước 4 |
| Job `migrate` báo `Thiếu SUPABASE_…` | Secrets chưa đặt trong environment `production` |
| `db push` lỗi `Remote migration versions not found in local migrations directory` | Lịch sử trên DB có version không có trong repo → đồng bộ file migration hoặc `migration repair`; **không** dùng `--include-all` khi chưa hiểu rõ |
| Pages 404 sau khi deploy | Kiểm tra bước 2 (Source = GitHub Actions) |
| Link xác nhận email / đổi mật khẩu sai địa chỉ | Kiểm tra bước 5 |
| Mở app báo lỗi kết nối | Supabase Free tạm dừng project khi lâu không dùng → Restore trong dashboard |

## Fitora (app thứ hai dùng chung project Supabase)

Fitora — AI Nutrition & Fitness Coach — là một frontend riêng (repo riêng, GitHub Pages riêng) nhưng dùng
**cùng project Supabase** với Note_mytasks. Phần backend của Fitora nằm trong repo này:

| Thành phần | Vị trí |
|---|---|
| Bảng `fit_*`, RLS, RPC `fit_day_summary` / `fit_range_summary` / `fit_ai_quota_consume` | `supabase/migrations/20261009001400_fitora_schema.sql` |
| Bucket private `fitora` (ảnh bữa ăn, ảnh tiến trình) | `supabase/migrations/20261009001500_fitora_storage.sql` |
| Edge Function nhận diện món ăn (Claude vision) | `supabase/functions/fitora-food-ai/` (`verify_jwt = true` trong `supabase/config.toml`) |
| Test (PGlite) | `tests/db/fitora.test.js` |

Migration Fitora chỉ **thêm** đối tượng mới có tiền tố `fit_` / policy `fitora_*`; không sửa/xóa gì của Note_mytasks
hay app khác. Chúng được deploy bằng job `migrate` như mọi migration khác.

### Tài khoản dùng chung

Fitora dùng cùng `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` ⇒ cùng `auth.users`: người dùng đăng nhập Fitora bằng
đúng email/mật khẩu Note_mytasks (và ngược lại); Fitora đọc `public.profiles` (tên, avatar). Hai app lưu phiên ở hai
`storageKey` khác nhau (`nm.auth` / `fitora.auth`) nên đăng xuất app này không đăng xuất app kia. Xóa tài khoản trong
Auth sẽ xóa luôn dữ liệu `fit_*` (`on delete cascade`).

### Secrets của Edge Function (đặt một lần, chạy local)

Khóa AI **không bao giờ** nằm trong frontend hay GitHub; chỉ là Supabase secret. Cần **một** trong hai khóa:

- `GEMINI_API_KEY`: **miễn phí**, tạo ở https://aistudio.google.com/apikey (gói free giới hạn lượt/phút và lượt/ngày;
  Google có thể dùng dữ liệu gửi lên gói free để cải thiện sản phẩm).
- `ANTHROPIC_API_KEY`: trả phí, tạo ở https://console.anthropic.com/settings/keys.

Có cả hai thì mặc định dùng Anthropic; đặt `FITORA_AI_PROVIDER=gemini` để ép dùng Gemini. Đặt secret không cần deploy lại.
Không dùng CLI thì vào Dashboard → **Edge Functions → Secrets → Add new secret**.

```bash
npx supabase login
npx supabase secrets set --project-ref <project-ref> GEMINI_API_KEY=<khóa Gemini>          # miễn phí
# hoặc: npx supabase secrets set --project-ref <project-ref> ANTHROPIC_API_KEY=<khóa Anthropic>
# Tùy chọn:
npx supabase secrets set --project-ref <project-ref> FITORA_AI_PROVIDER=gemini             # khi có cả hai khóa
npx supabase secrets set --project-ref <project-ref> GEMINI_MODEL=gemini-flash-latest      # mặc định gemini-flash-latest
npx supabase secrets set --project-ref <project-ref> FITORA_AI_MODEL=claude-sonnet-5-5      # mặc định claude-sonnet-5-5
npx supabase secrets set --project-ref <project-ref> FITORA_AI_DAILY_LIMIT=40               # lượt quét AI / người / ngày
```

`SUPABASE_URL` / `SUPABASE_ANON_KEY` do nền tảng tự cấp cho function. Function gọi RPC `fit_ai_quota_consume` bằng JWT
của người dùng (không dùng `service_role`), vượt hạn mức → HTTP 429 `quota_exceeded`.

### Deploy function

Job `functions` trong `deploy.yml` chạy `supabase functions deploy --project-ref $SUPABASE_PROJECT_ID` (mọi function)
khi `supabase/functions/**` thay đổi (sau `migrate`, cần duyệt environment `production`, chỉ dùng secret
`SUPABASE_ACCESS_TOKEN` + variable `SUPABASE_PROJECT_ID` đã có). Chạy tay: **Actions → Deploy → Run workflow**, tick
`functions`. Job này bị bỏ qua thì `build` / `pages` của Note_mytasks vẫn chạy bình thường.

### Auth Redirect URLs

Supabase dashboard → **Authentication → URL Configuration → Redirect URLs**: **thêm** (đừng thay) URL của Fitora:

- `https://<user>.github.io/<fitora-repo>/**`
- `http://localhost:5173/**` (đã có nếu cùng cổng dev; nếu Fitora chạy cổng khác thì thêm cổng đó)

**Site URL** giữ nguyên là Note_mytasks; Fitora truyền `redirectTo` của chính nó khi đăng ký / quên mật khẩu, và
Supabase chỉ chấp nhận `redirectTo` nằm trong danh sách trên.

| Triệu chứng (Fitora) | Nguyên nhân / cách xử lý |
|---|---|
| Quét AI báo "chưa được cấu hình" (503 `ai_unavailable`) | Chưa đặt secret `GEMINI_API_KEY` (miễn phí) hoặc `ANTHROPIC_API_KEY` |
| Quét AI 404 / CORS lỗi | Function chưa deploy → chạy workflow với `functions` |
| Quét AI báo "AI miễn phí đang hết lượt tạm thời" | Gemini free tier chạm giới hạn lượt/phút hoặc lượt/ngày → đợi rồi thử lại |
| Link email từ Fitora mở về Note_mytasks | URL Fitora chưa có trong Redirect URLs |
| `relation "public.fit_profiles" does not exist` | Migration 001400 chưa được `db push` |
