import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getInviteConfig() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const smtpUser = process.env.SMTP_USER;
  const smtpAppPassword = process.env.SMTP_APP_PASSWORD;
  const inviteFromEmail = process.env.INVITE_FROM_EMAIL || smtpUser;
  const inviteReplyTo = process.env.INVITE_REPLY_TO;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase environment variables');
  }
  if (!smtpUser || !smtpAppPassword) {
    throw new Error('Missing SMTP environment variables');
  }
  if (!inviteFromEmail) {
    throw new Error('Missing sender email');
  }

  const normalizedSender = inviteFromEmail.trim().toLowerCase();
  const defaultName =
    normalizedSender === 'echo@iditor.com' ? 'Kobe from Iditor' : 'Iditor Team';
  const inviteFromName = process.env.INVITE_FROM_NAME || defaultName;

  return {
    supabaseUrl,
    serviceRoleKey,
    smtpUser,
    smtpAppPassword,
    inviteFromEmail,
    inviteFromName,
    inviteReplyTo,
  };
}

export async function POST(req: NextRequest) {
  try {
    const { ids } = await req.json();
    if (!ids || !Array.isArray(ids)) {
      return NextResponse.json({ error: 'Missing ids array' }, { status: 400 });
    }

    const cfg = getInviteConfig();
    const supabase = createClient(cfg.supabaseUrl, cfg.serviceRoleKey);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: cfg.smtpUser,
        pass: cfg.smtpAppPassword,
      },
    });

    const results = await Promise.allSettled(
      ids.map(async (id: string) => {
        const { data: userRows, error: fetchError } = await supabase.rpc('get_waitlist_user', {
          p_id: id,
        });

        if (fetchError) {
          throw new Error(`RPC Error: ${fetchError.message}`);
        }
        if (!userRows || userRows.length === 0) {
          throw new Error(`User not found: ${id}`);
        }

        const user = userRows[0];
        const code = 'Va0Qm';
        const subject = 'Your Iditor Echo invitation code';

        const text = `Hi ${user.name},

You requested access to Iditor Echo, and we're ready for you.

Your access code is: ${code}

You can redeem it here:
https://apps.apple.com/us/app/echochat/id6736381852

If you have any questions, feel free to reply to this email.

Best,
The Iditor Team`;

        const html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; line-height: 1.6; color: #333;">
          <p>Hi ${user.name},</p>
          <p>Thanks for waiting. We're ready to let you into <strong>Iditor Echo</strong>.</p>
          <p>Here is your access code:</p>
          
          <div style="background-color: #f5f5f5; border: 1px solid #ddd; border-radius: 4px; padding: 12px; margin: 20px 0; text-align: center;">
            <span style="font-family: monospace; font-size: 24px; font-weight: bold; letter-spacing: 2px; color: #000; user-select: all;">${code}</span>
          </div>

          <p>You can use this code to sign up here:</p>
          <p><a href="https://apps.apple.com/us/app/echochat/id6736381852" style="color: #007bff; text-decoration: none;">EchoChat @ Iditor Inc.</a></p>
          <hr style="border: 0; border-top: 1px solid #eee; margin: 30px 0;">
          <p style="font-size: 12px; color: #888;">Iditor Inc.</p>
        </div>
      `;

        const mailOptions = {
          from: `"${cfg.inviteFromName}" <${cfg.inviteFromEmail}>`,
          to: user.email,
          subject,
          text,
          html,
          headers: { 'X-Entity-Ref-ID': id },
          ...(cfg.inviteReplyTo ? { replyTo: cfg.inviteReplyTo } : {}),
        };

        await transporter.sendMail(mailOptions);

        const { error: updateError } = await supabase.rpc('update_waitlist_invite', {
          p_id: id,
          p_code: code,
        });
        if (updateError) {
          throw new Error(`Invite update failed: ${updateError.message}`);
        }

        return { id, email: user.email };
      })
    );

    const successful = results
      .filter((r): r is PromiseFulfilledResult<{ id: string; email: string }> => r.status === 'fulfilled')
      .map((r) => r.value);
    const failed = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));

    return NextResponse.json({
      success: true,
      invited: successful.length,
      failed: failed.length,
      details: successful,
      errors: failed,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    console.error('Waitlist Invite Error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
