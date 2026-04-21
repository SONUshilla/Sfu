import React, { useEffect, useRef, useState, useCallback } from 'react';
import socket from '../socket';
import { useMediasoup } from '../hooks/useMediasoup';

const ROLES = [
  {
    id: 'student',
    icon: '🎓',
    label: 'Student',
    desc: 'Join your exam. Share webcam and mic.',
  },
  {
    id: 'proctor',
    icon: '👁',
    label: 'Proctor',
    desc: 'Monitor all students in this session in real-time.',
  }
];

function AudioMeter({ stream }) {
  const [bars, setBars] = useState([false, false, false, false, false]);
  const rafRef = useRef(null);
  const ctxRef = useRef(null);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      
      // Auto-play policy warning
      if (ctx.state === 'suspended') {
        console.warn('AudioContext is suspended. Requires user interaction to resume.');
      }

      ctxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((s, v) => s + v, 0) / data.length;
        const level = Math.min(1, avg / 50);
        setBars(Array.from({ length: 5 }, (_, i) => level >= (i + 1) / 5));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { console.warn("AudioMeter context error", e); }
    
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (ctxRef.current && ctxRef.current.state !== 'closed') {
        ctxRef.current.close();
      }
    };
  }, [stream]);

  return (
    <div className="flex items-end gap-0.5 h-3.5">
      {bars.map((on, i) => (
        <div
          key={i}
          className={`w-0.5 rounded-full transition-colors duration-75 ${on ? 'bg-accent' : 'bg-surface-4'}`}
          style={{ height: `${40 + i * 15}%` }}
        />
      ))}
    </div>
  );
}

export function JoinView({ onJoin }) {
  const [role, setRole] = useState('student');
  const [name, setName] = useState('');
  const [sessionId, setSessionId] = useState('EXAM-2024');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleJoin = async () => {
    if (!name.trim()) return setError('Please enter your name.');
    if (!sessionId.trim()) return setError('Please enter a session code.');
    setError('');
    setLoading(true);
    try {
      await onJoin({ name: name.trim(), role, sessionId: sessionId.trim().toUpperCase() });
    } catch (e) {
      setError(e.message || 'Connection failed.');
      setLoading(false);
    }
  };

  const activeRole = ROLES.find((r) => r.id === role);

  return (
    <div className="min-h-screen bg-surface flex flex-col items-center justify-center px-4 relative overflow-hidden">
      <div className="absolute inset-0 opacity-[0.035] pointer-events-none" style={{ backgroundImage: 'linear-gradient(#00e5a0 1px, transparent 1px), linear-gradient(90deg, #00e5a0 1px, transparent 1px)', backgroundSize: '48px 48px' }} />
      <div className="relative z-10 w-full max-w-md animate-slide_up">
        <div className="text-center mb-10">
          <h1 className="font-display text-3xl font-bold text-text">ProctorSFU</h1>
          <p className="text-text-muted text-xs mt-2 font-mono uppercase tracking-widest">Secure Real-time Monitoring</p>
        </div>

        <div className="bg-surface-2 border border-surface-4 rounded-2xl p-7 shadow-2xl">
          <div className="mb-6">
            <label className="block text-xs font-mono text-text-muted uppercase mb-3">Join as</label>
            <div className="grid grid-cols-2 gap-3">
              {ROLES.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setRole(r.id)}
                  className={`relative rounded-xl border p-4 text-left transition-all ${role === r.id ? 'border-accent/60 bg-accent/10 glow-accent' : 'border-surface-4 bg-surface-3'}`}
                >
                  <span className="text-xl block mb-1.5">{r.icon}</span>
                  <span className={`block font-semibold text-xs ${role === r.id ? 'text-accent' : 'text-text'}`}>{r.label}</span>
                  <span className="block text-[9px] text-text-muted mt-1 leading-relaxed">{r.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-4 mb-6">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your Full Name"
              className="w-full bg-surface-1 border border-surface-4 rounded-lg px-4 py-3 text-text text-sm focus:border-accent outline-none"
            />
            <input
              type="text"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value.toUpperCase())}
              placeholder="Session Code"
              className="w-full bg-surface-1 border border-surface-4 rounded-lg px-4 py-3 text-text font-mono text-sm focus:border-accent outline-none"
            />
          </div>

          {error && <div className="mb-4 text-danger text-xs font-mono">⚠ {error}</div>}

          <button
            onClick={handleJoin}
            disabled={loading}
            className="w-full py-3.5 rounded-xl font-semibold text-sm bg-accent text-surface hover:bg-accent-dim disabled:opacity-50"
          >
            {loading ? 'Connecting...' : `Enter as ${activeRole?.label} →`}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ProctorView({ sessionInfo, onLeave }) {
  const { name, sessionId } = sessionInfo;
  const [students, setStudents] = useState(new Map());
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(true);
  const [flagTarget, setFlagTarget] = useState(null);

  const studentsRef = useRef(new Map());
  const { loadDevice, createRecvTransport, consume } = useMediasoup();

  const sync = () => setStudents(new Map(studentsRef.current));

  const getOrCreate = (peerId, name) => {
    if (!studentsRef.current.has(peerId)) {
      studentsRef.current.set(peerId, {
        peerId, name: name || 'Unknown',
        webcamStream: new MediaStream(),
        hasVideo: false, hasAudio: false, isActive: false, isPaused: false,
        consumers: new Map(), flags: [],
      });
    }
    return studentsRef.current.get(peerId);
  };

  const consumeProducer = useCallback(async ({ peerId, producerId, peerName, kind, mediaType }) => {
    if (mediaType === 'screen') return; 

    try {
      const student = getOrCreate(peerId, peerName);
      const consumer = await consume(producerId);
      student.consumers.set(consumer.id, consumer);
      student.webcamStream.addTrack(consumer.track);

      if (kind === 'video') student.hasVideo = true;
      if (kind === 'audio') student.hasAudio = true;
      student.isActive = true;
      student.isPaused = false; 
      sync();

      consumer.on('trackended', () => {
        student.webcamStream.removeTrack(consumer.track);
        if (kind === 'video') student.hasVideo = false;
        if (kind === 'audio') student.hasAudio = false;
        if (!student.hasVideo && !student.hasAudio) student.isActive = false;
        sync();
      });
    } catch (e) { console.error("Consume error", e); }
  }, [consume]);

  useEffect(() => {
    let mounted = true;
    async function init() {
      try {
        socket.connect();
        const joinData = await new Promise((res, rej) => {
          socket.emit('join', { sessionId, role: 'proctor', name }, (d) => d.ok ? res(d) : rej(new Error(d.error)));
        });

        if (!mounted) return;
        for (const p of joinData.existingPeers || []) {
          if (p.role === 'student') getOrCreate(p.peerId, p.name);
        }

        await loadDevice(joinData.routerRtpCapabilities);
        await createRecvTransport();
        await Promise.allSettled((joinData.existingProducers || []).map(consumeProducer));

        if (mounted) { setStatus('Monitoring'); sync(); }
      } catch (e) {
        if (mounted) { setError(e.message); setStatus('Error'); }
      }
    }

    init();

    const onConsumerClosed = ({ consumerId }) => {
      for (const [, s] of studentsRef.current) {
        const c = s.consumers.get(consumerId);
        if (c) {
          s.webcamStream.removeTrack(c.track);
          s.consumers.delete(consumerId);
          if (c.kind === 'video') s.hasVideo = false;
          if (c.kind === 'audio') s.hasAudio = false;
          if (s.consumers.size === 0) s.isActive = false;
          sync(); break;
        }
      }
    };

    const onConsumerPaused = ({ consumerId }) => {
      for (const [, s] of studentsRef.current) {
        if (s.consumers.has(consumerId)) {
          s.isPaused = true;
          sync(); break;
        }
      }
    };

    const onConsumerResumed = ({ consumerId }) => {
      for (const [, s] of studentsRef.current) {
        if (s.consumers.has(consumerId)) {
          s.isPaused = false;
          sync(); break;
        }
      }
    };

    const onPeerLeft = ({ peerId }) => {
      const s = studentsRef.current.get(peerId);
      if (s) { 
        s.isActive = false; s.hasVideo = false; s.hasAudio = false; s.isPaused = false;
        sync(); 
      }
    };

    socket.on('newProducer', consumeProducer);
    socket.on('consumerClosed', onConsumerClosed);
    socket.on('consumerPaused', onConsumerPaused);
    socket.on('consumerResumed', onConsumerResumed);
    socket.on('peerJoined', ({ peerId, name, role }) => { if (role === 'student') { getOrCreate(peerId, name); sync(); }});
    socket.on('peerLeft', onPeerLeft);
    socket.on('disconnect', () => setStatus('Disconnected from server'));

    return () => {
      mounted = false;
      socket.off('newProducer'); socket.off('consumerClosed');
      socket.off('consumerPaused'); socket.off('consumerResumed');
      socket.off('peerJoined'); socket.off('peerLeft'); socket.off('disconnect');
      socket.disconnect();
    };
  }, [consumeProducer, createRecvTransport, loadDevice, name, sessionId]);

  const activeStudents = Array.from(students.values()).filter(s => s.isActive || s.hasVideo || s.hasAudio);

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <header className="flex items-center justify-between px-6 py-3 border-b border-surface-3 bg-surface-1">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-accent">ProctorSFU</span>
          <span className="font-mono text-xs text-text-muted">ID: {sessionId}</span>
          <span className="font-mono text-xs text-text-muted">Status: {status}</span>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setMuted(!muted)} className="p-2 border border-surface-4 rounded-lg text-white">{muted ? '🔇 Unmute All' : '🔊 Mute All'}</button>
          <button onClick={onLeave} className="px-3 py-1.5 bg-danger/10 text-danger border border-danger/20 rounded-lg text-xs">Leave</button>
        </div>
      </header>

      <main className="flex-1 p-4 overflow-auto">
        {activeStudents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-muted font-mono">
            <span className="text-4xl mb-4">⏳</span>
            <p>Waiting for students to start their cameras...</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {activeStudents.map((s) => (
              <StudentTile key={s.peerId} student={s} muted={muted} onFlag={(id, name) => setFlagTarget({ peerId: id, name })} />
            ))}
          </div>
        )}
      </main>

      {flagTarget && <FlagModal target={flagTarget} onClose={() => setFlagTarget(null)} onSubmit={(pid, note, sev) => socket.emit('flagStudent', { studentId: pid, note, severity: sev })} />}
    </div>
  );
}

function StudentTile({ student, muted, onFlag }) {
  const videoRef = useRef(null);
  
  useEffect(() => {
    if (videoRef.current && student.webcamStream && student.webcamStream.getTracks().length > 0) {
      videoRef.current.srcObject = student.webcamStream;
      
      const playPromise = videoRef.current.play();
      if (playPromise !== undefined) {
        playPromise.catch(error => {
          console.warn(`Autoplay prevented for ${student.name}:`, error);
        });
      }
    }
  }, [student.webcamStream]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  return (
    <div className="bg-surface-2 border border-surface-4 rounded-xl overflow-hidden relative">
      <div className="aspect-video bg-black relative">
        <video 
          ref={videoRef} 
          playsInline 
          className={`w-full h-full object-cover transition-opacity ${student.isPaused ? 'opacity-30' : 'opacity-100'}`} 
        />
        
        <div className="absolute top-2 left-2 flex flex-col gap-1">
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${student.isActive ? 'bg-accent/20 text-accent' : 'bg-surface/60 text-muted'}`}>
            {student.isActive ? 'LIVE' : 'OFFLINE'}
          </span>
          {student.isPaused && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-warn/20 text-warn animate-pulse">
              Buffering (Network)
            </span>
          )}
        </div>
        <div className="absolute top-2 right-2"><AudioMeter stream={student.webcamStream} /></div>
      </div>
      <div className="p-3 flex justify-between items-center">
        <span className="text-sm font-medium">{student.name}</span>
        <button onClick={() => onFlag(student.peerId, student.name)} className="text-[10px] font-mono text-warn border border-warn/30 px-2 py-1 rounded hover:bg-warn/10">⚑ FLAG</button>
      </div>
    </div>
  );
}

function FlagModal({ target, onClose, onSubmit }) {
  const [note, setNote] = useState('');
  const [severity, setSeverity] = useState('warning');
  return (
    <div className="fixed inset-0 bg-surface/80 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-surface-2 border border-surface-4 p-6 rounded-2xl w-full max-w-sm">
        <h3 className="font-bold mb-4 text-text">Flag: {target.name}</h3>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="w-full mb-4 p-2 bg-surface-1 border border-surface-4 rounded-lg text-sm text-text">
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="critical">Critical</option>
        </select>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason..." className="w-full p-2 bg-surface-1 border border-surface-4 rounded-lg text-sm text-text mb-4" />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2 border border-surface-4 rounded-xl text-sm text-text">Cancel</button>
          <button onClick={() => { onSubmit(target.peerId, note, severity); onClose(); }} className="flex-1 py-2 bg-warn/20 text-warn border border-warn/40 rounded-xl text-sm">Submit</button>
        </div>
      </div>
    </div>
  );
}