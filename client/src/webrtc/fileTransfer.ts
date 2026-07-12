/**
 * FileTransferManager — P2P file transfer over WebRTC DataChannels
 *
 * Splits files into 16KB chunks for WebRTC DataChannel transmission,
 * reassembles on the receiver side into Blobs, and fires callbacks
 * when a complete file is received.
 *
 * Works through PeerManager — does not manage the DataChannel directly.
 * PeerManager creates the "files" channel and routes messages to this module.
 *
 * Protocol messages (JSON, sent via PeerManager.sendFileChunk):
 *   - FileMetaMessage:  { type: "file-meta", fileId, name, size, mimeType }
 *   - FileChunkMessage: { type: "file-chunk", fileId, chunkIndex, isLast, data: base64 }
 */

import type { PeerManager } from "./peerManager";

export interface FileMetadata {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
}

interface IncomingChunk {
  chunkIndex: number;
  data: ArrayBuffer;
  isLast: boolean;
}

interface PendingFile {
  chunks: (IncomingChunk | undefined)[];
  mimeType: string;
  name: string;
  size: number;
}

// WebRTC DataChannel max message size is ~64KB, but to be safe use 16KB chunks
const CHUNK_SIZE = 16384;

/**
 * Converts ArrayBuffer to base64 string.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Converts base64 string to ArrayBuffer.
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}

export class FileTransferManager {
  private peerManager: PeerManager;
  private pendingFiles: Map<string, PendingFile> = new Map();
  private onFileCompleteCallbacks: Array<(fileId: string, blob: Blob, meta: FileMetadata) => void> = [];
  private onProgressCallbacks: Array<(fileId: string, received: number, total: number) => void> = [];
  private metadataCache: Map<string, { name: string; size: number; mimeType: string }> = new Map();
  /** Local files cache — stores blobs for files sent by this peer (GM) */
  private localFiles: Map<string, Blob> = new Map();

  constructor(peerManager: PeerManager) {
    this.peerManager = peerManager;
    this.setupReceiver();
  }

  /**
   * Register the receiver callback on PeerManager.
   * PeerManager will call this when file chunks arrive via the "files" DataChannel.
   */
  setupReceiver(): void {
    this.peerManager.onFileChunk((msg: { fileId: string; chunkIndex: number; isLast: boolean; data: ArrayBuffer | undefined; name?: string; size?: number; mimeType?: string }) => {
      if (msg.data === null || msg.data === undefined) {
        // This is a file-meta message (data is undefined/null for meta)
        // Store metadata from the callback parameters
        this.handleFileMeta(msg.fileId, {
          name: msg.name ?? "",
          size: msg.size ?? 0,
          mimeType: msg.mimeType ?? "",
        });
      } else {
        this.handleFileChunk(msg);
      }
    });
  }


  /**
   * Send a file to all connected peers.
   * Returns the fileId for tracking.
   *
   * Step 1: Create a local blob from the File object and store it for local access
   * Step 2: Send file-meta via peerManager
   * Step 3: Read file, split into chunks, send each via peerManager.sendFileChunk()
   */
  sendFile(file: File): string {
    const fileId = this.generateFileId(file);
    const meta: FileMetadata = {
      fileId,
      name: file.name,
      size: file.size,
      mimeType: file.type,
    };

    // CRITICAL: Immediately create a blob from the File object and store it locally.
    // This ensures the sender (GM) has a blob for the fileId, so TableCanvas can create a texture.
    const localBlob = new Blob([file], { type: file.type });
    this.localFiles.set(fileId, localBlob);
    console.log(`[FileTransfer] Stored local file blob: fileId=${fileId}, size=${localBlob.size}, type=${localBlob.type}`);

    console.log(`[FileTransfer] Sending file: name=${file.name}, size=${file.size} bytes, mimeType=${file.type}, fileId=${fileId}`);

    // Send file metadata first
    this.peerManager.sendFileMeta(fileId, file.name, file.size, file.type);
    console.log(`[FileTransfer] Sent file-meta: id=${fileId}, name=${file.name}, size=${file.size}`);

    // Read file as ArrayBuffer and split into chunks
    const fileReader = new FileReader();
    const promise = new Promise<void>((resolve, reject) => {
      fileReader.onload = () => {
        const arrayBuffer = fileReader.result;
        if (arrayBuffer instanceof ArrayBuffer) {
          this.sendChunks(fileId, meta, arrayBuffer);
          resolve();
        } else {
          reject(new Error("FileReader returned non-ArrayBuffer result"));
        }
      };
      fileReader.onerror = reject;
    });

    // CRITICAL: Actually read the file — this triggers onload when done
    fileReader.readAsArrayBuffer(file);

    promise.catch((err) => {
      console.error(`[FileTransfer] Failed to read file:`, err);
    });

    return fileId;
  }

  /**
   * Split an ArrayBuffer into chunks and send each one via PeerManager.
   */
  private sendChunks(fileId: string, meta: FileMetadata, buffer: ArrayBuffer): void {
    const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);
    let offset = 0;

    for (let i = 0; i < totalChunks; i++) {
      const isLast = i === totalChunks - 1;
      const chunkSize = isLast ? buffer.byteLength - offset : CHUNK_SIZE;
      const chunkData = buffer.slice(offset, offset + chunkSize);

      this.peerManager.sendFileChunk(fileId, i, chunkData, isLast);
      console.log(`[FileTransfer] Sending chunk ${i + 1}/${totalChunks} for fileId ${fileId}, size=${chunkSize} bytes`);

      // Report progress
      const receivedBytes = offset + chunkSize;
      for (const cb of this.onProgressCallbacks) {
        cb(fileId, receivedBytes, meta.size);
      }

      offset += chunkSize;
    }

    console.log(`[FileTransfer] Sent all ${totalChunks} chunks for fileId ${fileId}`);
  }

  /**
   * Handle incoming file-meta message from a peer.
   * Stores metadata and prepares a container for incoming chunks.
   */
  private handleFileMeta(fileId: string, metaInfo: { name: string; size: number; mimeType: string }): void {
    console.log(`[FileTransfer] Received metadata: mimeType=${metaInfo.mimeType}, name=${metaInfo.name}, size=${metaInfo.size}, fileId=${fileId}`);
    
    // Store metadata for later use when reassembling the file
    this.metadataCache.set(fileId, metaInfo);
    
    // Prepare the container for incoming chunks
    const pending: PendingFile = {
      chunks: [],
      mimeType: metaInfo.mimeType,
      name: metaInfo.name,
      size: metaInfo.size,
    };
    this.pendingFiles.set(fileId, pending);
    console.log(`[FileTransfer] Storing metadata in container for fileId: ${fileId}`);
  }

  /**
   * Handle incoming file-chunk message from a peer.
   */
  private handleFileChunk(chunk: { fileId: string; chunkIndex: number; isLast: boolean; data: ArrayBuffer | undefined }): void {
    if (chunk.data === undefined || chunk.data === null) {
      console.warn("[FileTransfer] Received chunk message with no data");
      return;
    }
    let pending = this.pendingFiles.get(chunk.fileId);
    if (!pending) {
      // Metadata may be delayed — create container with defaults
      const metaInfo = this.metadataCache.get(chunk.fileId) ?? { name: "", size: 0, mimeType: "" };
      pending = { chunks: [], mimeType: metaInfo.mimeType, name: metaInfo.name, size: metaInfo.size };
      this.pendingFiles.set(chunk.fileId, pending);
      console.warn(`[FileTransfer] Received chunk for unknown fileId ${chunk.fileId}, metadata may be delayed`);
    }

    pending.chunks[chunk.chunkIndex] = {
      chunkIndex: chunk.chunkIndex,
      data: chunk.data,
      isLast: chunk.isLast,
    };

    const totalReceived = pending.chunks.reduce((sum, c) => sum + (c?.data?.byteLength ?? 0), 0);
    console.log(`[FileTransfer] Received chunk ${chunk.chunkIndex + 1} for fileId ${chunk.fileId}, total received: ${totalReceived} bytes`);

    if (chunk.isLast) {
      console.log(`[FileTransfer] All chunks received for fileId ${chunk.fileId}, reassembling...`);
      this.reassembleFile(chunk.fileId);
    }
  }

  /**
   * Reassemble all chunks into a Blob and fire onFileComplete callbacks.
   */
  private reassembleFile(fileId: string): void {
    const pending = this.pendingFiles.get(fileId);
    if (!pending) {
      console.error(`[FileTransferManager] Cannot reassemble fileId ${fileId} — pending file not found`);
      return;
    }

    // Filter out undefined entries and sort by chunk index
    const validChunks = (pending.chunks as IncomingChunk[]).filter((c): c is IncomingChunk => c !== undefined);
    validChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);

    // Concatenate all chunk data
    const totalLength = validChunks.reduce((sum, c) => sum + c.data.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of validChunks) {
      combined.set(new Uint8Array(chunk.data), offset);
      offset += chunk.data.byteLength;
    }

    // Create Blob with proper MIME type — THIS IS CRITICAL FOR PIXIJS
    const mimeType = pending.mimeType || "application/octet-stream";
    const blob = new Blob([combined], { type: mimeType });

    console.log(`[FileTransfer] Creating blob with mimeType: ${mimeType}`);
    console.log(`[FileTransfer] File complete: id=${fileId}, name=${pending.name}, blob size=${blob.size} bytes, mimeType=${mimeType}`);

    // Fire onFileComplete callbacks
    const meta: FileMetadata = {
      fileId,
      name: pending.name,
      size: pending.size,
      mimeType: pending.mimeType,
    };
    for (const cb of this.onFileCompleteCallbacks) {
      cb(fileId, blob, meta);
    }

    // Fire 100% progress
    for (const cb of this.onProgressCallbacks) {
      cb(fileId, pending.size || blob.size, pending.size || blob.size);
    }

    // Cleanup
    this.pendingFiles.delete(fileId);
    this.metadataCache.delete(fileId);
  }

  /**
   * Register a callback for completed file transfers.
   */
  onFileComplete(callback: (fileId: string, blob: Blob, meta: FileMetadata) => void): void {
    this.onFileCompleteCallbacks.push(callback);
  }

  /**
   * Register a callback for transfer progress updates.
   */
  onProgress(callback: (fileId: string, received: number, total: number) => void): void {
    this.onProgressCallbacks.push(callback);
  }

  /**
   * Generate a unique fileId from file properties and timestamp.
   */
  private generateFileId(file: File): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 10);
    return `${timestamp}-${random}-${file.name}-${file.size}`;
  }

  /**
   * Get a locally stored file blob by fileId.
   * Returns undefined if the file was not sent by this peer or doesn't exist in cache.
   */
  getLocalFile(fileId: string): Blob | undefined {
    const blob = this.localFiles.get(fileId);
    if (blob) {
      console.log(`[FileTransfer] Retrieved local file blob: fileId=${fileId}, size=${blob.size}`);
    }
    return blob;
  }

  /**
   * Clean up all resources.
   */
  destroy(): void {
    this.pendingFiles.clear();
    this.onFileCompleteCallbacks = [];
    this.onProgressCallbacks = [];
    this.localFiles.clear();
  }
}
