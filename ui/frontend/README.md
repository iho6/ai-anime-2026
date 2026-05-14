This is a [Next.js](https://nextjs.org/) project bootstrapped with [`create-next-app`](https://github.com/vercel/next.js/tree/canary/packages/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Development server (one instance)

Next.js 16 allows **only one** `next dev` process per this project directory. Starting a second dev server (even on another port, for example `npx next dev --port 3999`) fails with **“Another next dev server is already running”** until the first instance stops.

- Prefer **`npm run dev`** (defaults to port **3000**; you can pass `npm run dev -- --port 3000`) or the repo launchers ([`dev.ps1`](../../../dev.ps1) / [`scripts/dev.ps1`](../../../scripts/dev.ps1)).
- Avoid leaving extra `next dev` processes running from smoke tests or agent terminals.
- If you hit the duplicate error, run **`npm run dev:stop-lock`** (Windows; uses PowerShell) to stop Next.js processes for this folder (it reads `.next/dev/lock` when possible, otherwise matches `node`/`next` command lines under this path), then start `npm run dev` again. On macOS or Linux, stop the terminal that is running `next dev` manually for now.
- Background: [SCAN_DUPLICATE_NEXT_DEV.md](./SCAN_DUPLICATE_NEXT_DEV.md).

This project uses [`next/font`](https://nextjs.org/docs/basic-features/font-optimization) to automatically optimize and load Inter, a custom Google Font.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js/) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/deployment) for more details.

## One-command Dev (Backend + Frontend)
From the repo root (`D:\Animation\anime2026`):

```powershell
.\dev.ps1
```

This starts:
- Backend: FastAPI/uvicorn on `http://127.0.0.1:8000`
- Frontend: Next.js dev server on `http://localhost:3000`

When you click **“Install Dependencies and Launch AI Anime Tool”** in the UI, Python dependency repair/installs run inside the same venv created by `.\dev.ps1` (avoids global `pip check` conflicts).

To stop everything, press `Ctrl+C` in the launcher(s).
