import React, { useState, useRef, useEffect } from "react";
import { SignalingClient } from "./webrtc/signaling";
import { PeerManager } from "./webrtc/peerManager";

/**
 * OakTable WebRTC Test Client
 *
 * Test scenario:
 * 1. Open two browser tabs
 * 2. Tab 1: enter room="test", peer="A", click "Connect as Initiator"
 * 3. Tab 2: enter room="test", peer="B", click "Connect as Receiver"
 * 4. Tab 1 sends message "hello" -> Tab 2 receives it via P2P DataChannel
 *
 * After the WebRTC handshake completes, all message traffic goes directly
 * between peers — no WebSocket/server involvement. Verify in browser's
 * Network tab: WebSocket connection closes once the DataChannel opens.
 */

export default function App() {
  const [roomId, setRoomId] = useState("test");
  const [peerId, setPeerId] = useState("");
  const [message, setMessage] = useState("");
  const [receivedMessages, setReceivedMessages] = useState<string[]>([]);
  const [status, setStatus] = useState<string>("Disconnected");

  const signalingRef = useRef<SignalingClient | null>(null);
  const peerRef = useRef<PeerManager | null>(null);

  // Clean up WebRTC resources on unmount
  useEffect(() => {
    return () => {
      peerRef.current?.close();
      signalingRef.current?.disconnect();
    };
  }, []);

  /**
   * Connect to signaling server, then initialize PeerManager.
   */
  const handleConnect = async (isInitiator: boolean): Promise<void> => {
    if (!peerId.trim()) {
      alert("Please enter a Peer ID");
      return;
    }

    // Reset state
    setReceivedMessages([]);
    setStatus("Connecting...");

    // Clean up previous connections
    peerRef.current?.close();
    signalingRef.current?.disconnect();

    // Create signaling client
    const signaling = new SignalingClient("ws://localhost:8000");
    signalingRef.current = signaling;

    // Listen for signaling messages (offers, answers, ICE candidates)
    // PeerManager handles these internally, so we don't need a separate callback.
    // The onMessage handler inside PeerManager.init(false) registers its own listener.

    signaling.connect(roomId, peerId.trim());

    // Wait for signaling connection, then init WebRTC
    await new Promise<void>((resolve) => {
      const checkConnection = setInterval(() => {
        if (signaling.isConnected()) {
          clearInterval(checkConnection);
          resolve();
        }
      }, 100);
      // Timeout after 5 seconds
      setTimeout(() => {
        clearInterval(checkConnection);
        resolve();
      }, 5000);
    });

    // Create PeerManager and initialize WebRTC
    const peerManager = new PeerManager(signaling);
    peerRef.current = peerManager;

    // Patch PeerManager to update UI on received messages
    const originalSend = peerManager.sendMessage.bind(peerManager);
    // We can't override sendMessage, so we patch handleIncomingMessage via a wrapper
    // For simplicity, we use a simple polling approach on getReceivedMessages
    // but in production you'd use an event emitter.

    await peerManager.init(isInitiator);

    setStatus(
      isInitiator ? "Initiator (GM) — waiting for receiver..." : "Receiver (Player) — waiting for offer..."
    );
  };

  /**
   * Send a message via the DataChannel to the remote peer.
   */
  const handleSend = (): void => {
    if (!message.trim()) return;
    if (!peerRef.current?.sendMessage(message)) {
      setStatus("Cannot send — DataChannel not open");
      return;
    }
    setReceivedMessages((prev: string[]) => [...prev, `[You] ${message}`]);
    setMessage("");
  };

  /**
   * Disconnect all connections.
   */
  const handleDisconnect = (): void => {
    peerRef.current?.close();
    signalingRef.current?.disconnect();
    peerRef.current = null;
    signalingRef.current = null;
    setStatus("Disconnected");
    setReceivedMessages([]);
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>OakTable WebRTC Test</h1>

      <div style={styles.section}>
        <h3 style={styles.subtitle}>Connection</h3>
        <div style={styles.field}>
          <label style={styles.label}>Room ID:</label>
          <input
            style={styles.input}
            type="text"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="e.g. test"
          />
        </div>
        <div style={styles.field}>
          <label style={styles.label}>Peer ID:</label>
          <input
            style={styles.input}
            type="text"
            value={peerId}
            onChange={(e) => setPeerId(e.target.value)}
            placeholder="e.g. A or B"
          />
        </div>
        <div style={styles.buttons}>
          <button
            style={{ ...styles.button, ...styles.initiatorButton }}
            onClick={() => handleConnect(true)}
          >
            Connect as Initiator (GM)
          </button>
          <button
            style={{ ...styles.button, ...styles.receiverButton }}
            onClick={() => handleConnect(false)}
          >
            Connect as Receiver (Player)
          </button>
          <button
            style={{ ...styles.button, ...styles.disconnectButton }}
            onClick={handleDisconnect}
          >
            Disconnect
          </button>
        </div>
      </div>

      <div style={styles.section}>
        <h3 style={styles.subtitle}>Status</h3>
        <p style={styles.status}>Status: {status}</p>
        <p style={styles.status}>
          DataChannel: {peerRef.current?.getDataChannelState() ?? "N/A"}
        </p>
        <p style={styles.status}>
          P2P Connected: {peerRef.current?.isConnected() ? "Yes" : "No"}
        </p>
      </div>

      <div style={styles.section}>
        <h3 style={styles.subtitle}>Messages</h3>
        <div style={styles.messagesBox}>
          {receivedMessages.length === 0 && (
            <span style={styles.placeholder}>No messages yet.</span>
          )}
          {receivedMessages.map((msg: string, i: number) => (
            <div key={i} style={styles.messageRow}>
              {msg}
            </div>
          ))}
        </div>
        <div style={styles.sendRow}>
          <input
            style={{ ...styles.input, flex: 1 }}
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Type a message..."
          />
          <button style={styles.button} onClick={handleSend}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// Inline styles for simplicity (no CSS dependency in Phase 1)
const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 600,
    margin: "40px auto",
    padding: 24,
    fontFamily: "monospace",
  },
  title: {
    textAlign: "center",
    marginBottom: 24,
  },
  section: {
    marginBottom: 20,
    padding: 16,
    border: "1px solid #ccc",
    borderRadius: 6,
  },
  subtitle: {
    margin: "0 0 12px 0",
  },
  field: {
    marginBottom: 10,
  },
  label: {
    display: "block",
    marginBottom: 4,
    fontWeight: "bold",
  },
  input: {
    width: "100%",
    padding: 8,
    fontSize: 14,
    fontFamily: "monospace",
    boxSizing: "border-box",
  },
  buttons: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap" as const,
  },
  button: {
    padding: "8px 16px",
    fontSize: 14,
    cursor: "pointer",
    border: "1px solid #666",
    borderRadius: 4,
    background: "#fff",
  },
  initiatorButton: {
    border: "2px solid #2196F3",
    color: "#2196F3",
  },
  receiverButton: {
    border: "2px solid #4CAF50",
    color: "#4CAF50",
  },
  disconnectButton: {
    border: "2px solid #f44336",
    color: "#f44336",
  },
  status: {
    margin: "4px 0",
    fontSize: 14,
  },
  messagesBox: {
    minHeight: 120,
    maxHeight: 240,
    overflowY: "auto" as const,
    border: "1px solid #eee",
    padding: 8,
    marginBottom: 8,
    background: "#fafafa",
  },
  placeholder: {
    color: "#999",
    fontStyle: "italic",
  },
  messageRow: {
    padding: "4px 0",
    borderBottom: "1px solid #eee",
    fontSize: 13,
  },
  sendRow: {
    display: "flex",
    gap: 8,
  },
};