# Note_mytasks

## Deploy

Không cần server: GitHub Actions kiểm tra + build, GitHub Pages phục vụ web tĩnh, Supabase lo Auth/Database.

- **Pull Request** → [CI](.github/workflows/ci.yml): `vite build` + áp dụng thử toàn bộ migration trên Supabase local.
- **Push `main`** → [Deploy](.github/workflows/deploy.yml): CI → `supabase db push` (chỉ khi có migration mới, cần duyệt) → build → GitHub Pages.

Thiết lập một lần (Pages, environment `production`, Secrets/Variables, Auth URL) và quy tắc an toàn database: xem [docs/DEPLOY.md](docs/DEPLOY.md).
