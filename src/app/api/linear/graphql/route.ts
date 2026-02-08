import { NextRequest, NextResponse } from 'next/server';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

export async function POST(req: NextRequest) {
  const { access_token, query, variables } = await req.json();

  const res = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${access_token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const err = await res.text();
    return NextResponse.json({ error: err }, { status: res.status });
  }

  const data = await res.json();
  return NextResponse.json(data);
}
