import React, { useEffect, useRef, useState, useCallback } from 'react';
import socket from '../socket';
import { useMediasoup } from '../hooks/useMediasoup';

const STATUS = {
  IDLE: 'idle',
  LOADING: 'loading',
  CONNECTED: 'connected',
  ERROR: 'error',
};

function TrackBadge({ label, active, color = 'accent' }) {
  const colors = {
    accent: active ? 'bg-accent/20 text-accent border-accent/40' : 'bg-surface-3 text-muted border-surface-4',
    warn:   active ? 'bg-warn/20 text-warn border-warn/40'   : 'bg-surface-3 text-muted border-surface-4',
    danger: active ? 'bg-danger/20 text-danger border-danger/40' : 'bg-surface-3 text-muted border-surface-4',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-mono transition-all ${colors[color]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-current animate-pulse' : 'bg-muted'}`} />
      {label}
    </span>
  );
}

export default function StudentView({ sessionInfo, onLeave }) {
  const { name, sessionId } = sessionInfo;

  const [status, setStatus] = useState(STATUS.LOADING);
  const [error, setError] = useState('');
  const [tracks, setTracks] = useState({ webcam: false, audio: false, screen: false });
  const [proctorCount, setProctorCount] = useState(0);

  const webcamVideoRef = useRef(null);
  const screenVideoRef = useRef(null);

  const webcamStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const producersRef = useRef({}); 

  const { loadDevice, createSendTransport, produce } = useMediasoup();

  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        socket.connect();
        const joinData = await new Promise((res, rej) => {
          socket.emit('join', { sessionId, role: 'student', name }, (d) =>
            d.ok ? res(d) : rej(new Error(d.error))
          );
        });

        if (!mounted) return;

        await loadDevice(joinData.routerRtpCapabilities);
        await createSendTransport();

        const camStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
        });

        if (!mounted) { camStream.getTracks().forEach((t) => t.stop()); return; }

        webcamStreamRef.current = camStream;
        if (webcamVideoRef.current) webcamVideoRef.current.srcObject = camStream;

        const [videoTrack] = camStream.getVideoTracks();
        const [audioTrack] = camStream.getAudioTracks();

        // Hardware unplug listeners
        videoTrack.onended = () => {
          if (!mounted) return;
          setError('Camera disconnected physically or access was revoked.');
          setStatus(STATUS.ERROR);
          setTracks((t) => ({ ...t, webcam: false }));
        };

        audioTrack.onended = () => {
          if (!mounted) return;
          setError('Microphone disconnected.');
          setTracks((t) => ({ ...t, audio: false }));
        };

        producersRef.current.webcam = await produce(videoTrack, {
          mediaType: "webcam",
          encodings: [{ maxBitrate: 200000 }], 
        });
        if (mounted) setTracks((t) => ({ ...t, webcam: true }));

        producersRef.current.audio = await produce(audioTrack, { mediaType: 'audio' });
        if (mounted) setTracks((t) => ({ ...t, audio: true }));

        if (mounted) setStatus(STATUS.CONNECTED);

        await startScreenShare(mounted);
      } catch (err) {
        if (!mounted) return;
        console.error('Student init error:', err);
        setError(err.message || 'Failed to initialize media');
        setStatus(STATUS.ERROR);
      }
    }

    async function startScreenShare(mounted) {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15 } },
          audio: false,
        });

        if (!mounted) { screenStream.getTracks().forEach((t) => t.stop()); return; }

        screenStreamRef.current = screenStream;
        if (screenVideoRef.current) screenVideoRef.current.srcObject = screenStream;

        const [screenTrack] = screenStream.getVideoTracks();
        screenTrack.addEventListener("ended", stopScreenShare);

        producersRef.current.screen = await produce(screenTrack, {
          mediaType: "screen",
          encodings: [{ maxBitrate: 300000 }],
        });
        if (mounted) setTracks((t) => ({ ...t, screen: true }));
      } catch (e) {
        console.warn('Screen share not started:', e.message);
      }
    }

    init();

    const onDisconnect = () => {
      setStatus(STATUS.ERROR);
      setError('Connection to server lost. Attempting to reconnect...');
    };

    socket.on('peerJoined', ({ role }) => { if (role === 'proctor') setProctorCount((n) => n + 1); });
    socket.on('peerLeft', () => setProctorCount((n) => Math.max(0, n - 1)));
    socket.on('disconnect', onDisconnect);

    return () => {
      mounted = false;
      socket.off('peerJoined');
      socket.off('peerLeft');
      socket.off('disconnect');
      cleanup();
    };
  }, []); // eslint-disable-line

  const stopScreenShare = useCallback(() => {
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    if (producersRef.current.screen) {
      socket.emit('producerClosed', { producerId: producersRef.current.screen.id });
      producersRef.current.screen.close();
      producersRef.current.screen = null;
    }
    setTracks((t) => ({ ...t, screen: false }));
    if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
  }, []);

  const restartScreenShare = useCallback(async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15 } },
        audio: false,
      });
      screenStreamRef.current = screenStream;
      if (screenVideoRef.current) screenVideoRef.current.srcObject = screenStream;

      const [screenTrack] = screenStream.getVideoTracks();
      screenTrack.addEventListener('ended', stopScreenShare);
      producersRef.current.screen = await produce(screenTrack, { mediaType: 'screen' });
      setTracks((t) => ({ ...t, screen: true }));
    } catch (e) {
      console.warn('Restart screen share cancelled:', e.message);
    }
  }, [produce, stopScreenShare]);

  const cleanup = () => {
    Object.values(producersRef.current).forEach((p) => p?.close());
    webcamStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    socket.disconnect();
  };

  const handleLeave = () => {
    cleanup();
    onLeave();
  };

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <header className="flex items-center justify-between px-6 py-4 border-b border-surface-3 bg-surface-1">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-accent animate-pulse_slow" />
          <span className="font-mono text-xs text-accent tracking-widest uppercase">ProctorSFU</span>
          <span className="text-text-faint font-mono text-xs">·</span>
          <span className="font-mono text-xs text-text-muted">{sessionId}</span>
        </div>

        <div className="flex items-center gap-3">
          <TrackBadge label="Webcam" active={tracks.webcam} color="accent" />
          <TrackBadge label="Mic" active={tracks.audio} color="accent" />
          <TrackBadge label="Screen" active={tracks.screen} color="warn" />
          {status === STATUS.CONNECTED && (
            <span className="font-mono text-xs text-accent flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              LIVE
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className="font-display text-sm text-text-muted">{name}</span>
          <button
            onClick={handleLeave}
            className="px-3 py-1.5 rounded-lg border border-danger/40 text-danger text-xs font-mono hover:bg-danger/10 transition-all"
          >
            Leave
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col lg:flex-row gap-5 p-6">
        <div className="flex-1 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-text-muted uppercase tracking-widest">
              Webcam Preview
            </span>
            {tracks.webcam && (
              <span className="font-mono text-xs text-accent flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-accent rounded-full animate-pulse" />
                Broadcasting
              </span>
            )}
          </div>
          <div className="relative flex-1 bg-surface-2 rounded-2xl border border-surface-4 overflow-hidden min-h-70">
            <video
              ref={webcamVideoRef}
              autoPlay
              muted
              playsInline
              className="w-full h-full object-cover"
            />
            {!tracks.webcam && (
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-text-faint font-mono text-sm">Initializing camera…</span>
              </div>
            )}
            <div className="absolute bottom-3 left-3 px-3 py-1 rounded-lg bg-surface/70 backdrop-blur-sm border border-surface-3">
              <span className="font-mono text-xs text-accent">{name}</span>
            </div>
          </div>
        </div>

        <div className="flex-1 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-text-muted uppercase tracking-widest">
              Screen Share
            </span>
            <div className="flex items-center gap-2">
              {tracks.screen ? (
                <button
                  onClick={stopScreenShare}
                  className="px-2.5 py-1 rounded-lg border border-danger/40 text-danger text-xs font-mono hover:bg-danger/10 transition-all"
                >
                  Stop Sharing
                </button>
              ) : (
                <button
                  onClick={restartScreenShare}
                  className="px-2.5 py-1 rounded-lg border border-accent/40 text-accent text-xs font-mono hover:bg-accent/10 transition-all"
                >
                  Share Screen
                </button>
              )}
            </div>
          </div>
          <div className="relative flex-1 bg-surface-2 rounded-2xl border border-surface-4 overflow-hidden min-h-70 scan-line">
            <video
              ref={screenVideoRef}
              autoPlay
              muted
              playsInline
              className="w-full h-full object-contain"
            />
            {!tracks.screen && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <div className="w-16 h-16 rounded-full border-2 border-dashed border-surface-4 flex items-center justify-center">
                  <span className="text-2xl">🖥️</span>
                </div>
                <span className="text-text-muted font-mono text-sm">No screen being shared</span>
                <button
                  onClick={restartScreenShare}
                  className="px-4 py-2 rounded-xl border border-accent/40 text-accent text-xs font-mono hover:bg-accent/10 transition-all"
                >
                  Start Sharing
                </button>
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className="px-6 py-3 border-t border-surface-3 bg-surface-1 flex items-center justify-between">
        <div className="flex items-center gap-4">
          {status === STATUS.LOADING && (
            <span className="font-mono text-xs text-warn flex items-center gap-2">
              <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
              </svg>
              Initializing…
            </span>
          )}
          {status === STATUS.ERROR && (
            <span className="font-mono text-xs text-danger">✗ {error}</span>
          )}
          {status === STATUS.CONNECTED && (
            <span className="font-mono text-xs text-accent">✓ Secure Connection Active</span>
          )}
        </div>
        <div className="flex items-center gap-4 font-mono text-xs text-text-muted">
          {proctorCount > 0 && (
            <span className="text-accent">
              👁 {proctorCount} proctor{proctorCount !== 1 ? 's' : ''} monitoring
            </span>
          )}
          <span>Session: <span className="text-text">{sessionId}</span></span>
        </div>
      </footer>
    </div>
  );
}