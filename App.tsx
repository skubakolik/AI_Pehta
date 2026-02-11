
import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, Type, FunctionDeclaration } from '@google/genai';
import { ConnectionStatus, Transcription } from './types';
import { PEHTA_SYSTEM_INSTRUCTION, BLED_LOGO } from './constants';
import { decode, decodeAudioData, createBlob } from './services/audioUtils';

// Audio Contexts
let inputAudioContext: AudioContext | null = null;
let outputAudioContext: AudioContext | null = null;
let nextStartTime = 0;
const sources = new Set<AudioBufferSourceNode>();

// Tool Declarations
const getWeatherDeclaration: FunctionDeclaration = {
  name: 'get_weather_bled',
  parameters: {
    type: Type.OBJECT,
    description: 'Get current weather and 3-day forecast for Bled, Slovenia.',
    properties: {},
  },
};

const getEventsDeclaration: FunctionDeclaration = {
  name: 'get_upcoming_events_bled',
  parameters: {
    type: Type.OBJECT,
    description: 'Get upcoming festivals, concerts, and events in Bled.',
    properties: {
      category: {
        type: Type.STRING,
        description: 'Optional category filter (e.g., music, sports, culture).',
      },
    },
  },
};

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);

  const sessionRef = useRef<any>(null);
  const transcriptionsEndRef = useRef<HTMLDivElement>(null);
  
  const currentInputTransRef = useRef('');
  const currentOutputTransRef = useRef('');

  const scrollToBottom = () => {
    transcriptionsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [transcriptions]);

  const stopAllAudio = () => {
    sources.forEach(source => {
      try { source.stop(); } catch(e) {}
    });
    sources.clear();
    nextStartTime = 0;
  };

  const executeTool = async (name: string, args: any) => {
    if (name === 'get_weather_bled') {
      try {
        const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=46.3683&longitude=14.1146&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=Europe%2FLjubljana');
        const data = await res.json();
        return {
          current: {
            temp: data.current_weather.temperature,
            windspeed: data.current_weather.windspeed,
            condition_code: data.current_weather.weathercode
          },
          forecast: data.daily.time.slice(0, 3).map((date: string, i: number) => ({
            date,
            max_temp: data.daily.temperature_2m_max[i],
            min_temp: data.daily.temperature_2m_min[i],
            code: data.daily.weathercode[i]
          }))
        };
      } catch (e) {
        return { error: "Could not fetch weather data at this time." };
      }
    }

    if (name === 'get_upcoming_events_bled') {
      return [
        { name: "Bled Days & Bled Night", date: "July 2026", desc: "Traditional event with lights on the lake and local crafts.", link: "https://www.bled.si/sl/prireditve/" },
        { name: "Okarina Festival", date: "August 2026", desc: "World music festival at Bled Castle and lakeside.", link: "https://www.bled.si/sl/prireditve/" },
        { name: "Rikli Days", date: "July 2026", desc: "Focus on health and the legacy of Arnold Rikli.", link: "https://www.bled.si/sl/prireditve/" },
        { name: "Winter Fairy Tale", date: "Dec 2025 - Jan 2026", desc: "Festive market and ice skating by the lake.", link: "https://www.bled.si/sl/prireditve/" }
      ];
    }
    return { error: "Tool not found" };
  };

  const handleConnection = async () => {
    if (status === ConnectionStatus.CONNECTED || status === ConnectionStatus.CONNECTING) {
      if (sessionRef.current) sessionRef.current.close();
      setStatus(ConnectionStatus.DISCONNECTED);
      setIsListening(false);
      stopAllAudio();
      return;
    }

    try {
      setStatus(ConnectionStatus.CONNECTING);
      setError(null);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

      if (!inputAudioContext) inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      if (!outputAudioContext) outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: PEHTA_SYSTEM_INSTRUCTION,
          tools: [{ functionDeclarations: [getWeatherDeclaration, getEventsDeclaration] }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            setIsListening(true);
            sessionPromise.then(s => s.sendRealtimeInput({ text: "START_CONVERSATION" }));

            const source = inputAudioContext!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContext!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContext!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                const result = await executeTool(fc.name, fc.args);
                sessionPromise.then(s => s.sendToolResponse({
                  functionResponses: [{ id: fc.id, name: fc.name, response: { result } }]
                }));
              }
            }

            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && outputAudioContext) {
              nextStartTime = Math.max(nextStartTime, outputAudioContext.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContext, 24000, 1);
              const source = outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputAudioContext.destination);
              source.addEventListener('ended', () => sources.delete(source));
              source.start(nextStartTime);
              nextStartTime += audioBuffer.duration;
              sources.add(source);
            }

            if (message.serverContent?.interrupted) stopAllAudio();

            if (message.serverContent?.inputTranscription) {
              currentInputTransRef.current += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputTransRef.current += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const userText = currentInputTransRef.current.trim();
              const pehtaText = currentOutputTransRef.current.trim();
              
              if (userText && userText !== "START_CONVERSATION") {
                 setTranscriptions(prev => [...prev, { text: userText, sender: 'user', timestamp: Date.now() }]);
              }
              if (pehtaText) {
                 setTranscriptions(prev => [...prev, { text: pehtaText, sender: 'pehta', timestamp: Date.now() }]);
              }
              
              currentInputTransRef.current = '';
              currentOutputTransRef.current = '';
            }
          },
          onerror: (e) => {
            setError('System temporarily unavailable. Please try again later.');
            setStatus(ConnectionStatus.ERROR);
          },
          onclose: () => {
            setStatus(ConnectionStatus.DISCONNECTED);
            setIsListening(false);
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      setError(err.message || 'Failed to connect to the assistant.');
      setStatus(ConnectionStatus.ERROR);
    }
  };

  return (
    <div className="flex flex-col w-full h-full glass rounded-[2.5rem] overflow-hidden transition-all duration-700">
      <header className="bg-white/90 border-b border-gray-100 p-8 flex items-center justify-between">
        <div className="flex items-center space-x-6">
          <img src={BLED_LOGO} alt="Bled Logo" className="h-16 w-auto object-contain" />
          <div className="h-10 w-[1px] bg-gray-200"></div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Pehta <span className="text-[#0055a4] font-black uppercase text-sm ml-1 tracking-widest">AI Hub</span></h1>
            <p className="text-[10px] text-gray-500 font-bold tracking-[0.2em] uppercase">Infocenter Turizem Bled</p>
          </div>
        </div>
        <div className="flex items-center space-x-3 bg-white px-5 py-2.5 rounded-full border border-gray-100 shadow-sm">
          <div className={`w-2.5 h-2.5 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.6)] animate-pulse' : 'bg-gray-300'}`}></div>
          <span className="text-[10px] font-black text-gray-700 uppercase tracking-widest">{status}</span>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-10 space-y-6 custom-scrollbar relative">
        {transcriptions.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center max-w-2xl mx-auto">
            <div className="w-28 h-28 bg-[#00b2a9]/10 rounded-3xl flex items-center justify-center mb-10 text-[#00b2a9] text-5xl shadow-inner transform rotate-3 hover:rotate-0 transition-transform duration-500">
              <i className="fa-solid fa-mountain-sun"></i>
            </div>
            <h2 className="text-5xl font-black text-gray-900 mb-6 leading-[1.1] tracking-tight">Discover Lake Bled<br/><span className="text-[#0055a4]">with Pehta AI.</span></h2>
            <p className="text-xl text-gray-600 mb-12 leading-relaxed font-medium">
              I'm your official voice assistant. Ask about boat rides, castle entry, cream cakes, or taxi services in any language.
            </p>
            <div className="flex space-x-6">
              <LanguageBadge color="bg-blue-600" label="English" />
              <LanguageBadge color="bg-red-600" label="Slovenščina" />
              <LanguageBadge color="bg-yellow-500" label="Deutsch" />
            </div>
          </div>
        )}

        <div className="max-w-4xl mx-auto space-y-6">
          {transcriptions.map((msg, idx) => (
            <div key={idx} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-4 duration-500`}>
              <div className={`max-w-[75%] rounded-[1.8rem] px-8 py-5 shadow-xl ${
                msg.sender === 'user' 
                  ? 'message-user text-white rounded-tr-none shadow-blue-900/10' 
                  : 'message-pehta text-gray-900 rounded-tl-none shadow-gray-200/50'
              }`}>
                <p className="text-[1.05rem] leading-relaxed font-medium whitespace-pre-wrap">{msg.text}</p>
                <div className={`flex items-center space-x-2 mt-3 opacity-60 ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <span className="text-[9px] uppercase font-black tracking-widest">
                    {msg.sender === 'user' ? 'User Request' : 'Pehta Response'} • {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            </div>
          ))}
          <div ref={transcriptionsEndRef} />
        </div>
      </main>

      <footer className="p-10 bg-white border-t border-gray-100 flex flex-col items-center shadow-[0_-10px_40px_rgba(0,0,0,0.03)]">
        {error && (
          <div className="mb-6 text-red-600 text-sm bg-red-50 px-8 py-4 rounded-[1.2rem] border border-red-100 shadow-sm flex items-center space-x-4 animate-bounce">
            <i className="fa-solid fa-triangle-exclamation text-lg"></i>
            <span className="font-bold">{error}</span>
          </div>
        )}

        <div className="flex items-center space-x-12 w-full justify-center">
          <div className="flex space-x-6">
              <NavButton href="https://www.bled.si/sl/prireditve/" icon="fa-solid fa-calendar-check" label="Events" />
              <NavButton href="https://www.blejski-grad.si/sl/nacrtuj-obisk/cenik/" icon="fa-solid fa-chess-rook" label="Castle" />
          </div>

          <div className="relative group">
            {status === ConnectionStatus.CONNECTED && (
              <>
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-32 h-32 bg-[#0055a4]/10 rounded-full pulse-animation"></div>
                  <div className="w-28 h-28 bg-[#0055a4]/20 rounded-full pulse-animation" style={{animationDelay: '0.8s'}}></div>
                  <div className="w-24 h-24 bg-[#0055a4]/30 rounded-full pulse-animation" style={{animationDelay: '1.6s'}}></div>
                </div>
              </>
            )}
            
            <button
              onClick={handleConnection}
              disabled={status === ConnectionStatus.CONNECTING}
              className={`relative z-10 w-24 h-24 rounded-full flex items-center justify-center text-white text-4xl transition-all duration-500 transform hover:scale-110 active:scale-90 shadow-[0_15px_40px_rgba(0,85,164,0.3)] ${
                status === ConnectionStatus.CONNECTED 
                  ? 'bg-red-500 hover:bg-red-600 shadow-red-500/20' 
                  : 'bg-[#0055a4] hover:bg-[#003d73]'
              } ${status === ConnectionStatus.CONNECTING ? 'opacity-50 cursor-wait' : ''}`}
            >
              {status === ConnectionStatus.CONNECTING ? (
                <i className="fa-solid fa-spinner animate-spin"></i>
              ) : status === ConnectionStatus.CONNECTED ? (
                <i className="fa-solid fa-phone-slash"></i>
              ) : (
                <i className="fa-solid fa-microphone"></i>
              )}
            </button>
          </div>

          <div className="flex space-x-6">
              <NavButton href="https://www.vintgar.si/" icon="fa-solid fa-ticket" label="Vintgar" />
              <NavButton href="https://www.bled.si/en/accommodation/providers-of-accommodation/" icon="fa-solid fa-bed" label="Stay" />
          </div>
        </div>

        <div className="mt-8 text-center">
          <p className="text-[11px] font-black text-gray-400 uppercase tracking-[0.3em]">
            {status === ConnectionStatus.CONNECTED 
              ? 'LIVE VOICE SESSION' 
              : status === ConnectionStatus.CONNECTING 
              ? 'SYNCING WITH BLED INFO HUB...' 
              : 'TAP TO CALL INFOCENTER'}
          </p>
          {status === ConnectionStatus.CONNECTED && (
            <div className="flex items-center justify-center space-x-1.5 mt-3">
              {[1,2,3,4,5,6,7].map(i => (
                <div key={i} className={`w-1.5 bg-[#00b2a9] rounded-full animate-pulse`} style={{animationDelay: `${i*0.15}s`, height: `${Math.random()*20 + 8}px`}}></div>
              ))}
            </div>
          )}
        </div>
      </footer>
    </div>
  );
};

const LanguageBadge: React.FC<{color: string, label: string}> = ({color, label}) => (
  <div className="px-7 py-2.5 bg-white border border-gray-100 rounded-2xl shadow-sm flex items-center space-x-3 transform hover:-translate-y-1 transition-transform duration-300">
    <span className={`w-2.5 h-2.5 ${color} rounded-full`}></span>
    <span className="text-sm font-bold text-gray-800 tracking-tight">{label}</span>
  </div>
);

const NavButton: React.FC<{href: string, icon: string, label: string}> = ({href, icon, label}) => (
  <div className="flex flex-col items-center group">
    <a href={href} target="_blank" className="w-14 h-14 bg-gray-50 rounded-2xl shadow-sm border border-gray-100 flex items-center justify-center text-[#0055a4] hover:bg-[#0055a4] hover:text-white hover:shadow-lg hover:shadow-blue-900/10 transition-all duration-300 transform group-hover:-translate-y-1">
      <i className={`${icon} text-xl`}></i>
    </a>
    <span className="text-[9px] font-black mt-3 text-gray-400 uppercase tracking-[0.2em] group-hover:text-[#0055a4] transition-colors">{label}</span>
  </div>
);

export default App;
