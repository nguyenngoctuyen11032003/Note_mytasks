# Stratos

Hệ sinh thái cá nhân (trước đây là Note_mytasks): ghi chú, công việc, lịch, bấm giờ, KPI, chi tiêu – ngân sách, mua sắm và báo cáo. Web tĩnh (Vite, JavaScript thuần) + Supabase (Auth, PostgreSQL, RLS).

## Chạy trên máy

```bash
npm install
cp .env.example .env   # điền VITE_SUPABASE_URL và VITE_SUPABASE_ANON_KEY
npm run dev            # http://localhost:5173
npm run build          # build ra dist/
```

Chỉ hai biến `VITE_*` được đưa vào trình duyệt. Thiếu một trong hai, app hiển thị màn hình “Chưa kết nối Supabase”.

## Tính năng

| Trang | Nội dung |
|---|---|
| `#/login` `#/signup` `#/forgot-password` `#/reset-password` | Đăng nhập, đăng ký, gửi và đặt lại mật khẩu (PKCE) |
| Tổng quan `#/dashboard` | Tiêu điểm hôm nay, đồng hồ, gợi ý thông minh, nhịp 14 ngày, chi tiêu theo danh mục, ngân sách tháng, ghi chú & hoạt động gần đây |
| Ghi chú `#/notes` | Markdown (xem trước / chia đôi), sổ ghi chú, thẻ, màu, ghim, lưu trữ, thùng rác; mẫu checklist / nhật ký / biên bản họp; liên kết công việc, tạo việc từ checklist; tìm toàn văn |
| Công việc `#/tasks` | Danh sách / bảng kéo-thả; nhập nhanh bằng ngôn ngữ tự nhiên (`mai 9h #sales !cao ~30p hằng tuần`); lặp lại, lọc, thẻ, chọn nhiều; ngăn chi tiết; bấm giờ từng việc; phím tắt (`?`) |
| Lịch `#/calendar` | Tháng / tuần / lịch trình: việc theo hạn, giờ làm, khoản chi |
| Thời gian `#/time` | Bấm giờ + Pomodoro, chế độ tập trung, ghi giờ thủ công, dòng thời gian tuần, ước tính so với thực tế |
| Mục tiêu KPI `#/kpi` | Dự báo hoàn thành, đúng / chậm tiến độ, lịch sử ghi nhận |
| Chi tiêu `#/expenses` | Nhập nhanh (`50k cà phê`), ngày / tuần / tháng / tùy chọn; biểu đồ nhịp, cơ cấu, lũy kế & ngân sách, thứ trong tuần; ngân sách theo danh mục, khoản bất thường |
| Mua sắm `#/shopping` | Danh sách mua; “Đã mua” ghi thành khoản chi |
| Báo cáo `#/reports` | Tuần / tháng / quý / năm / tùy chọn, so với kỳ trước; CSV; in / PDF (luôn in bằng bảng màu sáng) |
| Cài đặt `#/settings` | Hồ sơ, tiền tệ, múi giờ, giao diện sáng/tối, danh mục, mật khẩu, sao lưu / khôi phục JSON |

Toàn cục: bảng lệnh `Ctrl/⌘+K`, `G` + phím để chuyển trang, `N` tạo mới, `?` bảng phím tắt; PWA cài được; giao diện “Coffee Glass” cho điện thoại và laptop (thanh tab dưới trên điện thoại). Icon web/PWA/iOS sinh từ logo gốc `design/brand/logo-source.png`: `npm i --no-save sharp && npm run icons` (`scripts/make-icons.mjs`).

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

Tóm tắt: (1) bật GitHub Pages với nguồn “GitHub Actions”; (2) đặt Variables `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (chỉ anon/publishable key); (3) thêm `https://<user>.github.io/Note_mytasks/` vào Supabase Auth → URL Configuration; (4) push `main`. App được phục vụ dưới `/Note_mytasks/` (Vite `base: './'`, hash router nên không cần rewrite).

**Migration Ghi chú:** trang Ghi chú cần `supabase/migrations/20261009000700_notes.sql` (bảng `notes` + RLS + tìm kiếm toàn văn) cùng các migration sau nó (`000800`, `000900`…). Workflow Deploy tự `db push` khi có migration mới (cần duyệt environment `production`); chạy tay: `npm run db:push`. Chưa áp dụng thì trang Ghi chú báo lỗi, các trang khác vẫn chạy.

Kiểm thử: `npm test` (unit), `npm run test:integration` (cần `npx supabase start`, chỉ chạy với Supabase local).
