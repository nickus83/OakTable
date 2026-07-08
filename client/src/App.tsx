import React, { useState, useRef, useEffect, useCallback } from "react";
import { SignalingClient } from "./webrtc/signaling";
import { PeerManager } from "./webrtc/peerManager";
import { YjsManager } from "./sync/yjsManager";
import type { TableObjectData } from "./sync/yjsManager";

/**
 * OakTable WebRTC Test Client with Yjs CRDT Sync
 *
 * Test scenario:
 * 1. Open two browser tabs
 * 2. Tab 1: enter room="test", peer="A", click "Connect as Initiator"
 * 3. Tab 2: enter room="test", peer="B", click "Connect as Receiver"
 * 4. Tab 1 clicks "Add Object" -> Tab 2 sees it in the list (synced via Yjs CRDT)
 * 5. Tab 1 types in notes -> Tab 2 sees it in real-time (synced via Y.Text)
 *
 * Yjs CRDT ensures that simultaneous edits from both tabs are resolved
 * automatically without conflicts — all peers eventually see the same state.
 */

export default function App() {
  const [roomId, setRoomId] = useState("test");
  const [peerId, setPeerId] = useState("");
  const [message, setMessage] = useState("");
  const [receivedMessages, setReceivedMessages] = useState<string[]>([]);
  const [status, setStatus] = useState<string>("Disconnected");

  // Yjs CRDT state
  const [objectCount, setObjectCount] = useState(0);
  const [objectList, setObjectList] = useState<Map<string, TableObjectData>>(new Map());
  const [notesText, setNotesText] = useState("");

  const signalingRef = useRef<SignalingClient | null>(null);
  const peerRef = useRef<PeerManager | null>(null);
  const yjsRef = useRef<YjsManager | null>(null);
  const checkDcIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clean up WebRTC resources on unmount
  useEffect(() => {
    return () => {
      yjsRef.current?.close();
      peerRef.current?.close();
      signalingRef.current?.disconnect();
      if (checkDcIntervalRef.current) {
        clearInterval(checkDcIntervalRef.current);
      }
    };
  }, []);

  // Sync object list from Yjs state
  const syncObjectList = useCallback((yjs: YjsManager) => {
    const objects = yjs.getAllObjects();
    setObjectList(new Map(objects));
    setObjectCount(yjs.getObjectCount());
  }, []);

  // Sync notes from Yjs state
  const syncNotes = useCallback((yjs: YjsManager) => {
    setNotesText(yjs.getNotesText());
  }, []);

  /**
   * Connect to signaling server, then initialize PeerManager and YjsManager.
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
    yjsRef.current?.close();
    peerRef.current?.close();
    signalingRef.current?.disconnect();
    if (checkDcIntervalRef.current) {
      clearInterval(checkDcIntervalRef.current);
    }

    // Create signaling client
    const signaling = new SignalingClient("ws://localhost:8000");
    signalingRef.current = signaling;

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
    await peerManager.init(isInitiator);

    // Create and initialize YjsManager
    const yjsManager = new YjsManager(peerId.trim());
    yjsManager.init();
    yjsRef.current = yjsManager;

    // Set up Yjs listeners for UI updates BEFORE connecting DataChannel
    yjsManager.onObjectsChange(() => {
      syncObjectList(yjsManager);
    });

    yjsManager.onNotesChange(() => {
      syncNotes(yjsManager);
    });

    yjsManager.onRoomEvent((event, pId) => {
      console.log(`[Yjs] Room event: ${event} from ${pId}`);
    });

    // Initial sync
    syncObjectList(yjsManager);
    syncNotes(yjsManager);

    // Poll for DataChannel open state, then connect to YjsManager
    checkDcIntervalRef.current = setInterval(() => {
      const dcState = peerManager.getDataChannelState();
      if (dcState === "open") {
        if (checkDcIntervalRef.current) {
          clearInterval(checkDcIntervalRef.current);
        }
        // Access private dataChannel via type assertion
        const pmAny = peerManager as unknown as Record<string, unknown>;
        const dc = pmAny["dataChannel"] as RTCDataChannel | undefined;
        if (dc && dc.readyState === "open") {
          yjsManager.connect(dc);
          console.log("[App] YjsManager connected to DataChannel");
        }
      }
    }, 200);

    setStatus(
      isInitiator
        ? "Initiator (GM) — waiting for receiver..."
        : "Receiver (Player) — waiting for offer..."
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
    setReceivedMessages((prev) => [...prev, `[You] ${message}`]);
    setMessage("");
  };

  /**
   * Add a new table object via Yjs CRDT.
   * This creates a new entry in Y.Map "objects" with random position.
   * All connected peers will see this change in real-time.
   */
  const handleAddObject = (): void => {
    const yjs = yjsRef.current;
    if (!yjs) {
      alert("YjsManager not initialized. Connect via WebRTC first.");
      return;
    }
    yjs.addObject({
      x: Math.round(Math.random() * 800),
      y: Math.round(Math.random() * 600),
      rotation: 0,
      scale: 1,
      type: "custom",
      name: `Object ${objectList.size + 1}`,
    });
  };

  /**
   * Update notes text via Yjs CRDT.
   * Y.Text will automatically sync changes to peers.
   */
  const handleNotesChange = (
    e: React.ChangeEvent<HTMLTextAreaElement>
  ): void => {
    const yjs = yjsRef.current;
    if (!yjs) return;
    const newText = e.target.value;
    setNotesText(newText);
    yjs.setNotesText(newText);
  };

  /**
   * Disconnect all connections.
   */
  const handleDisconnect = (): void => {
    if (checkDcIntervalRef.current) {
      clearInterval(checkDcIntervalRef.current);
    }
    yjsRef.current?.close();
    peerRef.current?.close();
    signalingRef.current?.disconnect();
    yjsRef.current = null;
    peerRef.current = null;
    signalingRef.current = null;
    setStatus("Disconnected");
    setReceivedMessages([]);
    setObjectCount(0);
    setObjectList(new Map());
    setNotesText("");
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>OakTable WebRTC + Yjs CRDT Test</h1>

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
        <p style={styles.status}>
          Yjs Objects: {objectCount}
        </p>
        <p style={styles.status}>
          Yjs Initialized: {yjsRef.current?.isInitialized() ? "Yes" : "No"}
        </p>
      </div>

      {/* Yjs CRDT Sync Section */}
      <div style={styles.section}>
        <h3 style={styles.subtitle}>
          Yjs CRDT Sync — Objects ({objectCount})
        </h3>
        <div style={{ marginBottom: 12 }}>
          <button
            style={{ ...styles.button, borderColor: "#9C27B0", color: "#9C27B0" }}
            onClick={handleAddObject}
          >
            Add Object
          </button>
        </div>
        <div style={styles.messagesBox}>
          {objectList.size === 0 && (
            <span style={styles.placeholder}>
              No objects yet. Click "Add Object" to create one.
            </span>
          )}
          {Array.from(objectList.entries()).map(
            ([id, data]: [string, TableObjectData]) => (
              <div key={id} style={styles.messageRow}>
                <strong>
                  {data.name || id.slice(0, 8)}
                </strong>:{", "}
                x={data.x}, y={data.y}, rot={data.rotation}, scale=
                {data.scale}
              </div>
            )
          )}
        </div>
      </div>

      <div style={styles.section}>
        <h3 style={styles.subtitle}>Yjs CRDT Sync — Shared Notes</h3>
        <p
          style={{
            ...styles.status,
            fontSize: 12,
            color: "#666",
            marginBottom: 8,
          }}
        >
          Edits are synced in real-time via Y.Text CRDT. Try typing in both
          tabs simultaneously.
        </p>
        <textarea
          style={{ ...styles.input, minHeight: 100, resize: "vertical" }}
          value={notesText}
          onChange={handleNotesChange}
          placeholder="Type shared notes here... (synced via Yjs Y.Text CRDT)"
        />
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
    maxWidth: 700,
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