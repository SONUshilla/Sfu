import { useRef, useCallback } from 'react';
import { Device } from 'mediasoup-client';
import socket from '../socket';

// Default ICE servers used if none are provided externally
const DEFAULT_ICE_SERVERS = [{
  urls: [
    'stun:stun.relay.metered.ca:80',
    'turn:global.relay.metered.ca:80',
    'turn:global.relay.metered.ca:80?transport=tcp',
    'turn:global.relay.metered.ca:443',
    'turns:global.relay.metered.ca:443?transport=tcp'
  ],
  username: 'openrelayproject',
  credential: 'openrelayproject'
}];

export function useMediasoup() {
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);
  // Store the active iceServers (can be overridden on loadDevice)
  const iceServersRef = useRef(DEFAULT_ICE_SERVERS);

  const loadDevice = useCallback(async (routerRtpCapabilities, customIceServers = null) => {
    // Use custom if provided, otherwise keep existing (or default)
    const iceServers = customIceServers ?? iceServersRef.current;
    iceServersRef.current = iceServers;

    const device = new Device();
    await device.load({ routerRtpCapabilities, iceServers });
    deviceRef.current = device;
    return device;
  }, []);

  const restartIce = useCallback((transport) => {
    if (!transport || transport.closed) return;
    socket.emit('restartIce', { transportId: transport.id }, (res) => {
      if (res?.iceParameters) {
        transport.restartIce({ iceParameters: res.iceParameters })
          .catch((err) => console.error(`[${transport.direction}] ICE restart failed:`, err));
      } else {
        console.warn(`[${transport.direction}] restartIce: no iceParameters returned`);
      }
    });
  }, []);

  const createSendTransport = useCallback((onDropped) => {
    return new Promise((resolve, reject) => {
      socket.emit('createWebRtcTransport', { direction: 'send' }, (data) => {
        if (!data.ok) return reject(new Error(data.error));

        const transport = deviceRef.current.createSendTransport({
          id: data.transportId,
          iceParameters: data.iceParameters,
          iceCandidates: data.iceCandidates,
          dtlsParameters: data.dtlsParameters,
          iceServers: iceServersRef.current,   // 👈 use the stored value
        });

        // ... rest unchanged
        transport.on('connect', ({ dtlsParameters }, callback, errback) => {
          socket.emit(
            'connectTransport',
            { transportId: transport.id, dtlsParameters },
            (res) => (res.ok ? callback() : errback(new Error(res.error)))
          );
        });

        transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
          socket.emit(
            'produce',
            { transportId: transport.id, kind, rtpParameters, appData },
            (res) => (res.ok ? callback({ id: res.producerId }) : errback(new Error(res.error)))
          );
        });

        let iceRestartAttempts = 0;
        const MAX_ICE_RESTARTS = 3;

        transport.on('connectionstatechange', (state) => {
          console.log(`[SendTransport] State: ${state}`);

          if (state === 'disconnected') {
            console.warn('[SendTransport] Disconnected, attempting ICE restart...');
            restartIce(transport);
          }

          if (state === 'failed') {
            if (iceRestartAttempts < MAX_ICE_RESTARTS) {
              iceRestartAttempts++;
              console.warn(`[SendTransport] Failed — ICE restart attempt ${iceRestartAttempts}/${MAX_ICE_RESTARTS}`);
              restartIce(transport);
            } else {
              console.error('[SendTransport] Max ICE restarts reached — escalating to full reconnect');
              iceRestartAttempts = 0;
              onDropped?.();
            }
          }

          if (state === 'connected') {
            iceRestartAttempts = 0;
          }
        });

        sendTransportRef.current = transport;
        resolve(transport);
      });
    });
  }, [restartIce]);

  const createRecvTransport = useCallback(() => {
    return new Promise((resolve, reject) => {
      socket.emit('createWebRtcTransport', { direction: 'recv' }, (data) => {
        if (!data.ok) return reject(new Error(data.error));

        const transport = deviceRef.current.createRecvTransport({
          id: data.transportId,
          iceParameters: data.iceParameters,
          iceCandidates: data.iceCandidates,
          dtlsParameters: data.dtlsParameters,
          iceServers: iceServersRef.current,   // 👈 use the stored value
        });

        // ... rest unchanged
        transport.on('connect', ({ dtlsParameters }, callback, errback) => {
          socket.emit(
            'connectTransport',
            { transportId: transport.id, dtlsParameters },
            (res) => (res.ok ? callback() : errback(new Error(res.error)))
          );
        });

        let iceRestartAttempts = 0;
        const MAX_ICE_RESTARTS = 3;

        transport.on('connectionstatechange', (state) => {
          console.log(`[RecvTransport] State: ${state}`);

          if (state === 'disconnected') {
            console.warn('[RecvTransport] Disconnected, attempting ICE restart...');
            restartIce(transport);
          }

          if (state === 'failed') {
            if (iceRestartAttempts < MAX_ICE_RESTARTS) {
              iceRestartAttempts++;
              console.warn(`[RecvTransport] Failed — ICE restart attempt ${iceRestartAttempts}/${MAX_ICE_RESTARTS}`);
              restartIce(transport);
            } else {
              console.error('[RecvTransport] Max ICE restarts reached — transport unrecoverable');
              iceRestartAttempts = 0;
            }
          }

          if (state === 'connected') {
            iceRestartAttempts = 0;
          }
        });

        recvTransportRef.current = transport;
        resolve(transport);
      });
    });
  }, [restartIce]);

  const produce = useCallback(async (track, options = {}) => {
    if (!sendTransportRef.current) throw new Error('Send transport not created');
    const { encodings, ...appData } = options;
    return await sendTransportRef.current.produce({ track, encodings, appData });
  }, []);

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

          socket.emit('resumeConsumer', { consumerId: consumer.id }, () => {});
          resolve(consumer);
        }
      );
    });
  }, []);

  return { loadDevice, createSendTransport, createRecvTransport, produce, consume };
}