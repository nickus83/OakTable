import React, { useState, useRef, useEffect, useCallback } from "react";
import { SignalingClient } from "./webrtc/signaling";
import { PeerManager } from "./webrtc/peerManager";
import { YjsManager } from "./sync/yjsManager";
import type { TableObjectData } from "./sync/yjsManager";
import TableCanvas, { TableCanvasRef } from "./table/TableCanvas";

/**
 * OakTable — P2P Virtual Tabletop
 *
 * Architecture:
 * - Signaling server (WebSocket) for initial PeerConnection setup
 * - WebRTC DataChannels: "chat" (text messages), "yjs" (CRDT sync)
 * - PixiJS canvas for infinite 2D virtual table
 * - Yjs CRDT for shared state synchronization
 */
export default function App() {
  // ─── Connection state ───
  const [roomId, setRoomId] = useState("test");
  const [peerId, setPeerId] = useState("");
  const [chatMessage, setChatMessage] = useState("");
  const [chatMessages, setChatMessages] = useState<string[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<string>("Disconnected");
  const [dataChannelState, setDataChannelState] = useState<string>("N/A");
  const [yjsChannelState, setYjsChannelState] = useState<string>("N/A");
  const [isConnected, setIsConnected] = useState(false);
  const [yjsInitialized, setYjsInitialized] = useState(false);
  const [activeYjsManager, setActiveYjsManager] = useState<YjsManager | undefined>(undefined);

  // ─── Yjs CRDT state ───
  const [objectCount, setObjectCount] = useState(0);
  const [objectList, setObjectList] = useState<Map<string, TableObjectData>>(new Map());
  const [notesText, setNotesText] = useState("");

  // ─── Refs ───
  const signalingRef = useRef<SignalingClient | null>(null);
  const peerRef = useRef<PeerManager | null>(null);
  const yjsRef = useRef<YjsManager | null>(null);
  const checkDcIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const yjsConnectedRef = useRef(false);
  const tableCanvasRef = useRef<TableCanvasRef | null>(null);

  // ─── Cleanup on unmount ───
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

  // ─── Yjs sync helpers ───
  const syncObjectList = useCallback((yjs: YjsManager) => {
    const objects = yjs.getAllObjects();
    setObjectList(new Map(objects));
    setObjectCount(yjs.getObjectCount());
  }, []);

  const syncNotes = useCallback((yjs: YjsManager) => {
    setNotesText(yjs.getNotesText());
  }, []);

  // ─── Connection handler ───
  const handleConnect = async (isInitiator: boolean): Promise<void> => {
    if (!peerId.trim()) {
      alert("Please enter a Peer ID");
      return;
    }

    // Reset state
    setChatMessages([]);
    setConnectionStatus("Connecting...");
    setDataChannelState("N/A");
    setYjsChannelState("N/A");
    setIsConnected(false);
    yjsConnectedRef.current = false;

    // Clean up previous
    yjsRef.current?.close();
    peerRef.current?.close();
    signalingRef.current?.disconnect();
    if (checkDcIntervalRef.current) {
      clearInterval(checkDcIntervalRef.current);
    }

    // Signaling
    const signaling = new SignalingClient("ws://localhost:8000");
    signalingRef.current = signaling;
    signaling.connect(roomId, peerId.trim());

    await new Promise<void>((resolve) => {
      const checkConnection = setInterval(() => {
        if (signaling.isConnected()) {
          clearInterval(checkConnection);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(checkConnection);
        resolve();
      }, 5000);
    });

    // PeerManager
    const peerManager = new PeerManager(signaling);
    peerRef.current = peerManager;

    peerManager.onConnectionStateChange((state: string) => {
      setConnectionStatus(state);
      setIsConnected(state === "connected");
    });

    peerManager.onDataChannelOpen(() => {
      setDataChannelState(peerManager.getChatChannelState() ?? "N/A");
      setYjsChannelState(peerManager.getYjsChannelState() ?? "N/A");
    });

    peerManager.onChatMessage((msg: string) => {
      setChatMessages((prev) => [...prev, msg]);
    });

    await peerManager.init(isInitiator);

    setConnectionStatus(peerManager.getConnectionState());
    setDataChannelState(peerManager.getChatChannelState() ?? "N/A");
    setYjsChannelState(peerManager.getYjsChannelState() ?? "N/A");

    // YjsManager
    const yjsManager = new YjsManager(peerId.trim());
    yjsManager.init();
    yjsRef.current = yjsManager;
    setActiveYjsManager(yjsManager);
    setYjsInitialized(yjsManager.isInitialized());

    yjsManager.onObjectsChange(() => syncObjectList(yjsManager));
    yjsManager.onNotesChange(() => syncNotes(yjsManager));

    syncObjectList(yjsManager);
    syncNotes(yjsManager);

    // Poll for DataChannels
    checkDcIntervalRef.current = setInterval(() => {
      const dcState = peerManager.getChatChannelState();
      const yjsState = peerManager.getYjsChannelState();
      setDataChannelState(dcState ?? "N/A");
      setYjsChannelState(yjsState ?? "N/A");

      if (yjsState === "open" && !yjsConnectedRef.current) {
        if (checkDcIntervalRef.current) {
          clearInterval(checkDcIntervalRef.current);
        }
        const pmAny = peerManager as unknown as Record<string, unknown>;
        const yjsDc = pmAny["yjsChannel"] as RTCDataChannel | undefined;
        if (yjsDc && yjsDc.readyState === "open") {
          yjsManager.connect(yjsDc);
          yjsConnectedRef.current = true;
          setConnectionStatus(`Connected (yjs bound)`);
        }
      }

      setIsConnected(peerManager.areDataChannelsOpen());
    }, 200);
  };

  // ─── Chat ───
  const handleSend = (): void => {
    if (!chatMessage.trim()) return;
    if (!peerRef.current?.sendChatMessage(chatMessage)) {
      return;
    }
    setChatMessages((prev) => [...prev, `[You] ${chatMessage}`]);
    setChatMessage("");
  };

  // ─── Yjs CRDT actions ───
  const handleAddObject = (): void => {
    const yjs = yjsRef.current;
    if (!yjs) {
      alert("YjsManager not initialized. Connect via WebRTC first.");
      return;
    }
    const id = crypto.randomUUID();
    console.log(`[App] Adding CRDT object: id=${id}, type=custom`);
    yjs.addObject({
      x: Math.round(Math.random() * 800),
      y: Math.round(Math.random() * 600),
      rotation: 0,
      scale: 1,
      type: "custom",
      name: `Object ${id.slice(0, 8)}`,
    });
  };

  const handleNotesChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const yjs = yjsRef.current;
    if (!yjs) return;
    const newText = e.target.value;
    setNotesText(newText);
    yjs.setNotesText(newText);
  };

  // ─── Table actions — ALL objects go through Yjs only ───
  const handleAddImage = (): void => {
    const yjs = yjsRef.current;
    if (!yjs) {
      console.warn("[App] Yjs not initialized, cannot add image");
      return;
    }
    const id = crypto.randomUUID();
    console.log(`[App] Adding image to Yjs: id=${id}, x=100, y=100`);
    yjs.addObject({
      x: 100,
      y: 100,
      rotation: 0,
      scale: 1,
      type: "image",
      name: id,
    });
  };

  const handleAddNote = (): void => {
    const yjs = yjsRef.current;
    if (!yjs) {
      console.warn("[App] Yjs not initialized, cannot add note");
      return;
    }
    const id = crypto.randomUUID();
    console.log(`[App] Adding note to Yjs: id=${id}, x=100, y=100`);
    yjs.addObject({
      x: 100,
      y: 100,
      rotation: 0,
      scale: 1,
      type: "note",
      name: "New note",
    });
  };

  // ─── Disconnect ───
  const handleDisconnect = (): void => {
    if (checkDcIntervalRef.current) {
      clearInterval(checkDcIntervalRef.current);
    }
    yjsRef.current?.close();
    peerRef.current?.close();
    signalingRef.current?.disconnect();
    yjsRef.current = null;
    setActiveYjsManager(undefined);
    peerRef.current = null;
    signalingRef.current = null;
    setConnectionStatus("Disconnected");
    setDataChannelState("N/A");
    setYjsChannelState("N/A");
    setIsConnected(false);
    setChatMessages([]);
    setObjectCount(0);
    setObjectList(new Map());
    setNotesText("");
  };

  // ─── Render ───
  return (
    <div style={styles.root}>
      {/* ─── Table Canvas Area ─── */}
      <div style={styles.tableArea}>
        <TableCanvas ref={tableCanvasRef} yjsManager={activeYjsManager} />

        {/* Toolbar overlay */}
        <div style={styles.toolbar}>
          <button style={styles.toolbarBtn} onClick={handleAddImage}>
            🖼 Add Image
          </button>
          <button style={styles.toolbarBtn} onClick={handleAddNote}>
            📝 Add Note
          </button>
          <span style={styles.toolbarHint}>
            Drag to pan · Scroll to zoom
          </span>
        </div>
      </div>

      {/* ─── Side Panel (Connection + Chat + Yjs) ─── */}
      <div style={styles.panel}>
        <h2 style={styles.panelTitle}>OakTable</h2>

        {/* Connection */}
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>Connection</h3>
          <div style={styles.field}>
            <label style={styles.label}>Room ID:</label>
            <input
              style={styles.input}
              type="text"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
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
          <div style={styles.connButtons}>
            <button
              style={{ ...styles.btn, ...styles.btnInitiator }}
              onClick={() => handleConnect(true)}
            >
              Initiate (GM)
            </button>
            <button
              style={{ ...styles.btn, ...styles.btnReceiver }}
              onClick={() => handleConnect(false)}
            >
              Join (Player)
            </button>
            <button
              style={{ ...styles.btn, ...styles.btnDisconnect }}
              onClick={handleDisconnect}
            >
              Disconnect
            </button>
          </div>
          <div style={styles.statusRow}>
            Status: <strong>{connectionStatus}</strong>
          </div>
          <div style={styles.statusRow}>
            Chat DC: <strong>{dataChannelState}</strong>
          </div>
          <div style={styles.statusRow}>
            Yjs DC: <strong>{yjsChannelState}</strong>
          </div>
        </div>

        {/* Yjs Objects */}
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>
            Objects ({objectCount})
          </h3>
          <button
            style={{ ...styles.btn, borderColor: "#9C27B0", color: "#9C27B0", marginBottom: 8 }}
            onClick={handleAddObject}
          >
            Add CRDT Object
          </button>
          <div style={styles.listBox}>
            {objectList.size === 0 && (
              <span style={styles.placeholder}>No objects yet.</span>
            )}
            {Array.from(objectList.entries()).map(
              ([id, data]: [string, TableObjectData]) => (
                <div key={id} style={styles.listItem}>
                  <strong>{data.name || id.slice(0, 8)}:</strong>{" "}
                  x={data.x}, y={data.y}
                </div>
              )
            )}
          </div>
        </div>

        {/* Shared Notes */}
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>Shared Notes</h3>
          <textarea
            style={{ ...styles.input, minHeight: 80, resize: "vertical" }}
            value={notesText}
            onChange={handleNotesChange}
            placeholder="Type notes..."
          />
        </div>

        {/* Chat */}
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>Chat</h3>
          <div style={styles.listBox}>
            {chatMessages.length === 0 && (
              <span style={styles.placeholder}>No messages.</span>
            )}
            {chatMessages.map((msg: string, i: number) => (
              <div key={i} style={styles.listItem}>
                {msg}
              </div>
            ))}
          </div>
          <div style={styles.sendRow}>
            <input
              style={{ ...styles.input, flex: 1 }}
              type="text"
              value={chatMessage}
              onChange={(e) => setChatMessage(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder="Type a message..."
            />
            <button style={styles.btn} onClick={handleSend}>Send</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ───
const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    height: "100vh",
    overflow: "hidden",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  tableArea: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
    background: "#e8e8e8",
  },
  toolbar: {
    position: "absolute",
    top: 12,
    left: 12,
    display: "flex",
    gap: 8,
    alignItems: "center",
    background: "rgba(255,255,255,0.92)",
    borderRadius: 8,
    padding: "6px 12px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
    zIndex: 10,
  },
  toolbarBtn: {
    padding: "6px 14px",
    fontSize: 13,
    cursor: "pointer",
    border: "1px solid #ccc",
    borderRadius: 6,
    background: "#fff",
    transition: "background 0.15s",
  },
  toolbarHint: {
    fontSize: 11,
    color: "#888",
    marginLeft: 8,
  },
  panel: {
    width: 340,
    overflowY: "auto",
    borderLeft: "1px solid #e0e0e0",
    background: "#fafafa",
    padding: 16,
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
  },
  panelTitle: {
    margin: 0,
    fontSize: 18,
    fontWeight: 700,
    borderBottom: "2px solid #2196F3",
    paddingBottom: 8,
  },
  section: {
    border: "1px solid #e0e0e0",
    borderRadius: 8,
    padding: 12,
    background: "#fff",
  },
  sectionTitle: {
    margin: "0 0 8px 0",
    fontSize: 14,
    fontWeight: 600,
  },
  field: {
    marginBottom: 8,
  },
  label: {
    display: "block",
    marginBottom: 2,
    fontSize: 12,
    fontWeight: 600,
    color: "#555",
  },
  input: {
    width: "100%",
    padding: "6px 8px",
    fontSize: 13,
    border: "1px solid #ddd",
    borderRadius: 4,
    boxSizing: "border-box" as const,
  },
  connButtons: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap" as const,
  },
  btn: {
    padding: "5px 10px",
    fontSize: 12,
    cursor: "pointer",
    border: "1px solid #999",
    borderRadius: 4,
    background: "#fff",
  },
  btnInitiator: {
    borderColor: "#2196F3",
    color: "#2196F3",
  },
  btnReceiver: {
    borderColor: "#4CAF50",
    color: "#4CAF50",
  },
  btnDisconnect: {
    borderColor: "#f44336",
    color: "#f44336",
  },
  statusRow: {
    fontSize: 12,
    margin: "3px 0",
    color: "#555",
  },
  listBox: {
    maxHeight: 120,
    overflowY: "auto" as const,
    border: "1px solid #eee",
    borderRadius: 4,
    padding: 4,
    marginBottom: 8,
    background: "#fafafa",
  },
  placeholder: {
    color: "#999",
    fontStyle: "italic",
    fontSize: 12,
    padding: "4px 0",
  },
  listItem: {
    fontSize: 12,
    padding: "3px 0",
    borderBottom: "1px solid #f0f0f0",
  },
  sendRow: {
    display: "flex",
    gap: 6,
  },
};