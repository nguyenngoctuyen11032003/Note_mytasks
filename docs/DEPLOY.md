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
