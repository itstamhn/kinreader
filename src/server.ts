import { Spiceflow } from 'spiceflow';
import { z } from 'zod';
import { sendMagicLinkEmail } from './lib/autosend';

// Ephemeral memory store for pending auth requests (15-min TTL)
const authCodes = new Map<string, { code: string; token: string; expires: number }>();

export const app = new Spiceflow()
  // Health Check
  .get('/api/health', () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }))

  // 0. AutoSend Magic Sign-In Email Endpoint
  .post('/api/auth/magic-link', async ({ request }) => {
    try {
      const body = await request.json();
      const email = body.email?.trim().toLowerCase();

      if (!email || !email.includes('@')) {
        return new Response(JSON.stringify({ error: 'Valid email address is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const env = ((request as any).env || (typeof process !== 'undefined' ? process.env : {})) || {};
      const autosendKey = env.AUTOSEND_API_KEY || body.autosendApiKey;

      if (!autosendKey) {
        return new Response(JSON.stringify({ error: 'AutoSend API key is not configured' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Generate 6-digit code + secure token
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const token = crypto.randomUUID();
      const expires = Date.now() + 15 * 60 * 1000; // 15 minutes

      authCodes.set(email, { code, token, expires });

      const urlObj = new URL(request.url);
      const magicUrl = `${urlObj.origin}/?auth_token=${token}&email=${encodeURIComponent(email)}`;

      await sendMagicLinkEmail({
        to: email,
        magicUrl,
        code,
        apiKey: autosendKey,
        fromEmail: 'login@mail.kinreader.com',
        fromName: 'KinReader',
      });

      return {
        success: true,
        message: `Magic link sent to ${email}`,
      };
    } catch (err: any) {
      console.error('Magic link error:', err);
      return new Response(JSON.stringify({ error: err.message || 'Failed to send magic link' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  })

  // 0.1 Verify Magic Link or Code
  .post('/api/auth/verify', async ({ request }) => {
    try {
      const body = await request.json();
      const email = body.email?.trim().toLowerCase();
      const code = body.code?.trim();
      const token = body.token?.trim();

      if (!email) {
        return new Response(JSON.stringify({ error: 'Email is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const record = authCodes.get(email);
      if (!record || Date.now() > record.expires) {
        return new Response(JSON.stringify({ error: 'Invalid or expired verification code' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const isValid = (code && record.code === code) || (token && record.token === token);
      if (!isValid) {
        return new Response(JSON.stringify({ error: 'Incorrect verification code' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Clear used code
      authCodes.delete(email);

      const username = email.split('@')[0];
      return {
        success: true,
        user: {
          email,
          name: username.charAt(0).toUpperCase() + username.slice(1),
          avatar: `https://unavatar.io/${encodeURIComponent(email)}`,
          tier: 'pro',
        },
      };
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message || 'Verification failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  })

  // 0.2 Google OAuth Initiation Endpoint
  .get('/api/auth/google', ({ request }) => {
    const env = ((request as any).env || (typeof process !== 'undefined' ? process.env : {})) || {};
    const clientId = env.GOOGLE_CLIENT_ID;

    const urlObj = new URL(request.url);
    const redirectUri = `${urlObj.origin}/api/auth/google/callback`;

    if (!clientId) {
      // If GOOGLE_CLIENT_ID is not configured yet, redirect with helpful query
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${urlObj.origin}/?auth_error=${encodeURIComponent('Google Client ID is not configured yet')}`,
        },
      });
    }

    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(
      clientId
    )}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20email%20profile&prompt=select_account`;

    return new Response(null, {
      status: 302,
      headers: { Location: googleAuthUrl },
    });
  })

  // 0.3 Google OAuth Callback Endpoint
  .get('/api/auth/google/callback', async ({ request }) => {
    const urlObj = new URL(request.url);
    const code = urlObj.searchParams.get('code');
    const env = ((request as any).env || (typeof process !== 'undefined' ? process.env : {})) || {};
    const clientId = env.GOOGLE_CLIENT_ID;
    const clientSecret = env.GOOGLE_CLIENT_SECRET;
    const redirectUri = `${urlObj.origin}/api/auth/google/callback`;

    if (!code || !clientId || !clientSecret) {
      return new Response(null, {
        status: 302,
        headers: { Location: `${urlObj.origin}/?auth_error=Missing+Google+credentials` },
      });
    }

    try {
      // Exchange authorization code for tokens
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });

      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        throw new Error(tokenData.error_description || 'Failed to exchange Google token');
      }

      // Fetch Google User Profile
      const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const googleUser = await userRes.json();

      const email = googleUser.email?.toLowerCase();
      const token = crypto.randomUUID();
      const expires = Date.now() + 15 * 60 * 1000;

      // Register session
      authCodes.set(email, { code: 'GOOGLE_OAUTH', token, expires });

      const returnUrl = `${urlObj.origin}/?auth_token=${token}&email=${encodeURIComponent(
        email
      )}&name=${encodeURIComponent(googleUser.name || '')}&avatar=${encodeURIComponent(googleUser.picture || '')}`;

      return new Response(null, {
        status: 302,
        headers: { Location: returnUrl },
      });
    } catch (err: any) {
      console.error('Google OAuth error:', err);
      return new Response(null, {
        status: 302,
        headers: { Location: `${urlObj.origin}/?auth_error=${encodeURIComponent(err.message)}` },
      });
    }
  })

  // 1. Article / X Post Extractor Endpoint
  .post('/api/extract', async ({ request }) => {
    try {
      const body = await request.json();
      const url = body.url?.trim();

      if (!url) {
        return new Response(JSON.stringify({ error: 'URL is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Detect Twitter / X
      const isTwitter = /twitter\.com|x\.com|fxtwitter\.com|fixupx\.com/i.test(url);

      let title = 'Article';
      let content = '';
      let author = isTwitter ? 'X Post' : 'Article';
      let authorHandle = '';
      let authorAvatar = '';
      let image: string | undefined = undefined;

      const env = ((request as any).env || (typeof process !== 'undefined' ? process.env : {})) || {};
      const monidApiKey = body.monidApiKey || env.MONID_API_KEY;

      // 0. DEDICATED X / TWITTER ARTICLE & TWEET EXTRACTOR
      const xMatch = url.match(/(?:twitter\.com|x\.com|fxtwitter\.com|fixupx\.com)\/([a-zA-Z0-9_]+)\/status\/([0-9]+)/i);
      if (xMatch) {
        const username = xMatch[1];
        const statusId = xMatch[2];
        try {
          const fxRes = await fetch(`https://api.fxtwitter.com/${username}/status/${statusId}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'application/json',
            },
          });
          if (fxRes.ok) {
            const fxData = await fxRes.json();
            const tweet = fxData?.tweet;
            if (tweet) {
              author = tweet.author?.name ? `${tweet.author.name}` : `${username} on X`;
              authorHandle = `@${tweet.author?.screen_name || username}`;
              authorAvatar = tweet.author?.avatar_url || `https://unavatar.io/x/${username}`;

              // Handle Long-Form X Articles (e.g. Jacob Posel, Dan Koe articles)
              if (tweet.article?.content?.blocks && Array.isArray(tweet.article.content.blocks)) {
                title = tweet.article.title || tweet.text || 'X Article';
                content = tweet.article.content.blocks
                  .map((b: any) => b.text)
                  .filter(Boolean)
                  .join('\n\n');
                image = tweet.article.cover_media?.media_info?.original_img_url ||
                        tweet.article.media_entities?.[0]?.media_info?.original_img_url ||
                        tweet.media?.photos?.[0]?.url;
              } else {
                title = tweet.text ? tweet.text.slice(0, 90) : 'X Post';
                content = tweet.text || '';
                image = tweet.media?.photos?.[0]?.url;
              }
            }
          }
        } catch (err) {
          console.warn('fxTwitter API extraction error', err);
        }
      }

      // 1. PRIMARY: Monid TinyFish /fetch (Free, fast real-browser markdown extraction)
      if (!content && monidApiKey) {
        try {
          const monidRunRes = await fetch('https://api.monid.ai/v1/run', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${monidApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              provider: 'tinyfish',
              endpoint: '/fetch',
              input: { body: { urls: [url], format: 'markdown' } },
            }),
          });

          if (monidRunRes.ok) {
            const runData = await monidRunRes.json();
            if (runData.status === 'COMPLETED' && runData.output?.results?.[0]) {
              const res = runData.output.results[0];
              title = res.title || title;
              content = res.text || '';
              if (res.author) author = res.author;
            } else if (runData.runId) {
              // Quick poll (max 3s)
              for (let i = 0; i < 3; i++) {
                await new Promise((r) => setTimeout(r, 800));
                const pollRes = await fetch(`https://api.monid.ai/v1/runs/${runData.runId}`, {
                  headers: { 'Authorization': `Bearer ${monidApiKey}` },
                });
                if (pollRes.ok) {
                  const pollData = await pollRes.json();
                  if (pollData.status === 'COMPLETED' && pollData.output?.results?.[0]) {
                    const res = pollData.output.results[0];
                    title = res.title || title;
                    content = res.text || '';
                    if (res.author) author = res.author;
                    break;
                  }
                }
              }
            }
          }
        } catch (err) {
          console.warn('Monid TinyFish fetch error, falling back to direct parser', err);
        }
      }

      // 2. Fallback: Direct HTML parser for OpenGraph metadata & clean text extraction
      if (!content) {
        try {
          const rawRes = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
          });

        if (rawRes.ok) {
          const html = await rawRes.text();

          // Extract OG Metadata
          const ogTitleMatch = html.match(/<meta\s+(?:property|name)=["'](?:og:title|twitter:title)["']\s+content=["']([^"']+)["']/i);
          const titleTagMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          if (ogTitleMatch) title = ogTitleMatch[1].trim();
          else if (titleTagMatch) title = titleTagMatch[1].trim();

          const ogImageMatch = html.match(/<meta\s+(?:property|name)=["'](?:og:image|twitter:image)["']\s+content=["']([^"']+)["']/i);
          if (ogImageMatch) image = ogImageMatch[1].trim();

          const ogAuthorMatch = html.match(/<meta\s+(?:property|name)=["'](?:author|twitter:creator)["']\s+content=["']([^"']+)["']/i);
          if (ogAuthorMatch) author = ogAuthorMatch[1].trim();

          // Clean body content
          const cleanedBody = html
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
            .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, ' ')
            .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ')
            .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
            .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();

          if (cleanedBody.length > 50) {
            content = cleanedBody;
          }
        }
      } catch (e) {
        console.warn('Direct fetch failed, falling back to reader proxy', e);
      }
    }

      // 3. Fallback: Jina Reader API
      if (!content) {
        try {
          const jinaUrl = `https://r.jina.ai/${encodeURIComponent(url)}`;
          const jinaRes = await fetch(jinaUrl, {
            headers: {
              'Accept': 'application/json',
              'X-Return-Format': 'markdown',
            },
          });
          if (jinaRes.ok) {
            const jinaData = await jinaRes.json().catch(() => null);
            if (jinaData?.data) {
              title = jinaData.data.title || title;
              content = jinaData.data.content || '';
              if (!image) image = jinaData.data.image;
              if (jinaData.data.author) author = jinaData.data.author;
            }
          }
        } catch (e) {
          console.warn('Jina fetch failed', e);
        }
      }

      if (isTwitter) {
        const match = url.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/);
        if (match) {
          authorHandle = `@${match[1]}`;
          author = `${match[1]} on X`;
          authorAvatar = `https://unavatar.io/x/${match[1]}`;
        }
      }

      const cleanContent = (content || 'No readable text could be extracted from this page.')
        .replace(/^Post\s+Log\s+in.*?Post\s+.*?Dissecting/i, 'Dissecting')
        .replace(/^Post\s+Log\s+in[^\n]*?(\b[A-Z])/i, '$1')
        .replace(/\d+:\d+\s+[AP]M\s+·\s+.*?Views$/i, '')
        .replace(/!\[.*?\]\(.*?\)/g, '')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[\*\#\_`~]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      return {
        title: title || 'Extracted Article',
        content: cleanContent,
        author: author || 'Web Article',
        authorHandle,
        authorAvatar: authorAvatar || (authorHandle ? `https://unavatar.io/x/${authorHandle.replace('@', '')}` : undefined),
        image,
        sourceUrl: url,
        sourceType: isTwitter ? 'x' : 'article',
      };
    } catch (err: any) {
      console.error('Extract error:', err);
      return new Response(JSON.stringify({ error: err.message || 'Extraction failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  })

  // 2. TTS Generation (Supports Soniox v2 + Groq Whisper, ElevenLabs, or Browser Fallback)
  .post('/api/tts', async ({ request }) => {
    try {
      const body = await request.json();
      const text = body.text?.trim();
      const provider = body.provider || 'browser';

      if (!text) {
        return new Response(JSON.stringify({ error: 'Text is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const env = ((request as any).env || (typeof process !== 'undefined' ? process.env : {})) || {};

      // --- A. SONIOX TTS v2 + GROQ WHISPER ALIGNMENT ---
      if (provider === 'soniox' || provider === 'browser') {
        const sonioxApiKey = body.sonioxApiKey || env.SONIOX_API_KEY;
        const groqApiKey = body.groqApiKey || env.GROQ_API_KEY;
        const voice = body.sonioxVoice || 'Adrian';
        const speed = body.speed || 1.0;

        if (!sonioxApiKey) {
          const rawWords = text.split(/\s+/).filter(Boolean);
          let curTime = 0;
          const wordTimings = rawWords.map((w: string) => {
            const start = curTime;
            const duration = Math.max(0.18, Math.min(0.55, w.length * 0.048));
            const end = start + duration;
            curTime = end;
            return { text: w, start: round(start, 3), end: round(end, 3) };
          });

          return {
            words: wordTimings,
            duration: round(curTime, 3),
            provider: 'browser',
            message: 'Using native speech engine.',
          };
        }

        try {
          // 1. Generate Soniox TTS audio with 7s timeout
          const sonioxRes = await fetch('https://tts-rt.soniox.com/tts', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${sonioxApiKey}`,
              'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(7000),
            body: JSON.stringify({
              text: text.slice(0, 4000),
              model: 'tts-rt-v2',
              language: 'en',
              voice,
              audio_format: 'mp3',
              speed,
              reduce_silence: false,
            }),
          });

          if (!sonioxRes.ok) {
            throw new Error(`Soniox returned ${sonioxRes.status}`);
          }

          const audioBuffer = await sonioxRes.arrayBuffer();
          const base64Audio = arrayBufferToBase64(audioBuffer);

          // 2. Word Timings via Groq Whisper or Linear Distribution
          let words: Array<{ text: string; start: number; end: number }> = [];

          if (groqApiKey) {
            try {
              const formData = new FormData();
              const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });
              formData.append('file', audioBlob, 'audio.mp3');
              formData.append('model', 'whisper-large-v3-turbo');
              formData.append('response_format', 'verbose_json');
              formData.append('timestamp_granularities[]', 'word');

              const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${groqApiKey}` },
                signal: AbortSignal.timeout(5000),
                body: formData,
              });

              if (groqRes.ok) {
                const groqData = await groqRes.json();
                if (groqData.words && Array.isArray(groqData.words)) {
                  words = groqData.words.map((w: any) => ({
                    text: w.word.trim(),
                    start: round(w.start, 3),
                    end: round(w.end, 3),
                  })).filter((w: any) => Boolean(w.text));
                }
              }
            } catch {}
          }

          if (words.length === 0) {
            const rawWords = text.split(/\s+/).filter(Boolean);
            const estimatedTotalDuration = Math.max(1, rawWords.length * (0.28 / speed));
            const timePerWord = estimatedTotalDuration / rawWords.length;
            words = rawWords.map((w: string, idx: number) => ({
              text: w,
              start: round(idx * timePerWord, 3),
              end: round((idx + 1) * timePerWord, 3),
            }));
          }

          const totalDuration = words.length > 0 ? words[words.length - 1].end : 0;

          return {
            audioBase64: base64Audio,
            words,
            duration: totalDuration,
            provider: 'soniox',
          };
        } catch (err) {
          // Fallback to instant browser speech
          const rawWords = text.split(/\s+/).filter(Boolean);
          let curTime = 0;
          const wordTimings = rawWords.map((w: string) => {
            const start = curTime;
            const duration = Math.max(0.18, Math.min(0.55, w.length * 0.048));
            const end = start + duration;
            curTime = end;
            return { text: w, start: round(start, 3), end: round(end, 3) };
          });

          return {
            words: wordTimings,
            duration: round(curTime, 3),
            provider: 'browser',
            warning: 'Speech synthesis fallback active.',
          };
        }
      }

      // --- B. ELEVENLABS WITH TIMESTAMPS ---
      if (provider === 'elevenlabs') {
        const apiKey = body.apiKey || process.env.ELEVENLABS_API_KEY;
        const voiceId = body.voiceId || '21m00Tcm4TlvDq8ikWAM';

        if (!apiKey) {
          return new Response(JSON.stringify({ error: 'ElevenLabs API Key required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`, {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: text.slice(0, 5000),
            model_id: 'eleven_turbo_v2_5',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`ElevenLabs API error: ${errText}`);
        }

        const data = await res.json();
        const alignment = data.alignment;

        const words: Array<{ text: string; start: number; end: number }> = [];
        let currentWord = '';
        let wordStart = 0;

        for (let i = 0; i < alignment.characters.length; i++) {
          const char = alignment.characters[i];
          const start = alignment.character_start_times_seconds[i];
          const end = alignment.character_end_times_seconds[i];

          if (/\s/.test(char)) {
            if (currentWord) {
              words.push({ text: currentWord, start: round(wordStart, 3), end: round(end, 3) });
              currentWord = '';
            }
          } else {
            if (!currentWord) wordStart = start;
            currentWord += char;
          }
        }
        if (currentWord) {
          const lastEnd = alignment.character_end_times_seconds.slice(-1)[0] || wordStart + 0.3;
          words.push({ text: currentWord, start: round(wordStart, 3), end: round(lastEnd, 3) });
        }

        const totalDuration = words.length > 0 ? words[words.length - 1].end : 0;

        return {
          audioBase64: data.audio_base64,
          words,
          duration: totalDuration,
          provider: 'elevenlabs',
        };
      }

      // --- C. FREE ON-DEVICE BROWSER SPEECH FALLBACK ---
      const words = text.split(/\s+/).filter(Boolean);
      let curTime = 0;
      const wordTimings = words.map((w: string) => {
        const start = curTime;
        const duration = Math.max(0.18, Math.min(0.6, w.length * 0.05));
        const end = start + duration;
        curTime = end;
        return { text: w, start: round(start, 3), end: round(end, 3) };
      });

      return {
        words: wordTimings,
        duration: round(curTime, 3),
        provider: 'browser',
      };
    } catch (err: any) {
      console.error('TTS error:', err);
      return new Response(JSON.stringify({ error: err.message || 'TTS generation failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  })

  // 3. Dynamic OpenGraph Image Generator (1200x630 Announcr-style Player Card)
  .get('/api/og', ({ request }) => {
    const urlObj = new URL(request.url);
    const title = urlObj.searchParams.get('title') || 'We are in the middle of the digital renaissance';
    const author = urlObj.searchParams.get('author') || 'DAN KOE';
    const snippet = urlObj.searchParams.get('snippet') || title;
    const image = urlObj.searchParams.get('image') || '';

    const cleanTitle = title.length > 70 ? title.slice(0, 67) + '...' : title;
    const cleanSnippet = snippet.length > 55 ? snippet.slice(0, 52) + '...' : snippet;

    const svg = `
    <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <!-- Dark Purple Ambient Background Gradient -->
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0a0a10"/>
          <stop offset="50%" stop-color="#140a24"/>
          <stop offset="100%" stop-color="#07070d"/>
        </linearGradient>

        <radialGradient id="glow" cx="20%" cy="30%" r="70%">
          <stop offset="0%" stop-color="#7c3aed" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
        </radialGradient>

        <linearGradient id="cardGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#1e1b4b" stop-opacity="0.6"/>
          <stop offset="100%" stop-color="#0f0e17" stop-opacity="0.9"/>
        </linearGradient>

        <linearGradient id="pillGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#8b5cf6"/>
          <stop offset="100%" stop-color="#6366f1"/>
        </linearGradient>

        <clipPath id="cardClip">
          <rect x="40" y="40" width="1120" height="550" rx="32" ry="32"/>
        </clipPath>

        <clipPath id="imgClip">
          <rect x="740" y="110" width="370" height="410" rx="24" ry="24"/>
        </clipPath>
      </defs>

      <!-- Background Canvas -->
      <rect width="1200" height="630" fill="url(#bg)"/>
      <rect width="1200" height="630" fill="url(#glow)"/>

      <!-- Inner Glass Card Container -->
      <g clip-path="url(#cardClip)">
        <rect x="40" y="40" width="1120" height="550" rx="32" ry="32" fill="url(#cardGrad)" stroke="#312e81" stroke-width="2"/>

        <!-- Brand Header -->
        <circle cx="90" cy="95" r="9" fill="#10b981" />
        <circle cx="90" cy="95" r="16" fill="none" stroke="#10b981" stroke-opacity="0.4" stroke-width="2"/>
        <text x="115" y="102" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="24" font-weight="800" fill="#ffffff" letter-spacing="-0.5">kinreader<tspan fill="#a78bfa">.com</tspan></text>
        <text x="940" y="100" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="700" fill="#9ca3af" letter-spacing="2">X ARTICLE • MADE TO LISTEN</text>

        <!-- Full Article Pill -->
        <rect x="90" y="150" width="130" height="32" rx="16" fill="#065f46" fill-opacity="0.4" stroke="#10b981" stroke-width="1.5"/>
        <circle cx="108" cy="166" r="4" fill="#34d399"/>
        <text x="120" y="171" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="12" font-weight="800" fill="#6ee7b7" letter-spacing="1.5">FULL ARTICLE</text>

        <!-- Article Headline -->
        <foreignObject x="90" y="200" width="610" height="190">
          <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: 'Literata', 'EB Garamond', Georgia, serif; font-size: 42px; font-weight: 700; line-height: 1.25; color: #ffffff; letter-spacing: -0.5px; text-shadow: 0 4px 12px rgba(0,0,0,0.5);">
            ${cleanTitle}
          </div>
        </foreignObject>

        <!-- Author Tag -->
        <text x="90" y="420" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="16" font-weight="600" fill="#9ca3af" letter-spacing="1">by <tspan fill="#e5e7eb" font-weight="800">${author.toUpperCase()}</tspan></text>

        <!-- Action / Hear it out loud Pill -->
        <rect x="90" y="455" width="220" height="52" rx="26" fill="url(#pillGrad)" filter="drop-shadow(0 8px 16px rgba(139,92,246,0.3))"/>
        <polygon points="122,473 122,491 138,482" fill="#ffffff"/>
        <text x="148" y="487" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="16" font-weight="700" fill="#ffffff" letter-spacing="0.5">Hear it out loud</text>

        <!-- Bottom Kinetic Bar Indicator -->
        <rect x="90" y="525" width="610" height="30" rx="8" fill="#000000" fill-opacity="0.4"/>
        <text x="105" y="546" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="600" fill="#ffffff">${cleanSnippet}</text>

        <!-- Right Side Diagram / Cover Image -->
        <rect x="740" y="140" width="370" height="380" rx="24" fill="#0d0d14" stroke="#4338ca" stroke-width="2"/>
        ${image ? `<image href="${image}" x="740" y="140" width="370" height="380" preserveAspectRatio="xMidYMid slice" clip-path="url(#imgClip)"/>` : `
          <rect x="740" y="140" width="370" height="380" rx="24" fill="#181825"/>
          <text x="925" y="340" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="54" fill="#6b7280">🎧</text>
        `}
      </g>
    </svg>
    `;

    return new Response(svg, {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  })

  // 4. Shareable Deep-Link with Dynamic Twitter Card Meta Tags
  .get('/r/:id', ({ request, params }) => {
    const urlObj = new URL(request.url);
    const id = params.id;
    const title = urlObj.searchParams.get('t') || 'Kinetic Reader Article';
    const author = urlObj.searchParams.get('a') || 'Author';
    const image = urlObj.searchParams.get('img') || '';

    const ogImageUrl = `${urlObj.origin}/api/og?title=${encodeURIComponent(title)}&author=${encodeURIComponent(author)}&image=${encodeURIComponent(image)}`;

    const html = `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${title} • kinreader.com</title>

        <!-- Twitter Card Tags -->
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:site" content="@KineticReaderFM" />
        <meta name="twitter:title" content="${title}" />
        <meta name="twitter:description" content="by ${author} • Listen to this article in 1-line synchronized kinetic typography." />
        <meta name="twitter:image" content="${ogImageUrl}" />

        <!-- OpenGraph Tags -->
        <meta property="og:type" content="article" />
        <meta property="og:title" content="${title}" />
        <meta property="og:description" content="by ${author} • Made to listen on kinreader.com" />
        <meta property="og:image" content="${ogImageUrl}" />
        <meta property="og:url" content="${request.url}" />

        <meta http-equiv="refresh" content="0;url=/?read=${encodeURIComponent(id)}" />
      </head>
      <body style="background:#0d0d14;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
        <p>Loading ${title} on kinreader.com...</p>
      </body>
    </html>`;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  });

function round(num: number, decimals: number = 3) {
  return Number(Math.round(Number(num + 'e' + decimals)) + 'e-' + decimals);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as any);
  }
  return btoa(binary);
}

// Start Spiceflow standalone if executed directly
if (import.meta.main) {
  const PORT = Number(process.env.API_PORT) || 3008;
  Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    fetch(req) {
      return app.handle(req);
    },
  });
  console.log(`✨ Spiceflow backend running on http://127.0.0.1:${PORT}`);
}
