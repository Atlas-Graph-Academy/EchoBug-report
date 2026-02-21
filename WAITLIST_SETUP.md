# Waitlist Dashboard Setup

## Routes
- Dashboard UI: `/waitlist/dashboard`
- APIs:
  - `GET /api/waitlist/list`
  - `POST /api/waitlist/status`
  - `POST /api/waitlist/invite`

## Environment Variables
Add these to `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SMTP_USER=
SMTP_APP_PASSWORD=
INVITE_FROM_EMAIL=
INVITE_FROM_NAME=
INVITE_REPLY_TO=
```

Notes:
- If `INVITE_FROM_NAME` is not set and sender email is `echo@iditor.com`, sender name defaults to `Kobe from Iditor`.
- If `INVITE_FROM_EMAIL` is not set, it falls back to `SMTP_USER`.

## SQL Setup
Run in your Supabase SQL editor:
1. `sql/add_invitation_to_waitlist.sql`
2. `sql/waitlist_rpc_wrappers.sql`

These scripts assume table `waitlist.signups` already exists.
