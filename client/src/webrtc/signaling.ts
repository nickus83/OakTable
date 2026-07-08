/**
 * WebRTC Signaling Client for OakTable
 *
 * Signaling flow (documented for client developers):
 *
 * 1. When a player joins a room, create a SignalingClient and call connect(roomId, peerId).
 * 2. When the GM wants to start a WebRTC session:
 *    - GM creates an RTCPeerConnection and an SDP offer via createOffer()
 *    - GM calls signaling.send({ type: 'offer', payload: offerSDP })
 *    - The server broadcasts this to all other peers in the room (including the player)
 * 3. The player receives the offer via onMessage(), creates an answer via createAnswer()
 *    - Player calls signaling.send({ type: 'answer', payload: answerSDP })
 *    - Server broadcasts the answer back to the GM
 * 4. Both sides exchange ICE candidates continuously:
 *    - Each side attaches an onicecandidate handler on RTCPeerConnection
 *    - Candidates are sent via signaling.send({ type: 'ice-candidate', payload: candidate })
 *    - Server relays them to the remote peer
 *
 * NOTE: This file handles ONLY signaling. The actual RTCPeerConnection logic
 *       is implemented elsewhere (e.g., PeerManager class).
 */

type SignalingMessage = Record<string, unknown>;
type SignalingCallback = (message: SignalingMessage) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private callback: SignalingCallback | null = null;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  private url: string;
  private connected: boolean = false;

  /**
   * @param baseUrl WebSocket server base URL, e.g. "ws://localhost:8000"
   */
  constructor(private baseUrl: string = "ws://localhost:8000") {
    this.url = baseUrl;
  }

  /**
   * Connect to the signaling server for a specific room and peer.
   *
   * @param roomId — unique identifier for the game room
   * @param peerId — unique identifier for this client within the room
   */
  connect(roomId: string, peerId: string): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      console.warn("[SignalingClient] Already connected, ignoring duplicate connect()");
      return;
    }

    const url = `${this.url}/ws/signal/${encodeURIComponent(roomId)}/${encodeURIComponent(peerId)}`;
    console.log(`[SignalingClient] Connecting to ${url}`);

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log("[SignalingClient] Connected to signaling server");
      this.connected = true;
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const message: SignalingMessage = JSON.parse(event.data as string);
        if (this.callback) {
          this.callback(message);
        }
      } catch (err) {
        console.error("[SignalingClient] Failed to parse message:", err);
      }
    };

    this.ws.onerror = (event: Event) => {
      console.error("[SignalingClient] WebSocket error:", event);
    };

    this.ws.onclose = (event: CloseEvent) => {
      console.log(`[SignalingClient] Disconnected (code: ${event.code})`);
      this.connected = false;
      this.ws = null;
      this.scheduleReconnect(roomId, peerId);
    };
  }

  /**
   * Send a signaling message to the server (which broadcasts it to peers).
   *
   * @param message — JSON-serializable signaling payload
   *   Example: { type: "offer", payload: sdpObject }
   */
  send(message: SignalingMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[SignalingClient] Cannot send — not connected");
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Register a callback for incoming signaling messages.
   */
  onMessage(callback: SignalingCallback): void {
    this.callback = callback;
  }

  /**
   * Check if the client is currently connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Explicitly disconnect from the signaling server.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
    this.connected = false;
  }

  /**
   * Basic reconnection logic — retry every 3 seconds.
   */
  private scheduleReconnect(roomId: string, peerId: string): void {
    if (this.reconnectTimer) return; // Already scheduled

    console.log("[SignalingClient] Scheduling reconnect in 3s...");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(roomId, peerId);
    }, 3000);
  }
}