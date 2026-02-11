
export interface Transcription {
  text: string;
  sender: 'user' | 'pehta';
  timestamp: number;
}

export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}
