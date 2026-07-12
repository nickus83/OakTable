import * as PIXI from "pixi.js";

export type TableObjectType = "image" | "note";

export interface TableObjectOptions {
  id: string;
  type: TableObjectType;
  x: number;
  y: number;
  content?: string;
  width?: number;
  height?: number;
  rotation?: number;
  scale?: number;
  fileId?: string;
}

export type DragCallback = (id: string, x: number, y: number) => void;

/**
 * Represents a draggable object on the virtual table.
 * Wraps a PIXI.Container with sprite/text and handles dragging.
 */
export class TableObject {
  private _container: PIXI.Container;
  private _sprite: PIXI.Sprite | null = null;
  private _noteGroup: PIXI.Container | null = null;

  public readonly id: string;
  public readonly type: TableObjectType;
  public content: string;

  private _x: number;
  private _y: number;
  private _rotation: number;
  private _scale: number;

  private width: number;
  private height: number;

  private onDragCallback: DragCallback | null = null;

  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private containerStartX = 0;
  private containerStartY = 0;

  // Store original options for fileId access
  private _options: TableObjectOptions;

  constructor(options: TableObjectOptions, app: PIXI.Application) {
    this.id = options.id;
    this.type = options.type;
    this._x = options.x;
    this._y = options.y;
    this.content = options.content ?? "";
    this._rotation = options.rotation ?? 0;
    this._scale = options.scale ?? 1;
    this.width = options.width ?? 200;
    this.height = options.height ?? 150;
    this._options = options;

    this._container = new PIXI.Container();
    this._container.x = this._x;
    this._container.y = this._y;
    this._container.rotation = (this._rotation * Math.PI) / 180;
    this._container.scale.set(this._scale);
    this._container.eventMode = "static";
    this._container.cursor = "grab";

    // Interactive pointer events
    this._container.on("pointerdown", this.onPointerDown.bind(this));
    this._container.on("pointermove", this.onPointerMove.bind(this));
    this._container.on("pointerup", this.onPointerUp.bind(this));
    this._container.on("pointerupoutside", this.onPointerUp.bind(this));

    // Create visual based on type
    if (this.type === "image") {
      this.createImageSprite(app);
    } else {
      this.createNote();
    }

    this.addBorder();
  }

  /**
   * Create image sprite — try loading from content URL, otherwise show placeholder.
   */
  private createImageSprite(app: PIXI.Application): void {
    if (this.content) {
      PIXI.Assets.load(this.content).then((texture) => {
        this._sprite = new PIXI.Sprite(texture);
        const aspect = texture.width / texture.height;
        if (aspect > 1) {
          this._sprite.width = this.width;
          this._sprite.height = this.width / aspect;
        } else {
          this._sprite.height = this.height;
          this._sprite.width = this.height * aspect;
        }
        this._sprite.anchor.set(0.5);
        this._container.removeChildren();
        this._container.addChild(this._sprite);
        this.addBorder();
      }).catch(() => {
        this.createPlaceholderImage();
      });
    } else {
      this.createPlaceholderImage();
    }
  }

  /**
   * Create a placeholder image when no content or loading failed.
   */
  private createPlaceholderImage(): void {
    const graphics = new PIXI.Graphics();
    graphics.beginFill(0x888888, 0.3);
    graphics.drawRoundedRect(0, 0, this.width, this.height, 4);
    graphics.endFill();
    graphics.lineStyle(2, 0x888888, 0.5);
    graphics.drawRoundedRect(0, 0, this.width, this.height, 4);

    const centerX = this.width / 2;
    const centerY = this.height / 2;
    graphics.lineStyle(2, 0x888888, 0.5);
    graphics.moveTo(centerX - 15, centerY);
    graphics.lineTo(centerX + 15, centerY);
    graphics.moveTo(centerX, centerY - 15);
    graphics.lineTo(centerX, centerY + 15);

    this._sprite = null;
    this._container.removeChildren();
    this._container.addChild(graphics);

    const text = new PIXI.Text("Image", {
      fontSize: 14,
      fill: 0x888888,
      fontWeight: "bold",
      fontFamily: "sans-serif",
    });
    text.anchor.set(0.5);
    text.x = centerX;
    text.y = centerY + 30;
    this._container.addChild(text);
  }

  /**
   * Create a text note with a colored background.
   */
  private createNote(): void {
    this._noteGroup = new PIXI.Container();

    const graphics = new PIXI.Graphics();
    graphics.beginFill(0xFFFACD, 0.95);
    graphics.drawRoundedRect(0, 0, this.width, this.height, 4);
    graphics.endFill();
    graphics.lineStyle(2, 0xAAAA00, 0.8);
    graphics.drawRoundedRect(0, 0, this.width, this.height, 4);
    this._noteGroup!.addChild(graphics);

    const label = new PIXI.Text("Note", {
      fontSize: 11,
      fill: 0x888800,
      fontWeight: "bold",
      fontFamily: "sans-serif",
    });
    label.x = 8;
    label.y = 6;
    this._noteGroup!.addChild(label);

    const divider = new PIXI.Graphics();
    divider.lineStyle(1, 0xCCCCCC);
    divider.moveTo(5, 24);
    divider.lineTo(this.width - 5, 24);
    this._noteGroup!.addChild(divider);

    const displayText = this.content || "Double-click to edit...";
    const text = new PIXI.Text(displayText, {
      fontSize: 14,
      fill: 0x333333,
      wordWrap: true,
      wordWrapWidth: this.width - 16,
      lineHeight: 20,
      padding: 8,
      fontFamily: "sans-serif",
    });
    text.x = 0;
    text.y = 28;
    this._noteGroup!.addChild(text);

    this._container.removeChildren();
    this._container.addChild(this._noteGroup);
  }

  /**
   * Add a semi-transparent border around the object.
   */
  private addBorder(): void {
    const border = new PIXI.Graphics();
    border.lineStyle(2, 0x666666, 0.4);
    border.drawRoundedRect(-3, -3, this.width + 6, this.height + 6, 6);
    border.interactive = false;
    border.eventMode = "none";
    this._container.addChild(border);
  }

  // ==================== Dragging ====================

  private onPointerDown(e: PIXI.FederatedPointerEvent): void {
    this.isDragging = true;
    this.dragStartX = e.global.x;
    this.dragStartY = e.global.y;
    this.containerStartX = this._container.x;
    this.containerStartY = this._container.y;
    this._container.cursor = "grabbing";

    // Bring to front
    const parent = this._container.parent;
    if (parent) {
      const idx = parent.getChildIndex(this._container);
      parent.removeChild(this._container);
      parent.addChild(this._container);
    }
  }

  private onPointerMove(e: PIXI.FederatedPointerEvent): void {
    if (!this.isDragging) return;

    const dx = e.global.x - this.dragStartX;
    const dy = e.global.y - this.dragStartY;

    this._container.x = this.containerStartX + dx;
    this._container.y = this.containerStartY + dy;

    if (this.onDragCallback) {
      this.onDragCallback(this.id, this._container.x, this._container.y);
    }
  }

  private onPointerUp(_e: PIXI.FederatedPointerEvent): void {
    this.isDragging = false;
    this._container.cursor = "grab";
  }

  // ==================== Public API ====================

  /**
   * Get the PIXI container for adding to the stage.
   */
  get container(): PIXI.Container {
    return this._container;
  }

  /**
   * Set position and update internal state.
   */
  setPosition(x: number, y: number): void {
    this._x = x;
    this._y = y;
    this._container.x = x;
    this._container.y = y;
  }

  /**
   * Get current position.
   */
  getPosition(): { x: number; y: number } {
    return { x: this._container.x, y: this._container.y };
  }

  /**
   * Set rotation in degrees.
   */
  setRotation(angle: number): void {
    this._rotation = angle;
    this._container.rotation = (angle * Math.PI) / 180;
  }

  /**
   * Get current rotation in degrees.
   */
  getRotation(): number {
    return this._rotation;
  }

  /**
   * Set scale factor.
   */
  setScale(scale: number): void {
    this._scale = scale;
    this._container.scale.set(scale);
  }

  /**
   * Get current scale.
   */
  getScale(): number {
    return this._scale;
  }

  /**
   * Register a drag callback.
   */
  onDrag(callback: DragCallback | null): void {
    this.onDragCallback = callback;
  }

  /**
   * Convert world coordinates to screen coordinates.
   */
  worldToScreen(worldX: number, worldY: number, app: PIXI.Application): { x: number; y: number } {
    const view = app.renderer.view as HTMLCanvasElement;
    const rect = view.getBoundingClientRect();
    const screenX = (worldX - app.stage.x) / app.stage.scale.x;
    const screenY = (worldY - app.stage.y) / app.stage.scale.y;
    return { x: screenX + rect.left, y: screenY + rect.top };
  }

  /**
   * Rotate the object with mouse wheel.
   */
  rotateBy(delta: number): void {
    const degrees = delta * 0.5;
    this.setRotation(this._rotation + degrees);
  }

  /**
   * Update note text content.
   */
  updateNoteText(newText: string): void {
    this.content = newText;
    this._container.removeChildren();
    this.createNote();
    this.addBorder();
  }

  /**
   * Replace the current sprite/graphics with a new texture.
   * Used when a file is received P2P and we need to update the placeholder.
   * The old sprite/graphics is destroyed before adding the new one.
   * The sprite is positioned to match the placeholder's coordinate system (top-left anchored).
   */
  updateTexture(texture: PIXI.Texture): void {
    console.log(`[TableObject] updateTexture called for id=${this.id}, texWidth=${texture.width}, texHeight=${texture.height}`);
    
    // Destroy old sprite or graphics (not the container)
    const children = this._container.children;
    for (const child of children) {
      if (child instanceof PIXI.Sprite || child instanceof PIXI.Graphics) {
        child.destroy({ children: false });
      }
    }

    // Remove all old children
    this._container.removeChildren();

    // Create new sprite with the provided texture
    this._sprite = new PIXI.Sprite(texture);
    
    // Calculate display size based on texture aspect ratio
    // Use the same logic as createImageSprite to maintain consistency
    const aspect = texture.width / texture.height;
    if (aspect > 1) {
      this._sprite.width = this.width;
      this._sprite.height = this.width / aspect;
    } else {
      this._sprite.height = this.height;
      this._sprite.width = this.height * aspect;
    }
    
    // Anchor center to match how placeholders are positioned
    this._sprite.anchor.set(0.5);
    // Position sprite so its center matches the container's expected position
    this._sprite.x = this.width / 2;
    this._sprite.y = this.height / 2;
    
    this._container.addChild(this._sprite);

    // Re-add border — recreate border with proper size
    this.addBorder();
    
    console.log(`[TableObject] ✓ Texture applied: id=${this.id}, spriteWidth=${this._sprite.width}, spriteHeight=${this._sprite.height}`);
  }

  /**
   * Get the fileId associated with this object (for texture matching).
   */
  get fileId(): string | undefined {
    return this._options?.fileId;
  }

  /**
   * Check if this object is waiting for a file (has fileId but no valid image content).
   */
  isWaitingForFile(): boolean {
    return this.type === "image" && !!this._options?.fileId && !this.content;
  }

  /**
   * Clean up PIXI resources.
   */
  destroy(): void {
    this._container.off("pointerdown", this.onPointerDown);
    this._container.off("pointermove", this.onPointerMove);
    this._container.off("pointerup", this.onPointerUp);
    this._container.off("pointerupoutside", this.onPointerUp);

    this._container.destroy({ children: true, texture: false });
  }
}