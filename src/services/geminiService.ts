import { GoogleGenAI, Modality } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export type GeminiVoice = 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';

export async function convertVoice(
  audioBase64: string,
  targetVoice: GeminiVoice,
  mimeType: string = 'audio/wav'
): Promise<string> {
  try {
    const cleanMimeType = mimeType.split(';')[0];

    // Step 1: Transcribe the audio
    const transcriptionResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: 'user',
          parts: [
            { text: `Transcribe exactly what is being said in the provided audio file. Output ONLY the transcription, without any markdown formatting or extra text.` },
            { inlineData: { data: audioBase64, mimeType: cleanMimeType } }
          ]
        }
      ]
    });

    const transcription = transcriptionResponse.text;
    if (!transcription || transcription.trim() === '') {
      throw new Error("Could not transcribe the audio. Please provide clearer audio.");
    }

    // Step 2: Generate audio with the selected voice
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text: transcription }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: targetVoice }
          }
        }
      }
    });

    const parts = response.candidates?.[0]?.content?.parts;

    let resultAudioBase64: string | undefined;

    if (parts) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          resultAudioBase64 = part.inlineData.data;
          break;
        }
      }
    }
    
    if (!resultAudioBase64) {
      console.log("Full response for debugging:", JSON.stringify(response, null, 2));
      throw new Error("No audio returned from Gemini. Please try again with a different recording.");
    }

    return resultAudioBase64;
  } catch (error) {
    console.error("Gemini Voice Conversion Error:", error);
    throw error;
  }
}
