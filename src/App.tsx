import React, { useReducer, useCallback, useRef, useEffect, useState, useMemo } from 'react';
import type { ToolType, PaletteItem } from './types';
import { editorReducer } from './state/editorReducer';
import { createInitialState, ensureGridContainsBounds } from './state/editorState';
import type { ITool } from './tools/toolTypes';
import { PaintTool } from './tools/paintTool';
import { EraseTool } from './tools/eraseTool';
import { EyedropperTool } from './tools/eyedropperTool';
import { PanTool } from './tools/panTool';
import { FillTool } from './tools/fillTool';
import { RectangleTool } from './tools/rectangleTool';
import { LineTool } from './tools/lineTool';
import { SelectTool } from './tools/selectTool';
import { CircleTool } from './tools/circleTool';
import { EntitySelectTool } from './tools/entitySelectTool';
import { EntityPlaceTool } from './tools/entityPlaceTool';
import { CableDrawTool } from './tools/cableDrawTool';
import { PipeDrawTool } from './tools/pipeDrawTool';
import { DeviceLinkTool } from './tools/deviceLinkTool';
import { PrefabPlaceTool } from './tools/prefabPlaceTool';
import type { PrefabData } from './prefab/prefabTypes';
import { Camera } from './rendering/camera';
import { EditorCanvas } from './components/EditorCanvas';
import { Toolbar } from './components/Toolbar';
import { PalettePanel } from './components/PalettePanel';
import { DEFAULT_DECAL_PLACEMENT_SETTINGS } from './components/DecalPalette';
import type { DecalPlacementSettings } from './components/DecalPalette';
import { EntityInfoPanel } from './components/EntityInfoPanel';
import { DecalInfoPanel } from './components/DecalInfoPanel';
import { MenuBar } from './components/MenuBar';
import { StatusBar } from './components/StatusBar';
import { LoadingScreen } from './components/LoadingScreen';
import { LayerPanel } from './components/LayerPanel';
import { useKeyboard } from './hooks/useKeyboard';
import { initRegistry } from './loaders/initRegistry';
import { setActiveProvider, HttpResourceProvider } from './loaders/resourceProvider';
import type { ResourceProvider } from './loaders/resourceProvider';
import { ForkSelector } from './components/ForkSelector';
import { importMap } from './import/mapImporter';
import type { ImportedEntity } from './import/mapImporter';
import { exportMap } from './export/mapExporter';
import { DEFAULT_LAYER_VISIBILITY } from './rendering/entityRenderer';
import type { LayerVisibility } from './rendering/entityRenderer';
import { InfrastructurePanel } from './components/InfrastructurePanel';
import type { InfrastructureSelection } from './types';
import { PerformanceHUD } from './components/PerformanceHUD';
import { CollapsiblePanel } from './components/CollapsiblePanel';
import { GridTabBar } from './components/GridTabBar';
import { ConfirmModal } from './components/ConfirmModal';
import { BenchmarkOverlay } from './components/BenchmarkOverlay';
import { markSceneDirty, markOverlayDirty, markAllDirty } from './rendering/dirtyFlags';
import { buildTransformComponent } from './tools/entityHelpers';
import { resetAllCaches } from './loaders/resetAllCaches';
import { validateMap } from './validation/mapValidator';
import type { ValidationIssue } from './validation/mapValidator';
import ValidatorModal from './components/ValidatorModal';
import './App.css';

const entitySelectTool = new EntitySelectTool();
const entityPlaceTool = new EntityPlaceTool();
const cableDrawTool = new CableDrawTool();
const pipeDrawTool = new PipeDrawTool();
const deviceLinkTool = new DeviceLinkTool();
const prefabPlaceTool = new PrefabPlaceTool();

const TOOL_MAP: Record<string, ITool> = {
  paint: new PaintTool(),
  erase: new EraseTool(),
  eyedropper: new EyedropperTool(),
  pan: new PanTool(),
  fill: new FillTool(),
  rectangle: new RectangleTool(),
  line: new LineTool(),
  select: new SelectTool(),
  circle: new CircleTool(),
  entitySelect: entitySelectTool,
  entityPlace: entityPlaceTool,
  cableDraw: cableDrawTool,
  pipeDraw: pipeDrawTool,
  deviceLink: deviceLinkTool,
  prefabPlace: prefabPlaceTool,
};

export const App: React.FC = () => {
  const [state, dispatch] = useReducer(editorReducer, undefined, createInitialState);
  const [showDisclaimer, setShowDisclaimer] = useState(() => !localStorage.getItem('space-station-14-map-editor-disclaimer-dismissed'));
  const [statusMessage, setStatusMessage] = useState('Ready');
  const [loadingMessage, setLoadingMessage] = useState('Discovering prototypes...');
  const [loadFailed, setLoadFailed] = useState(false);
  const [forkProvider, setForkProvider] = useState<ResourceProvider | null>(null);
  const [forkName, setForkName] = useState('');
  const [builtInAvailable, setBuiltInAvailable] = useState(false);
  // Name of the pre-baked/built-in resources, written by prebuild-resources.mjs.
  // Falls back to a generic label when not specified (e.g. base Space Station 14).
  const [builtInForkName, setBuiltInForkName] = useState('Built-in');
  const [cursorTile, setCursorTile] = useState({ x: 0, y: 0 });
  const [showGrid, setShowGrid] = useState(true);
  const [showSpaceBackground, setShowSpaceBackground] = useState(false);
  const [showEntities, setShowEntities] = useState(true);
  const [showSubFloor, setShowSubFloor] = useState(true);
  const [showConnections, setShowConnections] = useState(false);
  const [showPerfHUD, setShowPerfHUD] = useState(true);
  const [showBenchmark, setShowBenchmark] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [layerVisibility, setLayerVisibility] = useState<LayerVisibility>({ ...DEFAULT_LAYER_VISIBILITY });
  const [pendingDeleteGridUid, setPendingDeleteGridUid] = useState<number | null>(null);
  const [validatorIssues, setValidatorIssues] = useState<ValidationIssue[] | null>(null);
  const [highlightTile, setHighlightTile] = useState<{ x: number; y: number; startTime: number } | null>(null);
  const [infraSelection, setInfraSelection] = useState<InfrastructureSelection>({
    mode: 'cable', cableType: 'CableHV', pipeType: 'supply',
  });
  const cameraRef = useRef(new Camera());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const decalPlacementSettingsRef = useRef<DecalPlacementSettings>({ ...DEFAULT_DECAL_PLACEMENT_SETTINGS });

  // Probe for built-in resources availability
  useEffect(() => {
    fetch('/resources-list?dir=Prototypes/Entities&ext=.yml')
      .then(r => { if (r.ok) setBuiltInAvailable(true); })
      .catch(() => { });
    fetch('/resources/_manifests/entities.json')
      .then(r => { if (r.ok) setBuiltInAvailable(true); })
      .catch(() => { });
    // Built-in resources may carry a fork name written at pre-bake time.
    fetch('/resources/_manifests/fork.json')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.name) setBuiltInForkName(data.name); })
      .catch(() => { });
  }, []);

  // Called when the ForkSelector picks a provider
  const handleForkReady = useCallback((provider: ResourceProvider, name: string) => {
    setForkProvider(provider);
    setForkName(name);
    setActiveProvider(provider);
    setLoadingMessage('Discovering prototypes...');
    initRegistry(provider, (msg) => setLoadingMessage(msg)).then(registry => {
      dispatch({ type: 'SET_REGISTRY', registry });
      setStatusMessage('Ready');
    }).catch(err => {
      setLoadingMessage(`Resource load failed: ${err}`);
      setLoadFailed(true);
    });
  }, []);

  const handleSwitchFork = useCallback(() => {
    if (forkProvider) {
      forkProvider.dispose();
    }
    resetAllCaches();
    dispatch({ type: 'NEW_MAP' });
    dispatch({ type: 'SET_REGISTRY', registry: null });
    setActiveProvider(null);
    setForkProvider(null);
    setForkName('');
    setLoadFailed(false);
  }, [forkProvider]);

  // Warn on unsaved changes before closing/navigating away
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (state.dirty) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [state.dirty]);

  const activeTool = TOOL_MAP[state.activeTool] ?? null;

  const selectedEntities = useMemo(() => {
    if (state.selectedEntityUids.length === 0) return [];
    return state.entities.filter(e => state.selectedEntityUids.includes(e.uid));
  }, [state.selectedEntityUids, state.entities]);

  const handleSelectTool = useCallback((tool: ToolType) => {
    // Redirect entityPlace to paint when a decal palette item is active
    // (entityPlace only handles entities, not decals)
    if (tool === 'entityPlace' && state.selectedPaletteItem?.type === 'decal') {
      dispatch({ type: 'SET_TOOL', tool: 'paint' });
      return;
    }
    dispatch({ type: 'SET_TOOL', tool });
  }, [state.selectedPaletteItem]);

  // Tools that support both tile and entity palette items
  const ENTITY_CAPABLE_TOOLS = new Set(['paint', 'erase', 'rectangle', 'line', 'circle', 'entitySelect', 'entityPlace']);

  const handleSelectPaletteItem = useCallback((item: PaletteItem) => {
    dispatch({ type: 'SET_PALETTE_ITEM', item });
    // Reset placement rotation when switching entities
    if (item.type === 'entity') {
      entityPlaceTool.resetRotation();
    }
    if (item.type === 'tile') {
      // Switch to paint if on an entity-only tool or eyedropper
      if (state.activeTool === 'eyedropper' || state.activeTool === 'entitySelect' || state.activeTool === 'entityPlace') {
        dispatch({ type: 'SET_TOOL', tool: 'paint' });
      }
    } else if (item.type === 'entity') {
      // Only auto-switch to entityPlace if current tool doesn't support entities
      if (!ENTITY_CAPABLE_TOOLS.has(state.activeTool)) {
        dispatch({ type: 'SET_TOOL', tool: 'entityPlace' });
      }
    } else if (item.type === 'decal') {
      // Switch to paint tool so canvas handles decal placement inline
      if (state.activeTool === 'eyedropper' || state.activeTool === 'entitySelect' || state.activeTool === 'entityPlace') {
        dispatch({ type: 'SET_TOOL', tool: 'paint' });
      }
    }
  }, [state.activeTool]);

  const handleNewMap = useCallback(() => {
    dispatch({ type: 'NEW_MAP' });
    cameraRef.current.x = 0;
    cameraRef.current.y = 0;
    cameraRef.current.zoom = 1;
    setStatusMessage('New map');
  }, []);

  const handleImport = useCallback((content: string) => {
    try {
      const map = importMap(content);
      dispatch({ type: 'LOAD_MAP', map });
      const { grid } = map;
      cameraRef.current.fitBounds(
        { minX: grid.offsetX, maxX: grid.offsetX + grid.width, minY: grid.offsetY, maxY: grid.offsetY + grid.height },
        window.innerWidth - 280,
        window.innerHeight - 60,
      );
      setStatusMessage(`Imported: ${grid.width}x${grid.height} grid, ${map.entities.length} entities`);
    } catch (err) {
      setStatusMessage(`Import failed: ${err}`);
    }
  }, []);

  const handleSearchNavigate = useCallback((entity: ImportedEntity) => {
    // Switch to entity select tool so the selection is visible
    dispatch({ type: 'SET_TOOL', tool: 'entitySelect' });
    // Select the entity
    dispatch({ type: 'SELECT_ENTITY', uids: [entity.uid] });
    // Pan camera to entity position
    const camera = cameraRef.current;
    camera.x = entity.position.x;
    camera.y = entity.position.y;
    // Always zoom in close so the entity is easy to spot
    camera.zoom = 3;
    markAllDirty();
  }, []);

  const handleValidate = useCallback(() => {
    if (!state.registry) return;
    const activeGrid = state.grids[state.activeGridIndex];
    const issues = validateMap(activeGrid.grid, activeGrid.entities, state.registry);
    setValidatorIssues(issues);
  }, [state]);

  const handleValidatorJump = useCallback((x: number, y: number) => {
    const camera = cameraRef.current;
    camera.x = x + 0.5;
    camera.y = y + 0.5;
    if (camera.zoom < 2) camera.zoom = 3;
    markAllDirty();
    setHighlightTile({ x, y, startTime: performance.now() });
  }, []);

  const handleExport = useCallback(() => {
    try {
      const yaml = exportMap({
        meta: state.meta,
        tilemap: state.tilemap ?? {},
        grid: state.grid,
        entities: state.entities,
        containedEntities: state.containedEntities,
        gridUid: state.gridUid,
        mapUid: state.mapUid,
        maps: state.maps,
        grids: state.gridUidList,
        orphans: state.orphans,
        nullspace: state.nullspace,
        gridDataList: state.grids,
        structuralEntityData: state.structuralEntityData,
        entityRawComponents: state.entityRawComponents,
        entityRawPreamble: state.entityRawPreamble,
        chunkKeyOrder: state.chunkKeyOrder,
        lineEnding: state.lineEnding,
        hasDocumentTerminator: state.hasDocumentTerminator,
        entityOrder: state.entityOrder,
      }, state.decalsDirty);
      downloadYAML(yaml, 'station.yml');
      setStatusMessage('Exported station.yml');
    } catch (err) {
      setStatusMessage(`Export failed: ${err}`);
    }
  }, [state.grid, state.entities, state.containedEntities, state.meta, state.gridUid, state.mapUid, state.tilemap, state.maps, state.gridUidList, state.orphans, state.nullspace, state.grids, state.structuralEntityData, state.entityRawComponents, state.entityRawPreamble, state.chunkKeyOrder, state.lineEnding, state.hasDocumentTerminator, state.entityOrder]);

  const handleUndo = useCallback(() => dispatch({ type: 'UNDO' }), []);
  const handleRedo = useCallback(() => dispatch({ type: 'REDO' }), []);

  // Grid management
  const handleSelectGrid = useCallback((index: number) => {
    dispatch({ type: 'SET_ACTIVE_GRID', index });
    markAllDirty();
  }, []);

  const handleAddGrid = useCallback(() => {
    const name = prompt('New grid name:', `Grid ${state.grids.length + 1}`);
    if (name) dispatch({ type: 'ADD_GRID', name });
  }, [state.grids.length]);

  const handleDeleteGrid = useCallback((gridUid: number) => {
    setPendingDeleteGridUid(gridUid);
  }, []);

  const confirmDeleteGrid = useCallback(() => {
    if (pendingDeleteGridUid !== null) {
      dispatch({ type: 'REMOVE_GRID', gridUid: pendingDeleteGridUid });
      markAllDirty();
      setPendingDeleteGridUid(null);
    }
  }, [pendingDeleteGridUid]);

  const handleRenameGrid = useCallback((gridUid: number, newName: string) => {
    dispatch({ type: 'RENAME_GRID', gridUid, name: newName });
  }, []);

  const handleFocusGrid = useCallback((index: number) => {
    const gd = state.grids[index];
    if (!gd || gd.grid.width === 0) return;
    const camera = cameraRef.current;
    const canvasEl = document.querySelector('canvas');
    if (!canvasEl) return;
    camera.fitBounds(
      { minX: gd.grid.offsetX, minY: gd.grid.offsetY, maxX: gd.grid.offsetX + gd.grid.width, maxY: gd.grid.offsetY + gd.grid.height },
      canvasEl.width, canvasEl.height,
    );
    markAllDirty();
  }, [state.grids]);

  // Clipboard actions delegate to SelectTool
  const getSelectTool = useCallback((): import('./tools/selectTool').SelectTool | null => {
    const tool = TOOL_MAP['select'];
    return tool instanceof SelectTool ? tool : null;
  }, []);

  const makeToolContext = useCallback(() => ({
    state,
    dispatch,
    camera: cameraRef.current,
    canvasW: window.innerWidth - 260,
    canvasH: window.innerHeight - 60,
    paletteItem: state.selectedPaletteItem,
    shiftHeld: false,
    ctrlHeld: false,
  }), [state, dispatch]);

  const handleCopy = useCallback(() => {
    if (state.activeTool === 'entitySelect' && state.selectedEntityUids.length > 0) {
      entitySelectTool.copy(makeToolContext());
      setStatusMessage('Copied entities');
      return;
    }
    getSelectTool()?.copy(makeToolContext());
    setStatusMessage('Copied');
  }, [getSelectTool, makeToolContext, state.activeTool, state.selectedEntityUids]);

  const handleCut = useCallback(() => {
    if (state.activeTool === 'entitySelect' && state.selectedEntityUids.length > 0) {
      entitySelectTool.cut(makeToolContext());
      setStatusMessage('Cut entities');
      return;
    }
    getSelectTool()?.cut(makeToolContext());
    setStatusMessage('Cut');
  }, [getSelectTool, makeToolContext, state.activeTool, state.selectedEntityUids]);

  const handlePaste = useCallback(() => {
    if (state.activeTool === 'entitySelect') {
      entitySelectTool.paste(makeToolContext());
      setStatusMessage('Paste, click to place');
      return;
    }
    getSelectTool()?.paste(makeToolContext());
    if (state.activeTool !== 'select') {
      dispatch({ type: 'SET_TOOL', tool: 'select' });
    }
    setStatusMessage('Paste, click to place');
  }, [getSelectTool, makeToolContext, state.activeTool]);

  const handleDelete = useCallback(() => {
    // If entity select tool is active, delete selected entities
    if (state.activeTool === 'entitySelect' && state.selectedEntityUids.length > 0) {
      entitySelectTool.deleteSelected(makeToolContext());
      setStatusMessage('Deleted entity');
      return;
    }
    getSelectTool()?.deleteSelection(makeToolContext());
    setStatusMessage('Deleted selection');
  }, [getSelectTool, makeToolContext, state.activeTool, state.selectedEntityUids]);

  const rotateSelectedDecals = useCallback((delta: number) => {
    const activeGrid = state.grids[state.activeGridIndex];
    const selectedSet = new Set(state.selectedDecalIds);
    const decalChanges = activeGrid.decals.decals
      .filter(d => selectedSet.has(d.id))
      .map(d => ({
        action: 'update' as const,
        decal: { ...d, angle: d.angle + delta },
        previousDecal: d,
      }));
    if (decalChanges.length > 0) {
      dispatch({
        type: 'APPLY_COMMAND',
        command: { label: 'Rotate decals', tileChanges: [], entityChanges: [], decalChanges },
      });
    }
  }, [state.grids, state.activeGridIndex, state.selectedDecalIds, dispatch]);

  const handleRotateEntityCW = useCallback(() => {
    if (state.activeTool === 'entitySelect') {
      if (entitySelectTool.isPasting()) {
        entitySelectTool.rotatePaste('cw');
      } else if (state.selectedEntityUids.length > 0) {
        entitySelectTool.rotateSelected(makeToolContext(), 'cw');
      } else if (state.selectedDecalIds.length > 0) {
        rotateSelectedDecals(-Math.PI / 2);
      }
    } else if (state.activeTool === 'select') {
      getSelectTool()?.rotateSelection(makeToolContext(), 'cw');
    }
  }, [state.activeTool, state.selectedEntityUids, state.selectedDecalIds, makeToolContext, getSelectTool, rotateSelectedDecals]);

  const handleRotateEntityCCW = useCallback(() => {
    if (state.activeTool === 'entitySelect') {
      if (entitySelectTool.isPasting()) {
        entitySelectTool.rotatePaste('ccw');
      } else if (state.selectedEntityUids.length > 0) {
        entitySelectTool.rotateSelected(makeToolContext(), 'ccw');
      } else if (state.selectedDecalIds.length > 0) {
        rotateSelectedDecals(Math.PI / 2);
      }
    } else if (state.activeTool === 'select') {
      getSelectTool()?.rotateSelection(makeToolContext(), 'ccw');
    }
  }, [state.activeTool, state.selectedEntityUids, state.selectedDecalIds, makeToolContext, getSelectTool, rotateSelectedDecals]);

  const handleUpdateEntity = useCallback((updated: import('./import/mapImporter').ImportedEntity) => {
    const original = state.entities.find(e => e.uid === updated.uid);
    if (!original) return;
    dispatch({
      type: 'APPLY_COMMAND',
      command: {
        label: `Edit ${updated.prototype}`,
        tileChanges: [],
        entityChanges: [
          { action: 'remove', entity: original },
          { action: 'add', entity: updated },
        ],
      },
    });
  }, [state.entities, dispatch]);

  const handleCycleEntityRotationCW = useCallback(() => {
    if (state.activeTool === 'entityPlace') {
      entityPlaceTool.cycleRotation('cw');
    }
    // Rotate decal placement angle by 90° CW
    if (state.selectedPaletteItem?.type === 'decal') {
      const settings = decalPlacementSettingsRef.current;
      decalPlacementSettingsRef.current = { ...settings, angle: settings.angle - Math.PI / 2 };
    }
  }, [state.activeTool, state.selectedPaletteItem]);

  const handleCycleEntityRotationCCW = useCallback(() => {
    if (state.activeTool === 'entityPlace') {
      entityPlaceTool.cycleRotation('ccw');
    }
    // Rotate decal placement angle by 90° CCW
    if (state.selectedPaletteItem?.type === 'decal') {
      const settings = decalPlacementSettingsRef.current;
      decalPlacementSettingsRef.current = { ...settings, angle: settings.angle + Math.PI / 2 };
    }
  }, [state.activeTool]);

  const keyboardActions = useMemo(() => ({
    onSetTool: handleSelectTool,
    onUndo: handleUndo,
    onRedo: handleRedo,
    onCopy: handleCopy,
    onCut: handleCut,
    onPaste: handlePaste,
    onDelete: handleDelete,
    onRotateEntityCW: (state.activeTool === 'entitySelect' && (state.selectedEntityUids.length > 0 || state.selectedDecalIds.length > 0 || entitySelectTool.isPasting())) || state.activeTool === 'select' ? handleRotateEntityCW : undefined,
    onRotateEntityCCW: (state.activeTool === 'entitySelect' && (state.selectedEntityUids.length > 0 || state.selectedDecalIds.length > 0 || entitySelectTool.isPasting())) || state.activeTool === 'select' ? handleRotateEntityCCW : undefined,
    onCycleEntityRotationCW: state.activeTool === 'entityPlace' || state.selectedPaletteItem?.type === 'decal' ? handleCycleEntityRotationCW : undefined,
    onCycleEntityRotationCCW: state.activeTool === 'entityPlace' || state.selectedPaletteItem?.type === 'decal' ? handleCycleEntityRotationCCW : undefined,
    onEscape: state.activeTool === 'deviceLink' ? () => deviceLinkTool.cancelLinking() : undefined,
    onShowShortcuts: () => setShowShortcuts(s => !s),
    onFocusSearch: () => searchInputRef.current?.focus(),
  }), [handleSelectTool, handleUndo, handleRedo, handleCopy, handleCut, handlePaste, handleDelete, handleRotateEntityCW, handleRotateEntityCCW, handleCycleEntityRotationCW, handleCycleEntityRotationCCW, state.activeTool, state.selectedEntityUids, state.selectedDecalIds, state.selectedPaletteItem]);

  const { isSpaceHeld, isRHeld } = useKeyboard(keyboardActions);

  const handleToggleLayer = useCallback((layer: keyof LayerVisibility) => {
    setLayerVisibility(prev => ({ ...prev, [layer]: !prev[layer] }));
    markSceneDirty();
  }, []);

  const handleInfraChange = useCallback((sel: InfrastructureSelection) => {
    setInfraSelection(sel);
    cableDrawTool.cableType = sel.cableType;
    pipeDrawTool.pipeType = sel.pipeType;
    // Auto-switch to appropriate tool
    if (sel.mode === 'cable') {
      dispatch({ type: 'SET_TOOL', tool: 'cableDraw' });
    } else {
      dispatch({ type: 'SET_TOOL', tool: 'pipeDraw' });
    }
  }, []);

  const handleSelectPrefab = useCallback((prefab: PrefabData) => {
    prefabPlaceTool.setPrefab(prefab);
    dispatch({ type: 'SET_TOOL', tool: 'prefabPlace' });
    setStatusMessage(`Prefab: ${prefab.name} (${prefab.width}\u00d7${prefab.height}) \u2014 click to place`);
  }, []);

  // Track cursor position (world coordinates)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const canvas = document.querySelector('.canvas-area canvas');
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const camera = cameraRef.current;
      const tile = camera.screenToTile(
        e.clientX - rect.left,
        e.clientY - rect.top,
        rect.width,
        rect.height,
      );
      setCursorTile({
        x: Math.floor(tile.x),
        y: Math.floor(tile.y),
      });
    };
    window.addEventListener('mousemove', handler);
    return () => window.removeEventListener('mousemove', handler);
  }, []);

  // Show fork selector when no provider selected yet
  if (!forkProvider) {
    return <ForkSelector onReady={handleForkReady} builtInAvailable={builtInAvailable} builtInForkName={builtInForkName} />;
  }

  // Show loading screen while registry loads
  if (!state.registry && !loadFailed) {
    return <LoadingScreen message={loadingMessage} />;
  }

  return (
    <div className="flex flex-col w-full h-full">
      {showDisclaimer && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.7)',
        }}>
          <div style={{
            backgroundColor: '#1a1a2e', border: '1px solid #2a2a4a',
            borderRadius: 8, padding: '32px 40px', maxWidth: 480,
            color: '#ccc', fontSize: 14, lineHeight: 1.7, textAlign: 'center',
          }}>
            <img src="/images/clown.png" alt="" style={{ width: 64, height: 64, imageRendering: 'pixelated', marginBottom: 12, display: 'block', marginLeft: 'auto', marginRight: 'auto' }} />
            <h2 style={{ color: '#fff', margin: '0 0 16px', fontSize: 20 }}>
              Early Development
            </h2>
            <p style={{ margin: '0 0 12px' }}>
              This map editor is under <strong style={{ color: '#fff' }}>active development</strong>.
              Expect bugs, missing features, and breaking changes.
            </p>
            <p style={{ margin: '0 0 24px' }}>
              It is <strong style={{ color: '#fff' }}>not yet suitable for production-level mapping</strong>.
            </p>
            <button
              onClick={() => {
                localStorage.setItem('space-station-14-map-editor-disclaimer-dismissed', '1');
                setShowDisclaimer(false);
              }}
              style={{
                backgroundColor: '#0f3460', border: '1px solid #2a2a4a',
                borderRadius: 4, color: '#fff', fontSize: 14,
                padding: '10px 32px', cursor: 'pointer',
              }}
            >
              I understand
            </button>
          </div>
        </div>
      )}
      {pendingDeleteGridUid !== null && (() => {
        const grid = state.grids.find(g => g.gridUid === pendingDeleteGridUid);
        const entityCount = grid ? grid.entities.length : 0;
        return (
          <ConfirmModal
            title="Delete Grid"
            message={`Delete grid '${grid?.name ?? 'Unknown'}'? This will remove all tiles and ${entityCount} entit${entityCount === 1 ? 'y' : 'ies'}.`}
            confirmLabel="Delete"
            cancelLabel="Keep"
            danger
            onConfirm={confirmDeleteGrid}
            onCancel={() => setPendingDeleteGridUid(null)}
          />
        );
      })()}
      {validatorIssues !== null && (
        <ValidatorModal
          issues={validatorIssues}
          onJumpTo={handleValidatorJump}
          onClose={() => setValidatorIssues(null)}
        />
      )}
      <MenuBar
        onNewMap={handleNewMap}
        onImport={handleImport}
        onExport={handleExport}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={state.undoStack.length > 0}
        canRedo={state.redoStack.length > 0}
        dirty={state.dirty}
        showGrid={showGrid}
        onToggleGrid={() => { setShowGrid(g => !g); markSceneDirty(); }}
        showEntities={showEntities}
        onToggleEntities={() => { setShowEntities(e => !e); markSceneDirty(); }}
        showSpaceBackground={showSpaceBackground}
        onToggleSpaceBackground={() => { setShowSpaceBackground(b => !b); markSceneDirty(); }}
        showLighting={state.lightingEnabled}
        onToggleLighting={() => { dispatch({ type: 'SET_LIGHTING_ENABLED', enabled: !state.lightingEnabled }); markSceneDirty(); }}
        showPerfHUD={showPerfHUD}
        onTogglePerfHUD={() => setShowPerfHUD(p => !p)}
        showBenchmark={showBenchmark}
        onToggleBenchmark={() => setShowBenchmark(b => !b)}
        showShortcuts={showShortcuts}
        onShowShortcuts={() => setShowShortcuts(true)}
        onCloseShortcuts={() => setShowShortcuts(false)}
        forkName={forkName}
        onSwitchFork={handleSwitchFork}
      />
      <div className="flex flex-1 overflow-hidden">
        <Toolbar activeTool={state.activeTool} onSelectTool={handleSelectTool} />
        <div className="canvas-area flex-1 flex flex-col overflow-hidden">
          <GridTabBar
            grids={state.grids}
            activeGridIndex={state.activeGridIndex}
            onSelectGrid={handleSelectGrid}
            onAddGrid={handleAddGrid}
            onDeleteGrid={handleDeleteGrid}
            onRenameGrid={handleRenameGrid}
            onFocusGrid={handleFocusGrid}
            entities={state.entities}
            registry={state.registry}
            onSearchNavigate={handleSearchNavigate}
            searchInputRef={searchInputRef}
            onValidate={handleValidate}
          />
          <div className="flex-1 relative overflow-hidden">
            {showPerfHUD && <PerformanceHUD />}
            {showBenchmark && <BenchmarkOverlay />}
            <EditorCanvas
              state={state}
              dispatch={dispatch}
              camera={cameraRef.current}
              activeTool={activeTool}
              showEntities={showEntities}
              showGrid={showGrid}
              showSpaceBackground={showSpaceBackground}
              isSpaceHeld={isSpaceHeld}
              isRHeld={isRHeld}
              showSubFloor={showSubFloor}
              layerVisibility={layerVisibility}
              showConnections={showConnections}
              lightingEnabled={state.lightingEnabled}
              decalPlacementSettingsRef={decalPlacementSettingsRef}
              highlightTile={highlightTile}
            />
          </div>
        </div>
        <div className="flex flex-col min-w-[280px] max-w-[400px] w-[20vw] bg-panel border-l border-subtle overflow-hidden">
          {/* Contextual panels at top */}
          {selectedEntities.length > 0 && (
            <CollapsiblePanel title="Entity Info" forceOpen={selectedEntities.length > 0}>
              <EntityInfoPanel
                entities={selectedEntities}
                allEntities={state.entities}
                registry={state.registry}
                grid={state.grid}
                onRotateCW={handleRotateEntityCW}
                onRotateCCW={handleRotateEntityCCW}
                onDelete={() => {
                  entitySelectTool.deleteSelected(makeToolContext());
                  setStatusMessage('Deleted entity');
                }}
                onDeselect={() => dispatch({ type: 'SELECT_ENTITY', uids: [] })}
                onUpdateEntity={handleUpdateEntity}
                containedEntities={state.containedEntities}
                onAddContainedEntity={(parentUid: number, prototypeId: string) => {
                  dispatch({ type: 'ADD_CONTAINED_ENTITY', parentUid, prototypeId });
                }}
                onRemoveContainedEntity={(parentUid: number, entityUid: number) => {
                  dispatch({ type: 'REMOVE_CONTAINED_ENTITY', parentUid, entityUid });
                }}
              />
            </CollapsiblePanel>
          )}
          {state.selectedDecalIds.length > 0 && state.selectedEntityUids.length === 0 && (
            <CollapsiblePanel title="Decal Info" forceOpen={state.selectedDecalIds.length > 0}>
              <DecalInfoPanel
                selectedDecalIds={state.selectedDecalIds}
                decals={state.grids[state.activeGridIndex]?.decals?.decals ?? []}
                registry={state.registry}
                dispatch={dispatch}
              />
            </CollapsiblePanel>
          )}
          {(state.activeTool === 'cableDraw' || state.activeTool === 'pipeDraw') && (
            <CollapsiblePanel title="Infrastructure" defaultOpen={true}>
              <InfrastructurePanel
                selection={infraSelection}
                onChange={handleInfraChange}
              />
            </CollapsiblePanel>
          )}
          {/* Palette, always visible, takes remaining space */}
          <PalettePanel
            registry={state.registry}
            selectedItem={state.selectedPaletteItem}
            onSelect={handleSelectPaletteItem}
            onSelectPrefab={handleSelectPrefab}
            decalPlacementSettingsRef={decalPlacementSettingsRef}
          />
          {/* Layer panel at bottom */}
          <CollapsiblePanel title="Layers" defaultOpen={true}>
            <LayerPanel
              layers={layerVisibility}
              onToggleLayer={handleToggleLayer}
              showSubFloor={showSubFloor}
              onToggleSubFloor={() => { setShowSubFloor(s => !s); markSceneDirty(); }}
              showConnections={showConnections}
              onToggleConnections={() => { setShowConnections(c => !c); markSceneDirty(); }}
            />
          </CollapsiblePanel>
        </div>
      </div>
      <StatusBar
        state={state}
        cursorTileX={cursorTile.x}
        cursorTileY={cursorTile.y}
        statusMessage={statusMessage}
      />
    </div>
  );
};

function downloadYAML(yaml: string, filename: string): void {
  const blob = new Blob([yaml], { type: 'text/yaml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
