import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { io } from 'socket.io-client';
import { Mic, Settings, Volume2, VolumeX } from 'lucide-react';
import './App.css';

const SAMPLE_RATE = 24000;
const FRAME_DURATION_MS = 80;
const FRAME_SAMPLES = Math.round((SAMPLE_RATE * FRAME_DURATION_MS) / 1000);
const FADE_SAMPLES = 0;
const DEBUG_DIAGNOSTICS = process.env.REACT_APP_DEBUG_DIAGNOSTICS !== 'false';
const MAX_CAPTURED_SAMPLES = SAMPLE_RATE * 180; // keep roughly 3 minutes of audio for debug downloads

const VOICES = [
  { id: 'alloy', name: 'Alloy', description: 'Neutral, balanced voice' },
  { id: 'ash', name: 'Ash', description: 'Warm, thoughtful voice' },
  { id: 'ballad', name: 'Ballad', description: 'Melodic, expressive voice' },
  { id: 'coral', name: 'Coral', description: 'Confident, vibrant voice' },
  { id: 'echo', name: 'Echo', description: 'Calm, professional voice' },
  { id: 'sage', name: 'Sage', description: 'Wise, measured voice' },
  { id: 'shimmer', name: 'Shimmer', description: 'Gentle, soothing voice' },
  { id: 'verse', name: 'Verse', description: 'Clear, articulate voice' }
];

const getVoiceName = (voiceId) => VOICES.find((voice) => voice.id === voiceId)?.name || voiceId;

const createEmptyMetrics = (renderCount) => ({
  frames: 0,
  sumLead: 0,
  minLead: Number.POSITIVE_INFINITY,
  maxLead: Number.NEGATIVE_INFINITY,
  negativeLeadFrames: 0,
  maxAmplitude: 0,
  maxQueueSamples: 0,
  minQueueSamples: Number.POSITIVE_INFINITY,
  events: [],
  renderCountAtStart: renderCount,
  startedAt: Date.now(),
  totalChunks: 0,
  maxChunkSamples: 0,
  sampleQueueSnapshots: [],
});

const decodeBase64ToInt16 = (base64) => {
  const binaryString = atob(base64);
  const pcmData = new Int16Array(binaryString.length / 2);

  for (let i = 0; i < pcmData.length; i++) {
    const byte1 = binaryString.charCodeAt(i * 2);
    const byte2 = binaryString.charCodeAt(i * 2 + 1);
    const sample = (byte2 << 8) | byte1;
    pcmData[i] = (sample << 16) >> 16;
  }

  return pcmData;
};

const appendInt16Samples = (existing, addition) => {
  if (!existing || existing.length === 0) {
    return addition;
  }

  const merged = new Int16Array(existing.length + addition.length);
  merged.set(existing, 0);
  merged.set(addition, existing.length);
  return merged;
};

const createWavFromInt16 = (samples, sampleRate = SAMPLE_RATE, numChannels = 1, bitsPerSample = 16) => {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const int16View = new Int16Array(buffer, 44, samples.length);
  int16View.set(samples);
  return buffer;
};

const int16ToFloat32 = (int16Array) => {
  const float32 = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32[i] = int16Array[i] / 32768;
  }
  return float32;
};

const applyMicroFade = (floatArray, fadeSamples = FADE_SAMPLES) => {
  const length = floatArray.length;
  const fadeCount = Math.min(fadeSamples, Math.floor(length / 2));

  for (let i = 0; i < fadeCount; i++) {
    const fadeInGain = i / fadeCount;
    const fadeOutGain = (fadeCount - i) / fadeCount;

    floatArray[i] *= fadeInGain;
    floatArray[length - 1 - i] *= fadeOutGain;
  }
};

const base64ToUint8Array = (base64) => {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

function App() {
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const candidatesRef = useRef([]);
  const [selectedCandidate, setSelectedCandidate] = useState('texas-governor');
  const [debateMode, setDebateMode] = useState('setup'); // setup, listening, responding, complete
  const [currentQuestion, setCurrentQuestion] = useState('');
  const [opponentResponse, setOpponentResponse] = useState('');
  const [isUpdatingCandidate, setIsUpdatingCandidate] = useState(false);
  const [activeCandidate, setActiveCandidate] = useState('');

  const [selectedVoice, setSelectedVoice] = useState('alloy');
  const [showSettings, setShowSettings] = useState(false);
  const [customInstructions, setCustomInstructions] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);
  const [pushToTalk, setPushToTalk] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [previewScript, setPreviewScript] = useState('');
  const [previewLoadingKey, setPreviewLoadingKey] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const metricsRef = useRef(createEmptyMetrics(renderCountRef.current));
  const lastMetricsRenderCountRef = useRef(renderCountRef.current);

  const audioContextRef = useRef(null);
  const pendingSamplesRef = useRef(new Int16Array(0));
  const nextStartTimeRef = useRef(0);
  const pendingSourceCountRef = useRef(0);
  const activeSourcesRef = useRef(new Set());
  const previewCacheRef = useRef({});
  const isPlayingAudioRef = useRef(false);
  const speechRecognitionRef = useRef(null);
  const recognitionModeRef = useRef(null); // 'question' or 'response'
  const processedFramesRef = useRef([]);
  const processedSampleCountRef = useRef(0);
const masterGainRef = useRef(null);
  const apiBaseUrl = useMemo(() => {
    const explicit = process.env.REACT_APP_API_BASE_URL;
    if (explicit) {
      return explicit.replace(/\/$/, '');
    }
    if (typeof window === 'undefined') {
      return '';
    }
    const { protocol, hostname, port } = window.location;
    let resolvedPort = port;
    if (!resolvedPort) {
      resolvedPort = protocol === 'https:' ? '443' : '80';
    }
    if (hostname === 'localhost' && (port === '3000' || !port)) {
      resolvedPort = '3001';
    }
    return `${protocol}//${hostname}${resolvedPort ? `:${resolvedPort}` : ''}`;
  }, []);

  const recordEvent = useCallback((event) => {
    if (!DEBUG_DIAGNOSTICS) {
      return;
    }
    const metrics = metricsRef.current;
    if (!metrics.events) {
      metrics.events = [];
    }
    metrics.events.push({
      ...event,
      timestamp: new Date().toISOString(),
    });
    if (metrics.events.length > 100) {
      metrics.events.shift();
    }
  }, []);

  const resetMetrics = useCallback(() => {
    metricsRef.current = createEmptyMetrics(renderCountRef.current);
  }, [renderCountRef]);

  const recordFrameMetrics = useCallback(
    (leadTime, maxAmplitude, queueBefore, queueAfter, metadata = {}) => {
      if (!DEBUG_DIAGNOSTICS) {
        return;
      }
      const metrics = metricsRef.current;
      metrics.frames += 1;
      metrics.sumLead += leadTime;
      metrics.minLead = Math.min(metrics.minLead, leadTime);
      metrics.maxLead = Math.max(metrics.maxLead, leadTime);
      if (leadTime < 0) {
        metrics.negativeLeadFrames += 1;
        recordEvent({ type: 'negativeLeadFrame', leadTimeMs: leadTime * 1000, metadata });
      } else if (leadTime < 0.005) {
        recordEvent({ type: 'lowLeadBuffer', leadTimeMs: leadTime * 1000, metadata });
      }

      metrics.maxAmplitude = Math.max(metrics.maxAmplitude, maxAmplitude);
      if (maxAmplitude > 0.98) {
        recordEvent({ type: 'nearClipping', amplitude: maxAmplitude, metadata });
      }

      if (typeof queueBefore === 'number') {
        metrics.maxQueueSamples = Math.max(metrics.maxQueueSamples, queueBefore);
      }
      if (typeof queueAfter === 'number') {
        metrics.minQueueSamples = Math.min(metrics.minQueueSamples, queueAfter);
      }
    },
    [recordEvent]
  );

  const ensureAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume().catch(() => {});
    }
    return audioContextRef.current;
  }, []);

  const ensureAudioGraph = useCallback(() => {
    const audioContext = ensureAudioContext();

    if (!masterGainRef.current) {
      const masterGain = audioContext.createGain();
      masterGain.gain.setValueAtTime(isMuted ? 0 : volume, audioContext.currentTime);
      masterGain.connect(audioContext.destination);
      masterGainRef.current = masterGain;
    }

    return audioContext;
  }, [ensureAudioContext, isMuted, volume]);

  // Audio processing functions
  const clearAudioQueue = useCallback(() => {
    activeSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch (error) {
        // Source might already be stopped; ignore.
      }
    });
    activeSourcesRef.current.clear();
    pendingSamplesRef.current = new Int16Array(0);
    nextStartTimeRef.current = 0;
    pendingSourceCountRef.current = 0;
    isPlayingAudioRef.current = false;
    setIsPlaying(false);
    processedFramesRef.current = [];
    processedSampleCountRef.current = 0;
    if (DEBUG_DIAGNOSTICS) {
      recordEvent({ type: 'clearAudioQueue' });
    }
  }, [recordEvent]);

  const scheduleFrame = useCallback(
    (pcmFrame, options = {}) => {
      if (!pcmFrame || pcmFrame.length === 0) {
        return;
      }

      const audioContext = ensureAudioGraph();
      const floatData = int16ToFloat32(pcmFrame);

      let maxAmplitude = 0;
      if (DEBUG_DIAGNOSTICS) {
        for (let i = 0; i < floatData.length; i += 1) {
          const amplitude = Math.abs(floatData[i]);
          if (amplitude > maxAmplitude) {
            maxAmplitude = amplitude;
          }
        }
      }

      applyMicroFade(floatData);

      const audioBuffer = audioContext.createBuffer(1, floatData.length, SAMPLE_RATE);
      audioBuffer.getChannelData(0).set(floatData);

      const source = audioContext.createBufferSource();

      const startTime = Math.max(nextStartTimeRef.current, audioContext.currentTime + 0.02);
      const leadTime = startTime - audioContext.currentTime;
      nextStartTimeRef.current = startTime + audioBuffer.duration;

      source.buffer = audioBuffer;
      if (masterGainRef.current) {
        source.connect(masterGainRef.current);
      } else {
        source.connect(audioContext.destination);
      }

      activeSourcesRef.current.add(source);
      pendingSourceCountRef.current += 1;
      isPlayingAudioRef.current = true;
      setIsPlaying(true);

      source.onended = () => {
        activeSourcesRef.current.delete(source);
        pendingSourceCountRef.current = Math.max(0, pendingSourceCountRef.current - 1);
        if (pendingSourceCountRef.current === 0 && pendingSamplesRef.current.length === 0) {
          isPlayingAudioRef.current = false;
          setIsPlaying(false);
          nextStartTimeRef.current = 0;
        }
      };

      source.start(startTime);

      if (DEBUG_DIAGNOSTICS) {
        const frameInt16 = new Int16Array(floatData.length);
        for (let i = 0; i < floatData.length; i += 1) {
          frameInt16[i] = Math.max(-32768, Math.min(32767, Math.round(floatData[i] * 32767)));
        }
        processedFramesRef.current.push(frameInt16);
        processedSampleCountRef.current += frameInt16.length;
        while (processedSampleCountRef.current > MAX_CAPTURED_SAMPLES && processedFramesRef.current.length > 0) {
          const removed = processedFramesRef.current.shift();
          processedSampleCountRef.current -= removed.length;
        }
      }

      recordFrameMetrics(
        leadTime,
        maxAmplitude,
        options.queueBefore,
        options.queueAfter,
        { ...options, frameSamples: pcmFrame.length }
      );
    },
    [ensureAudioGraph, recordFrameMetrics]
  );

  const processAudioQueue = useCallback(() => {
    while (pendingSamplesRef.current.length >= FRAME_SAMPLES) {
      const queueBefore = pendingSamplesRef.current.length;
      const frame = pendingSamplesRef.current.slice(0, FRAME_SAMPLES);
      pendingSamplesRef.current = pendingSamplesRef.current.slice(FRAME_SAMPLES);
      const queueAfter = pendingSamplesRef.current.length;

      scheduleFrame(frame, {
        queueBefore,
        queueAfter,
        isRemainder: false,
      });

      if (DEBUG_DIAGNOSTICS) {
        const metrics = metricsRef.current;
        if (metrics.sampleQueueSnapshots.length < 50) {
          metrics.sampleQueueSnapshots.push({ queueBefore, queueAfter });
        }
      }
    }
  }, [scheduleFrame]);

  const flushPendingAudio = useCallback(() => {
    if (pendingSamplesRef.current.length === 0) {
      return;
    }
    const queueBefore = pendingSamplesRef.current.length;
    scheduleFrame(pendingSamplesRef.current, {
      queueBefore,
      queueAfter: 0,
      isRemainder: true,
    });
    pendingSamplesRef.current = new Int16Array(0);
  }, [scheduleFrame]);

  const playAudioDelta = useCallback((audioData) => {
    try {
      ensureAudioGraph();
      const pcmData = decodeBase64ToInt16(audioData);
      pendingSamplesRef.current = appendInt16Samples(pendingSamplesRef.current, pcmData);
      if (DEBUG_DIAGNOSTICS) {
        const metrics = metricsRef.current;
        metrics.totalChunks += 1;
        metrics.maxChunkSamples = Math.max(metrics.maxChunkSamples, pcmData.length);
        metrics.maxQueueSamples = Math.max(metrics.maxQueueSamples, pendingSamplesRef.current.length);
        if (metrics.sampleQueueSnapshots.length < 50) {
          metrics.sampleQueueSnapshots.push({
            queueLength: pendingSamplesRef.current.length,
            chunkSamples: pcmData.length,
          });
        }
        recordEvent({
          type: 'chunkReceived',
          samples: pcmData.length,
          queueLength: pendingSamplesRef.current.length,
        });
      }
      processAudioQueue();
    } catch (error) {
      console.error('Error processing audio:', error);
    }
  }, [ensureAudioGraph, processAudioQueue, recordEvent]);

  const sendPlaybackDiagnostics = useCallback(
    (reason, extra = {}) => {
      if (!DEBUG_DIAGNOSTICS) {
        return;
      }

      const metrics = metricsRef.current;
      const hasData = metrics.frames > 0 || (metrics.events && metrics.events.length > 0) || metrics.totalChunks > 0;
      if (!hasData) {
        return;
      }

      const candidateData = candidatesRef.current.find((candidate) => candidate.id === selectedCandidate);
      const avgLead = metrics.frames ? metrics.sumLead / metrics.frames : null;
      const events = (metrics.events || []).slice(-100);

      const payload = {
        reason,
        candidateId: candidateData?.id,
        candidateName: candidateData?.name,
        voice: selectedVoice,
        frames: metrics.frames,
        avgLeadMs: avgLead != null ? avgLead * 1000 : null,
        minLeadMs: isFinite(metrics.minLead) ? metrics.minLead * 1000 : null,
        maxLeadMs: isFinite(metrics.maxLead) ? metrics.maxLead * 1000 : null,
        negativeLeadFrames: metrics.negativeLeadFrames,
        maxAmplitude: metrics.maxAmplitude,
        maxQueueSamples: metrics.maxQueueSamples,
        minQueueSamples: isFinite(metrics.minQueueSamples) ? metrics.minQueueSamples : null,
        totalChunks: metrics.totalChunks,
        maxChunkSamples: metrics.maxChunkSamples,
        sampleQueueSnapshots: metrics.sampleQueueSnapshots,
        renderCountTotal: renderCountRef.current,
        renderCountDelta: renderCountRef.current - metrics.renderCountAtStart,
        queueSamplesNow: pendingSamplesRef.current.length,
        startedAt: metrics.startedAt,
        durationMs: Date.now() - metrics.startedAt,
        volume,
        isMuted,
        browser: typeof window !== 'undefined' ? window.navigator.userAgent : 'unknown',
        events,
        timestamp: new Date().toISOString(),
        extra,
      };

      const endpointBase = apiBaseUrl || '';
      const endpoint = `${endpointBase}/api/debug/playback-metrics`;

      fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }).catch((error) => {
        console.error('Failed to send playback metrics', error);
      });

      lastMetricsRenderCountRef.current = renderCountRef.current;
      resetMetrics();
    },
    [candidatesRef, selectedCandidate, selectedVoice, volume, isMuted, resetMetrics, apiBaseUrl]
  );

  const playVoicePreview = useCallback(async (voiceIdOverride) => {
    const candidateData = candidates.find((candidate) => candidate.id === selectedCandidate);
    if (!candidateData) {
      setPreviewError('Select a candidate before previewing a voice.');
      return;
    }

    const scriptToUse = (previewScript && previewScript.trim().length > 0)
      ? previewScript.trim()
      : (candidateData.previewLine || `This is ${candidateData.name} speaking in character.`);

    const voiceToUse = voiceIdOverride || selectedVoice || candidateData.voice;
    if (!voiceToUse) {
      setPreviewError('Select a voice to preview.');
      return;
    }

    const cacheKey = `${candidateData.id}:${voiceToUse}:${scriptToUse}`;
    setPreviewLoadingKey(cacheKey);
    setPreviewError(null);

    try {
      let payload = previewCacheRef.current[cacheKey];
      if (!payload) {
        const response = await fetch('/api/voice-preview', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            candidateType: candidateData.id,
            voice: voiceToUse,
            script: scriptToUse
          })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
          throw new Error(data.message || 'Failed to generate voice preview');
        }
        payload = data;
        previewCacheRef.current[cacheKey] = payload;
      }

      if (!payload.audio) {
        throw new Error('Preview audio unavailable');
      }

      const audioContext = ensureAudioGraph();
      const audioBytes = base64ToUint8Array(payload.audio);
      const audioBufferData = audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength);
      const decodedBuffer = await audioContext.decodeAudioData(audioBufferData.slice(0));

      clearAudioQueue();

      const source = audioContext.createBufferSource();
      const startTime = audioContext.currentTime + 0.05;

      source.buffer = decodedBuffer;
      if (masterGainRef.current) {
        source.connect(masterGainRef.current);
      } else {
        source.connect(audioContext.destination);
      }

      activeSourcesRef.current.add(source);
      pendingSourceCountRef.current += 1;
      isPlayingAudioRef.current = true;
      setIsPlaying(true);
      nextStartTimeRef.current = startTime + decodedBuffer.duration;

      source.onended = () => {
        activeSourcesRef.current.delete(source);
        pendingSourceCountRef.current = Math.max(0, pendingSourceCountRef.current - 1);
        if (pendingSourceCountRef.current === 0) {
          isPlayingAudioRef.current = false;
          setIsPlaying(false);
          nextStartTimeRef.current = 0;
        }
      };

      source.start(startTime);
    } catch (error) {
      console.error('Error generating voice preview:', error);
      setPreviewError(error.message || 'Failed to preview voice');
    } finally {
      setPreviewLoadingKey(null);
    }
  }, [candidates, selectedCandidate, selectedVoice, previewScript, ensureAudioGraph, clearAudioQueue]);

  const downloadProcessedAudio = useCallback(() => {
    if (!DEBUG_DIAGNOSTICS) {
      return;
    }
    const totalSamples = processedSampleCountRef.current;
    if (!totalSamples) {
      alert('No processed audio captured yet.');
      return;
    }

    const merged = new Int16Array(totalSamples);
    let offset = 0;
    processedFramesRef.current.forEach((frame) => {
      merged.set(frame, offset);
      offset += frame.length;
    });

    const wavBuffer = createWavFromInt16(merged);
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `processed-playback-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, []);

  useEffect(() => {
    // Initialize speech recognition
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      speechRecognitionRef.current = new SpeechRecognition();
      speechRecognitionRef.current.continuous = true;
      speechRecognitionRef.current.interimResults = true;
      speechRecognitionRef.current.lang = 'en-US';

      speechRecognitionRef.current.onresult = (event) => {
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          }
        }
        
        if (finalTranscript) {
          if (recognitionModeRef.current === 'question') {
            setCurrentQuestion(prev => prev + finalTranscript);
          } else if (recognitionModeRef.current === 'response') {
            setOpponentResponse(prev => prev + finalTranscript);
          }
        }
      };

      speechRecognitionRef.current.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        setIsRecording(false);
      };

      speechRecognitionRef.current.onend = () => {
        setIsRecording(false);
        recognitionModeRef.current = null;
      };
    }

    // Initialize socket connection
    const newSocket = io('http://localhost:3001');
    setSocket(newSocket);

    newSocket.on('connect', () => {
      setIsConnected(true);
      console.log('Connected to server');
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
      console.log('Disconnected from server');
      sendPlaybackDiagnostics('socket-disconnect');
    });

    newSocket.on('session-started', (data) => {
      console.log('Session started:', data);
      setIsSessionActive(true);
    });

    newSocket.on('audio-response', (data) => {
      if (data.type === 'audio-delta' && data.delta) {
        playAudioDelta(data.delta);
      } else if (data.type === 'audio-done') {
        flushPendingAudio();
        sendPlaybackDiagnostics('audio-done');
      }
    });

    newSocket.on('error', (error) => {
      console.error('Socket error:', error);
      const errorMessage = error?.message || error?.error?.message || 'Unknown error occurred';
      alert('Error: ' + errorMessage);
      setIsSessionActive(false);
      setIsRecording(false);
      clearAudioQueue();
      sendPlaybackDiagnostics('socket-error', { errorMessage });
    });

    newSocket.on('speech-started', () => {
      console.log('Speech detected by AI');
    });

    newSocket.on('speech-stopped', () => {
      console.log('Speech ended, AI processing...');
      setIsProcessing(true);
    });

    newSocket.on('response-complete', () => {
      console.log('AI response complete');
      setIsProcessing(false);
      flushPendingAudio();
       sendPlaybackDiagnostics('response-complete');
    });

    newSocket.on('candidate-updated', (data) => {
      console.log('✅ Personality Reset Complete:', data);
      setIsUpdatingCandidate(false);
      setActiveCandidate(data.candidate);
      setPreviewLoadingKey(null);
      setPreviewError(null);
      
      // Show success feedback
      if (data.message) {
        console.log('🎭 ' + data.message);
      }
      
      // Update the voice selection to match the new candidate
      const candidateData = candidatesRef.current.find((c) => (data.candidateId ? c.id === data.candidateId : c.name === data.candidate));
      setSelectedVoice(data.voice || candidateData?.voice || 'alloy');
      if (data.previewLine) {
        setPreviewScript(data.previewLine);
      } else if (candidateData?.previewLine) {
        setPreviewScript(candidateData.previewLine);
      }

      if (data.candidateId) {
        setCandidates((prev) => {
          const updated = prev.map((candidate) => {
            if (candidate.id !== data.candidateId) {
              return candidate;
            }
            return {
              ...candidate,
              voice: data.voice || candidate.voice,
              voiceOptions: data.voiceOptions || candidate.voiceOptions,
              accentExamples: data.accentExamples || candidate.accentExamples,
              keyIssues: data.keyIssues || candidate.keyIssues,
              previewLine: data.previewLine || candidate.previewLine
            };
          });
          candidatesRef.current = updated;
          return updated;
        });
      }
      
      // Optional: Show user-friendly notification
      // This could be a toast notification in a real app
      console.log(`🎯 Now debating as: ${data.candidate}`);
    });

    // Load available candidates
    loadCandidates();

    return () => {
      sendPlaybackDiagnostics('socket-effect-cleanup');
      clearAudioQueue();
      newSocket.close();
    };
  }, [playAudioDelta, flushPendingAudio, clearAudioQueue, sendPlaybackDiagnostics]);

  const loadCandidates = async () => {
    try {
      const response = await fetch('/api/candidates');
      const candidateData = await response.json();
      setCandidates(candidateData);
      candidatesRef.current = candidateData;
    } catch (error) {
      console.error('Error loading candidates:', error);
    }
  };

  useEffect(() => {
    const candidateData = candidates.find((candidate) => candidate.id === selectedCandidate);
    if (candidateData) {
      setPreviewScript(candidateData.previewLine || `This is ${candidateData.name} speaking in character.`);
    }
  }, [selectedCandidate, candidates]);

  useEffect(() => {
    const audioContext = audioContextRef.current;
    if (masterGainRef.current && audioContext) {
      masterGainRef.current.gain.setTargetAtTime(isMuted ? 0 : volume, audioContext.currentTime, 0.01);
    }
  }, [volume, isMuted]);

  const startDebateSession = async () => {
    if (!socket || !isConnected) {
      alert('Not connected to server. Please refresh the page.');
      return;
    }

    try {
      console.log('Starting debate session...');
      // Clear any existing audio queues
      clearAudioQueue();
      setCurrentQuestion('');
      setOpponentResponse('');
      setDebateMode('listening');
      
      const config = {
        candidateType: selectedCandidate,
        voice: selectedVoice,
        customInstructions: customInstructions || undefined
      };

      socket.emit('start-voice-session', config);
      
      // Set the active candidate
      const candidateData = candidates.find(c => c.id === selectedCandidate);
      if (candidateData) {
        setActiveCandidate(candidateData.name);
      }
    } catch (error) {
      console.error('Error starting debate session:', error);
      alert('Error starting debate session: ' + error.message);
    }
  };

  const updateCandidate = async (candidateId) => {
    if (!socket || !isConnected) {
      console.log('Not connected to server');
      return;
    }

    if (isSessionActive) {
      // Update candidate during active session with complete personality reset
      try {
        clearAudioQueue();
        setIsUpdatingCandidate(true);
        
        const candidateData = candidates.find(c => c.id === candidateId);
        const candidateName = candidateData ? candidateData.name : candidateId;
        
        console.log('🔄 INITIATING PERSONALITY RESET...');
        console.log(`📋 Switching from: ${activeCandidate || 'Unknown'}`);
        console.log(`🎭 Switching to: ${candidateName}`);
        console.log('⚡ This will completely reset the AI\'s memory and personality');
        
        const config = {
          candidateType: candidateId,
          voice: selectedVoice,
          customInstructions: customInstructions || undefined
        };

        socket.emit('update-candidate', config);
      } catch (error) {
        console.error('❌ Error resetting personality:', error);
        setIsUpdatingCandidate(false);
        alert('Error resetting personality: ' + error.message);
      }
    } else {
      // Just update the selection if no active session
      console.log('Updating candidate selection:', candidateId);
    }
  };

  const handleCandidateSelection = (candidateId) => {
    setSelectedCandidate(candidateId);
    setPreviewError(null);
    setPreviewLoadingKey(null);
    
    // Update the voice to match the candidate's default voice
    const candidateData = candidates.find(c => c.id === candidateId);
    if (candidateData) {
      setSelectedVoice(candidateData.voice);
    }
    
    // If there's an active session, update the candidate immediately
    if (isSessionActive) {
      updateCandidate(candidateId);
    }
  };

  const recordModeratorQuestion = () => {
    if (!speechRecognitionRef.current) {
      alert('Speech recognition not supported in this browser. Please use Chrome or Edge.');
      return;
    }
    
    setDebateMode('listening');
    setCurrentQuestion('');
    setOpponentResponse('');
    recognitionModeRef.current = 'question';
    setIsRecording(true);
    speechRecognitionRef.current.start();
  };

  const recordOpponentResponse = () => {
    if (!speechRecognitionRef.current) {
      alert('Speech recognition not supported in this browser. Please use Chrome or Edge.');
      return;
    }
    
    if (currentQuestion.trim() === '') {
      alert('Please record the moderator question first.');
      return;
    }
    
    setDebateMode('listening');
    setOpponentResponse('');
    recognitionModeRef.current = 'response';
    setIsRecording(true);
    speechRecognitionRef.current.start();
  };

  const stopCurrentRecording = () => {
    if (speechRecognitionRef.current && isRecording) {
      speechRecognitionRef.current.stop();
    }
  };

  const generateAIResponse = () => {
    if (!currentQuestion.trim() || !opponentResponse.trim()) {
      alert('Please record both the moderator question and opponent response first.');
      return;
    }
    
    setDebateMode('responding');
    
    // Create context for the AI with the question and opponent's response
    const debateContext = `
MODERATOR QUESTION: "${currentQuestion}"

OPPONENT'S RESPONSE: "${opponentResponse}"

Your task: Provide your response to the moderator's question while also addressing key points made by your opponent. Remember your background, policy positions, and debate strategy.`;

    // Send context to AI and trigger response
    if (socket) {
      socket.emit('send-debate-context', debateContext);
      socket.emit('create-response');
    }
  };





  const stopVoiceSession = () => {
    if (socket) {
      socket.disconnect();
      setIsSessionActive(false);
      setIsRecording(false);
      setActiveCandidate('');
      setIsUpdatingCandidate(false);
      clearAudioQueue();
      setPreviewLoadingKey(null);
      setPreviewError(null);
    }
  };



  const createCustomCandidate = async () => {
    if (!customInstructions.trim()) {
      alert('Please enter custom candidate instructions');
      return;
    }

    try {
      const response = await fetch('/api/candidates/custom', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'custom-candidate',
          name: 'Custom Candidate',
          background: 'Custom Background',
          party: 'Independent',
          region: 'USA',
          profession: 'Public Service',
          instructions: customInstructions,
          voice: selectedVoice
        })
      });

      if (response.ok) {
        alert('Custom candidate created successfully!');
        setSelectedCandidate('custom-candidate');
        loadCandidates();
      } else {
        alert('Error creating custom candidate');
      }
    } catch (error) {
      console.error('Error creating custom candidate:', error);
    }
  };

  const selectedCandidateData = candidates.find((candidate) => candidate.id === selectedCandidate);
  const previewIsLoading = previewLoadingKey !== null;

  return (
    <div className="App">
      <div className="container">
        <header className="header">
          <h1>🗳️ Presidential Debate Simulator</h1>
          <p>Debate AI candidates with rich personalities and political backgrounds</p>
        </header>

        <div className="main-content">
          <div className="controls-section">
            <div className="candidate-selector">
              <h3>Choose AI Candidate</h3>
              {isSessionActive && (
                <p className="live-switching-info">
                  💡 Live Personality Switching: Click any candidate to completely reset the AI's memory and switch to that personality. Previous conversation history will be cleared for clean personality transitions.
                </p>
              )}
              <div className="candidate-grid">
                {candidates.map(candidate => (
                  <div
                    key={candidate.id}
                    className={`candidate-card ${selectedCandidate === candidate.id ? 'selected' : ''} ${(isUpdatingCandidate || isPlaying) ? 'disabled' : ''}`}
                    onClick={() => !isUpdatingCandidate && !isPlaying && handleCandidateSelection(candidate.id)}
                  >
                    <div className="candidate-header">
                      <div className="candidate-name">{candidate.name}</div>
                      <div className="candidate-background">{candidate.background}</div>
                      <div className="candidate-party">{candidate.party}</div>
                      <div className="candidate-voice">Default voice: {getVoiceName(candidate.voice)}</div>
                      {candidate.voiceOptions && candidate.voiceOptions.length > 0 && (
                        <div className="candidate-voice-options">
                          Recommended: {candidate.voiceOptions.map(getVoiceName).join(', ')}
                        </div>
                      )}
                    </div>
                    
                    <div className="candidate-personality">
                      {candidate.coreCharacteristics && candidate.coreCharacteristics.length > 0 && (
                        <div className="personality-section">
                          <h5>🧠 Core Personality</h5>
                          <ul className="personality-list">
                            {candidate.coreCharacteristics.slice(0, 3).map((trait, index) => (
                              <li key={index}>{trait}</li>
                            ))}
                            {candidate.coreCharacteristics.length > 3 && (
                              <li className="more-indicator">+{candidate.coreCharacteristics.length - 3} more traits</li>
                            )}
                          </ul>
                        </div>
                      )}
                      
                      {candidate.emotionalTriggers && candidate.emotionalTriggers.length > 0 && (
                        <div className="personality-section">
                          <h5>⚡ Gets Passionate About</h5>
                          <ul className="personality-list">
                            {candidate.emotionalTriggers.slice(0, 2).map((trigger, index) => (
                              <li key={index}>{trigger}</li>
                            ))}
                            {candidate.emotionalTriggers.length > 2 && (
                              <li className="more-indicator">+{candidate.emotionalTriggers.length - 2} more topics</li>
                            )}
                          </ul>
                        </div>
                      )}
                      
                      {candidate.signaturePhrases && candidate.signaturePhrases.length > 0 && (
                        <div className="personality-section">
                          <h5>💬 Speaking Style</h5>
                          <ul className="personality-list">
                            {candidate.signaturePhrases.slice(0, 2).map((phrase, index) => (
                              <li key={index}>{phrase}</li>
                            ))}
                            {candidate.signaturePhrases.length > 2 && (
                              <li className="more-indicator">+{candidate.signaturePhrases.length - 2} more patterns</li>
                            )}
                          </ul>
                        </div>
                      )}
                      
                      {candidate.personalAnecdotes && candidate.personalAnecdotes.length > 0 && (
                        <div className="personality-section">
                          <h5>📚 Personal Stories</h5>
                          <ul className="personality-list">
                            {candidate.personalAnecdotes.slice(0, 2).map((anecdote, index) => (
                              <li key={index}>{anecdote}</li>
                            ))}
                            {candidate.personalAnecdotes.length > 2 && (
                              <li className="more-indicator">+{candidate.personalAnecdotes.length - 2} more stories</li>
                            )}
                          </ul>
                        </div>
                      )}
                      
                      {candidate.regionalCharacteristics && candidate.regionalCharacteristics.length > 0 && (
                        <div className="personality-section">
                          <h5>🌍 Regional Style</h5>
                          <ul className="personality-list">
                            {candidate.regionalCharacteristics.slice(0, 2).map((characteristic, index) => (
                              <li key={index}>{characteristic}</li>
                            ))}
                            {candidate.regionalCharacteristics.length > 2 && (
                              <li className="more-indicator">+{candidate.regionalCharacteristics.length - 2} more traits</li>
                            )}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="voice-selector">
              <h3>Voice Settings</h3>
              <select
                value={selectedVoice}
                onChange={(e) => {
                  setSelectedVoice(e.target.value);
                  setPreviewError(null);
                }}
                className="voice-select"
              >
                {VOICES.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name} - {voice.description}
                  </option>
                ))}
              </select>

              {selectedCandidateData?.voiceOptions?.length > 0 && (
                <div className="voice-recommendations">
                  <span>Recommended voices:</span>
                  <div className="voice-chip-group">
                    {selectedCandidateData.voiceOptions.map((voiceOption) => (
                      <button
                        key={voiceOption}
                        type="button"
                        className={`voice-chip ${selectedVoice === voiceOption ? 'active' : ''}`}
                        onClick={() => {
                          setSelectedVoice(voiceOption);
                          setPreviewError(null);
                        }}
                      >
                        {VOICES.find((voice) => voice.id === voiceOption)?.name || voiceOption}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="voice-preview-panel">
                <label className="preview-label" htmlFor="voice-preview-script">
                  Preview script
                </label>
                <textarea
                  id="voice-preview-script"
                  value={previewScript}
                  onChange={(e) => {
                    setPreviewScript(e.target.value);
                    setPreviewError(null);
                  }}
                  rows={3}
                  className="preview-script-input"
                  placeholder="Enter a line to hear this persona."
                />
                <button
                  onClick={() => playVoicePreview()}
                  className="preview-btn"
                  disabled={previewIsLoading}
                >
                  {previewIsLoading ? 'Generating preview...' : 'Preview selected voice'}
                </button>
                {DEBUG_DIAGNOSTICS && (
                  <button
                    type="button"
                    onClick={downloadProcessedAudio}
                    className="preview-btn secondary"
                    disabled={processedSampleCountRef.current === 0}
                  >
                    Download playback audio (debug)
                  </button>
                )}
                {previewError && <div className="preview-error">{previewError}</div>}
                {selectedCandidateData?.accentExamples?.length > 0 && (
                  <div className="accent-cues">
                    <strong>Accent cues:</strong>
                    <ul>
                      {selectedCandidateData.accentExamples.slice(0, 4).map((cue, index) => (
                        <li key={index}>{cue}</li>
                      ))}
                      {selectedCandidateData.accentExamples.length > 4 && (
                        <li className="more-indicator">+{selectedCandidateData.accentExamples.length - 4} more cues</li>
                      )}
                    </ul>
                  </div>
                )}
              </div>
            </div>

                         <div className="audio-controls">
               <div className="volume-control">
                 <button
                   onClick={() => setIsMuted(!isMuted)}
                   className="volume-btn"
                 >
                   {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
                 </button>
                 <input
                   type="range"
                   min="0"
                   max="1"
                   step="0.1"
                   value={volume}
                   onChange={(e) => setVolume(parseFloat(e.target.value))}
                   className="volume-slider"
                 />
               </div>
               <div className="push-to-talk-toggle">
                 <label>
                   <input
                     type="checkbox"
                     checked={pushToTalk}
                     onChange={(e) => setPushToTalk(e.target.checked)}
                   />
                   Push to Talk Mode
                 </label>
               </div>
             </div>
          </div>

                    <div className="debate-section">
            <div className="status-bar">
              <div className={`status-indicator ${isConnected ? 'connected' : 'disconnected'}`}>
                {isConnected ? '🟢 Connected' : '🔴 Disconnected'}
              </div>
              <div className={`session-indicator ${isSessionActive ? 'active' : 'inactive'}`}>
                {isSessionActive ? '🎯 Debate Active' : '⏸️ Setup Mode'}
              </div>
              <div className={`debate-mode-indicator ${debateMode}`}>
                {debateMode === 'setup' && '📋 Setup'}
                {debateMode === 'listening' && '👂 Listening'}
                {debateMode === 'responding' && '🗣️ AI Responding'}
              </div>
              {isSessionActive && activeCandidate && (
                <div className="active-candidate-indicator">
                  👤 {activeCandidate}
                  {isUpdatingCandidate && <span className="updating-indicator">🔄 Resetting personality...</span>}
                </div>
              )}
            </div>

            <div className="debate-controls">
              {!isSessionActive ? (
                <button
                  onClick={startDebateSession}
                  className="start-debate-btn"
                  disabled={!isConnected}
                >
                  Start Debate Session
                </button>
              ) : (
                <div className="debate-flow">
                  <div className="debate-steps">
                    <div className="step">
                      <h4>1. Moderator Question</h4>
                      <button
                        onClick={isRecording && recognitionModeRef.current === 'question' ? stopCurrentRecording : recordModeratorQuestion}
                        className={`step-btn ${debateMode === 'listening' && recognitionModeRef.current === 'question' ? 'active' : ''}`}
                        disabled={isRecording && recognitionModeRef.current !== 'question'}
                      >
                        <Mic size={20} />
                        {isRecording && recognitionModeRef.current === 'question' ? 'Stop Recording Question' : 'Record Question'}
                      </button>
                      {currentQuestion && (
                        <div className="recorded-content">
                          <strong>Question:</strong> {currentQuestion}
                        </div>
                      )}
                    </div>

                    <div className="step">
                      <h4>2. Human Opponent Response</h4>
                      <button
                        onClick={isRecording && recognitionModeRef.current === 'response' ? stopCurrentRecording : recordOpponentResponse}
                        className={`step-btn ${debateMode === 'listening' && recognitionModeRef.current === 'response' ? 'active' : ''}`}
                        disabled={!currentQuestion || (isRecording && recognitionModeRef.current !== 'response')}
                      >
                        <Mic size={20} />
                        {isRecording && recognitionModeRef.current === 'response' ? 'Stop Recording Response' : 'Record Response'}
                      </button>
                      {opponentResponse && (
                        <div className="recorded-content">
                          <strong>Opponent:</strong> {opponentResponse}
                        </div>
                      )}
                    </div>

                    <div className="step">
                      <h4>3. AI Candidate Response</h4>
                      <button
                        onClick={generateAIResponse}
                        className={`step-btn ai-response ${debateMode === 'responding' ? 'active' : ''}`}
                        disabled={!currentQuestion || !opponentResponse || isPlaying}
                      >
                        🤖 Generate AI Response
                      </button>
                    </div>
                  </div>

                  {isPlaying && (
                    <button
                      onClick={clearAudioQueue}
                      className="interrupt-btn"
                    >
                      Stop AI Response
                    </button>
                  )}

                  <button
                    onClick={stopVoiceSession}
                    className="stop-debate-btn"
                  >
                    End Debate
                  </button>
                </div>
              )}
            </div>

            <div className="activity-indicator">
              {isUpdatingCandidate && <div className="updating-pulse">🔄 Resetting AI Personality & Memory...</div>}
              {isRecording && recognitionModeRef.current === 'question' && (
                <div className="recording-pulse">🎙️ Recording moderator question... Speak clearly!</div>
              )}
              {isRecording && recognitionModeRef.current === 'response' && (
                <div className="recording-pulse">🎙️ Recording opponent response... Speak clearly!</div>
              )}
              {isProcessing && <div className="processing-pulse">🤔 AI analyzing...</div>}
              {isPlaying && <div className="playing-pulse">🗣️ AI Candidate Speaking...</div>}
              {debateMode === 'setup' && isSessionActive && !isUpdatingCandidate && (
                <div className="instructions">
                  📋 Follow the 3-step debate process: Record moderator question → Record opponent response → Generate AI response
                </div>
              )}
            </div>
          </div>

          <div className="settings-section">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="settings-toggle"
            >
              <Settings size={20} />
              Create Custom Candidate
            </button>

            {showSettings && (
              <div className="settings-panel">
                <h3>Custom Presidential Candidate</h3>
                <p>Create your own AI presidential candidate with unique background, policies, and personality:</p>
                <textarea
                  value={customInstructions}
                  onChange={(e) => setCustomInstructions(e.target.value)}
                  placeholder="Enter detailed candidate profile including:
- Background & Experience (profession, education, career)
- Core Policy Positions (economy, healthcare, foreign policy, etc.)
- Speaking Style & Personality
- Regional Characteristics
- Debate Strategy

Example: You are Senator Maria Santos, a 42-year-old former teacher from Arizona..."
                  className="custom-instructions"
                  rows="12"
                />
                <button
                  onClick={createCustomCandidate}
                  className="create-candidate-btn"
                >
                  Create Custom Candidate
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App; 
