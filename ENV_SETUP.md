# PhotoCall environment files

Both application folders contain `.env` and `.env.sample`:

- `backend/.env` — local backend runtime values.
- `backend/.env.sample` — safe deployment template.
- `frontend/.env` — local Vite configuration.
- `frontend/.env.sample` — safe Vite deployment template.

The real `.env` files are intentionally ignored by Git so credentials are not published to the public repository. Put the same values in the corresponding Vercel Environment Variables for deployed projects.
