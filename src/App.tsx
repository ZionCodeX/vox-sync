import { useState, useRef, ChangeEvent } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, Square, Sparkles, Volume2, AlertCircle, Loader2, Download } from 'lucide-react';
// @ts-ignore
import lamejs from 'lamejs';
import Waveform from './components/Waveform';
import { VOICES } from './constants';
import { convertVoice, GeminiVoice } from './services/geminiService';

const audioBufferToMp3Blob = (buffer: AudioBuffer, targetSampleRate: number): Blob => {
  // @ts-ignore
  const mp3encoder = new lamejs.Mp3Encoder(1, targetSampleRate, 192); // Mono, Sample Rate, Bitrate
  const samples = buffer.getChannelData(0);
  const mp3Data = [];

  const samples16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let sample = Math.max(-1, Math.min(1, samples[i]));
    samples16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
  }

  const sampleBlockSize = 1152;
  for (let i = 0; i < samples16.length; i += sampleBlockSize) {
    const sampleChunk = samples16.subarray(i, i + sampleBlockSize);
    const mp3buf = mp3encoder.encodeBuffer(sampleChunk);
    if (mp3buf.length > 0) {
      mp3Data.push(mp3buf);
    }
  }
  
  const mp3buf = mp3encoder.flush();
  if (mp3buf.length > 0) {
    mp3Data.push(new Int8Array(mp3buf));
  }

  return new Blob(mp3Data, { type: 'audio/mp3' });
};

const audioBufferToWavBlob = (buffer: AudioBuffer): Blob => {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  
  const resultData = new Int16Array(buffer.length * numChannels);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < buffer.length; i++) {
      let sample = Math.max(-1, Math.min(1, channelData[i]));
      resultData[i * numChannels + channel] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    }
  }

  const byteRate = sampleRate * numChannels * (bitDepth / 8);
  const blockAlign = numChannels * (bitDepth / 8);
  const wavBuffer = new ArrayBuffer(44 + resultData.byteLength);
  const view = new DataView(wavBuffer);

  const writeString = (v: DataView, offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      v.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + resultData.byteLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, resultData.byteLength, true);

  const dataView = new Int16Array(wavBuffer, 44);
  dataView.set(resultData);

  return new Blob([wavBuffer], { type: 'audio/wav' });
};

// Input normalizer for Gemini API speed/compatibility
const normalizeInputAudioToWav = async (sourceBlob: Blob): Promise<{ base64: string, mimeType: string }> => {
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  const OfflineAudioContextClass = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  const ctx = new AudioContextClass();
  
  const arrayBuffer = await sourceBlob.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  
  // Downsample to 16000Hz Mono for Gemini to ingest lightning fast
  const targetSampleRate = 16000;
  const offlineCtx = new OfflineAudioContextClass(
    1, 
    Math.max(1, Math.round(audioBuffer.duration * targetSampleRate)), 
    targetSampleRate
  );
  
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start();
  
  const renderedBuffer = await offlineCtx.startRendering();
  
  const wavBlob = audioBufferToWavBlob(renderedBuffer);
  
  if (ctx.state === 'running') await ctx.close();
  
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve({
          base64: reader.result.split(',')[1],
          mimeType: 'audio/wav'
        });
      } else {
        reject(new Error("Failed to read normalized audio."));
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(wavBlob);
  });
};

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sourceAudioUrl, setSourceAudioUrl] = useState<string | null>(null);
  const [targetAudioUrl, setTargetAudioUrl] = useState<string | null>(null);
  const [targetBlob, setTargetBlob] = useState<Blob | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<GeminiVoice>('Kore');
  const [error, setError] = useState<string | null>(null);
  
  // Advanced Audio Settings
  const [syncMode, setSyncMode] = useState<'none' | 'stretch' | 'adr'>('adr');
  const [exportFormat, setExportFormat] = useState<'wav' | 'mp3'>('wav');
  const [exportSampleRate, setExportSampleRate] = useState<number>(44100);
  const [normalizeAudio, setNormalizeAudio] = useState<boolean>(true);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('audio/')) {
      setError("Please upload a valid audio file.");
      return;
    }

    const url = URL.createObjectURL(file);
    setSourceAudioUrl(url);
    setTargetAudioUrl(null);
    setError(null);
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const mimeType = mediaRecorder.mimeType || 'audio/webm';
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        const url = URL.createObjectURL(audioBlob);
        setSourceAudioUrl(url);
      };

      mediaRecorder.start();
      setIsRecording(true);
      setError(null);
    } catch (err: any) {
      console.error("Microphone access error:", err);
      if (err.name === 'NotAllowedError' || err.message?.includes('Permission')) {
        setError("Microphone access denied. Please enable it in browser settings or use the 'Upload Signal' button as a fallback.");
      } else {
        setError("Failed to access microphone. Please check your connection.");
      }
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      setIsRecording(false);
    }
  };

  const fileToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result.split(',')[1]);
        } else {
          reject(new Error("Failed to read file as Base64"));
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const createWavBlob = (pcmData: Uint8Array, sampleRate: number = 24000, numChannels: number = 1): Blob => {
    const byteRate = sampleRate * numChannels * 2;
    const blockAlign = numChannels * 2;
    const buffer = new ArrayBuffer(44 + pcmData.length);
    const view = new DataView(buffer);

    const writeString = (v: DataView, offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        v.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    // RIFF chunk
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + pcmData.length, true);
    writeString(view, 8, 'WAVE');

    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);

    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, pcmData.length, true);

    const pcmView = new Uint8Array(buffer, 44);
    pcmView.set(pcmData);

    return new Blob([buffer], { type: 'audio/wav' });
  };

  const handleConversion = async () => {
    if (!sourceAudioUrl) return;
    
    setIsProcessing(true);
    setError(null);
    
    try {
      // Fetch the blob from URL
      const response = await fetch(sourceAudioUrl);
      const blob = await response.blob();
      
      // Convert to standardized format
      const { base64: base64data, mimeType: cleanMimeType } = await normalizeInputAudioToWav(blob);
      
      const resultBase64 = await convertVoice(base64data, selectedVoice, cleanMimeType);
      
      const binary = atob(resultBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      
      const resultBlob = createWavBlob(bytes, 24000, 1);
      let finalArrayBuffer = await resultBlob.arrayBuffer();
      
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const OfflineAudioContextClass = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
      const calcCtx = new AudioContextClass();
      
      let processingBuffer = await calcCtx.decodeAudioData(finalArrayBuffer);
      let playbackRate = 1.0;
      let origDuration = processingBuffer.duration;

      if (syncMode !== 'none') {
        try {
          const origArrayBuffer = await blob.arrayBuffer();
          const origAudioBuffer = await calcCtx.decodeAudioData(origArrayBuffer);
          origDuration = origAudioBuffer.duration;
          const genDuration = processingBuffer.duration;
          if (origDuration > 0 && genDuration > 0 && syncMode === 'stretch') {
            playbackRate = genDuration / origDuration;
          }
        } catch (syncError) {
          console.error("Temporal sync decode error:", syncError);
        }
      }

      // Main Offline Engine Render (Applies Sample Rate, Pitch lock, and Volume)
      const renderDuration = syncMode === 'none' ? processingBuffer.duration : origDuration;
      
      const offlineCtx = new OfflineAudioContextClass(
        1, 
        Math.max(1, Math.round(renderDuration * exportSampleRate)), 
        exportSampleRate
      );

      if (syncMode === 'adr') {
          // Non-Destructive Auto Dialogue Replacement (Silence Parsing & Retiming)
          const channelData = processingBuffer.getChannelData(0);
          const chunks = [];
          const threshold = 0.05; 
          const minSilenceSamples = processingBuffer.sampleRate * 0.15; 
          const padding = processingBuffer.sampleRate * 0.03; 

          let inChunk = false;
          let startIdx = 0;
          let silenceLen = 0;

          for (let i = 0; i < channelData.length; i++) {
            if (Math.abs(channelData[i]) > threshold) {
                if (!inChunk) {
                  inChunk = true;
                  startIdx = Math.max(0, i - padding);
                }
                silenceLen = 0;
            } else {
                if (inChunk) {
                  silenceLen++;
                  if (silenceLen > minSilenceSamples) {
                      inChunk = false;
                      chunks.push({ start: startIdx, end: Math.min(channelData.length, i - silenceLen + padding) });
                  }
                }
            }
          }
          if (inChunk) chunks.push({ start: startIdx, end: channelData.length });
          if (chunks.length === 0) chunks.push({ start: 0, end: channelData.length });

          const stretchFactor = origDuration / processingBuffer.duration;
          let lastEndSec = 0;

          chunks.forEach(chunk => {
              const chunkStartSec = chunk.start / processingBuffer.sampleRate;
              const chunkDurationSec = (chunk.end - chunk.start) / processingBuffer.sampleRate;
              
              const chunkBuffer = calcCtx.createBuffer(
                  processingBuffer.numberOfChannels, 
                  Math.max(1, chunk.end - chunk.start), 
                  processingBuffer.sampleRate
              );
              for(let c = 0; c < processingBuffer.numberOfChannels; c++) {
                  chunkBuffer.copyToChannel(processingBuffer.getChannelData(c).subarray(chunk.start, chunk.end), c);
              }

              let newStartSec = chunkStartSec * stretchFactor;
              if (newStartSec < lastEndSec) newStartSec = lastEndSec + 0.02; // Prevents stacking collapse

              // Place the chunk unaltered (No scaling/stretching on actual syllables)
              const source = offlineCtx.createBufferSource();
              source.buffer = chunkBuffer;
              source.connect(offlineCtx.destination);
              source.start(newStartSec);
              
              lastEndSec = newStartSec + chunkDurationSec;
          });
      } else {
          // Standard play or Stretch
          const source = offlineCtx.createBufferSource();
          source.buffer = processingBuffer;
          source.playbackRate.value = playbackRate;
          
          // @ts-ignore
          if ('preservesPitch' in source) source.preservesPitch = true;
          
          source.connect(offlineCtx.destination);
          source.start();
      }
      
      let renderedBuffer = await offlineCtx.startRendering();

      if (normalizeAudio) {
        const pcmData = renderedBuffer.getChannelData(0);
        let maxVal = 0;
        for (let i = 0; i < pcmData.length; i++) {
          if (Math.abs(pcmData[i]) > maxVal) maxVal = Math.abs(pcmData[i]);
        }
        if (maxVal > 0) {
          // Normalize to -1dBFS (0.8912)
          const multiplier = 0.8912 / maxVal;
          for (let i = 0; i < pcmData.length; i++) {
            pcmData[i] *= multiplier;
          }
        }
      }

      const finalOutputBlob = exportFormat === 'mp3' 
        ? audioBufferToMp3Blob(renderedBuffer, exportSampleRate)
        : audioBufferToWavBlob(renderedBuffer);
        
      if (calcCtx.state === 'running') await calcCtx.close();

      setTargetBlob(finalOutputBlob);
      const url = URL.createObjectURL(finalOutputBlob);
      setTargetAudioUrl(url);
    } catch (err: any) {
      console.error("Conversion error caught in App:", err);
      if (err.message && err.message.includes('aborted')) {
        setError("The request timed out. The audio clip might be too long. Please try a shorter recording (under 15 seconds).");
      } else {
        setError(err.message || "Failed to convert voice. Try a shorter clip.");
      }
    } finally {
      setIsProcessing(false);
    }
  };


  const reset = () => {
    setSourceAudioUrl(null);
    setTargetAudioUrl(null);
    setError(null);
  };

  return (
    <div className="min-h-screen bg-bg flex flex-col font-sans">
      {/* Header */}
      <header className="h-[60px] border-b border-border flex items-center px-6 justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-[900] tracking-[2px] text-white">VOX-SYNC</span>
          <span className="text-muted text-[10px] mono">v3.1.0 PRO</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="px-2 py-0.5 rounded bg-accent/10 border border-accent/20">
            <span className="text-accent text-[9px] font-bold tracking-wider">TEMPORAL ENGINE READY</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#00FF00] shadow-[0_0_8px_#00FF0066]" />
            <span className="text-[11px] text-[#888] font-mono tracking-tighter">ONLINE</span>
          </div>
        </div>
      </header>

      <main className="flex-grow grid grid-cols-[280px_1fr] md:grid-cols-[300px_1fr] bg-border overflow-hidden gap-[1px]">
        {/* Left Control Panel */}
        <section className="bg-panel p-6 flex flex-col gap-8 overflow-y-auto">
          <div className="space-y-4">
            <span className="label-mono">Target Topology</span>
            <div className="space-y-2">
              {VOICES.map((voice) => (
                <button
                  key={voice.id}
                  onClick={() => setSelectedVoice(voice.id)}
                  className={`w-full text-left p-3 rounded border transition-all ${
                    selectedVoice === voice.id 
                    ? 'bg-accent/5 border-accent text-accent shadow-[0_0_15px_#00F0FF11]' 
                    : 'bg-bg/50 border-transparent text-muted hover:border-border hover:text-white'
                  }`}
                >
                  <div className="text-[12px] font-semibold">{voice.name}</div>
                  <div className="text-[10px] opacity-60 truncate">{voice.description}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-4 pt-4 border-t border-border">
            <span className="label-mono flex items-center justify-between">Temporal Mapping Strategy</span>
            <div className="space-y-3">
               <div className="flex justify-between items-center bg-bg/30 p-2 rounded border border-border">
                 <span className="text-[11px] text-muted font-medium">Alignment Engine</span>
                 <select 
                   value={syncMode}
                   onChange={(e) => setSyncMode(e.target.value as any)}
                   className="bg-panel border border-border text-[11px] text-white px-2 py-1 rounded appearance-none outline-none focus:border-accent font-mono"
                 >
                   <option value="none">Free-Flow (Unsynced)</option>
                   <option value="stretch">Vocoder (Time-Stretch)</option>
                   <option value="adr">ADR Cadence (Pristine)</option>
                 </select>
               </div>
               <p className="text-[10px] text-muted leading-relaxed">
                  {syncMode === 'adr' && "Proportionally distributes exact syllables to the original timeframe using silence-gating. Zero distortion."}
                  {syncMode === 'stretch' && "Mathematically stretches or compresses the waveform. Best for strict frame duration matching, but degrades tone."}
                  {syncMode === 'none' && "Leaves the generated audio completely unaltered in its native pacing."}
               </p>
            </div>
          </div>

          {/* New Audio Export Settings */}
          <div className="space-y-4 pt-4 border-t border-border">
            <span className="label-mono flex items-center justify-between">
              Engine Parameters
            </span>
            
            <div className="space-y-3">
              <div className="flex justify-between items-center bg-bg/30 p-2 rounded border border-border">
                <span className="text-[11px] text-muted font-medium">Output Format</span>
                <select 
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value as 'wav' | 'mp3')}
                  className="bg-panel border border-border text-[11px] text-white px-2 py-1 rounded appearance-none outline-none focus:border-accent font-mono"
                >
                  <option value="wav">WAV Lossless</option>
                  <option value="mp3">MP3 192kbps</option>
                </select>
              </div>

              <div className="flex justify-between items-center bg-bg/30 p-2 rounded border border-border">
                <span className="text-[11px] text-muted font-medium">Sample Rate</span>
                <select 
                  value={exportSampleRate}
                  onChange={(e) => setExportSampleRate(parseInt(e.target.value))}
                  className="bg-panel border border-border text-[11px] text-white px-2 py-1 rounded appearance-none outline-none focus:border-accent font-mono"
                >
                  <option value={48000}>48000 Hz (Video)</option>
                  <option value={44100}>44100 Hz (CD)</option>
                  <option value={24000}>24000 Hz (Native)</option>
                </select>
              </div>

              <div className="flex justify-between items-center bg-bg/30 p-2 rounded border border-border">
                <span className="text-[11px] text-muted font-medium">Peak Normalization</span>
                <button 
                  onClick={() => setNormalizeAudio(!normalizeAudio)} 
                  className={`w-8 h-4 rounded-full relative transition-colors border border-border ${normalizeAudio ? 'bg-accent/20' : 'bg-bg/50'}`}
                >
                  <div className={`w-2 h-2 rounded-full absolute top-[3px] transition-transform ${normalizeAudio ? 'translate-x-[18px] bg-accent glow-cyan' : 'translate-x-[4px] bg-muted'}`} />
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-4 pt-6 border-t border-border">
            <span className="label-mono">System Status</span>
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-bg/50 p-2 rounded border border-border text-center">
                <div className="label-mono opacity-50">Latency</div>
                <div className="text-[11px] font-mono text-accent">1.2ms</div>
              </div>
              <div className="bg-bg/50 p-2 rounded border border-border text-center">
                <div className="label-mono opacity-50">Load</div>
                <div className="text-[11px] font-mono text-[#00FF00]">14.2%</div>
              </div>
            </div>
          </div>

          {error && (
            <div className="mt-auto p-3 bg-red-500/10 border border-red-500/20 rounded text-red-500 text-[11px] flex gap-2">
              <AlertCircle size={14} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </section>

        {/* Center Stage */}
        <section className="bg-bg p-8 flex flex-col gap-6 overflow-y-auto">
          <div className="flex justify-between items-baseline">
            <h2 className="text-xl font-light tracking-tight text-white/90">Temporal Frame Mapping</h2>
            <span className="label-mono text-accent">Sync Deviation: 0.00ms</span>
          </div>

          <div className="flex-grow flex flex-col gap-4">
            {/* Input Waveform */}
            <div className="space-y-2">
              <Waveform 
                audioUrl={sourceAudioUrl || undefined} 
                isRecording={isRecording} 
                label={isRecording ? "Input Signal [Active]" : "Source Frame"} 
                color="#00F0FF"
              />
            </div>

            {/* Actions */}
            <div className="flex gap-4">
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileUpload} 
                accept="audio/*" 
                className="hidden" 
              />
              <AnimatePresence mode="wait">
                {!sourceAudioUrl && !isRecording ? (
                  <div className="flex-1 flex gap-4">
                    <button
                      onClick={startRecording}
                      className="flex-1 btn-primary-cyan h-16 flex items-center justify-center gap-3"
                    >
                      <Mic size={18} /> INITIALIZE CAPTURE
                    </button>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="flex-1 btn-outline-dark h-16 flex items-center justify-center gap-3"
                    >
                      <Volume2 size={18} /> UPLOAD SIGNAL
                    </button>
                  </div>
                ) : isRecording ? (
                  <button
                    onClick={stopRecording}
                    className="flex-1 bg-red-500/10 border border-red-500/50 text-red-500 font-bold uppercase tracking-widest text-[12px] h-16 flex items-center justify-center gap-3 animate-pulse"
                  >
                    <Square size={18} fill="currentColor" /> TERMINATE STREAM
                  </button>
                ) : (
                  <>
                    <button
                      onClick={reset}
                      className="flex-1 btn-outline-dark h-16"
                    >
                      CLEAR BUFFER
                    </button>
                    <button
                      onClick={handleConversion}
                      disabled={isProcessing}
                      className="flex-1 btn-primary-cyan h-16 flex items-center justify-center gap-3 disabled:opacity-50"
                    >
                      {isProcessing ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
                      MORPH TOPOLOGY
                    </button>
                  </>
                )}
              </AnimatePresence>
            </div>

            {/* Output Display */}
            <AnimatePresence>
              {(targetAudioUrl || isProcessing) && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="space-y-2 pt-4"
                >
                  {isProcessing ? (
                    <div className="h-24 bg-panel rounded border border-border flex flex-col items-center justify-center gap-2 text-accent/50">
                      <Loader2 size={24} className="animate-spin" />
                      <span className="label-mono animate-pulse">Scanning Spectral Resonances...</span>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-4">
                      <Waveform 
                        audioUrl={targetAudioUrl!} 
                        label={`Converted Framework [${exportFormat.toUpperCase()} / ${Math.round(exportSampleRate/1000)}k]`} 
                        color="#00F0FF" 
                      />
                      <button
                        onClick={() => {
                          const a = document.createElement('a');
                          a.href = targetAudioUrl!;
                          a.download = `vox-sync-export.${exportFormat}`;
                          a.click();
                        }}
                        className="w-full btn-outline-dark h-12 flex items-center justify-center gap-2 text-[11px] font-bold tracking-widest text-accent border-accent/30 hover:border-accent hover:bg-accent/10 transition-all rounded"
                      >
                        <Download size={14} /> EXPORT COMPILED PACKAGE
                      </button>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="h-[80px] bg-panel border-t border-border flex items-center px-6 gap-8 shrink-0">
        <div className="text-accent font-mono text-2xl tracking-[4px]">
          00:00:<span className="opacity-50">00:00</span>
        </div>
        
        <div className="h-1 bg-border flex-grow rounded-full overflow-hidden">
          <motion.div 
            className="h-full bg-accent glow-cyan" 
            initial={{ width: '0%' }}
            animate={{ width: isRecording ? '100%' : '35%' }}
            transition={{ duration: 1 }}
          />
        </div>

        <div className="flex gap-10">
          <div className="flex flex-col gap-1">
            <span className="label-mono opacity-50">Resonance Sync</span>
            <div className="w-[100px] h-1 bg-border rounded-full overflow-hidden">
              <div className="w-[85%] h-full bg-accent" />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="label-mono opacity-50">Engine Load</span>
            <span className="text-[11px] font-mono text-[#00FF00]">Optimal</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

