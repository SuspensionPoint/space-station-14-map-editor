import { describe, it, expect } from 'vitest';
import { exportMap } from '../mapExporter';
import { importMap, ImportedMap } from '../../import/mapImporter';

function makeMinimalMap(): ImportedMap {
  return {
    meta: { format: 6, postmapinit: false },
    tilemap: { 0: 'Space', 1: 'FloorSteel' },
    grid: {
      width: 16, height: 16, offsetX: 0, offsetY: 0,
      cells: Array(256).fill(null).map((_, i) => ({
        tileId: i === 0 ? 'FloorSteel' : 'Space'
      })),
    },
    entities: [
      {
        uid: 100,
        prototype: 'APCBasic',
        position: { x: 0.5, y: 0.5 },
        rotation: 0,
        components: [
          { type: 'Transform', pos: '0.5,0.5', parent: 1 },
          { type: 'Battery', startingCharge: 25000 },
        ],
      },
    ],
    gridUid: 1,
    mapUid: 0,
  };
}

describe('exportMap', () => {
  it('produces valid YAML that can be re-imported', () => {
    const original = makeMinimalMap();
    const yamlStr = exportMap(original);
    const reimported = importMap(yamlStr);
    expect(reimported.meta.format).toBe(6);
  });

  it('preserves tilemap', () => {
    const original = makeMinimalMap();
    const yamlStr = exportMap(original);
    const reimported = importMap(yamlStr);
    expect(reimported.tilemap[0]).toBe('Space');
    // FloorSteel should be present (index may differ)
    const hasFl = Object.values(reimported.tilemap).includes('FloorSteel');
    expect(hasFl).toBe(true);
  });

  it('preserves grid tiles', () => {
    const original = makeMinimalMap();
    const yamlStr = exportMap(original);
    const reimported = importMap(yamlStr);
    // First cell was FloorSteel
    expect(reimported.grid.cells[0].tileId).toBe('FloorSteel');
    // Rest are Space
    expect(reimported.grid.cells[1].tileId).toBe('Space');
  });

  it('preserves entities', () => {
    const original = makeMinimalMap();
    const yamlStr = exportMap(original);
    const reimported = importMap(yamlStr);
    const apc = reimported.entities.find(e => e.prototype === 'APCBasic');
    expect(apc).toBeDefined();
    expect(apc!.uid).toBe(100);
  });

  it('preserves entity components verbatim', () => {
    const original = makeMinimalMap();
    const yamlStr = exportMap(original);
    const reimported = importMap(yamlStr);
    const apc = reimported.entities.find(e => e.prototype === 'APCBasic');
    const battery = apc!.components.find((c: any) => c.type === 'Battery') as any;
    expect(battery.startingCharge).toBe(25000);
  });

  it('does not export spriteStateOverride to YAML', () => {
    const map = makeMinimalMap();
    // Add an entity with spriteStateOverride set
    map.entities.push({
      uid: 200,
      prototype: 'AirlockGlass',
      position: { x: 1.5, y: 1.5 },
      rotation: 0,
      components: [
        { type: 'Transform', pos: '1.5,1.5', parent: 1 },
      ],
      spriteStateOverride: 'open',
    });
    const yamlStr = exportMap(map);
    expect(yamlStr).not.toContain('spriteStateOverride');
  });

  it('exports editor-placed entity rotation with rad suffix', () => {
    const map = makeMinimalMap();
    // Add an editor-placed entity with rotation (no Transform in components)
    map.entities.push({
      uid: 300,
      prototype: 'APCBasic',
      position: { x: 2.5, y: 3.5 },
      rotation: 3 * Math.PI / 2,
      components: [],
    });
    const yamlStr = exportMap(map);
    // Should contain the rotation value with " rad" suffix
    expect(yamlStr).toContain(`${3 * Math.PI / 2} rad`);
    // The rot line must include "rad"
    const lines = yamlStr.split('\n');
    const rotLine = lines.find(l => l.includes('rot:') && l.includes(`${3 * Math.PI / 2}`));
    expect(rotLine).toBeDefined();
    expect(rotLine).toContain('rad');
  });

  it('skips all-Space chunks', () => {
    const map = makeMinimalMap();
    // Make all cells Space
    map.grid.cells = Array(256).fill(null).map(() => ({ tileId: 'Space' }));
    const yamlStr = exportMap(map);
    // Should not contain any chunks (or the chunks section should be empty)
    expect(yamlStr).not.toContain('tiles:');
  });

  describe('contained entity export', () => {
    it('exports imported contained entities with raw YAML lines', () => {
      const map = makeMinimalMap();
      map.entities.push({
        uid: 50, prototype: 'LockerBotanist',
        position: { x: 5.5, y: 3.5 }, rotation: 0,
        components: [
          { type: 'Transform', pos: '5.5,3.5', parent: 1 },
          { type: 'ContainerContainer', containers: { entity_storage: { ents: [51] } } },
        ],
      });
      map.containedEntities = {
        50: [{
          uid: 51, prototype: 'Crowbar',
          position: { x: 0, y: 0 }, rotation: 0,
          components: [{ type: 'Transform', parent: 50 }, { type: 'Physics', canCollide: false }],
        }],
      };
      map.entityRawComponents = {
        ...map.entityRawComponents,
        51: [
          '    - type: Transform',
          '      parent: 50',
          '    - type: Physics',
          '      canCollide: False',
        ],
      };

      const yaml = exportMap(map);
      expect(yaml).toContain('- proto: Crowbar');
      expect(yaml).toContain('  - uid: 51');
      expect(yaml).toContain('      parent: 50');
      expect(yaml).toContain('      canCollide: False');
    });

    it('exports newly added contained entities with synthesized components', () => {
      const map = makeMinimalMap();
      map.entities.push({
        uid: 50, prototype: 'LockerBotanist',
        position: { x: 5.5, y: 3.5 }, rotation: 0,
        components: [
          { type: 'Transform', pos: '5.5,3.5', parent: 1 },
          { type: 'ContainerContainer', containers: { entity_storage: { ents: [51] } } },
        ],
      });
      map.containedEntities = {
        50: [{
          uid: 51, prototype: 'Wrench',
          position: { x: 0, y: 0 }, rotation: 0,
          components: [
            { type: 'Transform', parent: 50 },
            { type: 'Physics', canCollide: false },
          ],
        }],
      };

      const yaml = exportMap(map);
      expect(yaml).toContain('- proto: Wrench');
      expect(yaml).toContain('  - uid: 51');
      expect(yaml).toContain('      parent: 50');
    });

    it('does not export contained entities when their container is absent', () => {
      const map = makeMinimalMap();
      map.containedEntities = {
        999: [{
          uid: 1000, prototype: 'Crowbar',
          position: { x: 0, y: 0 }, rotation: 0,
          components: [{ type: 'Transform', parent: 999 }],
        }],
      };

      const yaml = exportMap(map);
      expect(yaml).not.toContain('uid: 1000');
    });
  });

  describe('YAML document terminator (...)', () => {
    it('emits ... at the end when hasDocumentTerminator is true', () => {
      const map = makeMinimalMap();
      map.hasDocumentTerminator = true;
      const yamlStr = exportMap(map);
      // The output should end with "...\n"
      const lines = yamlStr.trimEnd().split('\n');
      expect(lines[lines.length - 1]).toBe('...');
    });

    it('does not emit ... when hasDocumentTerminator is false', () => {
      const map = makeMinimalMap();
      map.hasDocumentTerminator = false;
      const yamlStr = exportMap(map);
      const lines = yamlStr.trimEnd().split('\n');
      expect(lines[lines.length - 1]).not.toBe('...');
    });

    it('does not emit ... when hasDocumentTerminator is undefined', () => {
      const map = makeMinimalMap();
      delete map.hasDocumentTerminator;
      const yamlStr = exportMap(map);
      const lines = yamlStr.trimEnd().split('\n');
      expect(lines[lines.length - 1]).not.toBe('...');
    });

    it('places ... after all entities when new entities are added', () => {
      const map = makeMinimalMap();
      map.hasDocumentTerminator = true;

      // Add a new entity (simulating editor-added entity)
      map.entities.push({
        uid: 300,
        prototype: 'GasVentPump',
        position: { x: 2.5, y: 3.5 },
        rotation: 0,
        components: [
          { type: 'Transform', pos: '2.5,3.5', parent: 1 },
        ],
      });

      const yamlStr = exportMap(map);
      const lines = yamlStr.trimEnd().split('\n');

      // ... must be the very last line
      expect(lines[lines.length - 1]).toBe('...');

      // ... should only appear once in the output
      const terminatorCount = lines.filter(l => l.trim() === '...').length;
      expect(terminatorCount).toBe(1);

      // The new entity should appear BEFORE the terminator
      const terminatorIdx = lines.lastIndexOf('...');
      const entityLine = lines.findIndex(l => l.includes('uid: 300'));
      expect(entityLine).toBeGreaterThan(-1);
      expect(entityLine).toBeLessThan(terminatorIdx);
    });
  });

  describe('multi-grid export', () => {
    /**
     * Build a base64-encoded 16x16 chunk with 7 bytes per tile (format 7):
     *   int32 LE tileIndex + uint8 flags (0) + uint8 variant (0) + uint8 rotationMirroring (0).
     * tileAssignments maps flat tile index (0-255) to tilemap index.
     */
    function makeChunkBase64F7(tileAssignments: Record<number, number>): string {
      const BYTES_PER_TILE = 7;
      const buf = new Uint8Array(256 * BYTES_PER_TILE);
      const view = new DataView(buf.buffer);
      for (const [idx, tileIndex] of Object.entries(tileAssignments)) {
        const offset = Number(idx) * BYTES_PER_TILE;
        view.setInt32(offset, tileIndex, true);
      }
      let binary = '';
      for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
      return btoa(binary);
    }

    function buildTwoGridMap(): string {
      const chunkGrid2 = makeChunkBase64F7({ 0: 7 });
      const chunkGrid100 = makeChunkBase64F7({ 0: 3 });

      // Meta field order matches exporter emission order:
      // format, entityCount, postmapinit
      return `meta:
  format: 7
  entityCount: 5
  postmapinit: false
maps:
- 1
grids:
- 2
- 100
orphans: []
nullspace: []
tilemap:
  0: Space
  7: FloorSteel
  3: FloorWood
entities:
- proto: ""
  entities:
  - uid: 1
    components:
    - type: MetaData
      name: Map Entity
    - type: Transform
    - type: Map
      mapPaused: True
  - uid: 2
    components:
    - type: MetaData
      name: Main Station
    - type: Transform
      parent: 1
      pos: 0,0
    - type: MapGrid
      chunks:
        0,0:
          ind: 0,0
          tiles: ${chunkGrid2}
          version: 7
  - uid: 100
    components:
    - type: MetaData
      name: Shuttle
    - type: Transform
      parent: 1
      pos: 50.5,20.5
    - type: MapGrid
      chunks:
        0,0:
          ind: 0,0
          tiles: ${chunkGrid100}
          version: 7
- proto: WallSolid
  entities:
  - uid: 3
    components:
    - type: Transform
      pos: 5.5,3.5
      parent: 2
- proto: APCBasic
  entities:
  - uid: 4
    components:
    - type: Transform
      pos: 2.5,1.5
      parent: 100
`;
    }

    it('exports two grids with independent chunks', () => {
      const map = importMap(buildTwoGridMap());
      const exported = exportMap(map);
      const reimported = importMap(exported);
      expect(reimported.gridDataList!.length).toBe(2);
      expect(reimported.gridDataList![0].grid.cells[0].tileId).toBe('FloorSteel');
      expect(reimported.gridDataList![1].grid.cells[0].tileId).toBe('FloorWood');
    });

    it('exports entities with correct grid parenting', () => {
      const map = importMap(buildTwoGridMap());
      const exported = exportMap(map);
      const reimported = importMap(exported);
      expect(reimported.gridDataList![0].entities.length).toBe(1);
      expect(reimported.gridDataList![0].entities[0].uid).toBe(3);
      expect(reimported.gridDataList![1].entities.length).toBe(1);
      expect(reimported.gridDataList![1].entities[0].uid).toBe(4);
    });

    it('multi-grid roundtrip produces identical bytes', () => {
      const original = buildTwoGridMap();
      const map = importMap(original);
      const exported = exportMap(map);
      expect(exported).toBe(original);
    });
  });

  describe('dangling device reference cleanup', () => {
    it('strips DeviceList references to non-existent UIDs', () => {
      const map = makeMinimalMap();
      map.entities.push({
        uid: 200,
        prototype: 'AirAlarm',
        position: { x: 1.5, y: 1.5 },
        rotation: 0,
        components: [
          { type: 'Transform', pos: '1.5,1.5', parent: 1 },
          { type: 'DeviceList', devices: [300, 999] }, // 300 exists, 999 doesn't
        ],
      });
      map.entities.push({
        uid: 300,
        prototype: 'GasVentPump',
        position: { x: 2.5, y: 2.5 },
        rotation: 0,
        components: [{ type: 'Transform', pos: '2.5,2.5', parent: 1 }],
      });

      const exported = exportMap(map);
      const reimported = importMap(exported);
      const alarm = reimported.entities.find(e => e.prototype === 'AirAlarm');
      expect(alarm).toBeDefined();
      const dl = alarm!.components.find(c => (c as any).type === 'DeviceList') as any;
      expect(dl.devices).toEqual([300]);
      expect(dl.devices).not.toContain(999);
    });

    it('strips DeviceLinkSource references to non-existent UIDs', () => {
      const map = makeMinimalMap();
      map.entities.push({
        uid: 200,
        prototype: 'SignalButton',
        position: { x: 1.5, y: 1.5 },
        rotation: 0,
        components: [
          { type: 'Transform', pos: '1.5,1.5', parent: 1 },
          { type: 'DeviceLinkSource', linkedPorts: { '300': [['Pressed', 'Toggle']], '888': [['Pressed', 'Toggle']] } },
        ],
      });
      map.entities.push({
        uid: 300,
        prototype: 'Airlock',
        position: { x: 2.5, y: 2.5 },
        rotation: 0,
        components: [{ type: 'Transform', pos: '2.5,2.5', parent: 1 }],
      });

      const exported = exportMap(map);
      const reimported = importMap(exported);
      const button = reimported.entities.find(e => e.prototype === 'SignalButton');
      expect(button).toBeDefined();
      const dls = button!.components.find(c => (c as any).type === 'DeviceLinkSource') as any;
      expect(dls.linkedPorts).toHaveProperty('300');
      expect(dls.linkedPorts).not.toHaveProperty('888');
    });

    it('strips DeviceNetwork.deviceLists references to non-existent UIDs', () => {
      const map = makeMinimalMap();
      map.entities.push({
        uid: 200,
        prototype: 'GasVentPump',
        position: { x: 1.5, y: 1.5 },
        rotation: 0,
        components: [
          { type: 'Transform', pos: '1.5,1.5', parent: 1 },
          { type: 'DeviceNetwork', deviceLists: [100, 777] }, // 100 exists (APCBasic), 777 doesn't
        ],
      });

      const exported = exportMap(map);
      const reimported = importMap(exported);
      const vent = reimported.entities.find(e => e.prototype === 'GasVentPump');
      expect(vent).toBeDefined();
      const dn = vent!.components.find(c => (c as any).type === 'DeviceNetwork') as any;
      expect(dn.deviceLists).toEqual([100]);
      expect(dn.deviceLists).not.toContain(777);
    });
  });

  describe('tile variant sanitization', () => {
    it('exports all tile variants as 0 to prevent MapRenderer crashes', () => {
      const map = makeMinimalMap();
      // Even a "legitimate" variant gets reset to 0 on export, because the editor
      // has no variant editing capability and stale variants from the paint tool bug
      // can crash SS14's MapRenderer. The game re-randomizes variants at load time.
      map.grid.cells[0] = { tileId: 'FloorSteel', variant: 3 };
      map.grid.cells[1] = { tileId: 'FloorSteel', variant: 5 };

      const exported = exportMap(map);
      const reimported = importMap(exported);

      expect(reimported.grid.cells[0].tileId).toBe('FloorSteel');
      expect(reimported.grid.cells[0].variant ?? 0).toBe(0);
      expect(reimported.grid.cells[1].tileId).toBe('FloorSteel');
      expect(reimported.grid.cells[1].variant ?? 0).toBe(0);
    });

    it('stale variant from paint-over does not survive export', () => {
      const map = makeMinimalMap();
      map.tilemap = { 0: 'Space', 1: 'FloorSteel', 2: 'Plating' };
      // Simulate stale variant: Plating cell with variant 5 (Plating only has 1 variant)
      map.grid.cells[0] = { tileId: 'Plating', variant: 5 };

      const exported = exportMap(map);
      const reimported = importMap(exported);

      expect(reimported.grid.cells[0].tileId).toBe('Plating');
      expect(reimported.grid.cells[0].variant ?? 0).toBe(0);
    });
  });

  describe('format 7 top-level sections', () => {
    function makeGridFileMap(): ImportedMap {
      const map = makeMinimalMap();
      map.meta = { format: 7, postmapinit: false, category: 'Grid' };
      map.maps = [];
      map.grids = [1];
      map.orphans = [1];
      return map;
    }

    it('writes empty lists as [] rather than a bare key', () => {
      const exported = exportMap(makeGridFileMap());
      expect(exported).toMatch(/^maps: \[\]$/m);
      expect(exported).not.toMatch(/^maps:$/m);
    });

    it('preserves orphans so standalone grid files keep their root grid', () => {
      const reimported = importMap(exportMap(makeGridFileMap()));
      expect(reimported.maps).toEqual([]);
      expect(reimported.orphans).toEqual([1]);
    });

    it('preserves nullspace and drops UIDs of deleted entities', () => {
      const map = makeGridFileMap();
      map.nullspace = [100, 999]; // 999 no longer exists
      const reimported = importMap(exportMap(map));
      expect(reimported.nullspace).toEqual([100]);
    });

    it('roundtrips orphans and nullspace from a file', () => {
      const original = importMap(exportMap({ ...makeGridFileMap(), nullspace: [100] }));
      const again = importMap(exportMap(original));
      expect(again.orphans).toEqual([1]);
      expect(again.nullspace).toEqual([100]);
    });
  });
});
