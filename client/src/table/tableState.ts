import { TableObject, TableObjectOptions } from "./TableObject";
import type { Application } from "pixi.js";

type OnChangeCallback = (objects: Map<string, TableObject>) => void;

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