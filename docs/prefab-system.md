# Prefab System

## Overview

Prefabs are reusable map regions saved as `.prefab.json` files. They capture tiles, entities, raw YAML component data, and device links from a rectangular selection, and can be stamped onto any map with full SS14 export correctness.

## File Format

A `.prefab.json` file containing a self-contained room/region:

```json
{
  "name": "Surgery Room",
  "width": 7,
  "height": 5,
  "tiles": [
    { "dx": 0, "dy": 0, "tileId": "FloorWhite" },
    { "dx": 1, "dy": 0, "tileId": "FloorWhite" }
  ],
  "entities": [
    {
      "uid": 412,
      "dx": 2, "dy": 1,
      "prototype": "OperatingTable",
      "rotation": 0,
      "components": [{ "type": "Transform" }],
      "rawYamlLines": ["    - type: Transform"]
    }
  ],
  "contained": {
    "412": [{ "uid": 413, "prototype": "Scalpel", "position": { "x": 0, "y": 0 }, "rotation": 0, "components": [] }]
  },
  "deviceLinks": [
    { "sourceIdx": 0, "targetIdx": 1, "port": "Pressed", "sink": "Toggle" }
  ]
}
```

Key design points:

- **Sprite state overrides**, `PrefabEntity` includes an optional `spriteStateOverride?: string` field. If present, it is serialized into the `.prefab.json` file and restored on placement, preserving the visual state chosen via the Sprite State Selector.
- **Sparse tiles**, Only non-Space tiles are stored. Space tiles are omitted.
- **Relative offsets**, All `dx`/`dy` values are integer tile offsets from the prefab's top-left corner. Entity positions are stored as `Math.floor(position) - minBound`.
- **Raw YAML lines**, `rawYamlLines` on entities carry verbatim YAML for byte-exact export roundtrip. On placement, these are stored in `entityRawComponents` so the exporter emits them unchanged.
- **Index-based device links**, Links reference entities by array index, not UIDs. New UIDs are assigned when the prefab is stamped.
- **Source UIDs**, `uid` is the UID each entity had in the map the prefab was saved from. On placement it is used to point UIDs inside components (`DeviceList.devices`, `DeviceNetwork.deviceLists`, `DeviceLinkSource.linkedPorts`, container `ents`) at the placed entities. References to anything outside the prefab are dropped. Files saved before this field existed have every such reference dropped.
- **Container contents**, `contained` holds what the prefab's entities contain, keyed by the container's `uid`, to any depth. Contents are placed with fresh UIDs inside the placed containers.
- **Device link serialization**, Uses `DeviceLinkSource.linkedPorts` (not `DeviceList.devices`) to capture port/sink pairs. Each entry in `linkedPorts` maps a target UID to an array of `[port, sink]` pairs.
- **Entity position on placement**, When stamped, entity world position is `placeX + dx + 0.5, placeY + dy + 0.5` (center of tile).

### Validation

`parsePrefabJson()` validates that all 6 required fields (`name`, `width`, `height`, `tiles`, `entities`, `deviceLinks`) are present and correctly typed. Invalid files throw descriptive errors.

## Creating a Prefab

1. Select a region with the Select Tool (S)
2. Right-click → "Save as Prefab..."
3. Enter a name in the prompt dialog
4. File downloads as `name.prefab.json`

## Placing a Prefab

1. Open the **Prefabs** tab in the palette panel
2. The panel auto-loads all `.prefab.json` files from `public/prefabs/` on startup
3. Click a prefab entry to enter placement mode
4. Ghost preview follows cursor showing footprint, tiles, and entity positions
5. Click to stamp, creates a single undoable command
6. Stay in placement mode to stamp multiple copies
7. Switch tools or Escape to exit

You can also import individual files via the **+** button, and hit **↻** to refresh after adding new files to the directory.

## Directory Structure

Save prefabs under `public/prefabs/` in the map_creator project. Subdirectories become collapsible folder groups in the panel:

```
public/prefabs/
  medical/
    surgery-room.prefab.json
    chemistry-lab.prefab.json
  engineering/
    smes-room.prefab.json
    atmos-setup.prefab.json
  common-rooms.prefab.json
```

The dev server provides a `/__api/prefabs` endpoint that lists all `.prefab.json` files recursively. The panel fetches this on mount and on refresh.

## Conflict Handling

Stamping overwrites the footprint: tiles are replaced, existing entities in the footprint are removed, then prefab entities are placed with fresh UIDs.

## Export Correctness

Prefab entities carry `rawYamlLines` which are stored in `entityRawComponents` on placement. The exporter (`src/export/mapExporter.ts`) emits these lines verbatim, producing valid SS14 YAML identical to entities imported from a real map file.

## Source Files

| File | Purpose |
|------|---------|
| `src/prefab/prefabTypes.ts` | `PrefabData`, `PrefabEntity`, `PrefabDeviceLink` interfaces |
| `src/prefab/prefabSerializer.ts` | Capture editor region → `PrefabData` |
| `src/prefab/prefabPlacer.ts` | Stamp `PrefabData` → `Command` for dispatch |
| `src/prefab/prefabIO.ts` | JSON parse/stringify, browser file download |
| `src/tools/prefabPlaceTool.ts` | Tool for cursor-following ghost preview + click-to-stamp |
| `src/components/PrefabPanel.tsx` | Library panel with file import and directory browsing |
| `src/components/ContextMenu.tsx` | Generic right-click context menu |
