/**
 * WebRTC PeerManager for OakTable
 *
 * WebRTC handshake flow (offer/answer/ICE):
 *
 *   Initiator (GM)                          Receiver (Player)
 *       |                                          |
 *       |  1. Create RTCPeerConnection             |
 *       |  2. createDataChannel("chat")            |
 *       |  3. createOffer() -> local SDP           |
 *       |  4. setLocalDescription(offer)           |
 *       |                                          |
 *       |  --- signaling.send({type: "offer"}) --->|
 *       |                                          |
 *       |                               5. Receive "offer" via signaling
 *       |                               6. createRTCPeerConnection
 *       |                               7. setRemoteDescription(offer)
 *       |                               8. createAnswer() -> local SDP
 *       |                               9. setLocalDescription(answer)
 *       |                                          |
 *       |  <-- signaling.send({type: "answer"}) ----|
 *       |                                          |
 *       |  10. Receive "answer" via signaling       |
 *       |  11. setRemoteDescription(answer)         |
 *       |                                          |
 *       |  <--- ICE candidates exchanged --->      |
 *       |     (via signaling, relayed by server)    |
 *       |                                          |
 *       |  === WebRTC connection established ====== |
 *       |  DataChannel "chat" is open on both sides|
 *
 * Role of initiator vs receiver:
 *   - Initiator creates the DataChannel and initiates the offer.
 *     In a P2P mesh, the GM is typically the initiator.
 *   - Receiver only responds to incoming offers. It does NOT create
 *     DataChannels — the remote peer's DataChannel is used for sending.
 *   - Both sides are equal once connected: each can send/receive via
 *     the DataChannel opened by the initiator.
 *
 * DataChannel over WebRTC:
 *   - Built on top of the SCTP protocol (reliable, ordered by default).
 *   - Provides direct browser-to-browser communication — no server
 *     involvement after the initial signaling phase.
 *   - In Phase 1 we use a single "chat" channel for test messages.
 *     Later this will carry Yjs CRDT updates and asset transfers.
 */

import { SignalingClient } from "./signaling";

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
  private dataChannel: RTCDataChannel | null = null;
  private receivedMessages: string[] = [];

  /**
   * @param signaling Pre-configured SignalingClient instance
   */
  constructor(private signaling: SignalingClient) {}

  /**
   * Initialize the WebRTC peer connection.
   *
   * @param isInitiator — if true, this peer creates the offer and DataChannel
   * @returns a promise that resolves when the connection is established
   */
  async init(isInitiator: boolean): Promise<void> {
    if (this.peerConnection) {
      console.warn("[PeerManager] Already initialized, ignoring duplicate init()");
      return;
    }

    this.peerConnection = new RTCPeerConnection(STUN_SERVERS);
    this.peerConnection.addEventListener("icecandidate", (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        // Send ICE candidate to remote peer via signaling server
        this.signaling.send({
          type: "ice-candidate",
          payload: event.candidate.toJSON(),
        });
        console.log("[PeerManager] Sent ICE candidate");
      }
    });

    this.peerConnection.addEventListener("iceconnectionstatechange", () => {
      const state = this.peerConnection?.iceConnectionState;
      console.log(`[PeerManager] ICE connection state: ${state}`);
    });

    if (isInitiator) {
      await this.initiate();
    } else {
      await this.respond();
    }
  }

  /**
   * Initiator flow: create DataChannel, create offer, send via signaling.
   */
  private async initiate(): Promise<void> {
    console.log("[PeerManager] Initiator: creating DataChannel and offer");

    // Create the DataChannel — this is the only side that creates channels
    this.dataChannel = this.peerConnection!.createDataChannel("chat", {
      ordered: true, // Messages guaranteed delivered in order
    });

    this.dataChannel.addEventListener("open", (event: Event) => {
      console.log("[PeerManager] DataChannel opened");
    });

    this.dataChannel.addEventListener("message", (event: MessageEvent) => {
      this.handleIncomingMessage(event.data);
    });

    this.dataChannel.addEventListener("close", () => {
      console.log("[PeerManager] DataChannel closed");
    });

    // Create and set local offer
    const offer = await this.peerConnection!.createOffer();
    await this.peerConnection!.setLocalDescription(offer);

    // Send the offer via signaling server (broadcast to receivers)
    this.signaling.send({
      type: "offer",
      payload: offer,
    });
    console.log("[PeerManager] Sent SDP offer via signaling");
  }

  /**
   * Receiver flow: wait for offer via signaling, create answer, send back.
   */
  private async respond(): Promise<void> {
    console.log("[PeerManager] Receiver: waiting for offer via signaling");

    this.signaling.onMessage((message: Record<string, unknown>) => {
      const type = message.type as SignalingMessageType;

      switch (type) {
        case "offer":
          this.handleOffer(message.payload as RTCSessionDescriptionInit);
          break;

        case "answer":
          this.handleAnswer(message.payload as RTCSessionDescriptionInit);
          break;

        case "ice-candidate":
          this.handleIceCandidate(message.payload as RTCIceCandidateInit);
          break;

        case "peer-joined":
        case "peer-left":
          // Room management events, not part of WebRTC handshake
          console.log(`[PeerManager] Room event: ${type}`, message);
          break;

        default:
          console.warn(`[PeerManager] Unknown signaling message type: ${type}`);
      }
    });
  }

  /**
   * Handle incoming SDP offer from remote peer.
   */
  private async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    console.log("[PeerManager] Received SDP offer");

    if (!this.peerConnection) {
      console.error("[PeerManager] No peer connection for handling offer");
      return;
    }

    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

    // Create and send answer
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);

    this.signaling.send({
      type: "answer",
      payload: answer,
    });
    console.log("[PeerManager] Sent SDP answer via signaling");
  }

  /**
   * Handle incoming SDP answer from remote peer.
   */
  private async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    console.log("[PeerManager] Received SDP answer");

    if (!this.peerConnection) {
      console.error("[PeerManager] No peer connection for handling answer");
      return;
    }

    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    console.log("[PeerManager] WebRTC handshake complete, waiting for ICE candidates");
  }

  /**
   * Handle incoming ICE candidate from remote peer.
   */
  private handleIceCandidate(candidate: RTCIceCandidateInit): void {
    if (!this.peerConnection) {
      console.error("[PeerManager] No peer connection for ICE candidate");
      return;
    }

    this.peerConnection
      .addIceCandidate(new RTCIceCandidate(candidate))
      .then(() => {
        console.log("[PeerManager] Added ICE candidate from remote peer");
      })
      .catch((err: unknown) => {
        console.error("[PeerManager] Failed to add ICE candidate:", err);
      });
  }

  /**
   * Handle a message received over the DataChannel.
   */
  private handleIncomingMessage(data: string): void {
    console.log("[PeerManager] Received message:", data);
    this.receivedMessages.push(data);
  }

  /**
   * Send a text message to the remote peer via DataChannel.
   *
   * @param msg — the string to send
   * @returns true if sent successfully, false if the channel is not open
   */
  sendMessage(msg: string): boolean {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      console.warn(
        "[PeerManager] Cannot send — DataChannel is not open (state:",
        this.dataChannel?.readyState,
        ")"
      );
      return false;
    }

    this.dataChannel.send(msg);
    console.log("[PeerManager] Sent message:", msg);
    return true;
  }

  /**
   * Get all received messages (both from DataChannel and signaling room events).
   */
  getReceivedMessages(): string[] {
    return [...this.receivedMessages];
  }

  /**
   * Get the current readyState of the DataChannel.
   */
  getDataChannelState(): RTCDataChannelState | null {
    return this.dataChannel?.readyState ?? null;
  }

  /**
   * Check if the peer connection is active.
   */
  isConnected(): boolean {
    return (
      this.peerConnection?.connectionState === "connected" ||
      this.dataChannel?.readyState === "open"
    );
  }

  /**
   * Clean up all WebRTC resources.
   */
  close(): void {
    console.log("[PeerManager] Closing all connections");

    this.dataChannel?.close();
    this.dataChannel = null;

    this.peerConnection?.close();
    this.peerConnection = null;

    this.receivedMessages = [];
  }
}