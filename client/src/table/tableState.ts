import { TableObject, TableObjectOptions } from "./TableObject";
import type { Application } from "pixi.js";

type OnChangeCallback = (objects: Map<string, TableObject>) => void;

/**
 * Manages blob storage for received files.
 * Blobs are stored in memory only (not persisted).
 */
export class FileBlobStore {
  private blobs = new Map<string, Blob>();
  private objectUrls = new Map<string, string>();

  /**
   * Store a blob for the given fileId.
   * Cleans up old object URL if one existed.
   */
  setBlob(fileId: string, blob: Blob): void {
    const oldUrl = this.objectUrls.get(fileId);
    if (oldUrl) {
      URL.revokeObjectURL(oldUrl);
    }
    this.blobs.set(fileId, blob);
    const objectUrl = URL.createObjectURL(blob);
    this.objectUrls.set(fileId, objectUrl);
    console.log(`[FileBlobStore] Blob stored: fileId=${fileId}, size=${blob.size} bytes, objectUrl=${objectUrl}`);
  }

  /**
   * Get a blob for the given fileId.
   */
  getBlob(fileId: string): Blob | undefined {
    return this.blobs.get(fileId);
  }

  /**
   * Get the Object URL for a fileId (for PixiJS/HTML img usage).
   */
  getObjectUrl(fileId: string): string | undefined {
    return this.objectUrls.get(fileId);
  }

  /**
   * Check if a blob exists for the given fileId.
   */
  hasBlob(fileId: string): boolean {
    return this.blobs.has(fileId);
  }

  /**
   * Remove blob and clean up object URL.
   */
  removeBlob(fileId: string): void {
    const oldUrl = this.objectUrls.get(fileId);
    if (oldUrl) {
      URL.revokeObjectURL(oldUrl);
    }
    this.blobs.delete(fileId);
    this.objectUrls.delete(fileId);
  }

  /**
   * Clean up all resources.
   */
  clear(): void {
    for (const url of this.objectUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.blobs.clear();
    this.objectUrls.clear();
  }
}

/**
 * Local state manager for table objects.
 * Tracks all TableObject instances and provides CRUD operations.
 */
export class TableStateManager {
  private objects = new Map<string, TableObject>();
  private onChangeCallbacks = new Set<OnChangeCallback>();

  /**
   * Add a new object to the table.
   */
  addObject(options: TableObjectOptions, pixiApp: Application): TableObject {
    const obj = new TableObject(options, pixiApp);
    this.objects.set(options.id, obj);
    this.notifyChange();
    return obj;
  }

  /**
   * Remove an object from the table.
   */
  removeObject(id: string): void {
    const obj = this.objects.get(id);
    if (obj) {
      obj.destroy();
      this.objects.delete(id);
      this.notifyChange();
    }
  }

  /**
   * Get an object by id.
   */
  getObject(id: string): TableObject | undefined {
    return this.objects.get(id);
  }

  /**
   * Get all objects.
   */
  getAllObjects(): Map<string, TableObject> {
    return new Map(this.objects);
  }

  /**
   * Get count of objects.
   */
  getCount(): number {
    return this.objects.size;
  }

  /**
   * Register a callback for object changes. Returns unsubscribe function.
   */
  onChange(callback: OnChangeCallback): () => void {
    this.onChangeCallbacks.add(callback);
    return () => {
      this.onChangeCallbacks.delete(callback);
    };
  }

  private notifyChange(): void {
    for (const cb of this.onChangeCallbacks) {
      cb(this.objects);
    }
  }

  /**
   * Destroy all objects and clear state.
   */
  clear(): void {
    for (const [, obj] of this.objects) {
      obj.destroy();
    }
    this.objects.clear();
    this.notifyChange();
  }
}