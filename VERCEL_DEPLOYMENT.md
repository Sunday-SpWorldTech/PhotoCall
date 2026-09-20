# PhotoCall Vercel Deployment

## Backend

Create/use the Vercel project for the backend with:

- Root Directory: `backend`
- Node.js runtime
- Entry point: `api/index.js`
- Environment variables: use the values from `backend/.env` in Vercel Project Settings

The backend now exposes the main REST endpoints through the serverless function and the frontend checks `/api/config` to confirm that it is online.

## Frontend

Create/use the Vercel project for the frontend with:

- Root Directory: `frontend`
- Framework Preset: Vite
- Build Command: `npm run build`
- Output Directory: `dist`
- Environment variables: use the values from `frontend/.env`

The frontend package now includes `@mediapipe/tasks-vision@1.0.1`; Vercel installs it during the build.

## Environment files

The project package intentionally contains all four files:

- `backend/.env`
- `backend/.env.sample`
- `frontend/.env`
- `frontend/.env.sample`

Do not publish secret values in screenshots, README files, or frontend JavaScript. For production, put backend secrets in Vercel Environment Variables.
