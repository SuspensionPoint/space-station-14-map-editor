# Tool System

Tools handle user interaction on the canvas. They follow the strategy pattern, each tool implements the `ITool` interface and the active tool receives all mouse events.

## Active Grid Scope

All tools operate on the **active grid** only. Switching grids via the grid tab bar above the canvas changes which grid's tiles and entities the tools read and modify. This applies to all tool categories: tile tools, entity tools, infrastructure tools, and the select/clipboard tools. Copy/paste between grids is supported, pasting into a different grid assigns new entity UIDs parented to the target grid.

## ITool Interface

Defined in `src/tools/toolTypes.ts`:

```typescript
interface ITool {
  name: string;
  cursor: string;  // CSS cursor style

  onMouseDown(ctx: ToolContext, tileX: number, tileY: number, button: number): void;
  onMouseMove(ctx: ToolContext, tileX: number, tileY: number): void;
  onMouseUp(ctx: ToolContext, tileX: number, tileY: number): void;

  renderPreview?(ctx: CanvasRenderingContext2D, toolCtx: ToolContext,
    cursorTileX: number, cursorTileY: number): void;
  onWheel?(ctx: ToolContext, tileX: number, tileY: number, deltaY: number): boolean;
  getContextMenuItems?(ctx: ToolContext, tileX: number, tileY: number): ContextMenuItem[];
  deactivate?(): void;
}
```

### ToolContext

Provides everything a tool needs to read state and dispatch actions:

```typescript
interface ToolContext {
  state: EditorState;
  dispatch: (action: EditorAction) => void;
  camera: Camera;
  canvasW: number;
  canvasH: number;
  paletteItem: PaletteItem | null;
}
```

## Current Tools

### Basic Tools

### PaintTool (`src/tools/paintTool.ts`)
- **Shortcut**: B
- **Behavior**: Click or drag to paint the selected tile type. Collects all changes during a drag and dispatches a single `APPLY_COMMAND` on mouseUp.
- **Grid expansion**: Auto-expands the grid when painting outside bounds.
- **Preview**: Green outline at cursor position.

### EraseTool (`src/tools/eraseTool.ts`)
- **Shortcut**: E
- **Behavior**: Click or drag to set tiles to Space. Only affects tiles within the existing grid.
- **Preview**: Red outline with X mark at cursor position.

### EyedropperTool (`src/tools/eyedropperTool.ts`)
- **Shortcut**: I
- **Behavior**: Click to pick the topmost entity, decal, or tile at the cursor position. Entities take priority over decals, which take priority over tiles.
  - **Entity pick**: Sets the entity prototype as the active palette item and switches to EntityPlace tool.
  - **Decal pick**: Sets the decal prototype as the active palette item, applies the decal's color to placement settings, and switches to Paint tool.
  - **Tile pick** (fallback): Sets the tile type as the active palette item and switches to Paint tool.
  - **Scroll picker**: When 2+ items exist at a tile (entities + decals + tile), scroll wheel opens a popup list to cycle through all pickable items. Click to confirm selection. The popup shows `[E]` for entities, `[D]` for decals, and `[T]` for tiles.
  - Space tiles are not pickable.
- **Preview**: Yellow dashed outline at cursor position. Popup list when scroll picker is active.

### PanTool (`src/tools/panTool.ts`)
- **Shortcut**: H (also Space+drag from any tool)
- **Behavior**: Click and drag to pan the camera. Pan is also available by holding Space with any tool.
- **Cursor**: `grab` / `grabbing`.

### Shape Tools

### FillTool (`src/tools/fillTool.ts`)
- **Shortcut**: G
- **Behavior**: Click to flood-fill a contiguous region of same-type tiles with the selected tile. Uses 4-directional BFS with a 50,000 tile safety limit.
- **Preview**: Green filled square with outline at cursor.

### RectangleTool (`src/tools/rectangleTool.ts`)
- **Shortcut**: R
- **Behavior**: Click and drag to define a rectangle. On release, fills the rectangle with the selected tile. Shows a live preview with dimension label (e.g. "12x8") during drag.
- **Grid expansion**: Auto-expands grid to fit the rectangle (no padding).
- **Preview**: Blue dashed rectangle with semi-transparent fill and dimension label.

### LineTool (`src/tools/lineTool.ts`)
- **Shortcut**: L
- **Behavior**: Click to set start point, drag to endpoint. On release, fills tiles along the Bresenham line with the selected tile. Shows live preview with length label.
- **Grid expansion**: Auto-expands grid to fit the line (no padding).
- **Preview**: Yellow highlighted tiles along line path with length label.

### CircleTool (`src/tools/circleTool.ts`)
- **Shortcut**: C
- **Behavior**: Click to set center, drag to set radius. On release, fills a filled circle (Bresenham midpoint algorithm) with the selected tile. Shows live preview with radius label.
- **Grid expansion**: Auto-expands grid to fit the circle (no padding).
- **Preview**: Cyan highlighted tiles with radius label.

### SelectTool (`src/tools/selectTool.ts`)
- **Shortcut**: S
- **Behavior**: Click and drag to create a selection (marching ants border). Captures both tiles AND entities within selected tiles. Supports:
  - **Ctrl+C**, Copy tiles + entities to clipboard
  - **Ctrl+X**, Cut (copy + clear tiles to Space + remove entities)
  - **Ctrl+V**, Paste (enters paste mode, click to place). Pasted entities get new UIDs. Device links between them point at the copies, links to anything outside the copied set are dropped, and container contents are copied too.
  - **Delete/Backspace**, Clear tiles to Space + remove entities in selection
  - **Move**, Click inside an existing selection and drag to move the entire region (tiles + entities). Commits on mouse-up as a single undoable command. Entities keep their UIDs, so device links and container contents move with them.
- **Modifier keys during box select:**
  - **Shift+drag**: Add box contents to existing selection (green marquee). Build up complex non-rectangular shapes.
  - **Ctrl+drag**: Remove box contents from existing selection (red marquee). Carve out areas you don't want.
  - **No modifier**: Replace selection with box contents (blue marquee).
- **Phases**: idle → selecting → selected → moving/pasting
- **Preview**: Per-tile highlights on selected tiles. Marching ants (animated black/white dashed border) around bounding box. Color-coded marquee during drag. Move mode shows ghost tiles (blue) and entities (green). Paste mode shows semi-transparent ghost preview.
- **Clipboard**: Uses `src/state/clipboard.ts` singleton. Stores tiles (row-major) and entities (as relative offsets from selection origin).

### Entity Tools

### EntitySelectTool (`src/tools/entitySelectTool.ts`)
- **Shortcut**: V
- **Behavior**: Click to select topmost entity at tile. Click same tile again to cycle through stacked entities. Right-click to deselect all.
- **Layer visibility**: Selection respects the Layer Panel visibility toggles. Entities and decals on hidden layers cannot be clicked, box-selected, or picked via the scroll picker. The hover tooltip also only shows items on visible layers.
- **Stack picker**: Scroll wheel over a selected tile with 2+ entities/decals opens a floating picker popup. Scrolling immediately selects the highlighted item (no extra click needed, you can drag right away). The picker closes when the cursor leaves the tile, on right-click, or when you click to start a drag. Suppresses camera zoom while open.
- **Selection highlight**: Selected entities show a pulsing gold (#FFD700) pixel-perfect outline that traces the exact sprite contour. The outline is 2px thick, computed from the sprite's opaque pixels, and cached per prototype+direction.
- **Multi-select**: Shift+click toggles individual entities. Drag on empty space draws a box selection capturing all entities within.
  - **Shift+drag box**: Add entities in box to current selection (green marquee)
  - **Ctrl+drag box**: Remove entities in box from current selection (red marquee)
  - **No modifier drag**: Replace selection with entities in box (blue marquee)
- **Move**: Click and drag selected entities to move them as a group. All selected entities move together.
- **Rotate**: R key rotates all selected entities 90° clockwise. Dispatches remove+add command (undoable).
- **Delete**: Delete/Backspace removes all selected entities.
- **Preview**: Pulsing gold outline on selected entities. Dashed blue ghost during move drag. Box selection rectangle with semi-transparent fill. Yellow outline on picker-highlighted entity with floating popup list.

### EntityPlaceTool (`src/tools/entityPlaceTool.ts`)
- **Shortcut**: P
- **Behavior**: When an entity is selected in the Entity Palette, shows a ghost preview at cursor. Left-click places entity with auto-incrementing UID. R cycles through 4 rotations (0°, 90°, 180°, 270°) before placement.
- **Position**: Entities are placed at tile center (x+0.5, y+0.5).
- **Preview**: Green dashed outline with rotation arrow indicator. Entity name label below when zoomed in.
- **Auto-switch**: Selecting an entity in the palette auto-switches to this tool.

### Decal Tools

### Decal Palette (Decals tab in Palette Panel)
- Browse all decal prototypes grouped by tags (markings, overlays, flora, dirty, etc.)
- Search to filter by prototype ID
- Sprite thumbnail preview for each decal
- Selecting a decal sets it as the active palette item for placement

### Decal Placement
- When a decal is selected in the Decals palette tab, click on the canvas to place it
- **Placement controls** (in the palette panel below the decal list):
  - **Color**: Color picker with alpha (only for `defaultCustomColor` prototypes)
  - **Angle**: Degrees (0-360)
  - **Z-Index**: Rendering layer order (higher = on top)
  - **Snap**: Checkbox, snaps to tile center when enabled (default: on)
  - **Cleanable**: Checkbox, whether janitors can mop it (default: off)
- Ghost preview shows at cursor position before placement
- Each placement is a single undoable command

### Decal Selection & Editing (via Entity Select tool)
- The Entity Select tool (V) also handles decals:
  - **Click** on a decal to select it (cyan dashed highlight)
  - **Shift+click** to add/toggle decal in selection
  - **Box select** captures both entities and decals
  - **Ctrl+box** subtracts from selection
  - **Drag** selected decals to move them
  - **Delete/Backspace** removes selected decals
  - Mixed entity+decal selection supported, move/delete operates on both
- When decal(s) selected, the **Decal Info Panel** appears in the sidebar showing:
  - Prototype name + sprite preview
  - Color picker (if prototype supports custom color)
  - Angle, Z-Index, Cleanable editors
  - Property changes are undoable

### Entity Info Panel: Sprite State Selector

When a single entity is selected via the Entity Select tool, the Entity Info Panel shows a **Sprite State Selector** dropdown if the entity's RSI contains multiple states. Each option displays a 24x24 pixel thumbnail of the state sprite alongside the state name. Selecting a different state sets `spriteStateOverride` on the entity, which the renderer uses instead of the default state.

- **Appears**: Only when exactly one entity is selected and its RSI has more than one state
- **Thumbnails**: 24x24 pixel previews rendered from the RSI sprite sheet
- **Undo support**: State changes dispatch an `APPLY_COMMAND` (remove old entity + add updated entity), so they are fully undoable
- **Visual-only**: The override is not exported to YAML, it only affects how the entity appears in the editor

### Infrastructure Tools

### CableDrawTool (`src/tools/cableDrawTool.ts`)
- **Shortcut**: K
- **Behavior**: Drag to lay cable entities. One cable entity per tile, no rotation needed (SS14 auto-connects via NodeContainer). Right-click erases cable at tile.
- **Cable types**: CableHV (orange), CableMV (yellow), CableApcExtension (green), selected via Infrastructure Panel.
- **Preview**: Semi-transparent colored path during drag, colored outline at cursor.

### PipeDrawTool (`src/tools/pipeDrawTool.ts`)
- **Shortcut**: J
- **Behavior**: Drag to lay pipe path. On mouseUp, runs auto-fitting algorithm on new tiles + affected neighbors to determine correct prototypes (Straight/Bend/TJunction/Fourway) and rotations. Right-click erases pipe and refits neighbors.
- **Pipe types**: Supply (blue), Return (red), Disposal (brown), selected via Infrastructure Panel.
- **Auto-fitting**: Uses `src/algorithms/pipeFittings.ts`, counts 4-directional neighbors to determine fitting type. Merges with existing pipe entities of same network when computing.
- **Colors**: Supply/Return pipes get AtmosPipeColor component. Disposal pipes have no color.
- **Preview**: Semi-transparent colored path during drag.

### DeviceLinkTool (`src/tools/deviceLinkTool.ts`)
- **Shortcut**: D
- **Behavior**: Click an entity with DeviceList or DeviceLinkSource component to enter linking mode. Left-click targets to add links, right-click to remove. Click empty space or ESC to cancel.
- **Link types**: DeviceList adds target UID to `devices` array. DeviceLinkSource adds target to `linkedPorts` with default port mapping `[['Pressed', 'Toggle']]`.
- **Preview**: In idle, green outlines on valid source entities. In linking, pulsing outline on source, dashed line to cursor, cyan/orange outlines on linked targets, green on valid unlinked targets.
- **Auto-link**: EntityInfoPanel shows "Auto-link Room" button on AirAlarm and FireAlarm entities (detected via prototype, no manual DeviceList setup needed for newly placed alarms).
  - Uses **room-aware flood fill**, only links to devices in the same enclosed room
  - Room boundaries: walls (Occluder entities), doors, firelocks, and Space tiles stop the flood fill
  - **AirAlarm**: links to GasVentPump, GasVentScrubber, AirSensor found within the flooded room
  - **FireAlarm**: links to Firelock entities found on the room's boundary edges (walls/doors)
  - Safety cap: 500 tiles maximum flood fill to prevent runaway on open spaces

## Context Menu

A generic right-click context menu system (`src/components/ContextMenu.tsx`).

### ITool Extension

Tools can optionally implement `getContextMenuItems(ctx, tileX, tileY): ContextMenuItem[]` to provide context-dependent menu items on right-click. The `EditorCanvas` calls this method and renders the menu if items are returned.

### Current Consumers

- **SelectTool** (when region selected): Copy, Cut, Delete, Save as Prefab..., Paste (if clipboard has data)

## PrefabPlaceTool

**Shortcut:** None (activated from Prefabs panel)
**Purpose:** Stamp prefab templates onto the map.

- Ghost preview shows the prefab footprint at cursor position
- Left-click to stamp (single undoable APPLY_COMMAND)
- Stays in placement mode after stamping for multiple copies
- Escape or tool switch exits placement mode

## Tool Lifecycle

1. Tools are instantiated once in `App.tsx` as a static `TOOL_MAP` record.
2. The active tool is selected by `state.activeTool` (a `ToolType` string).
3. `EditorCanvas` passes mouse events to the active tool, converting screen coordinates to world tile coordinates.
4. Tools accumulate changes internally during drag operations for visual feedback.
5. On mouseUp, tools dispatch a single `APPLY_COMMAND` with all accumulated changes.
6. `deactivate()` is called when switching away from a tool, allowing cleanup.

## Adding a New Tool

1. Create `src/tools/myTool.ts` implementing `ITool`.
2. Add the tool name to `ToolType` in `src/types.ts`.
3. Register it in `TOOL_MAP` in `src/App.tsx`.
4. Add a button in `src/components/Toolbar.tsx`.
5. Add a keyboard shortcut in `src/hooks/useKeyboard.ts`.

### Tool implementation pattern

```typescript
export class MyTool implements ITool {
  name = 'myTool';
  cursor = 'crosshair';

  private active = false;
  private changes: TileChange[] = [];

  onMouseDown(ctx: ToolContext, tileX: number, tileY: number, button: number) {
    if (button !== 0) return;
    this.active = true;
    this.changes = [];
    // Start operation...
  }

  onMouseMove(ctx: ToolContext, tileX: number, tileY: number) {
    if (!this.active) return;
    // Continue operation, accumulate changes...
  }

  onMouseUp(ctx: ToolContext) {
    if (!this.active) return;
    this.active = false;
    if (this.changes.length > 0) {
      ctx.dispatch({
        type: 'APPLY_COMMAND',
        command: {
          label: 'My operation',
          tileChanges: this.changes,
          entityChanges: [],
        },
      });
    }
    this.changes = [];
  }

  deactivate() {
    this.active = false;
    this.changes = [];
  }
}
```

## Keyboard Shortcuts Summary

| Key | Tool |
|-----|------|
| B | Paint |
| E | Erase |
| I | Eyedropper |
| H | Pan |
| G | Fill |
| R | Rectangle |
| L | Line |
| C | Circle |
| S | Select |
| V | Entity Select |
| P | Entity Place |
| R | Rotate entity (when entity tool active) |
| D | Device Link |
| K | Cable Draw |
| J | Pipe Draw |
| Escape | Cancel linking (Device Link tool) |
| Space (hold) | Temporary pan |
| Ctrl+Z | Undo |
| Ctrl+Y / Ctrl+Shift+Z | Redo |
| Ctrl+C | Copy selection |
| Ctrl+X | Cut selection |
| Ctrl+V | Paste |
| Delete / Backspace | Delete selection |

## Files

| File | Purpose |
|------|---------|
| `src/tools/toolTypes.ts` | `ITool` and `ToolContext` interfaces |
| `src/tools/paintTool.ts` | Tile painting tool |
| `src/tools/eraseTool.ts` | Tile erasing tool |
| `src/tools/eyedropperTool.ts` | Tile picker tool |
| `src/tools/panTool.ts` | Camera panning tool |
| `src/tools/fillTool.ts` | Flood-fill tool |
| `src/tools/rectangleTool.ts` | Rectangle drawing tool |
| `src/tools/lineTool.ts` | Line drawing tool |
| `src/tools/circleTool.ts` | Circle drawing tool |
| `src/tools/selectTool.ts` | Selection + clipboard tool |
| `src/tools/entitySelectTool.ts` | Entity selection, move, rotate, delete |
| `src/tools/entityPlaceTool.ts` | Entity placement with ghost preview |
| `src/tools/cableDrawTool.ts` | Cable drawing tool |
| `src/tools/pipeDrawTool.ts` | Pipe drawing tool with auto-fitting |
| `src/tools/deviceLinkTool.ts` | Device link wiring tool |
| `src/algorithms/pipeFittings.ts` | Pipe auto-fitting algorithm |
| `src/algorithms/autoLink.ts` | Auto-link nearby compatible devices |
| `src/components/componentEditors/` | Per-component-type property editors |
| `src/state/clipboard.ts` | Clipboard data for copy/paste |
| `src/tools/prefabPlaceTool.ts` | Prefab stamp tool with ghost preview |
| `src/components/ContextMenu.tsx` | Generic right-click context menu |
| `src/components/PrefabPanel.tsx` | Prefab library panel |
