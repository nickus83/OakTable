/**
 * WebRTC PeerManager for OakTable
 *
 * WebRTC handshake flow (offer/answer/ICE):
 *
 *   Initiator (GM)                          Receiver (Player)
 *       |                                          |
 *       |  1. Create RTCPeerConnection             |
 *       |  2. createDataChannel("chat")            |
 *       |  3. createDataChannel("yjs")             |
 *       |  4. createOffer() -> local SDP           |
 *       |  5. setLocalDescription(offer)           |
 *       |                                          |
 *       |  --- signaling.send({type: "offer"}) --->|
 *       |                                          |
 *       |                               6. Receive "offer" via signaling
 *       |                               7. createRTCPeerConnection
 *       |                               8. setRemoteDescription(offer)
 *       |                               9. createAnswer() -> local SDP
 *       |                              10. setLocalDescription(answer)
 *       |                                          |
 *       |  <-- signaling.send({type: "answer"}) ----|
 *       |                                          |
 *       |  11. Receive "answer" via signaling       |
 *       |  12. setRemoteDescription(answer)         |
 *       |                                          |
 *       |  <--- ICE candidates exchanged --->      |
 *       |     (via signaling, relayed by server)    |
 *       |                                          |
 *       |  === WebRTC connection established ====== |
 *       |  DataChannel "chat" is open on both sides |
 *       |  DataChannel "yjs" is open on both sides  |
 *
 * Two DataChannels:
 *   - "chat"  — plain text messages for chat
 *   - "yjs"   — Yjs CRDT binary/JSON updates
 */

import { SignalingClient } from "./signaling";

type SignalingCallback = (message: Record<string, unknown>) => void;

// STUN servers to help with NAT traversal
const STUN_SERVERS = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

type SignalingMessageType =
  | "offer"
  | "answer"
  | "ice-candidate"
  | "peer-joined"
  | "peer-left"
  | "signal";

export class PeerManager {
  private peerConnection: RTCPeerConnection | null = null;
  private chatChannel: RTCDataChannel | null = null;
  private yjsChannel: RTCDataChannel | null = null;
  private receivedChatMessages: string[] = [];

  // Callback systems for UI events
  private onChatMessageCallbacks: Array<(msg: string) => void> = [];
  private onConnectionStateChangeCallbacks: Array<(state: string) => void> = [];
  private onDataChannelOpenCallbacks: Array<() => void> = [];
  private onDataChannelCloseCallbacks: Array<() => void> = [];

  // Promise for waiting for both channels to open (used by waitForChannelsOpen)
  private waitForChannelsPromise: Promise<void> | null = null;

  /**
   * Register callback for chat messages.
   */
  onChatMessage(callback: (msg: string) => void): void {
    this.onChatMessageCallbacks.push(callback);
    console.log(`[PeerManager] onChatMessage registered, total listeners: ${this.onChatMessageCallbacks.length}`);
  }

  /**
   * Register callback for connection state changes.
   */
  onConnectionStateChange(callback: (state: string) => void): void {
    this.onConnectionStateChangeCallbacks.push(callback);
  }

  /**
   * Register callback for DataChannel open events.
   */
  onDataChannelOpen(callback: () => void): void {
    this.onDataChannelOpenCallbacks.push(callback);
  }

  /**
   * Register callback for DataChannel close events.
   */
  onDataChannelClose(callback: () => void): void {
    this.onDataChannelCloseCallbacks.push(callback);
  }

  /**
   * Get current connection state as string.
   */
  getConnectionState(): string {
    return this.peerConnection?.connectionState ?? "disconnected";
  }

  /**
   * Get chat DataChannel readyState.
   */
  getChatChannelState(): RTCDataChannelState | null {
    return this.chatChannel?.readyState ?? null;
  }

  /**
   * Get Yjs DataChannel readyState.
   */
  getYjsChannelState(): RTCDataChannelState | null {
    return this.yjsChannel?.readyState ?? null;
  }

  /**
   * Check if both DataChannels are open.
   */
  areDataChannelsOpen(): boolean {
    const chatOpen = this.chatChannel?.readyState === "open";
    const yjsOpen = this.yjsChannel?.readyState === "open";
    return chatOpen && yjsOpen;
  }

  /**
   * Get received chat messages.
   */
  getReceivedChatMessages(): string[] {
    return [...this.receivedChatMessages];
  }

  /**
   * Wait for both DataChannels to be open.
   */
  waitForChannelsOpen(): Promise<void> {
    if (this.waitForChannelsPromise) return this.waitForChannelsPromise;

    this.waitForChannelsPromise = new Promise((resolve) => {
      const checkState = () => {
        if (this.areDataChannelsOpen()) {
          console.log("[PeerManager] Both DataChannels are open");
          resolve();
          return;
        }
        setTimeout(checkState, 100);
      };
      checkState();
    });

    return this.waitForChannelsPromise;
  }

  /**
   * @param signaling Pre-configured SignalingClient instance
   */
  constructor(private signaling: SignalingClient) {}

  /**
   * Initialize the WebRTC peer connection.
   *
   * @param isInitiator — if true, this peer creates the DataChannels and offer
   * @returns a promise that resolves when the connection is established
   */
  private waitForPeerPromise: Promise<void> | null = null;
  private pendingMessageHandler: Record<string, unknown> | null = null;

  async init(isInitiator: boolean): Promise<void> {
    console.log(`[PeerManager] init() called, isInitiator=${isInitiator}`);

    if (isInitiator) {
      // ================================================
      // INITIATOR FLOW: Create RTCPeerConnection + DataChannels
      // ================================================
      if (this.peerConnection) {
        console.warn("[PeerManager] Already initialized, ignoring duplicate init()");
        return;
      }

      this.peerConnection = new RTCPeerConnection(STUN_SERVERS);
      console.log("[PeerManager] Created RTCPeerConnection for initiator");

      // Set up event handlers for initiator
      this.peerConnection.onconnectionstatechange = () => {
        const state = this.peerConnection?.connectionState ?? "unknown";
        console.log(`[PeerManager] Connection state changed: ${state}`);
        for (const cb of this.onConnectionStateChangeCallbacks) {
          cb(state);
        }
      };

      this.peerConnection.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
        if (event.candidate) {
          console.log("[PeerManager] ICE candidate generated, sending via signaling");
          this.signaling.send({
            type: "ice-candidate",
            payload: event.candidate.toJSON(),
          });
        }
      };

      this.peerConnection.oniceconnectionstatechange = () => {
        console.log(`[PeerManager] ICE connection state: ${this.peerConnection?.iceConnectionState}`);
      };

      this.peerConnection.onicegatheringstatechange = () => {
        console.log(`[PeerManager] ICE gathering state: ${this.peerConnection?.iceGatheringState}`);
      };

      // Wait for peers to join, then create DataChannels + offer
      await this.waitForPeer();
      console.log("[PeerManager] Peer joined, proceeding with initiator flow");
      await this.initiate();
    } else {
      // ================================================
      // RECEIVER FLOW: Just register signaling handler
      // RTCPeerConnection and DataChannels created in handleOffer()
      // ================================================
      console.log("[PeerManager] Receiver mode: waiting for signaling messages...");
      await this.respond();
      console.log("[PeerManager] Receiver: signaling handler registered, waiting for offer");
    }
  }

  /**
   * Wait for a "peer-joined" message from the signaling server
   * before proceeding with the WebRTC handshake.
   * ALSO handles answer and ice-candidate messages from the receiver.
   */
  private waitForPeer(): Promise<void> {
    if (this.waitForPeerPromise) return this.waitForPeerPromise;

    this.pendingMessageHandler = null;

    this.waitForPeerPromise = new Promise((resolve) => {
      console.log("[PeerManager] Waiting for peers to join before creating offer");
      let resolved = false;

      // Register PERSISTENT callback for peer-joined, answer, and ice-candidate
      this.signaling.onMessage((message: Record<string, unknown>) => {
        const type = message.type as string | undefined;

        if (type === "peer-joined" && !resolved) {
          resolved = true;
          console.log("[PeerManager] Received peer-joined, creating offer now");
          this.pendingMessageHandler = message;
          resolve();
          return;
        }

        // After resolved, handle answer and ice-candidate messages
        if (resolved) {
          if (type === "answer") {
            console.log(`[PeerManager] Initiator: Received answer from ${(message as Record<string, unknown>).from}`);
            this.handleAnswer(message.payload as RTCSessionDescriptionInit);
          } else if (type === "ice-candidate") {
            console.log(`[PeerManager] Initiator: Received ice-candidate from ${(message as Record<string, unknown>).from}`);
            this.handleIceCandidate(message.payload as RTCIceCandidateInit);
          }
        }
      });
    });

    return this.waitForPeerPromise;
  }

  /**
   * Initiator flow: create DataChannels, create offer, send via signaling.
   */
  private async initiate(): Promise<void> {
    console.log("[PeerManager] Initiator: creating DataChannels and offer");

    // Create "chat" DataChannel — for plain text messages
    this.chatChannel = this.peerConnection!.createDataChannel("chat", {
      ordered: true,
    });
    console.log(`[PeerManager] ✓ Initiator "chat" DataChannel created: label="${this.chatChannel.label}", id=${this.chatChannel.id}, readyState=${this.chatChannel.readyState}`);
    this.setupChatChannelListeners();

    // Create "yjs" DataChannel — for Yjs CRDT updates
    this.yjsChannel = this.peerConnection!.createDataChannel("yjs", {
      ordered: true,
    });
    console.log(`[PeerManager] ✓ Initiator "yjs" DataChannel created: label="${this.yjsChannel.label}", id=${this.yjsChannel.id}, readyState=${this.yjsChannel.readyState}`);
    this.setupYjsChannelListeners();

    // Create and set local offer
    console.log("[PeerManager] Creating WebRTC offer...");
    const offer = await this.peerConnection!.createOffer();
    console.log(`[PeerManager] Offer created, type: ${offer.type}, sdp_length: ${offer.sdp?.length}`);

    await this.peerConnection!.setLocalDescription(offer);
    console.log(`[PeerManager] Local description set: ${this.peerConnection!.localDescription?.type}`);

    // Send the offer via signaling server (broadcast to receivers)
    console.log("[PeerManager] Sending SDP offer via signaling...");
    this.signaling.send({
      type: "offer",
      payload: offer,
    });
    console.log("[PeerManager] SDP offer sent via signaling");
  }

  // ==================== Initiator DataChannel Listeners ====================

  private setupChatChannelListeners(): void {
    if (!this.chatChannel) return;

    console.log(`[PeerManager] Setting up listeners for Initiator "chat" channel: ${this.chatChannel.readyState}`);

    this.chatChannel.onopen = () => {
      console.log(`[PeerManager] ✓ Initiator "chat" DataChannel OPENED, readyState=${this.chatChannel!.readyState}`);
      for (const cb of this.onDataChannelOpenCallbacks) cb();
    };

    this.chatChannel.onmessage = (event: MessageEvent) => {
      const text = event.data as string;
      console.log(`[PeerManager] ← Initiator received chat message: "${text.substring(0, 200)}"`);
      this.receivedChatMessages.push(text);
      for (const cb of this.onChatMessageCallbacks) cb(text);
    };

    this.chatChannel.onclose = () => {
      console.log(`[PeerManager] ✓ Initiator "chat" DataChannel CLOSED`);
      for (const cb of this.onDataChannelCloseCallbacks) cb();
    };

    this.chatChannel.onerror = (event: Event) => {
      console.error(`[PeerManager] ✗ Initiator "chat" DataChannel ERROR:`, event);
    };
  }

  private setupYjsChannelListeners(): void {
    if (!this.yjsChannel) return;

    console.log(`[PeerManager] Setting up listeners for Initiator "yjs" channel: ${this.yjsChannel.readyState}`);

    this.yjsChannel.onopen = () => {
      console.log(`[PeerManager] ✓ Initiator "yjs" DataChannel OPENED, readyState=${this.yjsChannel!.readyState}`);
      for (const cb of this.onDataChannelOpenCallbacks) cb();
    };

    this.yjsChannel.onclose = () => {
      console.log(`[PeerManager] ✓ Initiator "yjs" DataChannel CLOSED`);
      for (const cb of this.onDataChannelCloseCallbacks) cb();
    };

    this.yjsChannel.onerror = (event: Event) => {
      console.error(`[PeerManager] ✗ Initiator "yjs" DataChannel ERROR:`, event);
    };
  }

  // ==================== Receiver Flow ====================

  /**
   * Receiver flow: wait for offer via signaling, create answer, send back.
   */
  private async respond(): Promise<void> {
    console.log("[PeerManager] Receiver: setting up signaling message handler");
    const pmAny = this.signaling as unknown as Record<string, unknown>;
    const queuedCount =
      pmAny["messageQueue"] && Array.isArray(pmAny["messageQueue"])
        ? (pmAny["messageQueue"] as unknown[]).length
        : 0;
    console.log(`[PeerManager] Queued messages before handler registration: ${queuedCount}`);

    const handler = (message: Record<string, unknown>) => {
      const type = message.type as SignalingMessageType;
      const from = message.from as string | undefined;
      console.log(`[PeerManager] Signaling message received: type=${type} from=${from} keys=[${Object.keys(message).join(", ")}]`);

      switch (type) {
        case "offer":
          console.log("[PeerManager] Received offer from " + from + " — creating answer");
          this.handleOffer(message.payload as RTCSessionDescriptionInit);
          break;

        case "answer":
          console.log("[PeerManager] Received answer from " + from);
          this.handleAnswer(message.payload as RTCSessionDescriptionInit);
          break;

        case "ice-candidate":
          console.log("[PeerManager] Received ice-candidate from " + from);
          this.handleIceCandidate(message.payload as RTCIceCandidateInit);
          break;

        case "peer-joined":
          console.log(`[PeerManager] Room event: peer-joined, peer_id=${(message as Record<string, unknown>).peer_id}`);
          break;

        case "peer-left":
          console.log(`[PeerManager] Room event: peer-left, peer_id=${(message as Record<string, unknown>).peer_id}`);
          break;

        default:
          console.warn(`[PeerManager] Unknown signaling message type: ${type}`);
      }
    };

    this.signaling.onMessage(handler);
  }

  /**
   * Handle incoming SDP offer from remote peer.
   * CRITICAL: ondatachannel handler MUST be set BEFORE setRemoteDescription().
   */
  private async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    console.log(`[PeerManager] ✓ handleOffer() called - type: ${offer.type}, sdp_length: ${offer.sdp?.length}`);
    console.log(`[PeerManager] Offer SDP contains "m=application": ${offer.sdp?.includes("m=application")}`);

    if (!this.peerConnection) {
      console.log("[PeerManager] Creating RTCPeerConnection for receiver...");
      this.peerConnection = new RTCPeerConnection(STUN_SERVERS);
      console.log("[PeerManager] RTCPeerConnection created");
    }

    // =========================================
    // CRITICAL: Set ALL handlers BEFORE setRemoteDescription
    // =========================================

    // 1. Set ondatachannel handler FIRST — routes to chat or yjs channel
    console.log("[PeerManager] ★ Setting ondatachannel handler (BEFORE setRemoteDescription)");
    this.peerConnection.ondatachannel = (event: RTCDataChannelEvent) => {
      const label = event.channel.label;
      console.log(`[PeerManager] ★ ondatachannel EVENT FIRED: label="${label}", id=${event.channel.id}, readyState=${event.channel.readyState}`);

      if (label === "chat") {
        this.chatChannel = event.channel;
        console.log(`[PeerManager] ★ Routing to "chat" channel`);
        this.setupReceiverChatChannelListeners();
      } else if (label === "yjs") {
        this.yjsChannel = event.channel;
        console.log(`[PeerManager] ★ Routing to "yjs" channel`);
        this.setupReceiverYjsChannelListeners();
      } else {
        console.warn(`[PeerManager] ★ Unknown DataChannel label: ${label}`);
      }
    };
    console.log("[PeerManager] ★ ondatachannel handler SET successfully");

    // 2. Set onicecandidate handler
    this.peerConnection.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        console.log("[PeerManager] ICE candidate generated, sending via signaling");
        this.signaling.send({
          type: "ice-candidate",
          payload: event.candidate.toJSON(),
        });
      }
    };

    // 3. Set onconnectionstatechange handler
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState ?? "unknown";
      console.log(`[PeerManager] Connection state changed: ${state}`);
      for (const cb of this.onConnectionStateChangeCallbacks) cb(state);
    };

    // 4. Set oniceconnectionstatechange handler
    this.peerConnection.oniceconnectionstatechange = () => {
      console.log(`[PeerManager] ICE connection state: ${this.peerConnection?.iceConnectionState}`);
    };

    // 5. Set onicegatheringstatechange handler
    this.peerConnection.onicegatheringstatechange = () => {
      console.log(`[PeerManager] ICE gathering state: ${this.peerConnection?.iceGatheringState}`);
    };

    // =========================================
    // NOW safe to set remote description
    // =========================================
    console.log("[PeerManager] Calling setRemoteDescription(offer)...");
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    console.log(`[PeerManager] setRemoteDescription DONE, remoteDescription.type=${this.peerConnection.remoteDescription?.type}`);

    // 6. Create answer
    console.log("[PeerManager] Creating answer...");
    const answer = await this.peerConnection.createAnswer();
    console.log(`[PeerManager] Answer created, type: ${answer.type}, sdp_length: ${answer.sdp?.length}`);

    // 7. Set local description
    await this.peerConnection.setLocalDescription(answer);
    console.log(`[PeerManager] setLocalDescription DONE, localDescription.type=${this.peerConnection.localDescription?.type}`);

    // 8. Send answer via signaling
    console.log("[PeerManager] Sending SDP answer via signaling to initiator...");
    this.signaling.send({
      type: "answer",
      payload: answer,
    });
    console.log("[PeerManager] SDP answer sent via signaling successfully");
  }

  // ==================== Receiver DataChannel Listeners ====================

  private setupReceiverChatChannelListeners(): void {
    if (!this.chatChannel) return;

    console.log(`[PeerManager] Setting up Receiver "chat" channel listeners: ${this.chatChannel.readyState}`);

    this.chatChannel.onopen = () => {
      console.log(`[PeerManager] ✓ Receiver "chat" DataChannel OPENED, readyState=${this.chatChannel!.readyState}`);
      for (const cb of this.onDataChannelOpenCallbacks) cb();
    };

    this.chatChannel.onmessage = (event: MessageEvent) => {
      const text = event.data as string;
      console.log(`[PeerManager] ← Receiver received chat message: "${text.substring(0, 200)}"`);
      this.receivedChatMessages.push(text);
      for (const cb of this.onChatMessageCallbacks) cb(text);
    };

    this.chatChannel.onclose = () => {
      console.log(`[PeerManager] ✓ Receiver "chat" DataChannel CLOSED`);
      for (const cb of this.onDataChannelCloseCallbacks) cb();
    };

    this.chatChannel.onerror = (event: Event) => {
      console.error(`[PeerManager] ✗ Receiver "chat" DataChannel ERROR:`, event);
    };
  }

  private setupReceiverYjsChannelListeners(): void {
    if (!this.yjsChannel) return;

    console.log(`[PeerManager] Setting up Receiver "yjs" channel listeners: ${this.yjsChannel.readyState}`);

    this.yjsChannel.onopen = () => {
      console.log(`[PeerManager] ✓ Receiver "yjs" DataChannel OPENED, readyState=${this.yjsChannel!.readyState}`);
      for (const cb of this.onDataChannelOpenCallbacks) cb();
    };

    this.yjsChannel.onclose = () => {
      console.log(`[PeerManager] ✓ Receiver "yjs" DataChannel CLOSED`);
      for (const cb of this.onDataChannelCloseCallbacks) cb();
    };

    this.yjsChannel.onerror = (event: Event) => {
      console.error(`[PeerManager] ✗ Receiver "yjs" DataChannel ERROR:`, event);
    };
  }

  // ==================== Answer & ICE Handling ====================

  /**
   * Handle incoming SDP answer from remote peer.
   */
  private async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    console.log(`[PeerManager] Received SDP answer, type: ${answer.type}, sdp_length: ${answer.sdp?.length}`);

    if (!this.peerConnection) {
      console.error("[PeerManager] No peer connection for handling answer");
      return;
    }

    console.log("[PeerManager] Setting remote description from answer...");
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    console.log(`[PeerManager] Remote description set, state: ${this.peerConnection.remoteDescription?.type}`);
    console.log("[PeerManager] WebRTC handshake complete, waiting for ICE candidates");
  }

  /**
   * Handle incoming ICE candidate from remote peer.
   */
  private handleIceCandidate(candidate: RTCIceCandidateInit): void {
    console.log(`[PeerManager] Received ICE candidate`);

    if (!this.peerConnection) {
      console.error("[PeerManager] No peer connection for ICE candidate");
      return;
    }

    this.peerConnection
      .addIceCandidate(new RTCIceCandidate(candidate))
      .then(() => {
        console.log("[PeerManager] ICE candidate added successfully");
      })
      .catch((err: unknown) => {
        console.error("[PeerManager] Failed to add ICE candidate:", err);
      });
  }

  // ==================== Public API: Chat ====================

  /**
   * Send a chat message via the "chat" DataChannel.
   * If the channel is not yet open, waits up to 5 seconds for it to open.
   */
  sendChatMessage(msg: string): boolean {
    if (!this.chatChannel) {
      console.error("[PeerManager] ✗ Cannot send — chat channel is undefined/null");
      return false;
    }

    if (this.chatChannel.readyState === "open") {
      this.chatChannel.send(msg);
      console.log(`[PeerManager] → Sent chat message via "chat" channel: "${msg.substring(0, 100)}"`);
      return true;
    }

    console.warn(`[PeerManager] ⚠ Cannot send — "chat" channel is not open (state: ${this.chatChannel.readyState})`);

    // Wait for the channel to open (timeout after 5 seconds)
    const waitForOpen = (retryCount: number): void => {
      if (retryCount <= 0) {
        console.error(`[PeerManager] ✗ "chat" channel did not open within 5s, cannot send`);
        return;
      }
      setTimeout(() => {
        if (this.chatChannel?.readyState === "open") {
          this.chatChannel.send(msg);
          console.log(`[PeerManager] → Sent chat message via "chat" channel (after waiting): "${msg.substring(0, 100)}"`);
        } else {
          console.warn(`[PeerManager] ⚠ "chat" channel state is ${this.chatChannel?.readyState}, still waiting...`);
          waitForOpen(retryCount - 1);
        }
      }, 100);
    };

    waitForOpen(50); // Check every 100ms for 5 seconds
    return false;
  }

  // ==================== Public API: Yjs ====================

  /**
   * Send a Yjs update via the "yjs" DataChannel.
   */
  sendYjsUpdate(data: string | ArrayBuffer): boolean {
    if (!this.yjsChannel) {
      console.error("[PeerManager] ✗ Cannot send — yjs channel is undefined/null");
      return false;
    }

    if (this.yjsChannel.readyState === "open") {
      // Use any to bypass TypeScript's strict RTCDataChannel.send() typing
      // At runtime, RTCDataChannel accepts string, ArrayBuffer, and ArrayBufferView
      (this.yjsChannel as any).send(data);
      const size = typeof data === "string" ? data.length : data.byteLength;
      console.log(`[PeerManager] → Sent Yjs update via "yjs" channel (${size} bytes)`);
      return true;
    }

    console.warn(`[PeerManager] ⚠ Cannot send — "yjs" channel is not open (state: ${this.yjsChannel.readyState})`);
    return false;
  }

  // ==================== Public API: Status ====================

  /**
   * Get the current readyState of the chat DataChannel.
   */
  getDataChannelState(): RTCDataChannelState | null {
    return this.chatChannel?.readyState ?? null;
  }

  /**
   * Check if the peer connection is active.
   */
  isConnected(): boolean {
    return (
      this.peerConnection?.connectionState === "connected" ||
      this.areDataChannelsOpen()
    );
  }

  /**
   * Clean up all WebRTC resources.
   */
  close(): void {
    console.log("[PeerManager] Closing all connections");

    this.chatChannel?.close();
    this.chatChannel = null;

    this.yjsChannel?.close();
    this.yjsChannel = null;

    this.peerConnection?.close();
    this.peerConnection = null;

    this.receivedChatMessages = [];
    this.onChatMessageCallbacks = [];
    this.onConnectionStateChangeCallbacks = [];
    this.onDataChannelOpenCallbacks = [];
    this.onDataChannelCloseCallbacks = [];
  }
}