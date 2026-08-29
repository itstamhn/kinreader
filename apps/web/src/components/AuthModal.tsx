import React, { useEffect, useState } from 'react';
import { X, Mail, Sparkles, ArrowRight, ShieldCheck, CreditCard, ExternalLink, Copy, LogOut, Lock } from 'lucide-react';
import { isEmbeddedBrowser } from '../lib/browser';
import { authClient } from '../lib/auth-client';

export interface UserProfile {
  email: string;
  name: string;
  avatar?: string;
  tier: 'free' | 'pro';
}

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess?: (user: UserProfile) => void;
  user?: UserProfile | null;
  onLogout?: () => void;
  /** A failure reported by the redirect back from Google (`?auth_error=`). */
  externalError?: string | null;
  onDismissExternalError?: () => void;
}

export function AuthModal({
  isOpen,
  onClose,
  onLoginSuccess,
  user,
  onLogout,
  externalError,
  onDismissExternalError,
}: AuthModalProps) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isEmbedded] = useState(() =>
    typeof navigator === 'undefined' ? false : isEmbeddedBrowser(navigator.userAgent)
  );

  useEffect(() => {
    if (externalError) setError(null);
  }, [externalError]);

  if (!isOpen) return null;

  const shownError = externalError || error;

  const clearErrors = () => {
    setError(null);
    onDismissExternalError?.();
  };

  const showError = (message: string) => {
    onDismissExternalError?.();
    setError(message);
  };

  const handleCopyLink = async () => {
    const link = `${window.location.origin}/`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      showError(`Copy is blocked here — open ${link} in Safari or Chrome`);
    }
  };

  const handleGoogleSignIn = async () => {
    clearErrors();
    setIsLoading(true);
    try {
      await authClient.signIn.social({
        provider: 'google',
        callbackURL: window.location.origin,
      });
    } catch (err: any) {
      showError(err.message || 'Google sign-in failed');
      setIsLoading(false);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !email.includes('@')) {
      showError('Please enter a valid email address');
      return;
    }
    if (!password || password.length < 6) {
      showError('Password must be at least 6 characters');
      return;
    }

    setIsLoading(true);
    clearErrors();

    try {
      if (mode === 'signup') {
        const res = await authClient.signUp.email({
          email,
          password,
          name: name.trim() || email.split('@')[0] || 'User',
          callbackURL: window.location.origin,
        });
        if (res.error) throw new Error(res.error.message || 'Failed to sign up');
        if (res.data?.user) {
          onLoginSuccess?.({
            email: res.data.user.email,
            name: res.data.user.name || email.split('@')[0] || 'User',
            avatar: res.data.user.image || undefined,
            tier: 'pro',
          });
        }
      } else {
        const res = await authClient.signIn.email({
          email,
          password,
          callbackURL: window.location.origin,
        });
        if (res.error) throw new Error(res.error.message || 'Invalid email or password');
        if (res.data?.user) {
          onLoginSuccess?.({
            email: res.data.user.email,
            name: res.data.user.name || email.split('@')[0] || 'User',
            avatar: res.data.user.image || undefined,
            tier: 'pro',
          });
        }
      }
      onClose();
    } catch (err: any) {
      showError(err.message || 'Authentication failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await authClient.signOut();
    } catch {}
    onLogout?.();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-fade-in select-none">
      <div className="w-full max-w-sm bg-[#14151C] border border-white/10 rounded-3xl p-6 sm:p-7 shadow-[0_30px_80px_rgba(0,0,0,0.6)] relative animate-scale-up text-center">
        {/* Close Button */}
        <button
          onClick={() => {
            clearErrors();
            onClose();
          }}
          className="absolute top-4 right-4 p-2 rounded-full hover:bg-white/10 text-white/40 hover:text-white transition"
        >
          <X className="w-4 h-4" />
        </button>

        {user ? (
          /* ── 1. SIGNED-IN PROFILE SCREEN ── */
          <div>
            <div className="relative w-16 h-16 mx-auto mb-3">
              <img
                src={user.avatar || `https://unavatar.io/${encodeURIComponent(user.email)}`}
                alt={user.name}
                className="w-16 h-16 rounded-full border-2 border-[#F2A33C]/60 object-cover bg-[#0B0C10] shadow-xl"
                onError={(e) => {
                  (e.target as HTMLElement).style.display = 'none';
                }}
              />
              <div className="absolute -bottom-1 -right-1 p-1 rounded-full bg-[#14151C] border border-[#F2A33C]/50 text-[#F2A33C]">
                <ShieldCheck className="w-3.5 h-3.5" />
              </div>
            </div>

            <h2 className="font-serif font-medium text-xl text-[#F4F0E6] tracking-tight">{user.name}</h2>
            <p className="font-sans text-xs text-[#ECEAE4]/40 mt-0.5 mb-3">{user.email}</p>

            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#F2A33C]/15 border border-[#F2A33C]/35 text-[#F2A33C] text-[11px] font-sans font-semibold mb-5 shadow-sm">
              <Sparkles className="w-3.5 h-3.5 text-[#F2A33C]" />
              <span>PRO MEMBER ACTIVE</span>
            </div>

            <div className="space-y-2 mb-6 text-left">
              <div className="p-3 rounded-2xl bg-gradient-to-br from-[#1B1D26] to-[#101117] border border-white/10 flex items-center justify-between">
                <div>
                  <div className="font-sans text-xs font-semibold text-[#F4F0E6]">Cloud Sync</div>
                  <div className="font-sans text-[11px] text-[#ECEAE4]/45">Library synced with Convex</div>
                </div>
                <span className="font-mono text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  ONLINE
                </span>
              </div>

              <a
                href="https://buy.stripe.com/eVqfZbgvZeDH6Uc2zJ53O00"
                target="_blank"
                rel="noreferrer"
                className="p-3 rounded-2xl bg-gradient-to-br from-[#1B1D26] to-[#101117] hover:border-[#F2A33C]/40 border border-white/10 flex items-center justify-between transition group"
              >
                <div className="flex items-center gap-2.5">
                  <CreditCard className="w-4 h-4 text-[#F2A33C]" />
                  <div>
                    <div className="font-sans text-xs font-semibold text-[#F4F0E6] group-hover:text-[#F2A33C] transition">
                      Billing & Subscription
                    </div>
                    <div className="font-sans text-[11px] text-[#ECEAE4]/45">Manage Stripe membership</div>
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-white/40 group-hover:text-white transition" />
              </a>
            </div>

            <button
              onClick={handleSignOut}
              className="w-full py-2.5 rounded-2xl border border-white/10 hover:border-rose-500/30 hover:bg-rose-500/10 text-[#ECEAE4]/60 hover:text-rose-400 font-sans text-xs font-semibold flex items-center justify-center gap-2 transition active:scale-98"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        ) : (
          /* ── 2. LOGGED OUT: SIGN IN / SIGN UP ── */
          <div>
            <div className="w-12 h-12 mx-auto mb-3.5 rounded-2xl bg-gradient-to-br from-[#2A2D38] to-[#181A21] border border-white/10 flex items-center justify-center shadow-lg">
              <Sparkles className="w-5 h-5 text-[#F2A33C]" />
            </div>

            <h2 className="font-serif font-medium text-2xl text-[#F4F0E6] tracking-tight">
              {mode === 'signin' ? 'Sign In to Kinreader' : 'Create Account'}
              <span className="text-[#F2A33C]">.</span>
            </h2>
            <p className="font-sans text-xs text-[#ECEAE4]/50 mt-1 mb-5">
              Sync your reading queue, audio progress, and custom speed presets across all your devices.
            </p>

            {shownError && (
              <div className="mb-4 p-2.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-sans">
                {shownError}
              </div>
            )}

            {isEmbedded && (
              <div className="mb-4 p-3 rounded-2xl bg-[#F2A33C]/10 border border-[#F2A33C]/30 text-left">
                <div className="flex items-center gap-1.5 text-[#F2A33C] font-sans text-[11px] font-semibold mb-1">
                  <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                  <span>Google blocks sign-in inside in-app browsers</span>
                </div>
                <p className="font-sans text-[11px] text-[#ECEAE4]/60 leading-relaxed">
                  You opened Kinreader from inside another app. Open it in Safari or Chrome to
                  continue with Google — or sign in with email below, which works anywhere.
                </p>
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-[#F2A33C]/40 hover:bg-[#F2A33C]/15 text-[#F2A33C] font-sans text-[11px] font-semibold transition active:scale-[0.98]"
                >
                  <Copy className="w-3 h-3" />
                  <span>{copied ? 'Link copied' : 'Copy link'}</span>
                </button>
              </div>
            )}

            {/* Google 1-Tap Sign-In Button */}
            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={isLoading}
              className="w-full bg-white hover:bg-gray-100 text-gray-900 font-sans font-semibold py-3 rounded-2xl text-xs transition shadow-md flex items-center justify-center gap-2.5 mb-3 select-none active:scale-[0.98] disabled:opacity-50"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
              <span>Continue with Google</span>
            </button>

            {/* Divider */}
            <div className="flex items-center gap-3 my-3">
              <div className="h-px bg-white/10 flex-1" />
              <span className="font-mono text-[9.5px] uppercase font-semibold text-white/30 tracking-wider">
                or with email
              </span>
              <div className="h-px bg-white/10 flex-1" />
            </div>

            <form onSubmit={handleEmailAuth} className="space-y-2.5">
              {mode === 'signup' && (
                <div className="relative">
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your Name (optional)"
                    className="w-full bg-white/5 border border-white/10 focus:border-[#F2A33C]/50 rounded-2xl py-2.5 px-4 font-sans text-xs text-[#ECEAE4] placeholder-[#ECEAE4]/30 focus:outline-none transition"
                  />
                </div>
              )}

              <div className="relative">
                <Mail className="w-4 h-4 text-white/40 absolute left-3.5 top-3" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email address"
                  className="w-full bg-white/5 border border-white/10 focus:border-[#F2A33C]/50 rounded-2xl py-2.5 pl-10 pr-4 font-sans text-xs text-[#ECEAE4] placeholder-[#ECEAE4]/30 focus:outline-none transition"
                  required
                />
              </div>

              <div className="relative">
                <Lock className="w-4 h-4 text-white/40 absolute left-3.5 top-3" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password (min 6 chars)"
                  className="w-full bg-white/5 border border-white/10 focus:border-[#F2A33C]/50 rounded-2xl py-2.5 pl-10 pr-4 font-sans text-xs text-[#ECEAE4] placeholder-[#ECEAE4]/30 focus:outline-none transition"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full h-11 rounded-2xl glow-amber-btn font-sans font-semibold text-xs transition active:scale-98 flex items-center justify-center gap-2 disabled:opacity-50 mt-1"
              >
                {isLoading ? (
                  <span className="animate-spin text-xs">⚡ Processing...</span>
                ) : (
                  <>
                    <span>{mode === 'signin' ? 'Sign In' : 'Create Account'}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </>
                )}
              </button>
            </form>

            <button
              type="button"
              onClick={() => {
                clearErrors();
                setMode(mode === 'signin' ? 'signup' : 'signin');
              }}
              className="mt-4 font-sans text-xs text-[#ECEAE4]/50 hover:text-white transition"
            >
              {mode === 'signin'
                ? "Don't have an account? Sign up"
                : 'Already have an account? Sign in'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
