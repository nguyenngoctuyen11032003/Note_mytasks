# Note_mytasks

Sổ tay cá nhân: công việc, lịch, bấm giờ, KPI, chi tiêu – ngân sách, mua sắm và báo cáo. Web tĩnh (Vite, JavaScript thuần) + Supabase (Auth, PostgreSQL, RLS).

## Chạy trên máy

```bash
npm install
cp .env.example .env   # điền VITE_SUPABASE_URL và VITE_SUPABASE_ANON_KEY
npm run dev            # http://localhost:5173
npm run build          # build ra dist/
```

Chỉ hai biến `VITE_*` được đưa vào trình duyệt. Thiếu một trong hai, app hiển thị màn hình “Chưa kết nối Supabase”.

## Các trang

| # | Đường dẫn | Nội dung |
|---|---|---|
| — | `#/login` `#/signup` `#/forgot-password` `#/reset-password` | Đăng nhập, đăng ký, gửi và đặt lại mật khẩu (PKCE) |
| 01 | `#/dashboard` | Việc hôm nay, đồng hồ, hoạt động gần đây, giờ làm 14 ngày, chi tiêu tháng, KPI, mua sắm |
| 02 | `#/tasks` | Danh sách (nhóm theo hạn) / Bảng kéo-thả; lọc, tìm, thẻ, bấm giờ từ từng việc; phím `N` |
| 03 | `#/calendar` | Lịch tháng: việc theo hạn chót, giờ làm, khoản chi; panel chi tiết ngày |
| 04 | `#/time` | Đồng hồ bấm giờ (bắt đầu / tạm dừng / tiếp tục / dừng), ghi giờ thủ công, nhật ký, thống kê |
| 05 | `#/kpi` | Thẻ KPI có vòng tiến độ, so với tiến độ kỳ vọng, lịch sử, cập nhật số liệu |
| 06 | `#/expenses` | Khoản chi theo tháng, ngân sách carry-forward theo danh mục, dự báo cuối tháng |
| 07 | `#/shopping` | Danh sách mua; “Đã mua” có thể ghi thành khoản chi |
| 08 | `#/reports` | Báo cáo theo khoảng ngày, so với kỳ trước; xuất CSV |
| 09 | `#/settings` | Hồ sơ, tiền tệ, múi giờ, ngày đầu tuần, giao diện, danh mục, đổi mật khẩu |

## Cấu trúc `src/`

- `core/`: cấu hình, Supabase client, hash router, store, sự kiện
- `services/`: nơi duy nhất gọi Supabase
- `components/`: shell, dialog, toast, chart, timer, form công việc, icon SVG
- `pages/`: từng trang
- `css/`: `tokens.css` (màu, chữ, khoảng cách; sáng/tối), `base`, `layout`, `components`, `pages`
- `utils/`: ngày theo múi giờ người dùng, định dạng tiền và giờ, CSV, DOM

## Deploy

Không cần server: GitHub Actions kiểm tra + build, GitHub Pages phục vụ web tĩnh, Supabase lo Auth/Database.

- **Pull Request** → [CI](.github/workflows/ci.yml): `vite build` + áp dụng thử toàn bộ migration trên Supabase local.
- **Push `main`** → [Deploy](.github/workflows/deploy.yml): CI → `supabase db push` (chỉ khi có migration mới, cần duyệt) → build → GitHub Pages.

Thiết lập một lần (Pages, environment `production`, Secrets/Variables, Auth URL) và quy tắc an toàn database: xem [docs/DEPLOY.md](docs/DEPLOY.md).
