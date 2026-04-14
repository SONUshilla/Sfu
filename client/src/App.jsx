import React, { useState } from 'react';
import JoinView from './views/JoinView';
import StudentView from './views/StudentView';
import ProctorView from './views/ProctorView';
import socket from './socket';

export default function App() {
  const [view, setView]               = useState('join');
  const [sessionInfo, setSessionInfo] = useState(null);

  const handleJoin = async ({ name, role, sessionId }) => {
    // Pre-connect and confirm server is reachable before navigating
    await new Promise((resolve, reject) => {
      socket.connect();
      const onConnect = () => { cleanup(); resolve(); };
      const onError   = (err) => { cleanup(); reject(new Error(err?.message || 'Cannot reach server')); };
      const cleanup   = () => { socket.off('connect', onConnect); socket.off('connect_error', onError); };
      socket.once('connect', onConnect);
      socket.once('connect_error', onError);
      setTimeout(() => { cleanup(); reject(new Error('Connection timed out')); }, 8000);
    });

    setSessionInfo({ name, role, sessionId });
    setView(role); // 'student' | 'proctor'
  };

  const handleLeave = () => {
    socket.disconnect();
    setSessionInfo(null);
    setView('join');
  };

  return (
    <>
      {view === 'join'    && <JoinView onJoin={handleJoin} />}
      {view === 'student' && sessionInfo && <StudentView sessionInfo={sessionInfo} onLeave={handleLeave} />}
      {view === 'proctor' && sessionInfo && <ProctorView sessionInfo={sessionInfo} onLeave={handleLeave} />}
    </>
  );
}