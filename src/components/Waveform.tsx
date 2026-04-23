import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { motion, AnimatePresence } from 'motion/react';
import { Play, Pause, Square } from 'lucide-react';

interface WaveformProps {
  audioUrl?: string;
  isRecording?: boolean;
  color?: string;
  label?: string;
  onPlayStateChange?: (isPlaying: boolean) => void;
}

export default function Waveform({ 
  audioUrl, 
  isRecording, 
  color = '#FF4444', 
  label = 'SIGNAL',
  onPlayStateChange
}: WaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    if (!containerRef.current || isRecording) return;

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: '#2A2D35',
      progressColor: color === '#FF4444' ? '#00F0FF' : color,
      cursorColor: color === '#FF4444' ? '#00F0FF' : color,
      barWidth: 2,
      barGap: 3,
      height: 64,
      normalize: true,
      hideScrollbar: true,
    });

    wavesurferRef.current = ws;

    if (audioUrl) {
      ws.load(audioUrl);
    }

    ws.on('ready', () => {
      setDuration(ws.getDuration());
    });

    ws.on('audioprocess', () => {
      setCurrentTime(ws.getCurrentTime());
    });

    ws.on('play', () => {
      setIsPlaying(true);
      onPlayStateChange?.(true);
    });

    ws.on('pause', () => {
      setIsPlaying(false);
      onPlayStateChange?.(false);
    });

    ws.on('finish', () => {
      setIsPlaying(false);
      onPlayStateChange?.(false);
    });

    return () => ws.destroy();
  }, [audioUrl, isRecording, color, onPlayStateChange]);

  const togglePlay = () => {
    wavesurferRef.current?.playPause();
  };

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    const ms = Math.floor((time % 1) * 100);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  return (
    <div className="bg-[#0F1115] p-4 rounded-lg border border-[#2A2D35] space-y-3">
      <div className="flex items-center justify-between">
        <span className="label-mono">
          {label}
        </span>
        <div className="flex items-center gap-3">
           <span className="text-[11px] font-mono text-[#666]">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
          <div className={`w-2 h-2 rounded-full ${isRecording ? 'bg-accent animate-pulse glow-cyan' : 'bg-[#2A2D35]'}`} />
        </div>
      </div>

      <div className="relative">
        {isRecording && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="absolute inset-0 flex items-center justify-center gap-1 z-10"
          >
            {[...Array(12)].map((_, i) => (
              <motion.div
                key={i}
                animate={{
                  height: [8, 24, 8],
                }}
                transition={{
                  repeat: Infinity,
                  duration: 0.5,
                  delay: i * 0.05,
                }}
                className="w-1 bg-[#00F0FF]/50 rounded-full"
              />
            ))}
          </motion.div>
        )}
        <div ref={containerRef} className={`${isRecording ? 'opacity-20' : 'opacity-100'} transition-opacity`} />
      </div>

      {!isRecording && audioUrl && (
        <div className="flex justify-center pt-2">
          <button
            onClick={togglePlay}
            className="p-2 hover:bg-white/5 rounded-full transition-colors text-white"
          >
            {isPlaying ? <Pause size={20} className="text-accent" /> : <Play size={20} />}
          </button>
        </div>
      )}
    </div>
  );
}
