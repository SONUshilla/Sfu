import { useRef, useCallback } from 'react';
import { Device } from 'mediasoup-client';
import socket from '../socket';

/**
 * Core mediasoup-client hook.
 * Handles Device loading, transport creation, producing, and consuming.
 */
export function useMediasoup() {
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);

  // ── Load Device ─────────────────────────────────────────────────────────────
  const loadDevice = useCallback(async (routerRtpCapabilities) => {
    const device = new Device();
    await device.load({ routerRtpCapabilities });
    deviceRef.current = device;
    return device;
  }, []);

  // ── Create Send Transport (student → SFU) ───────────────────────────────────
  const createSendTransport = useCallback(() => {
    return new Promise((resolve, reject) => {
      socket.emit('createWebRtcTransport', { direction: 'send' }, (data) => {
        if (!data.ok) return reject(new Error(data.error));

        const transport = deviceRef.current.createSendTransport({
          id: data.transportId,
          iceParameters: data.iceParameters,
          iceCandidates: data.iceCandidates,
          dtlsParameters: data.dtlsParameters,
        });

        // Connect fired once on first produce
        transport.on('connect', ({ dtlsParameters }, callback, errback) => {
          socket.emit(
            'connectTransport',
            { transportId: transport.id, dtlsParameters },
            (res) => (res.ok ? callback() : errback(new Error(res.error)))
          );
        });

        // Produce event: server creates producer, returns producerId
        transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
          socket.emit(
            'produce',
            { transportId: transport.id, kind, rtpParameters, appData },
            (res) => (res.ok ? callback({ id: res.producerId }) : errback(new Error(res.error)))
          );
        });

        sendTransportRef.current = transport;
        resolve(transport);
      });
    });
  }, []);

  // ── Create Recv Transport (SFU → proctor) ───────────────────────────────────
  const createRecvTransport = useCallback(() => {
    return new Promise((resolve, reject) => {
      socket.emit('createWebRtcTransport', { direction: 'recv' }, (data) => {
        if (!data.ok) return reject(new Error(data.error));

        const transport = deviceRef.current.createRecvTransport({
          id: data.transportId,
          iceParameters: data.iceParameters,
          iceCandidates: data.iceCandidates,
          dtlsParameters: data.dtlsParameters,
        });

        transport.on('connect', ({ dtlsParameters }, callback, errback) => {
          socket.emit(
            'connectTransport',
            { transportId: transport.id, dtlsParameters },
            (res) => (res.ok ? callback() : errback(new Error(res.error)))
          );
        });

        recvTransportRef.current = transport;
        resolve(transport);
      });
    });
  }, []);

// ── Produce a Track ──────────────────────────────────────────────────────────
  const produce = useCallback(async (track, options = {}) => {
    if (!sendTransportRef.current) throw new Error('Send transport not created');

    // Separate the encodings from the rest of your appData (like mediaType)
    const { encodings, ...appData } = options;

    const producer = await sendTransportRef.current.produce({ 
      track, 
      encodings, // <── This applies the 100kbps bitrate limit
      appData    // <── This keeps your { mediaType: 'webcam' } intact
    });

    return producer;
  }, []);

  // ── Consume a Remote Producer ────────────────────────────────────────────────
  const consume = useCallback((producerId) => {
    return new Promise((resolve, reject) => {
      if (!deviceRef.current?.rtpCapabilities) return reject(new Error('Device not loaded'));

      socket.emit(
        'consume',
        {
          transportId: recvTransportRef.current.id,
          producerId,
          rtpCapabilities: deviceRef.current.rtpCapabilities,
        },
        async (data) => {
          if (!data.ok) return reject(new Error(data.error));

          const consumer = await recvTransportRef.current.consume({
            id: data.consumerId,
            producerId: data.producerId,
            kind: data.kind,
            rtpParameters: data.rtpParameters,
          });

          // Resume (server starts paused to avoid packet loss before client is ready)
          socket.emit('resumeConsumer', { consumerId: consumer.id }, () => {});

          resolve(consumer);
        }
      );
    });
  }, []);

  return {
    deviceRef,
    sendTransportRef,
    recvTransportRef,
    loadDevice,
    createSendTransport,
    createRecvTransport,
    produce,
    consume,
  };
}