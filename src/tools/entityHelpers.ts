import type { ContainedEntityChange } from '../types';
import type { ImportedEntity } from '../import/mapImporter';

const TWO_PI = 2 * Math.PI;

/**
 * Normalize a rotation angle to [0, 2π).
 * Snaps to nearest 90° increment (0, π/2, π, 3π/2) if within floating-point tolerance.
 */
export function normalizeRotation(radians: number): number {
  let norm = ((radians % TWO_PI) + TWO_PI) % TWO_PI;
  // Snap to nearest 90° increment to avoid floating-point drift
  const HALF_PI = Math.PI / 2;
  const nearest = Math.round(norm / HALF_PI) * HALF_PI;
  if (Math.abs(norm - nearest) < 1e-9) {
    norm = nearest >= TWO_PI ? 0 : nearest;
  }
  return norm;
}

/**
 * Build a components array containing a Transform component for a newly-placed entity.
 * SS14 requires Transform with pos, parent (grid UID), and optionally rot.
 */
export function buildTransformComponent(
  position: { x: number; y: number },
  rotation: number,
  gridUid: number,
): Record<string, unknown>[] {
  const transform: Record<string, unknown> = {
    type: 'Transform',
    pos: `${position.x},${position.y}`,
    parent: gridUid,
  };
  if (rotation !== 0) {
    transform.rot = `${rotation} rad`;
  }
  return [transform];
}

/**
 * Update the Transform component's `pos` field in a components array.
 * Returns a new array with the Transform updated (or unchanged if none exists).
 */
/**
 * Update the Transform component's `rot` field in a components array.
 * Returns a new array with the Transform updated (or unchanged if none exists).
 */
export function updateTransformRot(
  components: Record<string, unknown>[],
  newRot: number,
): Record<string, unknown>[] {
  return components.map(c => {
    if (c.type === 'Transform') {
      const updated = { ...c };
      if (newRot !== 0) {
        updated.rot = `${newRot} rad`;
      } else {
        delete updated.rot;
      }
      return updated;
    }
    return c;
  });
}

/**
 * Update the Transform component's `pos` field in a components array.
 * Returns a new array with the Transform updated (or unchanged if none exists).
 */
export function updateTransformPos(
  components: Record<string, unknown>[],
  newPos: { x: number; y: number },
): Record<string, unknown>[] {
  return components.map(c => {
    if (c.type === 'Transform') {
      return { ...c, pos: `${newPos.x},${newPos.y}` };
    }
    return c;
  });
}

/**
 * Clone a components array and update the Transform pos in a single pass.
 * Avoids the double-iteration of components.map(c => ({...c})) + updateTransformPos().
 */
export function cloneComponentsWithPos(
  components: Record<string, unknown>[],
  newPos: { x: number; y: number },
): Record<string, unknown>[] {
  return components.map(c => {
    if (c.type === 'Transform') {
      return { ...c, pos: `${newPos.x},${newPos.y}` };
    }
    return { ...c };
  });
}

/**
 * Clone a components array and update both Transform pos and rot in a single pass.
 */
export function cloneComponentsWithPosRot(
  components: Record<string, unknown>[],
  newPos: { x: number; y: number },
  newRot: number,
): Record<string, unknown>[] {
  return components.map(c => {
    if (c.type === 'Transform') {
      const updated: Record<string, unknown> = { ...c, pos: `${newPos.x},${newPos.y}` };
      if (newRot !== 0) {
        updated.rot = `${newRot} rad`;
      } else {
        delete updated.rot;
      }
      return updated;
    }
    return { ...c };
  });
}

/**
 * Point the UIDs a copied entity's components hold at the copies. `uidMap` goes from
 * each copied entity's old UID to its new one. A reference to an entity that was not
 * copied is dropped.
 */
export function remapEntityReferences(
  components: Record<string, unknown>[],
  uidMap: Map<number, number>,
): Record<string, unknown>[] {
  const remapList = (uids: unknown[]) => uids
    .filter(uid => uidMap.has(Number(uid)))
    .map(uid => uidMap.get(Number(uid))!);

  return components.map(c => {
    if (c.type === 'DeviceList' && Array.isArray(c.devices)) {
      return { ...c, devices: remapList(c.devices) };
    }
    if (c.type === 'DeviceNetwork' && Array.isArray(c.deviceLists)) {
      return { ...c, deviceLists: remapList(c.deviceLists) };
    }
    if (c.type === 'DeviceLinkSource' && c.linkedPorts && typeof c.linkedPorts === 'object') {
      const linkedPorts: Record<string, unknown> = {};
      for (const [uid, ports] of Object.entries(c.linkedPorts as Record<string, unknown>)) {
        const mapped = uidMap.get(Number(uid));
        if (mapped !== undefined) linkedPorts[mapped] = ports;
      }
      return { ...c, linkedPorts };
    }
    if (c.type === 'ContainerContainer' && c.containers && typeof c.containers === 'object') {
      const containers: Record<string, unknown> = {};
      for (const [name, container] of Object.entries(c.containers as Record<string, any>)) {
        if (!container || typeof container !== 'object') {
          containers[name] = container;
          continue;
        }
        const mapped = { ...container };
        if (Array.isArray(container.ents)) mapped.ents = remapList(container.ents);
        if (container.ent != null) mapped.ent = uidMap.get(Number(container.ent)) ?? null;
        containers[name] = mapped;
      }
      return { ...c, containers };
    }
    if (c.type === 'Transform' && uidMap.has(Number(c.parent))) {
      return { ...c, parent: uidMap.get(Number(c.parent)) };
    }
    return c;
  });
}

/** What the given entities contain, to any depth, keyed by the UID of the container. */
export function collectContained(
  containedEntities: Record<number, ImportedEntity[]>,
  uids: number[],
): Record<number, ImportedEntity[]> {
  const result: Record<number, ImportedEntity[]> = {};
  const pending = [...uids];
  for (let i = 0; i < pending.length; i++) {
    const children = containedEntities[pending[i]];
    if (!children || children.length === 0) continue;
    result[pending[i]] = children;
    for (const child of children) pending.push(child.uid);
  }
  return result;
}

/** An entity about to be copied. `sourceUid` is the entity it was copied from, when known. */
export interface CopySource {
  sourceUid?: number;
  entity: Omit<ImportedEntity, 'uid'>;
}

/**
 * Give copied entities fresh UIDs starting at `firstUid`, copy what they contain, and
 * point the references between them at the copies.
 */
export function instantiateCopies(
  sources: CopySource[],
  contained: Record<number, ImportedEntity[]> | undefined,
  firstUid: number,
): { entities: ImportedEntity[]; containedChanges: ContainedEntityChange[] } {
  let nextUid = firstUid;
  const uidMap = new Map<number, number>();
  const uids = sources.map(source => {
    const uid = nextUid++;
    if (source.sourceUid !== undefined) uidMap.set(source.sourceUid, uid);
    return uid;
  });

  const children: { parentUid: number; entity: ImportedEntity }[] = [];
  const pending = [...uidMap.keys()];
  for (let i = 0; i < pending.length; i++) {
    for (const child of contained?.[pending[i]] ?? []) {
      uidMap.set(child.uid, nextUid++);
      children.push({ parentUid: pending[i], entity: child });
      pending.push(child.uid);
    }
  }

  const entities = sources.map((source, i) => ({
    ...source.entity,
    uid: uids[i],
    components: remapEntityReferences(source.entity.components, uidMap),
  }));
  const containedChanges = children.map(({ parentUid, entity }) => ({
    action: 'add' as const,
    parentUid: uidMap.get(parentUid)!,
    entity: {
      ...entity,
      uid: uidMap.get(entity.uid)!,
      components: remapEntityReferences(entity.components, uidMap),
    },
  }));
  return { entities, containedChanges };
}
