import type { TileCell } from '../types';
import type { ImportedEntity } from '../import/mapImporter';

/** Entity stored relative to selection origin (dx, dy offsets from originX, originY). */
export interface ClipboardEntity {
  /** UID of the entity this was taken from */
  uid?: number;
  /** Offset from clipboard origin */
  dx: number;
  dy: number;
  prototype: string;
  rotation: number;
  components: Record<string, unknown>[];
  spriteStateOverride?: string;
}

/** Decal stored relative to selection origin. */
export interface ClipboardDecal {
  dx: number;
  dy: number;
  prototypeId: string;
  color: string | null;
  angle: number;
  zIndex: number;
  cleanable: boolean;
}

export interface ClipboardData {
  width: number;
  height: number;
  tiles: (TileCell | null)[];  // row-major, null = empty/space
  entities: ClipboardEntity[];
  decals?: ClipboardDecal[];
  originX: number; // world coords of top-left when copied
  originY: number;
}

let clipboard: ClipboardData | null = null;

export function getClipboard(): ClipboardData | null {
  return clipboard;
}

export function setClipboard(data: ClipboardData): void {
  clipboard = data;
}
