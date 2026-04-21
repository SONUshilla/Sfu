'use strict';
import express from "express";
import http from 'http';
import { Server } from 'socket.io';
import mediasoup from 'mediasoup';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 10000, 
  pingInterval: 5000,
});

const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8',  clockRate: 90000, parameters: { 'x-google-start-bitrate': 1000 } },
  { kind: 'video', mimeType: 'video/VP9',  clockRate: 90000, parameters: { 'profile-id': 2, 'x-google-start-bitrate': 1000 } },
  {
    kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '4d0032', 'level-asymmetry-allowed': 1, 'x-google-start-bitrate': 1000 },
  },
];

const ANNOUNCED_IP = process.env.ANNOUNCED_IP || '127.0.0.1'; // Change to your public server IP
const RTC_MIN_PORT = parseInt(process.env.RTC_MIN_PORT || '40000');
const RTC_MAX_PORT = parseInt(process.env.RTC_MAX_PORT || '49999');

const WEBRTC_TRANSPORT_OPTIONS = {
  listenIps: [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  initialAvailableOutgoingBitrate: 1_000_000,
  minimumAvailableOutgoingBitrate: 600_000,
};

let worker = null;
const rooms = new Map();

async function createWorker() {
  const w = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: RTC_MIN_PORT,
    rtcMaxPort: RTC_MAX_PORT,
  });
  w.on('died', (err) => { console.error('mediasoup Worker died:', err); process.exit(1); });
  console.log(`mediasoup Worker created [pid:${w.pid}]`);
  return w;
}

async function getOrCreateRoom(sessionId) {
  if (!rooms.has(sessionId)) {
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    
    router.observer.on('close', () => {
       console.log(`Router for room ${sessionId} closed`);
       rooms.delete(sessionId);
    });

    rooms.set(sessionId, {
      router,
      peers: new Map(),
      flags: new Map(),
    });
    console.log(`Room created: ${sessionId}`);
  }
  return rooms.get(sessionId);
}

function cleanupRoom(sessionId) {
  const room = rooms.get(sessionId);
  if (room && room.peers.size === 0) {
    room.router.close();
    rooms.delete(sessionId);
    console.log(`Room closed: ${sessionId}`);
  }
}

function emitToRole(room, role, event, data) {
  for (const [, p] of room.peers) {
    if (p.role === role) io.to(p.id).emit(event, data);
  }
}

function buildFlagsPayload(room) {
  const result = {};
  for (const [studentId, list] of room.flags) {
    result[studentId] = list;
  }
  return result;
}

io.on('connection', (socket) => {
  console.log(`[${socket.id}] connected`);

  let room = null;
  let peer = null;

  socket.on('join', async ({ sessionId, role, name }, cb) => {
    try {
      room = await getOrCreateRoom(sessionId);
      peer = {
        id: socket.id, name, role, sessionId,
        transports: new Map(), producers: new Map(), consumers: new Map(),
      };
      room.peers.set(socket.id, peer);
      socket.join(sessionId);

      console.log(`[${socket.id}] join role=${role} name="${name}" session=${sessionId}`);
      socket.to(sessionId).emit('peerJoined', { peerId: socket.id, name, role });

      let existingProducers = [];
      if (role === 'proctor') {
        for (const [peerId, p] of room.peers) {
          if (p.role !== 'student') continue;
          for (const [, producer] of p.producers) {
            if (producer.appData.mediaType === 'screen') continue;
            existingProducers.push({
              peerId, producerId: producer.id, peerName: p.name,
              mediaType: producer.appData.mediaType, kind: producer.kind,
            });
          }
        }
      }

      cb({
        ok: true,
        routerRtpCapabilities: room.router.rtpCapabilities,
        existingProducers,
        existingPeers: Array.from(room.peers.values())
          .filter((p) => p.id !== socket.id)
          .map((p) => ({ peerId: p.id, name: p.name, role: p.role })),
        flags: buildFlagsPayload(room),
      });
    } catch (err) {
      console.error('join error:', err);
      cb({ ok: false, error: err.message });
    }
  });

  socket.on('createWebRtcTransport', async ({ direction }, cb) => {
    try {
      const transport = await room.router.createWebRtcTransport(WEBRTC_TRANSPORT_OPTIONS);
      transport.on('dtlsstatechange', (s) => { if (s === 'closed') transport.close(); });
      transport.observer.on('close', () => peer.transports.delete(transport.id));

      peer.transports.set(transport.id, transport);
      cb({
        ok: true,
        transportId: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (err) { cb({ ok: false, error: err.message }); }
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, cb) => {
    try {
      const t = peer.transports.get(transportId);
      if (!t) throw new Error(`Transport not found: ${transportId}`);
      await t.connect({ dtlsParameters });
      cb({ ok: true });
    } catch (err) { cb({ ok: false, error: err.message }); }
  });

  socket.on('restartIce', async ({ transportId }, cb) => {
    try {
      const t = peer.transports.get(transportId);
      if (!t) throw new Error('Transport not found');
      const iceParameters = await t.restartIce();
      cb({ ok: true, iceParameters });
    } catch (err) { cb({ ok: false, error: err.message }); }
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, cb) => {
    try {
      const transport = peer.transports.get(transportId);
      if (!transport) throw new Error(`Transport not found: ${transportId}`);

      const producer = await transport.produce({ kind, rtpParameters, appData });
      peer.producers.set(producer.id, producer);
      producer.on('transportclose', () => producer.close());

      console.log(`[${socket.id}] produce kind=${kind} mediaType=${appData.mediaType} id=${producer.id}`);

      if (appData.mediaType !== 'screen') {
        emitToRole(room, 'proctor', 'newProducer', {
          peerId: socket.id, producerId: producer.id, peerName: peer.name,
          mediaType: appData.mediaType, kind,
        });
      }

      cb({ ok: true, producerId: producer.id });
    } catch (err) { cb({ ok: false, error: err.message }); }
  });

  socket.on('producerClosed', ({ producerId }) => {
    const producer = peer?.producers?.get(producerId);
    if (producer) {
      producer.close();
      peer.producers.delete(producerId);
      io.to(peer.sessionId).emit('producerClosed', { producerId, peerId: socket.id });
    }
  });

  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, cb) => {
    try {
      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error(`Cannot consume producer ${producerId}`);
      }
      const transport = peer.transports.get(transportId);
      if (!transport) throw new Error(`Transport not found: ${transportId}`);

      const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
      peer.consumers.set(consumer.id, consumer);

      consumer.on('transportclose', () => consumer.close());
      consumer.on('producerclose', () => {
        peer.consumers.delete(consumer.id);
        socket.emit('consumerClosed', { consumerId: consumer.id });
      });
      
      consumer.on('producerpause',  () => socket.emit('consumerPaused',  { consumerId: consumer.id }));
      consumer.on('producerresume', () => socket.emit('consumerResumed', { consumerId: consumer.id }));

      cb({
        ok: true,
        consumerId: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (err) { cb({ ok: false, error: err.message }); }
  });

  socket.on('resumeConsumer', async ({ consumerId }, cb) => {
    try {
      const consumer = peer.consumers.get(consumerId);
      if (!consumer) throw new Error(`Consumer not found: ${consumerId}`);
      await consumer.resume();
      cb({ ok: true });
    } catch (err) { cb({ ok: false, error: err.message }); }
  });

  socket.on('flagStudent', ({ studentId, note, severity }, cb) => {
    try {
      if (peer.role !== 'proctor') throw new Error('Not authorized');

      if (!room.flags.has(studentId)) room.flags.set(studentId, []);
      const flag = {
        flagId: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        proctorId: socket.id, proctorName: peer.name,
        studentName: room.peers.get(studentId)?.name || 'Unknown',
        note: note || '', severity: severity || 'warning', ts: Date.now(),
      };
      room.flags.get(studentId).push(flag);

      console.log(`[proctor ${peer.name}] flagged student=${studentId} severity=${flag.severity}`);
      emitToRole(room, 'proctor', 'studentFlagged', { studentId, flag });

      cb({ ok: true, flag });
    } catch (err) { cb({ ok: false, error: err.message }); }
  });

  socket.on('disconnect', () => {
    console.log(`[${socket.id}] disconnected`);
    if (!room || !peer) return;

    for (const t of peer.transports.values()) t.close();

    const sessionId = peer.sessionId;
    const leftRole  = peer.role;
    const leftName  = peer.name;
    room.peers.delete(socket.id);

    io.to(sessionId).emit('peerLeft', { peerId: socket.id, role: leftRole, name: leftName });
    cleanupRoom(sessionId);
  });
});

app.get('/health', (_, res) => res.json({ status: 'ok', rooms: rooms.size, pid: process.pid }));

const PORT = parseInt(process.env.PORT || '3001');

(async () => {
  try {
    worker = await createWorker();
    httpServer.listen(PORT, () => {
      console.log(`\n🚀 ProctorSFU  http://0.0.0.0:${PORT}`);
      console.log(`   ANNOUNCED_IP : ${ANNOUNCED_IP}`);
      console.log(`   RTC ports    : ${RTC_MIN_PORT}–${RTC_MAX_PORT}\n`);
    });
  } catch (err) {
    console.error('Boot failed:', err);
    process.exit(1);
  }
})();