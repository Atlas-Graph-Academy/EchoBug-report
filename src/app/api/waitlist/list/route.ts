import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status') || 'all';
    const page = parseInt(searchParams.get('page') || '1', 10);
    const pageSize = parseInt(searchParams.get('pageSize') || '20', 10);
    const search = searchParams.get('search') || '';

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json(
        { error: 'Missing Supabase environment variables' },
        { status: 500 }
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: rows, error } = await supabase.rpc('get_waitlist_data', {
      p_status: status,
      p_search: search,
      p_page: page,
      p_page_size: pageSize,
    });

    if (error) {
      console.error('Error fetching waitlist:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const total = rows && rows.length > 0 ? rows[0].total_count : 0;

    return NextResponse.json({
      success: true,
      users: rows || [],
      total,
      page,
      pageSize,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    console.error('Waitlist API Error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
