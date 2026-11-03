import { useState, useRef, useEffect } from 'react';
import { Mic, Square, Copy, Save, Check, Loader, Pause, Play, Trash2 } from 'lucide-react';

const App = () => {
  // 'idle' | 'connecting' | 'recording' | 'paused' | 'reconnecting'
  const [status, setStatus] = useState('idle');
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [isCopied, setIsCopied] = useState(false);

  const socketRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const workletNodeRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const muteGainRef = useRef(null);

  const isPausedRef = useRef(false);
  const isRecordingActiveRef = useRef(false);
  const keepAliveTimerRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 5;

  const transcriptBoxRef = useRef(null);

  const DEEPGRAM_API_KEY = import.meta.env.VITE_DEEPGRAM_API_KEY;

  // Auto-scroll transcript container as new words arrive
  useEffect(() => {
    if (transcriptBoxRef.current) {
      transcriptBoxRef.current.scrollTop = transcriptBoxRef.current.scrollHeight;
    }
  }, [transcript, interimTranscript]);

  const startKeepAlive = (socket) => {
    stopKeepAlive();
    // Deepgram inactivity timeout is 10-12s. Sending KeepAlive every 5s keeps it open indefinitely.
    keepAliveTimerRef.current = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, 5000);
  };

  const stopKeepAlive = () => {
    if (keepAliveTimerRef.current) {
      clearInterval(keepAliveTimerRef.current);
      keepAliveTimerRef.current = null;
    }
  };

  const handleAudioBuffer = (float32) => {
    // Skip sending audio chunks when paused to save bandwidth/API usage
    if (isPausedRef.current) return;

    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      // Convert float32 [-1, 1] to int16 [-32768, 32767] (linear16 PCM)
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      socket.send(int16.buffer);
    }
  };

  const setupAudioPipeline = async (stream) => {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    audioContextRef.current = audioContext;

    const source = audioContext.createMediaStreamSource(stream);
    sourceRef.current = source;

    // Silent gain node to keep the audio graph active without mic playback through speakers
    const muteGain = audioContext.createGain();
    muteGain.gain.value = 0;
    muteGainRef.current = muteGain;
    muteGain.connect(audioContext.destination);

    let workletInitialized = false;

    // Prefer AudioWorkletNode: runs in a dedicated background audio thread, immune to UI thread stalls & GC pauses
    if (audioContext.audioWorklet) {
      try {
        const workletCode = `
          class PCMCaptureProcessor extends AudioWorkletProcessor {
            process(inputs) {
              const input = inputs[0];
              if (input && input[0]) {
                this.port.postMessage(input[0]);
              }
              return true;
            }
          }
          registerProcessor('pcm-capture-processor', PCMCaptureProcessor);
        `;
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        await audioContext.audioWorklet.addModule(workletUrl);
        URL.revokeObjectURL(workletUrl);

        const workletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor');
        workletNodeRef.current = workletNode;

        workletNode.port.onmessage = (e) => {
          handleAudioBuffer(e.data);
        };

        source.connect(workletNode);
        workletNode.connect(muteGain);
        workletInitialized = true;
      } catch (err) {
        console.warn('AudioWorklet initialization failed, falling back to ScriptProcessor:', err);
      }
    }

    // Fallback: ScriptProcessorNode
    if (!workletInitialized) {
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (e) => {
        handleAudioBuffer(e.inputBuffer.getChannelData(0));
      };
      source.connect(processor);
      processor.connect(muteGain);
    }
  };

  const connectDeepgramSocket = () => {
    if (!DEEPGRAM_API_KEY) {
      alert('VITE_DEEPGRAM_API_KEY is missing in .env.local');
      cleanupResources();
      setStatus('idle');
      return;
    }

    const params = new URLSearchParams({
      model: 'nova-3',
      language: 'en',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      filler_words: 'true',
      punctuate: 'true',
      interim_results: 'true',
      endpointing: '300',
      utterance_end_ms: '1000',
      vad_events: 'true',
    });

    const wsUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    const socket = new WebSocket(wsUrl, ['token', DEEPGRAM_API_KEY]);
    socketRef.current = socket;

    socket.onopen = () => {
      console.log('Deepgram WebSocket connected.');
      reconnectAttemptsRef.current = 0;
      startKeepAlive(socket);
      setStatus(isPausedRef.current ? 'paused' : 'recording');
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'Results' && data.channel?.alternatives?.[0]) {
          const newTranscript = data.channel.alternatives[0].transcript;
          if (newTranscript) {
            if (data.is_final) {
              setTranscript((prev) => prev + newTranscript + ' ');
              setInterimTranscript('');
            } else {
              setInterimTranscript(newTranscript);
            }
          }
        } else if (data.type === 'UtteranceEnd') {
          // Clear interim transcription during silent periods
          setInterimTranscript('');
        }
      } catch (err) {
        console.error('Error handling WebSocket message:', err);
      }
    };

    socket.onclose = (event) => {
      console.log(`Deepgram WebSocket closed. Code: ${event.code}, Reason: ${event.reason || 'None'}`);
      stopKeepAlive();

      // If recording was active and not explicitly stopped by the user, automatically reconnect
      if (isRecordingActiveRef.current) {
        handleAutoReconnect();
      }
    };

    socket.onerror = (err) => {
      console.error('Deepgram WebSocket error:', err);
      // Browser will fire onclose after onerror, triggering reconnect if still active
    };
  };

  const handleAutoReconnect = () => {
    if (!isRecordingActiveRef.current) return;

    if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
      console.error(`Max reconnect attempts (${maxReconnectAttempts}) reached.`);
      alert('Connection lost. Please check your network connection or API quota.');
      stopRecording();
      return;
    }

    setStatus('reconnecting');
    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttemptsRef.current), 8000);
    console.log(`Reconnecting Deepgram in ${delay}ms (Attempt ${reconnectAttemptsRef.current + 1}/${maxReconnectAttempts})...`);

    reconnectTimeoutRef.current = setTimeout(() => {
      if (isRecordingActiveRef.current) {
        reconnectAttemptsRef.current += 1;
        connectDeepgramSocket();
      }
    }, delay);
  };

  const startRecording = async () => {
    try {
      setStatus('connecting');
      setTranscript('');
      setInterimTranscript('');
      isPausedRef.current = false;
      isRecordingActiveRef.current = true;
      reconnectAttemptsRef.current = 0;

      // Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      await setupAudioPipeline(stream);
      connectDeepgramSocket();
    } catch (error) {
      console.error('Error starting recording:', error);
      alert('Could not start recording. Check console for details.');
      cleanupResources();
      setStatus('idle');
    }
  };

  const pauseRecording = () => {
    isPausedRef.current = true;
    setInterimTranscript('');
    setStatus('paused');
  };

  const resumeRecording = () => {
    isPausedRef.current = false;
    setStatus('recording');
  };

  const cleanupResources = () => {
    isRecordingActiveRef.current = false;
    isPausedRef.current = false;

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    stopKeepAlive();

    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    if (muteGainRef.current) {
      muteGainRef.current.disconnect();
      muteGainRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (socketRef.current) {
      socketRef.current.onclose = null;
      socketRef.current.onerror = null;
      if (
        socketRef.current.readyState === WebSocket.OPEN ||
        socketRef.current.readyState === WebSocket.CONNECTING
      ) {
        socketRef.current.close();
      }
      socketRef.current = null;
    }
  };

  const stopRecording = () => {
    cleanupResources();
    setStatus('idle');
  };

  const clearTranscript = () => {
    setTranscript('');
    setInterimTranscript('');
    setIsCopied(false);
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(transcript + interimTranscript);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  const saveToFile = () => {
    const textToSave = transcript + interimTranscript;
    if (!textToSave.trim()) return;

    const date = new Date();
    const timestamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}_${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}-${String(date.getSeconds()).padStart(2, '0')}`;
    const filename = `Recording_${timestamp}.txt`;

    const blob = new Blob([textToSave], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    }, 0);
  };

  const cleanupRef = useRef(null);

  useEffect(() => {
    cleanupRef.current = cleanupResources;
  });

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const isRecording = status === 'recording';
  const isPaused = status === 'paused';
  const isConnecting = status === 'connecting';
  const isReconnecting = status === 'reconnecting';
  const isIdle = status === 'idle';

  return (
    <div className="app-container">
      <div className="recorder-card">
        <div className="header">
          <h1>Speech to Text Recorder</h1>
          <div
            className={`status-badge ${isRecording ? 'status-recording' : ''} ${
              isConnecting ? 'status-connecting' : ''
            } ${isReconnecting ? 'status-reconnecting' : ''} ${
              isPaused ? 'status-paused' : ''
            }`}
          >
            {isRecording ? (
              <><span className="pulse-dot"></span> Recording</>
            ) : isPaused ? (
              <><span className="paused-dot"></span> Paused</>
            ) : isConnecting ? (
              <><Loader size={14} className="spinner" /> Connecting...</>
            ) : isReconnecting ? (
              <><Loader size={14} className="spinner" /> Reconnecting...</>
            ) : (
              <><span className="idle-dot"></span> Idle</>
            )}
          </div>
        </div>

        {isRecording && (
          <div className="recording-bar">
            <span className="bar-segment"></span>
            <span className="bar-segment"></span>
            <span className="bar-segment"></span>
            <span className="bar-segment"></span>
            <span className="bar-segment"></span>
          </div>
        )}

        {isPaused && (
          <div className="recording-bar paused-bar">
            <span className="bar-segment"></span>
            <span className="bar-segment"></span>
            <span className="bar-segment"></span>
            <span className="bar-segment"></span>
            <span className="bar-segment"></span>
          </div>
        )}

        <div className="transcript-box" ref={transcriptBoxRef}>
          <div className="text-content">
            {transcript}
            <span className="interim">{interimTranscript}</span>
            {!transcript && !interimTranscript && isIdle && (
              <span className="placeholder">Your speech will appear here...</span>
            )}
            {isConnecting && (
              <span className="placeholder">Connecting to Deepgram...</span>
            )}
            {isReconnecting && (
              <span className="placeholder">Reconnecting to Deepgram...</span>
            )}
          </div>
        </div>

        <div className="controls">
          {isIdle ? (
            <button className="record-btn" onClick={startRecording}>
              <Mic size={24} />
              Start Recording
            </button>
          ) : isConnecting ? (
            <button className="record-btn connecting" disabled>
              <Loader size={24} className="spinner" />
              Connecting...
            </button>
          ) : (
            <div className="active-controls">
              <button
                className={`record-btn ${isPaused ? 'resume' : 'pause'}`}
                onClick={isPaused ? resumeRecording : pauseRecording}
                disabled={isReconnecting}
              >
                {isPaused ? <Play size={24} /> : <Pause size={24} />}
                {isPaused ? 'Resume' : 'Pause'}
              </button>
              <button className="record-btn recording" onClick={stopRecording}>
                <Square size={24} fill="currentColor" />
                Stop
              </button>
            </div>
          )}

          <div className="actions">
            <button
              className="action-btn"
              onClick={copyToClipboard}
              disabled={!transcript && !interimTranscript}
              title="Copy to clipboard"
              aria-label="Copy to clipboard"
            >
              {isCopied ? <Check size={20} className="success-icon" /> : <Copy size={20} />}
            </button>
            <button
              className="action-btn save-btn"
              onClick={saveToFile}
              disabled={!transcript && !interimTranscript}
              title="Save to file"
              aria-label="Save to file"
            >
              <Save size={20} />
            </button>
            <button
              className="action-btn clear-btn"
              onClick={clearTranscript}
              disabled={!transcript && !interimTranscript}
              title="Clear transcript"
              aria-label="Clear transcript"
            >
              <Trash2 size={20} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
