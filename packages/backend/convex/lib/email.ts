/**
 * Kinreader Transactional & Lifecycle Email Module
 *
 * Implements deliverability & formatting standards from AutoSend email-skills:
 * - Table-based HTML structure for 100% email client compatibility (Outlook, Apple Mail, Gmail)
 * - Safe high-contrast typography that will NEVER wash out (dark text on clean light card)
 * - Explicit table bgcolor attributes + inline styles so clients cannot strip backgrounds
 * - Hidden preheader buffers with ZWNJ spacers
 * - Large accessible CTA buttons with fallback URL boxes
 * - Synchronized plain-text MIME alternatives
 * - RFC 8058 One-Click Unsubscribe headers for recurring digests
 */

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
  fromName?: string;
  fromEmail?: string;
  headers?: Record<string, string>;
}

const FROM_EMAIL = 'auth@mail.kinreader.com';
const FROM_NAME = 'Kinreader';
const APP_URL = 'https://app.kinreader.com';
const SUPPORT_URL = 'https://kinreader.com';

function baseEmailTemplate({
  subject,
  previewText,
  heading,
  bodyContentHtml,
  ctaHtml,
  secondaryHtml = '',
  footerHtml = '',
}: {
  subject: string;
  previewText: string;
  heading: string;
  bodyContentHtml: string;
  ctaHtml?: string;
  secondaryHtml?: string;
  footerHtml?: string;
}): string {
  const previewSpacer = '&nbsp;&zwnj;'.repeat(16);

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>${subject}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style type="text/css">
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
    body { margin: 0 !important; padding: 0 !important; width: 100% !important; background-color: #F4F5F7; }
    @media (prefers-color-scheme: dark) {
      .bg-body { background-color: #0B0C10 !important; }
      .bg-card { background-color: #14151C !important; border-color: #232530 !important; }
      .text-title { color: #F4F0E6 !important; }
      .text-body { color: #B0B3BC !important; }
      .text-muted { color: #7E828E !important; }
      .fallback-box { background-color: #0B0C10 !important; border-color: #1F2129 !important; }
      .footer-box { background-color: #0F1015 !important; border-color: #1C1E26 !important; }
    }
  </style>
</head>
<body class="bg-body" bgcolor="#F4F5F7" style="margin: 0; padding: 0; background-color: #F4F5F7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <!-- Preheader buffer -->
  <div style="display: none; max-height: 0px; overflow: hidden; mso-hide: all; font-size: 1px; line-height: 1px; color: #F4F5F7; opacity: 0;">
    ${previewText}
  </div>
  <div style="display: none; max-height: 0px; overflow: hidden; mso-hide: all; font-size: 1px; line-height: 1px;">
    ${previewSpacer}
  </div>

  <!-- Outer wrapper table -->
  <table role="presentation" class="bg-body" bgcolor="#F4F5F7" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #F4F5F7; width: 100%;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <!-- Card Container (max 520px) -->
        <table role="presentation" class="bg-card" bgcolor="#FFFFFF" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 520px; width: 100%; background-color: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.05);">
          
          <!-- Header Logo / Brand -->
          <tr>
            <td style="padding: 32px 32px 16px 32px; text-align: left;">
              <table role="presentation" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="background-color: #F2A33C; width: 12px; height: 12px; border-radius: 50%; display: inline-block; vertical-align: middle;"></td>
                  <td style="padding-left: 10px; font-size: 18px; font-weight: 700; color: #111827; letter-spacing: -0.02em;" class="text-title">
                    Kinreader
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 8px 32px 28px 32px;">
              <h1 class="text-title" style="margin: 0 0 12px 0; font-size: 22px; font-weight: 700; color: #111827; letter-spacing: -0.02em; line-height: 1.3;">
                ${heading}
              </h1>
              ${bodyContentHtml}

              ${ctaHtml ? ctaHtml : ''}

              ${secondaryHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td class="footer-box" bgcolor="#F9FAFB" style="padding: 20px 32px 24px 32px; background-color: #F9FAFB; border-top: 1px solid #E5E7EB; text-align: left;">
              <p style="margin: 0; font-size: 12px; line-height: 1.5; color: #6B7280;">
                Kinreader &middot; Rapid Kinetic RSVP Reader<br>
                <a href="${SUPPORT_URL}" target="_blank" rel="noopener noreferrer" style="color: #4B5563; text-decoration: none;">kinreader.com</a>
              </p>
              ${footerHtml}
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * 1. Magic Link Authentication Email
 */
export function renderMagicLinkEmail({
  url,
}: {
  url: string;
  email: string;
}): { subject: string; html: string; text: string } {
  const subject = 'Sign in to Kinreader';
  const previewText = 'Your secure one-click sign in link for Kinreader. Link expires in 15 minutes.';

  const bodyContentHtml = `
    <p class="text-body" style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.6; color: #374151;">
      Click the button below to sign in to Kinreader. This link is valid for <strong style="color: #111827;">15 minutes</strong> and can only be used once.
    </p>
  `;

  const ctaHtml = `
    <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin: 28px 0 24px 0;">
      <tr>
        <td align="center" bgcolor="#F2A33C" style="border-radius: 10px; background-color: #F2A33C;">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:48px;v-text-anchor:middle;width:220px;" arcsize="20%" stroke="f" fillcolor="#F2A33C">
            <w:anchorlock/>
            <center style="color:#111827;font-family:sans-serif;font-size:15px;font-weight:bold;">Sign in to Kinreader &rarr;</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-->
          <a href="${url}" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 14px 28px; font-size: 15px; font-weight: 700; color: #111827; text-decoration: none; border-radius: 10px; line-height: 100%;">
            Sign in to Kinreader &rarr;
          </a>
          <!--<![endif]-->
        </td>
      </tr>
    </table>
  `;

  const secondaryHtml = `
    <p class="text-muted" style="margin: 24px 0 8px 0; font-size: 13px; line-height: 1.5; color: #6B7280;">
      If the button above doesn't work, copy and paste this URL into your browser:
    </p>
    <div class="fallback-box" bgcolor="#F9FAFB" style="background-color: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px; padding: 12px 14px; margin-bottom: 24px;">
      <a href="${url}" target="_blank" rel="noopener noreferrer" style="font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: #D97706; text-decoration: none; word-break: break-all; line-height: 1.4;">
        ${url}
      </a>
    </div>
    <p class="text-muted" style="margin: 0; padding-top: 16px; border-top: 1px solid #E5E7EB; font-size: 13px; line-height: 1.5; color: #6B7280;">
      If you didn't request this sign-in link, you can safely ignore this email. Your account remains secure.
    </p>
  `;

  const html = baseEmailTemplate({
    subject,
    previewText,
    heading: 'Sign in to your account',
    bodyContentHtml,
    ctaHtml,
    secondaryHtml,
  });

  const text = `Sign in to Kinreader

Click the link below to sign in to your Kinreader account:
${url}

This link is valid for 15 minutes and can only be used once.

If you didn't request this sign-in link, you can safely ignore this email. Your account remains secure.

---
Kinreader · Rapid Kinetic RSVP Reader
${SUPPORT_URL}
`;

  return { subject, html, text };
}

/**
 * 2. Welcome & Quickstart Onboarding Email
 */
export function renderWelcomeEmail({
  name,
  appUrl = APP_URL,
}: {
  name?: string;
  email: string;
  appUrl?: string;
}): { subject: string; html: string; text: string } {
  const firstName = name ? name.split(' ')[0] : 'there';
  const subject = 'Welcome to Kinreader ⚡️';
  const previewText = 'Read 2-3x faster with rapid kinetic RSVP reading and neural speech.';

  const bodyContentHtml = `
    <p class="text-body" style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: #374151;">
      Hi ${firstName}, welcome! Kinreader helps you absorb long articles, papers, and newsletters in minutes using rapid Rapid Serial Visual Presentation (RSVP).
    </p>
    
    <div style="background-color: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 18px 20px; margin: 20px 0;">
      <p style="margin: 0 0 10px 0; font-size: 14px; font-weight: 700; color: #111827;">
        ⚡️ Pro Keyboard Shortcuts:
      </p>
      <ul style="margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.8; color: #4B5563;">
        <li><strong style="color: #111827;">Spacebar:</strong> Play or pause playback</li>
        <li><strong style="color: #111827;">← / → :</strong> Skip back or forward sentence by sentence</li>
        <li><strong style="color: #111827;">↑ / ↓ :</strong> Adjust reading speed (WPM)</li>
        <li><strong style="color: #111827;">Paste (⌘V / Ctrl+V):</strong> Paste any article URL anywhere in the app to narrate instantly</li>
      </ul>
    </div>
  `;

  const ctaHtml = `
    <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin: 24px 0 16px 0;">
      <tr>
        <td align="center" bgcolor="#F2A33C" style="border-radius: 10px; background-color: #F2A33C;">
          <a href="${appUrl}" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 14px 28px; font-size: 15px; font-weight: 700; color: #111827; text-decoration: none; border-radius: 10px; line-height: 100%;">
            Start Reading Now &rarr;
          </a>
        </td>
      </tr>
    </table>
  `;

  const secondaryHtml = `
    <p class="text-muted" style="margin: 16px 0 0 0; font-size: 13px; line-height: 1.5; color: #6B7280;">
      Have feedback or questions? Simply reply directly to this email — I read every response.
    </p>
  `;

  const html = baseEmailTemplate({
    subject,
    previewText,
    heading: `Welcome to Kinreader, ${firstName}`,
    bodyContentHtml,
    ctaHtml,
    secondaryHtml,
  });

  const text = `Welcome to Kinreader!

Hi ${firstName},

Kinreader helps you absorb articles, papers, and essays in minutes using rapid RSVP kinetic reading.

⚡️ Pro Shortcuts:
- Spacebar: Play / pause playback
- Left / Right arrows: Skip backward / forward by sentence
- Up / Down arrows: Adjust tempo (WPM)
- Global Paste: Copy any URL and press Cmd+V anywhere in the app to narrate instantly

Open Kinreader and start reading:
${appUrl}

Have questions or feedback? Reply directly to this email!

---
Kinreader · Rapid Kinetic RSVP Reader
${SUPPORT_URL}
`;

  return { subject, html, text };
}

/**
 * 3. Weekly Reading Digest Email
 */
export function renderWeeklyDigestEmail({
  name,
  stats,
  queueCount = 0,
  appUrl = APP_URL,
  unsubscribeUrl,
}: {
  name?: string;
  email: string;
  stats: {
    wordsRead: number;
    articlesCompleted: number;
    timeSavedMinutes: number;
  };
  queueCount?: number;
  appUrl?: string;
  unsubscribeUrl?: string;
}): { subject: string; html: string; text: string } {
  const firstName = name ? name.split(' ')[0] : 'there';
  const subject = `Your Kinreader Weekly Digest: ${stats.timeSavedMinutes}m saved ⚡️`;
  const previewText = `You completed ${stats.articlesCompleted} articles and read ${stats.wordsRead.toLocaleString()} words this week.`;

  const bodyContentHtml = `
    <p class="text-body" style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.6; color: #374151;">
      Here is your reading summary for the past week:
    </p>

    <!-- Stats Table Grid -->
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-bottom: 24px;">
      <tr>
        <td width="33%" align="center" bgcolor="#F9FAFB" style="padding: 16px 12px; border: 1px solid #E5E7EB; border-radius: 10px; background-color: #F9FAFB;">
          <div style="font-size: 22px; font-weight: 700; color: #F2A33C; line-height: 1.2;">
            ${stats.timeSavedMinutes}m
          </div>
          <div style="font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase; margin-top: 4px;">
            Time Saved
          </div>
        </td>
        <td width="5%"></td>
        <td width="33%" align="center" bgcolor="#F9FAFB" style="padding: 16px 12px; border: 1px solid #E5E7EB; border-radius: 10px; background-color: #F9FAFB;">
          <div style="font-size: 22px; font-weight: 700; color: #111827; line-height: 1.2;">
            ${stats.articlesCompleted}
          </div>
          <div style="font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase; margin-top: 4px;">
            Completed
          </div>
        </td>
        <td width="5%"></td>
        <td width="33%" align="center" bgcolor="#F9FAFB" style="padding: 16px 12px; border: 1px solid #E5E7EB; border-radius: 10px; background-color: #F9FAFB;">
          <div style="font-size: 22px; font-weight: 700; color: #111827; line-height: 1.2;">
            ${stats.wordsRead > 1000 ? `${(stats.wordsRead / 1000).toFixed(1)}k` : stats.wordsRead}
          </div>
          <div style="font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase; margin-top: 4px;">
            Words Read
          </div>
        </td>
      </tr>
    </table>

    ${queueCount > 0 ? `
    <p class="text-body" style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; color: #4B5563;">
      📚 You have <strong style="color: #111827;">${queueCount} article${queueCount === 1 ? '' : 's'}</strong> waiting in your playlist.
    </p>` : ''}
  `;

  const ctaHtml = `
    <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin: 20px 0 16px 0;">
      <tr>
        <td align="center" bgcolor="#F2A33C" style="border-radius: 10px; background-color: #F2A33C;">
          <a href="${appUrl}" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 14px 28px; font-size: 15px; font-weight: 700; color: #111827; text-decoration: none; border-radius: 10px; line-height: 100%;">
            Open Your Reading Queue &rarr;
          </a>
        </td>
      </tr>
    </table>
  `;

  const footerHtml = unsubscribeUrl ? `
    <p style="margin: 12px 0 0 0; font-size: 11px; color: #9CA3AF;">
      Don't want weekly digests? <a href="${unsubscribeUrl}" target="_blank" rel="noopener noreferrer" style="color: #6B7280; text-decoration: underline;">Unsubscribe</a>
    </p>
  ` : '';

  const html = baseEmailTemplate({
    subject,
    previewText,
    heading: `Weekly Reading Digest, ${firstName}`,
    bodyContentHtml,
    ctaHtml,
    footerHtml,
  });

  const text = `Your Kinreader Weekly Digest

Hi ${firstName},

Here is your reading summary for the past week:
- Time Saved: ${stats.timeSavedMinutes} minutes
- Articles Completed: ${stats.articlesCompleted}
- Words Read: ${stats.wordsRead.toLocaleString()}
${queueCount > 0 ? `- Unread Queue: ${queueCount} article(s) waiting\n` : ''}
Continue reading in your library:
${appUrl}

${unsubscribeUrl ? `Unsubscribe from weekly digests: ${unsubscribeUrl}\n` : ''}
---
Kinreader · Rapid Kinetic RSVP Reader
${SUPPORT_URL}
`;

  return { subject, html, text };
}

/**
 * 4. Security & Account Alert Email
 */
export function renderSecurityAlertEmail({
  name,
  eventType = 'New sign-in',
  ipAddress,
  userAgent,
  timestamp = Date.now(),
  appUrl = APP_URL,
}: {
  name?: string;
  email: string;
  eventType?: string;
  ipAddress?: string;
  userAgent?: string;
  timestamp?: number;
  appUrl?: string;
}): { subject: string; html: string; text: string } {
  const firstName = name ? name.split(' ')[0] : 'there';
  const subject = `Security Alert: ${eventType} to Kinreader`;
  const previewText = `We detected a ${eventType.toLowerCase()} to your Kinreader account.`;
  const timeFormatted = new Date(timestamp).toUTCString();

  const bodyContentHtml = `
    <p class="text-body" style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: #374151;">
      Hi ${firstName}, we detected a <strong style="color: #111827;">${eventType}</strong> for your Kinreader account.
    </p>

    <div style="background-color: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 18px; margin: 18px 0;">
      <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="4" style="font-size: 13px; color: #4B5563;">
        <tr>
          <td width="30%" style="font-weight: 600; color: #6B7280;">Time (UTC):</td>
          <td style="color: #111827;">${timeFormatted}</td>
        </tr>
        ${ipAddress ? `
        <tr>
          <td style="font-weight: 600; color: #6B7280;">IP Address:</td>
          <td style="color: #111827; font-family: monospace;">${ipAddress}</td>
        </tr>` : ''}
        ${userAgent ? `
        <tr>
          <td style="font-weight: 600; color: #6B7280;">Device / Client:</td>
          <td style="color: #111827;">${userAgent}</td>
        </tr>` : ''}
      </table>
    </div>

    <p class="text-body" style="margin: 18px 0 0 0; font-size: 14px; line-height: 1.6; color: #374151;">
      If this was you, you can safely ignore this alert. If you did not perform this action, please secure your account immediately.
    </p>
  `;

  const ctaHtml = `
    <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin: 20px 0 16px 0;">
      <tr>
        <td align="center" bgcolor="#111827" style="border-radius: 10px; background-color: #111827;">
          <a href="${appUrl}" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 14px 28px; font-size: 14px; font-weight: 700; color: #FFFFFF; text-decoration: none; border-radius: 10px; line-height: 100%;">
            Review Account Security &rarr;
          </a>
        </td>
      </tr>
    </table>
  `;

  const html = baseEmailTemplate({
    subject,
    previewText,
    heading: 'Security Alert',
    bodyContentHtml,
    ctaHtml,
  });

  const text = `Security Alert: ${eventType}

Hi ${firstName},

We detected a ${eventType.toLowerCase()} for your Kinreader account.

Time (UTC): ${timeFormatted}
${ipAddress ? `IP Address: ${ipAddress}\n` : ''}${userAgent ? `Device: ${userAgent}\n` : ''}
If this was you, you can safely ignore this alert. If not, please review your account:
${appUrl}

---
Kinreader · Rapid Kinetic RSVP Reader
${SUPPORT_URL}
`;

  return { subject, html, text };
}

/**
 * Sends an email using AutoSend API.
 */
export async function sendEmail({
  to,
  subject,
  html,
  text,
  fromName = FROM_NAME,
  fromEmail = FROM_EMAIL,
  headers,
}: EmailPayload): Promise<void> {
  const apiKey = process.env.AUTOSEND_API_KEY;
  if (!apiKey) {
    console.log(`[EMAIL DEV MOCK] To: ${to} | Subject: "${subject}"\n${text}`);
    return;
  }

  const payload: Record<string, any> = {
    from: { email: emailNormalize(fromEmail), name: fromName },
    to: { email: to },
    subject,
    html,
    text,
  };

  if (headers && Object.keys(headers).length > 0) {
    payload.headers = headers;
  }

  const res = await fetch('https://api.autosend.com/v1/mails/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    console.error('AutoSend API error:', res.status, errorBody);
    throw new Error(`Failed to send email via AutoSend (${res.status}): ${errorBody}`);
  }
}

function emailNormalize(email: string): string {
  return email.trim().toLowerCase();
}
