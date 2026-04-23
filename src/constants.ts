import { GeminiVoice } from "./services/geminiService";

export const VOICES: { id: GeminiVoice; name: string; description: string }[] = [
  { id: 'Puck', name: 'Puck', description: 'Energetic and youthful male' },
  { id: 'Charon', name: 'Charon', description: 'Deep and authoritative male' },
  { id: 'Kore', name: 'Kore', description: 'Soft and clear female' },
  { id: 'Fenrir', name: 'Fenrir', description: 'Gravelly and powerful male' },
  { id: 'Zephyr', name: 'Zephyr', description: 'Smooth and rhythmic' },
];
