import { describe, expect, it, spyOn, afterEach } from 'bun:test';
import {
  renderMagicLinkEmail,
  renderWelcomeEmail,
  renderWeeklyDigestEmail,
  renderSecurityAlertEmail,
  sendEmail,
} from './email';

describe('renderMagicLinkEmail', () => {
  const testUrl = 'https://app.kinreader.com/auth/verify?token=xyz123abc';
  const testEmail = 'user@example.com';

  it('renders a subject under 60 characters with clear transactional intent', () => {
    const { subject } = renderMagicLinkEmail({ url: testUrl, email: testEmail });
    expect(subject).toBe('Sign in to Kinreader');
    expect(subject.length).toBeLessThan(60);
  });

  it('includes invisible preheader text with ZWNJ spacers in HTML', () => {
    const { html } = renderMagicLinkEmail({ url: testUrl, email: testEmail });
    expect(html).toContain('Your secure one-click sign in link for Kinreader');
    expect(html).toContain('&zwnj;');
    expect(html).toContain('mso-hide: all');
  });

  it('embeds the target magic link URL in HTML button and monospace fallback block', () => {
    const { html } = renderMagicLinkEmail({ url: testUrl, email: testEmail });
    expect(html).toContain(`href="${testUrl}"`);
    expect(html).toContain('word-break: break-all');
  });

  it('includes link expiration and security reassurance', () => {
    const { html, text } = renderMagicLinkEmail({ url: testUrl, email: testEmail });
    expect(html).toContain('15 minutes');
    expect(html).toContain("If you didn't request this sign-in link");
    expect(text).toContain('15 minutes');
    expect(text).toContain("If you didn't request this sign-in link");
  });

  it('produces a structured plain-text alternative matching the HTML content', () => {
    const { text } = renderMagicLinkEmail({ url: testUrl, email: testEmail });
    expect(text).toContain('Sign in to Kinreader');
    expect(text).toContain(testUrl);
    expect(text).toContain('Kinreader · Rapid Kinetic RSVP Reader');
  });
});

describe('renderWelcomeEmail', () => {
  it('renders personalized welcome greeting and essential kinetic shortcuts', () => {
    const { subject, html, text } = renderWelcomeEmail({
      email: 'reader@example.com',
      name: 'Ada Lovelace',
      appUrl: 'https://app.kinreader.com',
    });

    expect(subject).toBe('Welcome to Kinreader ⚡️');
    expect(html).toContain('Welcome to Kinreader, Ada');
    expect(html).toContain('Spacebar');
    expect(html).toContain('Paste (⌘V / Ctrl+V)');
    expect(text).toContain('Hi Ada');
    expect(text).toContain('Spacebar: Play / pause');
  });

  it('falls back gracefully when name is not provided', () => {
    const { html, text } = renderWelcomeEmail({
      email: 'reader@example.com',
    });

    expect(html).toContain('Welcome to Kinreader, there');
    expect(text).toContain('Hi there');
  });
});

describe('renderWeeklyDigestEmail', () => {
  it('renders formatted reading statistics, time saved, and unread queue count', () => {
    const { subject, html, text } = renderWeeklyDigestEmail({
      email: 'reader@example.com',
      name: 'Alan Turing',
      stats: {
        wordsRead: 14250,
        articlesCompleted: 4,
        timeSavedMinutes: 38,
      },
      queueCount: 3,
      appUrl: 'https://app.kinreader.com',
      unsubscribeUrl: 'https://app.kinreader.com/api/unsubscribe?email=reader%40example.com',
    });

    expect(subject).toContain('38m saved ⚡️');
    expect(html).toContain('38m');
    expect(html).toContain('Time Saved');
    expect(html).toContain('14.3k'); // formatted words
    expect(html).toContain('3 articles');
    expect(html).toContain('Unsubscribe');
    expect(text).toContain('Time Saved: 38 minutes');
    expect(text).toContain('Unread Queue: 3 article(s) waiting');
  });
});

describe('renderSecurityAlertEmail', () => {
  it('renders clear, calm security alert with event context and timestamp', () => {
    const { subject, html, text } = renderSecurityAlertEmail({
      email: 'reader@example.com',
      name: 'Grace Hopper',
      eventType: 'New sign-in from Chrome on macOS',
      ipAddress: '198.51.100.42',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      timestamp: 1724932800000,
    });

    expect(subject).toContain('Security Alert');
    expect(html).toContain('Grace');
    expect(html).toContain('198.51.100.42');
    expect(html).toContain('Review Account Security');
    expect(text).toContain('198.51.100.42');
  });
});

describe('sendEmail', () => {
  const originalEnv = process.env.AUTOSEND_API_KEY;
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env.AUTOSEND_API_KEY = originalEnv;
    global.fetch = originalFetch;
  });

  it('logs in dev mode when AUTOSEND_API_KEY is not set', async () => {
    delete process.env.AUTOSEND_API_KEY;
    const logSpy = spyOn(console, 'log');

    await sendEmail({
      to: 'reader@example.com',
      subject: 'Test Subject',
      html: '<p>Test</p>',
      text: 'Test',
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[EMAIL DEV MOCK] To: reader@example.com')
    );
    logSpy.mockRestore();
  });

  it('passes RFC 8058 List-Unsubscribe headers to AutoSend API payload', async () => {
    process.env.AUTOSEND_API_KEY = 'test_key';
    let payload: any = null;

    global.fetch = (async (_url: string, init?: any) => {
      payload = JSON.parse(init.body);
      return new Response(JSON.stringify({ status: 'success' }), { status: 200 });
    }) as any;

    await sendEmail({
      to: 'reader@example.com',
      subject: 'Digest',
      html: '<p>Digest</p>',
      text: 'Digest',
      headers: {
        'List-Unsubscribe': '<https://app.kinreader.com/api/unsubscribe>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    expect(payload.headers).toEqual({
      'List-Unsubscribe': '<https://app.kinreader.com/api/unsubscribe>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });
});
