# Implementation Plan

[Overview]
Implement real image file loading and P2P transfer for OakTable by adding a third WebRTC DataChannel ("files") for binary file transfer, creating a FileTransferManager module, and integrating image rendering into the PixiJS table canvas. Files are split into 16KB chunks for WebRTC DataChannel transmission, reassembled on the receiver side into Blobs, and rendered as PixiJS textures via Object URLs. Yjs stores only file metadata (fileId, fileName, mimeType, size) — never the binary content.

The implementation touches three main areas: (1) WebRTC layer — adding the "files" DataChannel and chunk protocol, (2) Application layer — file upload UI and integration with Yjs object creation, (3) Rendering layer — loading file blobs and creating PixiJS textures. No server changes are needed since file transfer is pure P2P.

[Types]
Add new interfaces in `/client/src/webrtc/fileTransfer.ts` for the file transfer protocol messages. Define `FileChunkMessage` with fields: type ('file-chunk'), fileId (string), chunkIndex (number), data (ArrayBuffer), isLast (boolean). Define `FileMetadataMessage` with fields: type ('file-meta'), fileId (string), name (string), size (number), mimeType (string). Define `FileChunkData` as a helper type: { chunkIndex: number; data: ArrayBuffer; isLast: boolean }. Create `FileTransferCallbacks` interface: { onFileComplete?: (fileId: string, blob: Blob, meta: FileMetadata) => void; onProgress?: (fileId: string, received: number, total: number) => void }. These types stay in the fileTransfer module and do not affect Yjs types.

[Files]
New files:
- `/client/src/webrtc/fileTransfer.ts` — FileTransferManager class with sendFile(), chunking logic, chunk reassembly, and callback system.

Modified files:
- `/client/src/webrtc/peerManager.ts` — Add third DataChannel "files", add sendFileChunk() method, add onFileChunk() callback registration, add filesChannel property, handle "files" label in ondatachannel, add fileChannelState getter, update close() to clean up filesChannel.
- `/client/src/App.tsx` — Add hidden file input element, add "Upload Image" button, integrate FileTransferManager, add file reception callbacks, create Yjs object after file is locally received, pass fileTransferManager to TableCanvas.
- `/client/src/table/TableCanvas.tsx` — Add fileIdToFileBlob Map for local blob cache, modify image rendering to check for fileId and load from blob cache, create PIXI.Texture from Blob URL, add loading placeholder while waiting for file transfer, cache loaded textures.
- `/client/src/table/TableObject.ts` — Add method to update sprite with an external texture (updateTexture(texture: PIXI.Texture)), add fileId property to options.

[Functions]
New function — FileTransferManager in `/client/src/webrtc/fileTransfer.ts`:
- `constructor(peerManager: PeerManager)` — stores reference, registers onFileChunk callback on peerManager
- `sendFile(file: File): string` — generates fileId, sends file-meta via "files" channel, reads file as ArrayBuffer, splits into 16384-byte chunks, sends each chunk with递增 indices, returns fileId
- `onFileComplete(callback: (fileId: string, blob: Blob, meta: FileMetadata) => void): void` — registers completion callback
- `onProgress(callback: (fileId: string, received: number, total: number) => void): void` — registers progress callback
- `private accumulatedChunks: Map<string, FileChunkData[]>` — internal map for chunk reassembly
- `private onFileChunkReceived(data: FileChunkData): void` — internal handler called by peerManager, accumulates chunks, reassembles blob on last chunk

Modified functions — PeerManager in `/client/src/webrtc/peerManager.ts`:
- `init()` — no structural changes, but initiates createDataChannel("files") in initiate()
- `initiate()` — add `this.filesChannel = this.peerConnection!.createDataChannel("files", { ordered: true })` and `this.setupFilesChannelListeners()`
- `handleOffer()` — add routing for "files" label in ondatachannel handler
- `sendFileChunk(fileId: string, chunkIndex: number, data: ArrayBuffer, isLast: boolean): boolean` — sends serialized FileChunkMessage via filesChannel
- `onFileChunk(callback: (data: FileChunkData) => void): void` — registers receiver callback for file chunks
- `setupFilesChannelListeners()` — sets up onopen, onmessage (deserialize and call registered callbacks), onclose, onerror for filesChannel
- Add `getFilesChannelState(): RTCDataChannelState | null` — returns filesChannel.readyState
- Update `areDataChannelsOpen()` — include filesChannel check (optional, can exclude)
- Update `close()` — close and nullify filesChannel

Modified functions — TableCanvas in `/client/src/table/TableCanvas.tsx`:
- Add `fileBlobsRef = useRef<Map<string, Blob>>(new Map())` — stores received file blobs
- Add `textureCacheRef = useRef<Map<string, PIXI.Texture | null>>(new Map())` — caches loaded textures
- Modify `renderObjectFromData()` — when type === "image" and data has fileId, check texture cache, if missing show loading placeholder, if present render sprite
- Add `loadTextureFromFileId(fileId: string, ...): PIXI.Sprite | null` — looks up blob in fileBlobsRef, creates Object URL, loads PIXI.Texture, caches it, returns sprite
- Modify `subscribeToYjsDirect()` — pass fileBlobsRef and textureCacheRef to render helpers

Modified functions — App.tsx:
- Add `const fileTransferRef = useRef<FileTransferManager | null>(null)` — store instance
- Add hidden `<input type="file" accept="image/*" ref={fileInputRef} style={{ display: "none" }} />`
- Add `handleUploadImage()` — triggers fileInputRef.current.click()
- Modify connection handler — create FileTransferManager instance, wire up onFileComplete callback
- In onFileComplete — call yjsManager.addObject() with fileId metadata
- Pass fileTransferManager and fileBlobsRef down to TableCanvas

[Classes]
New class — FileTransferManager in `/client/src/webrtc/fileTransfer.ts`:
```typescript
interface FileMetadata {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
}

interface FileChunkData {
  chunkIndex: number;
  data: ArrayBuffer;
  isLast: boolean;
}

export class FileTransferManager {
  private peerManager: PeerManager;
  private accumulatedChunks: Map<string, FileChunkData[]>;
  private fileMetadatas: Map<string, FileMetadata>;
  private onFileCompleteCallbacks: Array<(fileId: string, blob: Blob, meta: FileMetadata) => void>;
  private onProgressCallbacks: Array<(fileId: string, received: number, total: number) => void>;
  constructor(peerManager: PeerManager);
  sendFile(file: File): string;
  onFileComplete(callback: (fileId: string, blob: Blob, meta: FileMetadata) => void): void;
  onProgress(callback: (fileId: string, received: number, total: number) => void): void;
  private setupReceiver(): void;
  private onChunk(data: FileChunkData): void;
}
```

Modified class — PeerManager in `/client/src/webrtc/peerManager.ts`:
- Add `private filesChannel: RTCDataChannel | null = null`
- Add methods: sendFileChunk(), onFileChunk(), setupFilesChannelListeners(), getFilesChannelState()
- Modify: initiate() to create "files" DataChannel, handleOffer() to route "files" label, close() to cleanup

Modified class — TableObject in `/client/src/table/TableObject.ts`:
- Add `updateTexture(texture: PIXI.Texture): void` — replaces current sprite/graphics with new texture sprite
- Add optional `fileId?: string` to constructor options
- Modify `createImageSprite()` to accept an already-loaded texture parameter

[Dependencies]
No new npm packages required. All functionality uses existing dependencies:
- pixi.js (already installed) — for PIXI.Assets.load() and PIXI.Texture.from()
- webRTC APIs (browser built-in) — no changes
- Yjs (already installed) — only metadata stored, no binary content
- TypeScript — strict mode, new types are fully typed

Testing considerations:
- Verify file chunks arrive in correct order (chunkIndex-based)
- Verify blob reassembly produces valid image blob
- Verify PIXI texture loads from Object URL correctly
- Verify texture is cached and reused across re-renders
- Verify file transfer works in both initiator→receiver and receiver→initiator directions
- Verify multiple concurrent file transfers work (different fileId)

[Implementation Order]
1. Create `/client/src/webrtc/fileTransfer.ts` — FileTransferManager class (standalone module)
2. Update `/client/src/webrtc/peerManager.ts` — add "files" DataChannel, routing, send/receive methods
3. Update `/client/src/table/TableObject.ts` — add updateTexture() method
4. Update `/client/src/table/TableCanvas.tsx` — add blob cache, texture cache, modify image rendering for fileId-based loading
5. Update `/client/src/App.tsx` — add file upload UI, integrate FileTransferManager, wire callbacks
6. Verify build passes with no TypeScript errors