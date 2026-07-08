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
  private callbackRegistered: boolean = false;
  private messageQueue: SignalingMessage[] = [];

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
    console.log(`[SignalingClient] connect() called: roomId=${roomId} peerId=${peerId} baseUrl=${this.baseUrl}`);
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      console.warn(`[SignalingClient] Already connected (readyState=${this.ws.readyState}), ignoring duplicate connect()`);
      return;
    }

    const url = `${this.url}/ws/signal/${encodeURIComponent(roomId)}/${encodeURIComponent(peerId)}`;
    console.log(`[SignalingClient] Creating WebSocket connection to ${url}`);

    this.ws = new WebSocket(url);
    console.log(`[SignalingClient] WebSocket instance created, readyState will be CONNECTING (${WebSocket.CONNECTING})`);

    this.ws.onopen = () => {
      console.log("[SignalingClient] WebSocket OPEN — connected to signaling server");
      this.connected = true;
    };

    this.ws.onmessage = (event: MessageEvent) => {
      console.log(`[Signaling] Message received from server, data type: ${typeof event.data}, data length: ${event.data.length}`);
      try {
        const message: SignalingMessage = JSON.parse(event.data as string);
        const msgType = (message as Record<string, unknown>).type as string | undefined;
        console.log(`[Signaling] Received message type=${msgType} from server, keys=[${Object.keys(message).join(", ")}]`);
        if (msgType === "peer-joined") {
          console.log(`[Signaling] peer-joined: peer_id=${(message as Record<string, unknown>).peer_id} room_size=${(message as Record<string, unknown>).room_size}`);
        } else if (msgType === "offer" || msgType === "answer") {
          const payload = (message as Record<string, unknown>).payload as Record<string, unknown> | undefined;
          console.log(`[Signaling] ${msgType} received from ${(message as Record<string, unknown>).from}, payload keys=[${payload ? Object.keys(payload).join(", ") : "none"}]`);
        } else if (msgType === "ice-candidate") {
          console.log(`[Signaling] ice-candidate received from ${(message as Record<string, unknown>).from}`);
        } else if (msgType === "peer-left") {
          console.log(`[Signaling] peer-left: peer_id=${(message as Record<string, unknown>).peer_id} room_size=${(message as Record<string, unknown>).room_size}`);
        }
        if (this.callbackRegistered && this.callback) {
          this.callback(message);
        } else {
          console.log(`[Signaling] Callback not registered yet, queueing message (queue size: ${this.messageQueue.length + 1})`);
          this.messageQueue.push(message);
        }
      } catch (err) {
        console.error("[Signaling] Failed to parse message from server:", err, "raw data:", event.data);
      }
    };

    this.ws.onerror = (event: Event) => {
      console.error("[SignalingClient] WebSocket ERROR event fired:", event);
    };

    this.ws.onclose = (event: CloseEvent) => {
      console.log(`[SignalingClient] WebSocket CLOSED — code: ${event.code}, reason: "${event.reason}"`);
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
    const msgType = (message as Record<string, unknown>).type as string | undefined;
    console.log(`[Signaling] send() called, type=${msgType} readyState=${this.ws?.readyState} connected=${this.connected}`);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn(`[Signaling] Cannot send — not connected (ws=${this.ws ? "exists" : "null"}, readyState=${this.ws?.readyState})`);
      return;
    }
    const serialized = JSON.stringify(message);
    console.log(`[Signaling] Sending message type=${msgType} to server (length=${serialized.length})`);
    this.ws.send(serialized);
  }

  /**
   * Register a callback for incoming signaling messages.
   * Any queued messages will be processed immediately after registration.
   */
  onMessage(callback: SignalingCallback): void {
    this.callback = callback;
    this.callbackRegistered = true;
    
    if (this.messageQueue.length > 0) {
      console.log(`[Signaling] Callback registered, processing ${this.messageQueue.length} queued messages`);
      const queued = this.messageQueue.splice(0);
      for (const message of queued) {
        const msgType = (message as Record<string, unknown>).type as string | undefined;
        console.log(`[Signaling] Processing queued message type=${msgType}`);
        callback(message);
      }
      console.log(`[Signaling] All ${queued.length} queued messages processed`);
    } else {
      console.log(`[Signaling] Callback registered, no queued messages to process`);
    }
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