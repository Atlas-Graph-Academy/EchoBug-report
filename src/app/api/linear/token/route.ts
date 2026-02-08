import { NextRequest, NextResponse } from 'next/server';

const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';
const CLIENT_ID = process.env.LINEAR_CLIENT_ID!;

export async function POST(req: NextRequest) {
  const { code, code_verifier, redirect_uri } = await req.json();

  const res = await fetch(LINEAR_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri,
      client_id: CLIENT_ID,
      code_verifier,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return NextResponse.json({ error: err }, { status: res.status });
  }

  const tokens = await res.json();
  return NextResponse.json(tokens);
}
