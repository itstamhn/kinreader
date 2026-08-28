export interface MagicLinkEmailOptions {
  to: string;
  magicUrl: string;
  code: string;
  apiKey: string;
  fromEmail?: string;
  fromName?: string;
}

export async function sendMagicLinkEmail({
  to,
  magicUrl,
  code,
  apiKey,
  fromEmail = 'login@mail.kinreader.com',
  fromName = 'KinReader',
}: MagicLinkEmailOptions) {
  const html = `
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #07070d; color: #ffffff; margin: 0; padding: 40px 20px; }
        .container { max-width: 520px; margin: 0 auto; background: #0f0e17; border: 1px solid #232238; border-radius: 24px; padding: 40px; text-align: center; }
        .logo { font-size: 24px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; margin-bottom: 24px; }
        .logo span { color: #a78bfa; }
        h1 { font-size: 22px; font-weight: 700; color: #ffffff; margin: 0 0 12px 0; }
        p { font-size: 15px; line-height: 1.6; color: #9ca3af; margin: 0 0 28px 0; }
        .btn { display: inline-block; background: linear-gradient(135deg, #7c3aed, #6366f1); color: #ffffff !important; text-decoration: none; font-weight: 700; font-size: 16px; padding: 14px 32px; border-radius: 9999px; box-shadow: 0 8px 20px rgba(124, 58, 237, 0.35); margin-bottom: 28px; }
        .code-box { background: #181726; border: 1px dashed #4338ca; border-radius: 12px; padding: 16px; margin: 20px 0; }
        .code-label { font-size: 11px; text-transform: uppercase; color: #a78bfa; font-weight: 700; letter-spacing: 1px; margin-bottom: 6px; }
        .code-val { font-size: 28px; font-weight: 800; letter-spacing: 6px; color: #34d399; font-family: monospace; }
        .footer { font-size: 12px; color: #6b7280; margin-top: 32px; border-top: 1px solid #1f1e30; padding-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">kinreader<span>.com</span></div>
        <h1>Sign in to KinReader</h1>
        <p>Tap the button below to instantly sign in and sync your reading queue across devices:</p>
        <a href="${magicUrl}" class="btn" target="_blank">✨ Sign In to KinReader</a>
        
        <div class="code-box">
          <div class="code-label">Or enter verification code</div>
          <div class="code-val">${code}</div>
        </div>

        <p style="font-size: 13px; color: #6b7280; margin-bottom: 0;">
          This link and code will expire in 15 minutes. If you did not request this email, you can safely ignore it.
        </p>

        <div class="footer">
          KinReader • Editorial Kinetic Audiobooks • <a href="https://kinreader.com" style="color: #a78bfa; text-decoration: none;">kinreader.com</a>
        </div>
      </div>
    </body>
  </html>
  `;

  // Fallback to active verified sending domain if primary is pending
  const sendEmail = async (senderEmail: string) => {
    return fetch('https://api.autosend.com/v1/mails/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: {
          email: senderEmail,
          name: fromName,
        },
        to: {
          email: to,
        },
        subject: '🎧 Your Magic Sign-in Link for KinReader',
        html,
      }),
    });
  };

  let res = await sendEmail(fromEmail);
  if (!res.ok) {
    // Retry with fallback verified domain
    res = await sendEmail('login@mail.itstamhn.com');
  }

  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as any).error?.message || 'Failed to send magic link email');
  }
  return data;
}
