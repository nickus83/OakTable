import React, { useEffect, useRef, useCallback } from "react";
import * as PIXI from "pixi.js";
import * as Y from "yjs";
import { YjsManager } from "../sync/yjsManager";
import { TableObject } from "./TableObject";
import type { TableObjectType } from "./TableObject";
import type { FileMetadata } from "../webrtc/fileTransfer";

// ==================== Types ====================

/** Map of PixiJS object ID → TableObject instance. */
type TableObjectMap = Record<string, TableObject>;

export interface TableCanvasRef {
  addImage: (id: string, x?: number, y?: number) => void;
  addNote: (id: string, text?: string, x?: number, y?: number) => void;
  removeObject: (id: string) => void;
  loadFileBlob: (fileId: string, blob: Blob) => void;
}

export interface TableCanvasProps {
  containerRef?: React.RefObject<HTMLDivElement>;
  yjsManager?: YjsManager;
}

// ==================== Blob & Texture Cache ====================

/**
 * Cache for received file blobs and their loaded PixiJS textures.
 * Key: fileId (Yjs object ID)
 */
export interface FileBlobCache {
  /** Maps fileId → Blob */
  blobs: Map<string, Blob>;
  /** Maps fileId → Object URL for texture loading */
  objectUrls: Map<string, string>;
  /** Maps fileId → loaded texture */
  textures: Map<string, PIXI.Texture>;
}

/** Yjs Y.Map "objects" type for typed access */
type ObjectsYMap = Y.Map<Y.Map<unknown>>;

/**
 * Convert Y.Map data to TableObject params.
 */
function yMapToData(yMap: Y.Map<unknown>): { x: number; y: number; type: TableObjectType; content?: string; name?: string; fileId?: string } {
  let x = 0, y = 0, scale = 1, rotation = 0;
  let type: TableObjectType = "image";
  let name: string | undefined;
  let fileId: string | undefined;

  yMap.forEach((v, k) => {
    if (k === "x" && typeof v === "number") x = v;
    else if (k === "y" && typeof v === "number") y = v;
    else if (k === "scale" && typeof v === "number") scale = v;
    else if (k === "rotation" && typeof v === "number") rotation = v;
    else if (k === "type" && typeof v === "string") type = (v as "image" | "note" | "custom") === "note" ? "note" : "image";
    else if (k === "name" && typeof v === "string") name = v;
    else if (k === "fileId" && typeof v === "string") fileId = v;
  });

  return { x, y, type, content: name, name, fileId };
}

/**
 * Load a PixiJS texture from a blob in the file cache.
 * Returns the sprite if the texture is already cached, null otherwise.
 * If the file is not yet available, starts async loading and returns null.
 * Uses HTMLImageElement → PIXI.Texture.from() instead of PIXI.Assets.load() for blob URLs.
 */
function loadTextureFromFileId(
  fileId: string,
  fileCache: FileBlobCache,
  appRef: React.MutableRefObject<PIXI.Application | null>,
  width: number = 200,
  height: number = 150
): PIXI.Sprite | null {
  const app = appRef.current;
  if (!app) return null;

  // Check if texture is already cached
  const cachedTexture = fileCache.textures.get(fileId);
  if (cachedTexture) {
    const sprite = new PIXI.Sprite(cachedTexture);
    const aspect = cachedTexture.width / cachedTexture.height;
    if (aspect > 1) {
      sprite.width = width;
      sprite.height = width / aspect;
    } else {
      sprite.height = height;
      sprite.width = height * aspect;
    }
    sprite.anchor.set(0.5);
    return sprite;
  }

  // Check if blob is available
  const blob = fileCache.blobs.get(fileId);
  if (!blob) {
    return null; // File not received yet
  }

  // Check if we already created an object URL for this blob
  let objectUrl = fileCache.objectUrls.get(fileId);
  
  // Start async texture loading if not already in progress
  if (!objectUrl) {
    objectUrl = URL.createObjectURL(blob);
    fileCache.objectUrls.set(fileId, objectUrl);

    const img = new Image();
    img.onload = () => {
      try {
        const texture = PIXI.Texture.from(img);
        fileCache.textures.set(fileId, texture);
        console.log(`[TableCanvas] loadTextureFromFileId: texture async loaded for fileId: ${fileId}, dimensions: ${texture.width}x${texture.height}`);
      } catch (error) {
        console.error(`[TableCanvas] Failed to create PIXI texture from image for fileId ${fileId}:`, error);
      } finally {
        URL.revokeObjectURL(objectUrl!);
        fileCache.objectUrls.delete(fileId);
      }
    };
    
    img.onerror = () => {
      console.error(`[TableCanvas] Failed to load image from blob for fileId ${fileId}:`, objectUrl);
      URL.revokeObjectURL(objectUrl!);
      fileCache.objectUrls.delete(fileId);
    };
    
    img.src = objectUrl;
  }

  // Return null — texture will be loaded asynchronously
  // The Yjs observer will pick up the cached texture on next render cycle
  return null;
}

/**
 * Render a PixiJS object from Yjs data.
 * Returns the created TableObject.
 */
function renderObjectFromData(
  objectId: string,
  type: TableObjectType,
  data: { x: number; y: number; content?: string; fileId?: string },
  tableObjectsRef: React.MutableRefObject<TableObjectMap>,
  objectsLayerRef: React.MutableRefObject<PIXI.Container | null>,
  appRef: React.MutableRefObject<PIXI.Application | null>,
  yjsRef: React.MutableRefObject<YjsManager | undefined>,
  fileCache: FileBlobCache
): TableObject {
  const app = appRef.current;
  const layer = objectsLayerRef.current;
  if (!app || !layer) {
    throw new Error("TableCanvas: app or layer not initialized");
  }

  // Check if object already exists — update position if so
  const existing = tableObjectsRef.current[objectId];
  if (existing) {
    existing.setPosition(data.x, data.y);
    return existing;
  }

  // For image objects with fileId, check if we have a cached texture
  let contentSource: string | undefined = data.content;
  if (type === "image" && data.fileId) {
    const cachedTexture = fileCache.textures.get(data.fileId);
    if (cachedTexture) {
      // Texture already loaded — create sprite directly
      const sprite = new PIXI.Sprite(cachedTexture);
      const aspect = cachedTexture.width / cachedTexture.height;
      let w = 200, h = 150;
      if (aspect > 1) {
        sprite.width = w;
        sprite.height = w / aspect;
      } else {
        sprite.height = h;
        sprite.width = h * aspect;
      }
      sprite.anchor.set(0.5);

      const obj = new TableObject(
        { id: objectId, type, x: data.x, y: data.y },
        app
      );
      // Replace placeholder with sprite
      obj.container.removeChildren();
      obj.container.addChild(sprite);
      // Re-add border (need to access private method via re-creation)
      const border = new PIXI.Graphics();
      border.lineStyle(2, 0x666666, 0.4);
      border.drawRoundedRect(-3, -3, w + 6, h + 6, 6);
      border.interactive = false;
      border.eventMode = "none";
      obj.container.addChild(border);

      tableObjectsRef.current[objectId] = obj;
      layer.addChild(obj.container);

      obj.onDrag((id: string, x: number, y: number) => {
        const yjs = yjsRef.current;
        if (yjs) {
          yjs.updateObject(id, { x, y });
        }
      });

      console.log(`[TableCanvas] Rendered object with cached texture: id=${objectId}, fileId=${data.fileId}`);
      return obj;
    }

    // File blob is available but texture not yet cached — start async loading
    // We'll create the TableObject with fileId, and update the sprite texture when loading completes
    const blob = fileCache.blobs.get(data.fileId!);
    if (blob) {
      console.log(`[TableCanvas] Blob available for fileId ${data.fileId}, starting async texture load`);
      
      // Start async texture loading — it will update the TableObject when done
      loadTextureFromBlob(data.fileId!, blob)
        .then((texture) => {
          const existingObj = tableObjectsRef.current[objectId];
          if (existingObj) {
            existingObj.updateTexture(texture);
            console.log(`[TableCanvas] Sprite texture applied: id=${objectId}, fileId=${data.fileId}`);
          }
        })
        .catch((error) => {
          console.error(`[TableCanvas] Failed to load texture for sprite: id=${objectId}, fileId=${data.fileId}`, error);
        });
    }
    
    // File not yet received — use fileId as content marker
    // TableObject will show placeholder, and updateTexture will be called later
    contentSource = undefined;
  }

  // Create new TableObject
  const obj = new TableObject(
    { id: objectId, type, x: data.x, y: data.y, content: contentSource, fileId: data.fileId },
    app
  );

  tableObjectsRef.current[objectId] = obj;
  layer.addChild(obj.container);

  // Register drag callback — always reads from yjsRef.current for latest instance
  obj.onDrag((id: string, x: number, y: number) => {
    const yjs = yjsRef.current;
    if (yjs) {
      yjs.updateObject(id, { x, y });
    }
  });

  console.log(`[TableCanvas] Rendered object: id=${objectId}, type=${type}, x=${Math.round(data.x)}, y=${Math.round(data.y)}`);
  return obj;
}

/**
 * Update existing PixiJS object position/scale/rotation from Yjs data.
 * Also checks for fileId-based texture updates.
 * Returns true if object was found and updated.
 */
function updateObjectInPixi(
  objectId: string,
  yMapData: Y.Map<unknown>,
  tableObjectsRef: React.MutableRefObject<TableObjectMap>,
  objectsLayerRef: React.MutableRefObject<PIXI.Container | null>,
  fileCache: FileBlobCache,
  appRef: React.MutableRefObject<PIXI.Application | null>
): boolean {
  const layer = objectsLayerRef.current;
  if (!layer) return false;

  const existing = tableObjectsRef.current[objectId];
  if (!existing) return false;

  // Extract updated values
  let x: number | undefined, y: number | undefined;
  yMapData.forEach((v, k) => {
    if (k === "x" && typeof v === "number") x = v;
    else if (k === "y" && typeof v === "number") y = v;
  });

  if (x !== undefined && y !== undefined) {
    existing.setPosition(x, y);
    console.log(`[TableCanvas] Object updated from Yjs: id=${objectId}, x=${Math.round(x)}, y=${Math.round(y)}`);
    return true;
  }

  return false;
}

/**
 * Try to update a TableObject with a texture from a received file.
 * Returns true if an update was performed.
 */
function updateObjectTextureFromFile(
  objectId: string,
  fileId: string,
  fileCache: FileBlobCache,
  tableObjectsRef: React.MutableRefObject<TableObjectMap>,
  appRef: React.MutableRefObject<PIXI.Application | null>
): boolean {
  const existing = tableObjectsRef.current[objectId];
  if (!existing) return false;

  // Check if we have a cached texture
  const cachedTexture = fileCache.textures.get(fileId);
  if (cachedTexture) {
    existing.updateTexture(cachedTexture);
    console.log(`[TableCanvas] Updated object texture: id=${objectId}, fileId=${fileId}`);
    return true;
  }

  // Check if we have a blob but texture not yet loaded
  const blob = fileCache.blobs.get(fileId);
  if (blob) {
    // Texture loading was initiated in onFileReceived callback
    return false;
  }

  return false;
}

/**
 * Load a texture from a Blob using HTMLImageElement as intermediate step.
 * PixiJS v7 Assets loader doesn't handle blob URLs reliably, so we use
 * HTMLImageElement which PixiJS.from() can then convert to a Texture.
 */
function loadTextureFromBlob(fileId: string, blob: Blob): Promise<PIXI.Texture> {
  return new Promise((resolve, reject) => {
    const blobUrl = URL.createObjectURL(blob);
    
    console.log(`[TableCanvas] Creating HTMLImageElement from blob: fileId=${fileId}, size=${blob.size}, type=${blob.type}`);
    
    const img = new Image();
    
    img.onload = () => {
      console.log(`[TableCanvas] Image loaded: fileId=${fileId}, width=${img.width}, height=${img.height}`);
      try {
        const texture = PIXI.Texture.from(img);
        console.log(`[TableCanvas] Texture created from image: fileId=${fileId}, texWidth=${texture.width}, texHeight=${texture.height}`);
        URL.revokeObjectURL(blobUrl);
        resolve(texture);
      } catch (error) {
        console.error(`[TableCanvas] Failed to create PIXI texture from image:`, error);
        URL.revokeObjectURL(blobUrl);
        reject(error);
      }
    };
    
    img.onerror = (error) => {
      console.error(`[TableCanvas] Failed to load image from blob: fileId=${fileId}, error=`, error);
      URL.revokeObjectURL(blobUrl);
      reject(new Error(`Failed to load image from blob for fileId ${fileId}`));
    };
    
    img.src = blobUrl;
  });
}

/**
 * Load a file blob into the cache and render/update the corresponding PixiJS object.
 * Called when a file is received via P2P file transfer.
 * Uses HTMLImageElement → PIXI.Texture.from() instead of PIXI.Assets.load() for blob URLs.
 */
async function loadFileBlobIntoCache(
  fileId: string,
  blob: Blob,
  fileCache: FileBlobCache,
  appRef: React.MutableRefObject<PIXI.Application | null>,
  tableObjectsRef: React.MutableRefObject<TableObjectMap>,
  yjsManager: YjsManager | undefined
): Promise<void> {
  console.log(`[TableCanvas] Loading file blob: fileId=${fileId}, size=${blob.size} bytes, type=${blob.type}`);

  // Skip if texture already cached
  if (fileCache.textures.has(fileId)) {
    console.log(`[TableCanvas] Texture already cached for fileId: ${fileId}, skipping`);
    return;
  }

  // Store blob
  fileCache.blobs.set(fileId, blob);

  // Log blob MIME type for debugging
  console.log(`[TableCanvas] Creating texture from blob: type=${blob.type}, size=${blob.size}, fileId=${fileId}`);
  if (!blob.type) {
    console.warn(`[TableCanvas] WARNING: Blob has no MIME type (type="${blob.type}"), texture may fail to load with PixiJS`);
  }

  // Load texture using HTMLImageElement approach (avoids PixiJS Assets blob URL issues)
  try {
    const texture = await loadTextureFromBlob(fileId, blob);
    console.log(`[TableCanvas] Texture loaded and cached for fileId: ${fileId}, dimensions: ${texture.width}x${texture.height}`);
    fileCache.textures.set(fileId, texture);

    // Update all TableObjects referencing this fileId
    for (const [objectId, tableObj] of Object.entries(tableObjectsRef.current)) {
      if (tableObj.fileId === fileId) {
        tableObj.updateTexture(texture);
        console.log(`[TableCanvas] Updated TableObject ${objectId} with texture for fileId ${fileId}`);
      }
    }
  } catch (err) {
    console.error(`[TableCanvas] Failed to load texture for fileId ${fileId}:`, err);
  }
}

/**
 * Remove PixiJS object by ID.
 */
function removeObjectFromPixi(
  objectId: string,
  tableObjectsRef: React.MutableRefObject<TableObjectMap>,
  objectsLayerRef: React.MutableRefObject<PIXI.Container | null>
): void {
  const layer = objectsLayerRef.current;
  if (!layer) return;

  const existing = tableObjectsRef.current[objectId];
  if (existing) {
    layer.removeChild(existing.container);
    existing.destroy();
    delete tableObjectsRef.current[objectId];
    console.log(`[TableCanvas] Object removed from PixiJS: id=${objectId}`);
  }
}

/**
 * Subscribe to Yjs.Doc changes directly (bypasses YjsManager's observeDeep limitation).
 *
 * Key insight: Yjs observeDeep only fires for changes INSIDE nested Y.Map values.
 * When a new key is added to Y.Map via set(), only the shallow observe fires, not observeDeep.
 * Solution: observe both shallow (key changes) and deep (nested value changes).
 */
function subscribeToYjsDirect(
  yjsManager: YjsManager,
  tableObjectsRef: React.MutableRefObject<TableObjectMap>,
  objectsLayerRef: React.MutableRefObject<PIXI.Container | null>,
  appRef: React.MutableRefObject<PIXI.Application | null>,
  yjsRef: React.MutableRefObject<YjsManager | undefined>,
  fileCacheRef: React.MutableRefObject<FileBlobCache>
): () => void {
  const doc = yjsManager.getDoc();
  const objectsMap: ObjectsYMap = doc.getMap("objects");

  // === SHALLOW OBSERVER: ONLY handles key ADD/DELETE events ===
  // Responsibilities: create/remove PixiJS objects from Yjs Y.Map keys
  // NOTE: Does NOT handle updates to x/y/rotation/scale — that's deep observer's job
  objectsMap.observe((event) => {
    for (const [key, change] of event.changes.keys) {
      const action = change.action; // "add" | "update" | "delete"

      if (action === "add") {
        // Skip if object already exists (prevents duplication from initial sync)
        if (tableObjectsRef.current[key]) {
          console.log(`[TableCanvas] Shallow add: ${key} exists, skipping`);
          continue;
        }
        const yMapValue = objectsMap.get(key) as Y.Map<unknown> | undefined;
        if (!yMapValue) {
          console.warn(`[TableCanvas] Add event for ${key} but value is null`);
          continue;
        }
        const data = yMapToData(yMapValue);
        console.log(`[TableCanvas] Shallow ADD: creating PixiJS object id=${key} type=${data.type}`);
        try {
          renderObjectFromData(key, data.type, { x: data.x, y: data.y, content: data.content, fileId: data.fileId }, tableObjectsRef, objectsLayerRef, appRef, yjsRef, fileCacheRef.current);
        } catch (err) {
          console.warn(`[TableCanvas] Could not render object ${key}:`, err);
        }
      } else if (action === "delete") {
        console.log(`[TableCanvas] Shallow DELETE: removing PixiJS object id=${key}`);
        removeObjectFromPixi(key, tableObjectsRef, objectsLayerRef);
      }
      // NOTE: "update" action on shallow observer is ignored for key updates
      // (only relevant when object is replaced, not used in our case)
    }
  });

  // === DEEP OBSERVER: ONLY handles nested Y.Map value changes (x, y, rotation, scale) ===
  // Responsibilities: update position/scale/rotation of EXISTING PixiJS objects
  // NOTE: Does NOT create or destroy objects — only updates existing ones
  //
  // Key insight: observeDeep receives YEvent objects where each event has:
  // - path: array of keys leading to the changed value (for nested maps)
  // - delta: array of operations (insert, retain, delete)
  // For Y.Map, path[0] is the key that was set on the parent Y.Map (objectId)
  // But we need to check the actual changed keys INSIDE the nested Y.Map.
  objectsMap.observeDeep((events) => {
    console.log(`[TableCanvas] Deep observer fired, events count: ${events.length}`);
    for (const deepEvent of events) {
      // For Y.Map observeDeep, path[0] is the key on the parent map (objectId)
      const rawId = (deepEvent as any).path?.[0];
      const objectId = typeof rawId === "string" ? rawId : null;

      if (!objectId) {
        console.log(`[TableCanvas] Deep event with invalid path: ${JSON.stringify(deepEvent.path)}`);
        // Fallback: iterate all objects in the map and sync them all
        // This is safer but less efficient — ensures we catch the update
        console.log(`[TableCanvas] Fallback: syncing all objects from Y.Map`);
        const allObjects = yjsManager.getAllObjects();
        for (const [id, data] of allObjects) {
          const existing = tableObjectsRef.current[id];
          if (existing) {
            const currentX = existing.getPosition();
            // Only update if position actually changed (prevent infinite loop)
            if (Math.abs(currentX.x - data.x) > 0.5 || Math.abs(currentX.y - data.y) > 0.5) {
              existing.setPosition(data.x, data.y);
              console.log(`[TableCanvas] PixiJS position updated (fallback): id=${id}, x=${Math.round(data.x)}, y=${Math.round(data.y)}`);
            }
          }
        }
        continue;
      }

      const existing = tableObjectsRef.current[objectId];
      if (!existing) {
        console.log(`[TableCanvas] Deep event for ${objectId} but object doesn't exist yet, skipping`);
        continue;
      }

      // Read current x,y from the Y.Map value directly
      const yMapValue = objectsMap.get(objectId) as Y.Map<unknown> | undefined;
      if (!yMapValue) {
        console.warn(`[TableCanvas] Deep event for ${objectId} but Y.Map value is null`);
        continue;
      }

      const xVal = yMapValue.get("x");
      const yVal = yMapValue.get("y");
      const rotVal = yMapValue.get("rotation");
      const scaleVal = yMapValue.get("scale");

      console.log(`[TableCanvas] Deep change data for ${objectId}: x=${xVal}, y=${yVal}, rot=${rotVal}, scale=${scaleVal}`);

      if (typeof xVal === "number" && typeof yVal === "number") {
        updateObjectInPixi(objectId, yMapValue, tableObjectsRef, objectsLayerRef, fileCacheRef.current, appRef);
      }
    }
  });

  // === Initial sync: render all existing objects from Y.Map ===
  const existingObjects = yjsManager.getAllObjects();
  console.log(`[TableCanvas] Initial sync: rendering ${existingObjects.size} objects from Y.Map`);
  for (const [id, data] of existingObjects) {
    const type: TableObjectType = data.type === "note" ? "note" : "image";
    try {
      renderObjectFromData(id, type, { x: data.x, y: data.y, content: data.name, fileId: data.fileId }, tableObjectsRef, objectsLayerRef, appRef, yjsRef, fileCacheRef.current);
    } catch (err) {
      console.warn(`[TableCanvas] Could not render object ${id} during initial sync:`, err);
    }
  }

  console.log("[TableCanvas] Yjs observer registered for 'objects' map (shallow + deep)");

  // Return unsubscribe function
  return () => {
    console.log("[TableCanvas] Yjs observer unregistered");
  };
}

// ==================== Component ====================

/**
 * Infinite 2D canvas using PixiJS with pan/zoom support.
 * Integrates with YjsManager for CRDT-based real-time sync.
 */
const TableCanvas = React.forwardRef<TableCanvasRef, TableCanvasProps>(
  ({ containerRef: externalRef, yjsManager }, forwardedRef) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const ref = externalRef ?? containerRef;
    const appRef = useRef<PIXI.Application | null>(null);
    const stageRef = useRef<PIXI.Container | null>(null);
    const objectsLayerRef = useRef<PIXI.Container | null>(null);
    const gridTickerCallbackRef = useRef<PIXI.TickerCallback<any> | null>(null);

    // Map of object ID → TableObject (replaces TableStateManager)
    const tableObjectsRef = useRef<TableObjectMap>({});
    // YjsManager ref for drag callbacks
    const yjsRef = useRef<YjsManager | undefined>(undefined);
    // File blob & texture cache
    const fileCacheRef = useRef<FileBlobCache>({ blobs: new Map(), objectUrls: new Map(), textures: new Map() });
    // Unsubscribe callbacks from Yjs listeners
    const unsubscribeYjsRef = useRef<(() => void) | null>(null);
    // Track whether we're subscribed to prevent duplicate subscriptions
    const isSubscribedRef = useRef(false);

    // Pan/Zoom state
    const isPanningRef = useRef(false);
    const panStartRef = useRef({ x: 0, y: 0 });
    const stageStartRef = useRef({ x: 0, y: 0 });

    // ==================== Pan/Zoom handlers ====================

    const onStagePointerDown = useCallback((e: PIXI.FederatedPointerEvent): void => {
      if (e.target !== appRef.current?.stage) {
        return;
      }
      isPanningRef.current = true;
      panStartRef.current = { x: e.global.x, y: e.global.y };
      stageStartRef.current = { x: stageRef.current!.x, y: stageRef.current!.y };
      if (appRef.current) {
        (appRef.current.stage as any).cursor = "grabbing";
      }
    }, []);

    const onStagePointerMove = useCallback((e: PIXI.FederatedPointerEvent): void => {
      if (!isPanningRef.current || !stageRef.current) return;

      const dx = e.global.x - panStartRef.current.x;
      const dy = e.global.y - panStartRef.current.y;

      stageRef.current.x = stageStartRef.current.x + dx;
      stageRef.current.y = stageStartRef.current.y + dy;
    }, []);

    const onStagePointerUp = useCallback((): void => {
      isPanningRef.current = false;
      if (appRef.current) {
        (appRef.current.stage as any).cursor = "grab";
      }
    }, []);

    const onWheelZoom = useCallback((e: PIXI.FederatedWheelEvent): void => {
      if (!stageRef.current || !appRef.current) return;

      const zoomFactor = 1.1;
      const direction = e.deltaY > 0 ? 1 / zoomFactor : zoomFactor;

      const mouseX = e.global.x;
      const mouseY = e.global.y;

      const worldX = (mouseX - stageRef.current.x) / stageRef.current.scale.x;
      const worldY = (mouseY - stageRef.current.y) / stageRef.current.scale.y;

      const newScale = stageRef.current.scale.x * direction;
      const clampedScale = Math.max(0.05, Math.min(20, newScale));
      const actualFactor = clampedScale / stageRef.current.scale.x;

      stageRef.current.scale.set(actualFactor);

      stageRef.current.x = mouseX - worldX * actualFactor;
      stageRef.current.y = mouseY - worldY * actualFactor;
    }, []);

    /**
     * Draw a subtle grid pattern — updates on ticker to simulate infinite canvas.
     */
    const drawGrid = (stage: PIXI.Container, app: PIXI.Application): void => {
      const gridLines = new PIXI.Graphics();
      stage.addChildAt(gridLines, 0);

      const gridSize = 100;

      const updateGrid = (): void => {
        gridLines.clear();

        const stagePos = (stage as any).position as { x: number; y: number };
        const stageSc = stage.scale;

        const viewWidth = app.screen.width;
        const viewHeight = app.screen.height;

        const left = stagePos.x / stageSc.x;
        const top = stagePos.y / stageSc.y;
        const right = (stagePos.x + viewWidth) / stageSc.x;
        const bottom = (stagePos.y + viewHeight) / stageSc.y;

        const startX = Math.floor(left / gridSize) * gridSize;
        const startY = Math.floor(top / gridSize) * gridSize;

        const alpha = Math.min(1, Math.max(0.05, (stageSc.x - 0.1) * 0.5));
        const color = 0xcccccc;

        gridLines.lineStyle(1, color, alpha);

        for (let x = startX; x <= right; x += gridSize) {
          gridLines.moveTo(x, startY);
          gridLines.lineTo(x, bottom);
        }

        for (let y = startY; y <= bottom; y += gridSize) {
          gridLines.moveTo(startX, y);
          gridLines.lineTo(right, y);
        }

        if (alpha > 0.2) {
          gridLines.lineStyle(2, 0x999999, alpha);
          gridLines.moveTo(-20, 0);
          gridLines.lineTo(20, 0);
          gridLines.moveTo(0, -20);
          gridLines.lineTo(0, 20);
        }
      };

      // Update grid every frame — store the callback for removal
      gridTickerCallbackRef.current = () => {
        updateGrid();
      };
      app.ticker.add(gridTickerCallbackRef.current);
    };

    /**
     * Initialize PixiJS application (PixiJS v7 — options in constructor, NO init() method).
     */
    const initPixi = useCallback((container: HTMLDivElement) => {
      if (appRef.current) {
        return;
      }

      const app = new PIXI.Application({
        width: container.clientWidth,
        height: container.clientHeight,
        backgroundColor: 0xf0f0f0,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });

      container.appendChild((app as any).view);
      appRef.current = app;

      // Main stage container for pan/zoom
      const stage = new PIXI.Container();
      stage.x = container.clientWidth / 2;
      stage.y = container.clientHeight / 2;
      stageRef.current = stage;
      app.stage.addChild(stage);

      // Objects layer
      const objectsLayer = new PIXI.Container();
      objectsLayerRef.current = objectsLayer;
      stage.addChild(objectsLayer);

      // Grid
      drawGrid(stage, app);

      // Stage pan events
      (app.stage as any).eventMode = "static";
      (app.stage as any).cursor = "grab";
      app.stage.on("pointerdown", onStagePointerDown);
      app.stage.on("pointermove", onStagePointerMove);
      app.stage.on("pointerup", onStagePointerUp);
      app.stage.on("pointerupoutside", onStagePointerUp);
      app.stage.on("wheel", onWheelZoom);

      // NOTE: Yjs subscription is handled by the useEffect below, not here.
      // This avoids duplicate subscriptions when yjsManager prop changes.
    }, [onStagePointerDown, onStagePointerMove, onStagePointerUp, onWheelZoom, yjsManager]);

    // ==================== Expose API ====================
    // NOTE: All object creation/deletion goes through Yjs only.
    // These methods are kept for backward compatibility but now
    // only call Yjs — PixiJS objects are created/removed by Yjs observer.

    const addImage = useCallback((id: string, x?: number, y?: number): void => {
      const yjs = yjsRef.current;
      if (!yjs) {
        console.warn("[TableCanvas] Yjs not available for addImage");
        return;
      }
      console.log(`[TableCanvas] addImage requested: id=${id}, x=${x ?? 0}, y=${y ?? 0}`);
      yjs.addObject({
        id,
        x: x ?? 0,
        y: y ?? 0,
        rotation: 0,
        scale: 1,
        type: "image",
        name: id,
      });
    }, []);

    const addNote = useCallback((id: string, text?: string, x?: number, y?: number): void => {
      const yjs = yjsRef.current;
      if (!yjs) {
        console.warn("[TableCanvas] Yjs not available for addNote");
        return;
      }
      console.log(`[TableCanvas] addNote requested: id=${id}`);
      yjs.addObject({
        id,
        x: x ?? 0,
        y: y ?? 0,
        rotation: 0,
        scale: 1,
        type: "note",
        name: text ?? "New note",
      });
    }, []);

    const removeObject = useCallback((id: string): void => {
      const yjs = yjsRef.current;
      if (!yjs) return;
      console.log(`[TableCanvas] removeObject requested: id=${id}`);
      yjs.removeObject(id);
    }, []);

    // Expose API via forwardRef
    React.useImperativeHandle(forwardedRef, () => ({
      addImage,
      addNote,
      removeObject,
      loadFileBlob(fileId: string, blob: Blob): void {
        loadFileBlobIntoCache(fileId, blob, fileCacheRef.current, appRef, tableObjectsRef, yjsRef.current);
      },
    }), [addImage, addNote, removeObject]);

    // ==================== Lifecycle ====================

    // Update yjsManager ref when prop changes and re-subscribe to Yjs events
    useEffect(() => {
      yjsRef.current = yjsManager;

      if (yjsManager && !isSubscribedRef.current) {
        // Only subscribe once per mount — don't resubscribe on yjsManager changes
        // The yjsManager is passed as prop and should be stable per-connection
        isSubscribedRef.current = true;
        unsubscribeYjsRef.current = subscribeToYjsDirect(
          yjsManager,
          tableObjectsRef,
          objectsLayerRef,
          appRef,
          yjsRef,
          fileCacheRef
        );
        console.log("[TableCanvas] Yjs subscription activated");
      }
    }, [yjsManager]);

    // Main mount/unmount lifecycle
    useEffect(() => {
      const container = ref.current;
      if (!container) return;

      initPixi(container);

      const handleResize = (): void => {
        if (!appRef.current || !container) return;
        (appRef.current as any).screen.width = container.clientWidth;
        (appRef.current as any).screen.height = container.clientHeight;
      };

      window.addEventListener("resize", handleResize);

      return () => {
        window.removeEventListener("resize", handleResize);

        // Unsubscribe from Yjs
        unsubscribeYjsRef.current?.();
        unsubscribeYjsRef.current = null;

        // Destroy all TableObjects
        for (const id of Object.keys(tableObjectsRef.current)) {
          tableObjectsRef.current[id].destroy();
          delete tableObjectsRef.current[id];
        }

        const app = appRef.current;
        if (app) {
          // Remove event listeners from stage
          app.stage.off("pointerdown", onStagePointerDown);
          app.stage.off("pointermove", onStagePointerMove);
          app.stage.off("pointerup", onStagePointerUp);
          app.stage.off("pointerupoutside", onStagePointerUp);
          app.stage.off("wheel", onWheelZoom);

          // Remove grid ticker callback BEFORE destroying app
          const callback = gridTickerCallbackRef.current;
          gridTickerCallbackRef.current = null;
          if (callback) {
            app.ticker.remove(callback);
          }

          // Remove stage children and destroy stage
          if (stageRef.current) {
            if (objectsLayerRef.current) {
              objectsLayerRef.current.removeChildren();
            }
            app.stage.removeChild(stageRef.current);
            stageRef.current.destroy({ children: true });
            stageRef.current = null;
          }

          // Destroy app
          app.destroy();
          appRef.current = null;
        }

        // Remove canvas element if still present
        if (container.firstChild) {
          container.removeChild(container.firstChild);
        }
      };
    }, [ref, initPixi, onStagePointerDown, onStagePointerMove, onStagePointerUp, onWheelZoom]);

    return (
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          overflow: "hidden",
          position: "relative",
          userSelect: "none",
        }}
      />
    );
  }
);

TableCanvas.displayName = "TableCanvas";

export default TableCanvas;