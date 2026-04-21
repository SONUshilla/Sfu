import { useRef, useCallback } from 'react';
import { Device } from 'mediasoup-client';
import socket from '../socket';

export function useMediasoup() {
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);

  const loadDevice = useCallback(async (routerRtpCapabilities) => {
    const device = new Device();
    await device.load({ routerRtpCapabilities });
    deviceRef.current = device;
    return device;
  }, []);

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

        // Catch silent ICE failures for Sender
        transport.on('connectionstatechange', (state) => {
          console.log(`[SendTransport] Connection state: ${state}`);
          if (state === 'disconnected' || state === 'failed') {
            console.error('Send transport connection dropped.');
          }
        });

        sendTransportRef.current = transport;
        resolve(transport);
      });
    });
  }, []);

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

        // Catch silent ICE failures for Receiver and trigger restart
        transport.on('connectionstatechange', (state) => {
          console.log(`[RecvTransport] Connection state: ${state}`);
          if (state === 'failed') {
            console.error('Recv transport failed. Attempting to restart ICE...');
            socket.emit('restartIce', { transportId: transport.id }, (res) => {
               if(res.iceParameters) transport.restartIce({ iceParameters: res.iceParameters });
            });
          }
        });

        recvTransportRef.current = transport;
        resolve(transport);
      });
    });
  }, []);

  const produce = useCallback(async (track, options = {}) => {
    if (!sendTransportRef.current) throw new Error('Send transport not created');
    const { encodings, ...appData } = options;
    
    return await sendTransportRef.current.produce({ 
      track, 
      encodings, 
      appData 
    });
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