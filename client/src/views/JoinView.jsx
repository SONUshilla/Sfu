import React, { useState } from 'react';

const ROLES = [
  {
    id: 'student',
    icon: '🎓',
    label: 'Student',
    desc: 'Join your exam. Share webcam, mic, and screen.',
    accent: 'accent',
  },
  {
    id: 'proctor',
    icon: '👁',
    label: 'Proctor',
    desc: 'Monitor assigned students via webcam and audio.',
    accent: 'accent',
  }
];

export default function JoinView({ onJoin }) {
  const [role, setRole]         = useState('student');
  const [name, setName]         = useState('');
  const [sessionId, setSessionId] = useState('EXAM-2024');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  const handleJoin = async () => {
    if (!name.trim())      return setError('Please enter your name.');
    if (!sessionId.trim()) return setError('Please enter a session code.');
    setError('');
    setLoading(true);
    try {
      await onJoin({ name: name.trim(), role, sessionId: sessionId.trim().toUpperCase() });
    } catch (e) {
      setError(e.message || 'Connection failed. Is the server running?');
      setLoading(false);
    }
  };

  const activeRole = ROLES.find((r) => r.id === role);

  return (
    <div className="min-h-screen bg-surface flex flex-col items-center justify-center px-4 relative overflow-hidden">
      {/* Background grid */}
      <div
        className="absolute inset-0 opacity-[0.035]"
        style={{
          backgroundImage:
            'linear-gradient(#00e5a0 1px, transparent 1px), linear-gradient(90deg, #00e5a0 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />
      {/* Radial glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] rounded-full bg-accent/4 blur-[120px] pointer-events-none" />

      <div className="relative z-10 w-full max-w-md animate-slide_up">
        {/* Brand */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 mb-3">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse_slow" />
            <span className="font-mono text-xs text-accent tracking-[0.3em] uppercase">ProctorSFU</span>
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse_slow" />
          </div>
          <h1 className="font-display text-3xl font-bold text-text">Secure Exam Monitoring</h1>
          <p className="text-text-muted text-xs mt-2 font-mono tracking-wide">
            Real-time · SFU-Powered · DTLS-SRTP Encrypted
          </p>
        </div>

        {/* Card */}
        <div className="bg-surface-2 border border-surface-4 rounded-2xl p-7 shadow-2xl">
          {/* Role selector */}
          <div className="mb-6">
            <label className="block text-xs font-mono text-text-muted uppercase tracking-widest mb-3">
              Join as
            </label>
            <div className="grid grid-cols-2 gap-3">
              {ROLES.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setRole(r.id)}
                  className={`
                    relative rounded-xl border p-4 text-left transition-all duration-200
                    ${role === r.id
                      ? 'border-accent/60 bg-accent/10 glow-accent'
                      : 'border-surface-4 bg-surface-3 hover:border-muted'
                    }
                  `}
                >
                  <span className="text-xl block mb-1.5">{r.icon}</span>
                  <span className={`block font-display font-semibold text-xs ${
                    role === r.id ? 'text-accent' : 'text-text'
                  }`}>
                    {r.label}
                  </span>
                  <span className="block text-[9px] text-text-muted mt-0.5 leading-relaxed font-mono">
                    {r.desc}
                  </span>
                  {role === r.id && (
                    <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-accent" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Inputs */}
          <div className="space-y-4 mb-6">
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-widest mb-2">
                Your Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                placeholder={role === 'proctor' ? 'e.g. Proctor Jones' : 'e.g. Alice Johnson'}
                className="w-full bg-surface-1 border border-surface-4 rounded-lg px-4 py-3 text-text placeholder-text-faint font-display text-sm
                  focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-widest mb-2">
                Session Code
              </label>
              <input
                type="text"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                placeholder="e.g. EXAM-2024"
                className="w-full bg-surface-1 border border-surface-4 rounded-lg px-4 py-3 text-text placeholder-text-faint font-mono text-sm tracking-widest
                  focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-all"
              />
              <p className="text-[10px] text-text-muted mt-1.5 font-mono">
                All participants with the same code share a room.
              </p>
            </div>
          </div>

          {error && (
            <div className="mb-4 rounded-lg bg-danger/10 border border-danger/30 px-4 py-2.5 text-danger text-xs font-mono">
              ⚠ {error}
            </div>
          )}

          <button
            onClick={handleJoin}
            disabled={loading}
            className="w-full py-3.5 rounded-xl font-display font-semibold text-sm transition-all duration-200
              disabled:opacity-50 disabled:cursor-not-allowed bg-accent text-surface hover:bg-accent-dim"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Connecting…
              </span>
            ) : (
              `Enter as ${activeRole?.label} →`
            )}
          </button>
        </div>

        <p className="text-center text-text-faint text-[10px] font-mono mt-5">
          Streams encrypted with DTLS-SRTP · No recordings stored on server
        </p>
      </div>
    </div>
  );
}