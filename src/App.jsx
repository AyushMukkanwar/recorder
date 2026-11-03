import React, { useState, useRef, useEffect } from 'react';
import { Mic, Square, Copy, Save, Check, Loader, Pause, Play } from 'lucide-react';

const App = () => {
  // 'idle' | 'connecting' | 'recording' | 'paused'
  const [status, setStatus] = useState('idle');
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [isCopied, setIsCopied] = useState(false);
  
  const socketRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const isPausedRef = useRef(false);

  const DEEPGRAM_API_KEY = import.meta.env.VITE_DEEPGRAM_API_KEY;

  const startRecording = async () => {
    try {
      setStatus('connecting');
      setTranscript('');
      setInterimTranscript('');
      isPausedRef.current = false;
      
      // Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          channelCount: 1,
          sampleRate: 16000,
        } 
      });
      streamRef.current = stream;
      
      // Build the Deepgram WebSocket URL — matching Claude's config
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
      });

      const wsUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

      // Connect using native browser WebSocket with token auth
      const socket = new WebSocket(wsUrl, ['token', DEEPGRAM_API_KEY]);
      socketRef.current = socket;

      socket.onopen = () => {
        console.log('Deepgram WebSocket connected.');

        // Use Web Audio API to capture raw PCM linear16 audio
        // Create AudioContext at 16kHz — browser will resample mic input to match
        const audioContext = new AudioContext({ sampleRate: 16000 });
        audioContextRef.current = audioContext;

        const source = audioContext.createMediaStreamSource(stream);
        sourceRef.current = source;

        // ScriptProcessorNode to access raw audio samples
        // Buffer size 4096 gives ~256ms chunks at 16kHz
        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (e) => {
          // Skip sending audio when paused
          if (isPausedRef.current) return;

          if (socket.readyState === WebSocket.OPEN) {
            const float32 = e.inputBuffer.getChannelData(0);
            // Convert float32 [-1, 1] to int16 [-32768, 32767] (linear16)
            const int16 = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
              const s = Math.max(-1, Math.min(1, float32[i]));
              int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            socket.send(int16.buffer);
          }
        };

        source.connect(processor);
        // Connect to destination to keep the processor alive (required by spec)
        processor.connect(audioContext.destination);

        setStatus('recording');
      };

      socket.onmessage = (event) => {
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
        }
      };

      socket.onclose = () => {
        console.log('Deepgram connection closed.');
      };

      socket.onerror = (err) => {
        console.error('Deepgram WebSocket error:', err);
        cleanupResources();
        setStatus('idle');
      };
      
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
    isPausedRef.current = false;

    // Disconnect audio processing pipeline
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    
    // Stop microphone
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // Close WebSocket
    if (socketRef.current) {
      if (socketRef.current.readyState === WebSocket.OPEN ||
          socketRef.current.readyState === WebSocket.CONNECTING) {
        socketRef.current.close();
      }
      socketRef.current = null;
    }
  };

  const stopRecording = () => {
    cleanupResources();
    setStatus('idle');
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
    // YYYY-MM-DD_HH-mm-ss
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

  useEffect(() => {
    return () => {
      cleanupResources();
    };
  }, []);

  const isRecording = status === 'recording';
  const isPaused = status === 'paused';
  const isConnecting = status === 'connecting';
  const isIdle = status === 'idle';
  const isActive = isRecording || isPaused;

  return (
    <div className="app-container">
      <div className="recorder-card">
        <div className="header">
          <h1>Speech to Text Recorder</h1>
          <div className={`status-badge ${isRecording ? 'status-recording' : ''} ${isConnecting ? 'status-connecting' : ''} ${isPaused ? 'status-paused' : ''}`}>
             {isRecording ? (
               <><span className="pulse-dot"></span> Recording</>
             ) : isPaused ? (
               <><span className="paused-dot"></span> Paused</>
             ) : isConnecting ? (
               <><Loader size={14} className="spinner" /> Connecting...</>
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

        <div className="transcript-box">
          <div className="text-content">
             {transcript}
             <span className="interim">{interimTranscript}</span>
             {!transcript && !interimTranscript && isIdle && (
               <span className="placeholder">Your speech will appear here...</span>
             )}
             {isConnecting && (
               <span className="placeholder">Connecting to Deepgram...</span>
             )}
          </div>
        </div>

        <div className="controls">
          {isIdle ? (
            <button 
              className="record-btn"
              onClick={startRecording}
            >
              <Mic size={24} />
              Start Recording
            </button>
          ) : isConnecting ? (
            <button 
              className="record-btn connecting"
              disabled
            >
              <Loader size={24} className="spinner" />
              Connecting...
            </button>
          ) : (
            <div className="active-controls">
              <button 
                className={`record-btn ${isPaused ? 'resume' : 'pause'}`}
                onClick={isPaused ? resumeRecording : pauseRecording}
              >
                {isPaused ? <Play size={24} /> : <Pause size={24} />}
                {isPaused ? 'Resume' : 'Pause'}
              </button>
              <button 
                className="record-btn recording"
                onClick={stopRecording}
              >
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
            >
              {isCopied ? <Check size={20} className="success-icon" /> : <Copy size={20} />}
            </button>
            <button 
              className="action-btn" 
              onClick={saveToFile}
              disabled={!transcript && !interimTranscript}
              title="Save to file"
            >
              <Save size={20} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
