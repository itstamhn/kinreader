import React, { useEffect, useState } from 'react';
import {
  ChevronLeft,
  Mail,
  Sparkles,
  ArrowRight,
  ShieldCheck,
  CreditCard,
  LogOut,
  CheckCircle2,
  RefreshCw,
} from 'lucide-react';
import { authClient } from '../lib/auth-client';

export interface UserProfile {
  email: string;
  name: string;
  avatar?: string;
  tier: 'free' | 'pro';
}

interface AuthScreenProps {
  onBack: () => void;
  onLoginSuccess?: (user: UserProfile) => void;
  user?: UserProfile | null;
  onLogout?: () => void;
  externalError?: string | null;
  onDismissExternalError?: () => void;
}

export function AuthScreen({
  onBack,
  onLoginSuccess,
  user,
  onLogout,
  externalError,
  onDismissExternalError,
}: AuthScreenProps) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [isSent, setIsSent] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (externalError) setError(null);
  }, [externalError]);

  const shownError = externalError || error;

  const clearErrors = () => {
    setError(null);
    onDismissExternalError?.();
  };

  const showError = (message: string) => {
    onDismissExternalError?.();
    setError(message);
  };

  const handleSendMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !email.includes('@')) {
      showError('Please enter a valid email address');
      return;
    }

    setIsLoading(true);
    clearErrors();

    try {
      const res = await (authClient.signIn as any).magicLink({
        email,
        name: name.trim() || email.split('@')[0],
        callbackURL: window.location.origin,
      });

      if (res?.error) {
        throw new Error(res.error.message || 'Failed to send sign-in link');
      }

      setIsSent(true);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'Failed to send sign-in link');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await authClient.signOut();
    } catch {}
    onLogout?.();
  };

  return (
    <div className="w-full h-full flex flex-col bg-[#0B0C10] text-[#ECEAE4] overflow-y-auto px-4 sm:px-8 py-6 select-none animate-fade-in">
      {/* Top Navigation */}
      <div className="w-full max-w-lg mx-auto flex items-center justify-between pb-6 border-b border-white/5">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-xs sm:text-sm font-sans font-medium text-[#ECEAE4]/60 hover:text-white transition group py-1.5 px-3 rounded-full bg-white/5 hover:bg-white/10"
        >
          <ChevronLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition" />
          <span>Back to Reader</span>
        </button>

        <span className="font-mono text-[11px] tracking-wider uppercase text-[#ECEAE4]/30">
          {user ? 'Account' : 'Sign In'}
        </span>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex items-center justify-center py-8">
        <div className="w-full max-w-sm flex flex-col">
          {user ? (
            /* ── 1. SIGNED-IN PROFILE ── */
            <div className="text-center">
              <div className="relative w-20 h-20 mx-auto mb-4">
                <img
                  src={user.avatar || `https://unavatar.io/${encodeURIComponent(user.email)}`}
                  alt={user.name}
                  className="w-20 h-20 rounded-full border-2 border-[#F2A33C]/60 object-cover bg-[#0B0C10] shadow-2xl"
                  onError={(e) => {
                    (e.target as HTMLElement).style.display = 'none';
                  }}
                />
                <div className="absolute -bottom-1 -right-1 p-1.5 rounded-full bg-[#14151C] border border-[#F2A33C]/50 text-[#F2A33C]">
                  <ShieldCheck className="w-4 h-4" />
                </div>
              </div>

              <h2 className="font-serif font-medium text-2xl text-[#F4F0E6] tracking-tight">{user.name}</h2>
              <p className="font-sans text-xs sm:text-sm text-[#ECEAE4]/40 mt-1 mb-4">{user.email}</p>

              <div className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-[#F2A33C]/15 border border-[#F2A33C]/35 text-[#F2A33C] text-xs font-sans font-semibold mb-6 shadow-sm">
                <Sparkles className="w-3.5 h-3.5 text-[#F2A33C]" />
                <span>PRO MEMBER ACTIVE</span>
              </div>

              <div className="space-y-3 mb-8 text-left">
                <div className="p-4 rounded-2xl bg-gradient-to-br from-[#1B1D26] to-[#101117] border border-white/10 flex items-center justify-between">
                  <div>
                    <div className="font-sans text-xs sm:text-sm font-semibold text-[#F4F0E6]">Cloud Synchronization</div>
                    <div className="font-sans text-xs text-[#ECEAE4]/45 pt-0.5">Library & progress synced with Convex</div>
                  </div>
                  <span className="font-mono text-[10px] font-bold px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                    ONLINE
                  </span>
                </div>

                <a
                  href="https://buy.stripe.com/eVqfZbgvZeDH6Uc2zJ53O00"
                  target="_blank"
                  rel="noreferrer"
                  className="p-4 rounded-2xl bg-gradient-to-br from-[#1B1D26] to-[#101117] hover:border-[#F2A33C]/40 border border-white/10 flex items-center justify-between transition group"
                >
                  <div className="flex items-center gap-3">
                    <CreditCard className="w-5 h-5 text-[#F2A33C]" />
                    <div>
                      <div className="font-sans text-xs sm:text-sm font-semibold text-[#F4F0E6] group-hover:text-[#F2A33C] transition">
                        Billing & Membership
                      </div>
                      <div className="font-sans text-xs text-[#ECEAE4]/45 pt-0.5">Manage subscription via Stripe</div>
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-white/40 group-hover:text-white transition" />
                </a>
              </div>

              <button
                onClick={handleSignOut}
                className="w-full py-3 rounded-2xl border border-white/10 hover:border-rose-500/30 hover:bg-rose-500/10 text-[#ECEAE4]/60 hover:text-rose-400 font-sans text-xs sm:text-sm font-semibold flex items-center justify-center gap-2 transition active:scale-98"
              >
                <LogOut className="w-4 h-4" />
                <span>Sign Out</span>
              </button>
            </div>
          ) : isSent ? (
            /* ── 2. MAGIC LINK SENT CONFIRMATION ── */
            <div className="text-center animate-scale-up">
              <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shadow-xl">
                <CheckCircle2 className="w-8 h-8 text-emerald-400" />
              </div>

              <h2 className="font-serif font-medium text-3xl text-[#F4F0E6] tracking-tight">
                Check Your Inbox
                <span className="text-[#F2A33C]">.</span>
              </h2>
              <p className="font-sans text-xs sm:text-sm text-[#ECEAE4]/60 mt-2 mb-6 leading-relaxed">
                We sent a secure passwordless sign-in link to{' '}
                <span className="text-[#F4F0E6] font-semibold">{email}</span>. Click the link in your email to instantly sign in.
              </p>

              <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/5 text-xs text-[#ECEAE4]/50 mb-6 text-left space-y-1.5">
                <p>• The link will stay active for 30 minutes.</p>
                <p>• No password needed — clicking logs you in immediately.</p>
                <p>• Check your spam or promotions folder if you don't see it.</p>
              </div>

              <button
                type="button"
                onClick={() => setIsSent(false)}
                className="inline-flex items-center gap-2 text-xs sm:text-sm font-sans text-[#F2A33C] hover:text-[#F2A33C]/80 transition"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Use a different email address</span>
              </button>
            </div>
          ) : (
            /* ── 3. PASSWORDLESS EMAIL SIGN IN ── */
            <div className="text-center">
              <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-[#2A2D38] to-[#181A21] border border-white/10 flex items-center justify-center shadow-xl">
                <Sparkles className="w-6 h-6 text-[#F2A33C]" />
              </div>

              <h2 className="font-serif font-medium text-3xl text-[#F4F0E6] tracking-tight">
                Sign In
                <span className="text-[#F2A33C]">.</span>
              </h2>
              <p className="font-sans text-xs sm:text-sm text-[#ECEAE4]/50 mt-1.5 mb-6">
                Enter your email address. We'll send you a secure, password-free link to sign in instantly.
              </p>

              {shownError && (
                <div className="mb-5 p-3 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-sans text-left">
                  {shownError}
                </div>
              )}

              <form onSubmit={handleSendMagicLink} className="flex flex-col gap-3 text-left">
                <div>
                  <label className="block text-[11px] font-mono uppercase tracking-wider text-[#ECEAE4]/50 mb-1.5">
                    Email Address
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-white/40 absolute left-3.5 top-3.5" />
                    <input
                      type="email"
                      aria-label="Email address"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@example.com"
                      className="w-full bg-white/5 border border-white/10 focus:border-[#F2A33C]/50 rounded-2xl py-3 pl-10 pr-4 font-sans text-xs sm:text-sm text-[#ECEAE4] placeholder-[#ECEAE4]/30 focus:outline-none transition"
                      required
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full h-12 rounded-2xl glow-amber-btn font-sans font-semibold text-xs sm:text-sm transition active:scale-98 flex items-center justify-center gap-2 disabled:opacity-50 mt-2"
                >
                  {isLoading ? (
                    <span className="animate-spin text-xs">⚡ Sending Link...</span>
                  ) : (
                    <>
                      <span>Continue with Email</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </form>

              <p className="font-sans text-[11.5px] text-[#ECEAE4]/35 mt-6 leading-relaxed">
                By continuing, your reading progress, speed preferences, and playlist will sync automatically across all your devices.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
