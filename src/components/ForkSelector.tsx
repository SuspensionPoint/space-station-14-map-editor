import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  HttpResourceProvider,
  FileSystemResourceProvider,
  setActiveProvider,
} from '../loaders/resourceProvider';
import type { ResourceProvider } from '../loaders/resourceProvider';
import {
  buildFileMapFromFileList,
  buildFileMapFromDirectoryHandle,
  validateRepository,
  summarizeRepository,
} from '../loaders/directoryScanner';
import type { RepositorySummary } from '../loaders/directoryScanner';
import { RepositoryLink } from './RepositoryLink';

type SelectorState = 'idle' | 'scanning' | 'summary' | 'error';

interface ForkSelectorProps {
  onReady: (provider: ResourceProvider, forkName: string) => void;
  builtInAvailable: boolean;
  builtInForkName: string;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

const supportsDirectoryPicker = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
const supportsWebkitDirectory = (() => {
  if (typeof document === 'undefined') return false;
  const input = document.createElement('input');
  return 'webkitdirectory' in input;
})();
const canPickFolder = supportsDirectoryPicker || supportsWebkitDirectory;

export const ForkSelector: React.FC<ForkSelectorProps> = ({
  onReady,
  builtInAvailable,
  builtInForkName,
}) => {
  const [phase, setPhase] = useState<SelectorState>('idle');
  const [scanProgress, setScanProgress] = useState(0);
  const [scanTotal, setScanTotal] = useState(0);
  const [summary, setSummary] = useState<RepositorySummary | null>(null);
  const [fileMap, setFileMap] = useState<Map<string, File> | null>(null);
  const [forkName, setForkName] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleOpenFolder = useCallback(async () => {
    if (supportsDirectoryPicker) {
      let handle: FileSystemDirectoryHandle;
      try {
        handle = await (window as any).showDirectoryPicker({ mode: 'read' });
      } catch {
        // User cancelled
        return;
      }

      setPhase('scanning');
      setScanProgress(0);

      try {
        const map = await buildFileMapFromDirectoryHandle(handle, (count) => {
          setScanProgress(count);
        });

        const validation = validateRepository(map);
        if (!validation.valid) {
          setErrorMessage(validation.error ?? 'Invalid repository');
          setPhase('error');
          return;
        }

        const s = summarizeRepository(map);
        setSummary(s);
        setFileMap(map);
        setForkName(handle.name);
        setPhase('summary');
      } catch (err) {
        setErrorMessage(String(err));
        setPhase('error');
      }
    } else {
      // Fallback: trigger hidden webkitdirectory input
      // Show scanning state immediately, the browser enumerates all files
      // before firing the change event, which can take several seconds
      setPhase('scanning');
      setScanProgress(0);
      fileInputRef.current?.click();
    }
  }, []);

  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) {
      setPhase('idle');
      return;
    }

    setPhase('scanning');
    setScanProgress(0);
    setScanTotal(files.length);

    try {
      const map = await buildFileMapFromFileList(Array.from(files), (processed, total) => {
        setScanProgress(processed);
        setScanTotal(total);
      });

      const validation = validateRepository(map);
      if (!validation.valid) {
        setErrorMessage(validation.error ?? 'Invalid repository');
        setPhase('error');
        return;
      }

      const s = summarizeRepository(map);
      setSummary(s);
      setFileMap(map);

      // Derive fork name from first file's webkitRelativePath root segment
      const firstPath = files[0].webkitRelativePath;
      const rootFolder = firstPath.split('/')[0] || 'Unknown';
      setForkName(rootFolder);
      setPhase('summary');
    } catch (err) {
      setErrorMessage(String(err));
      setPhase('error');
    }
  }, []);

  const handleLoad = useCallback(() => {
    if (!fileMap) return;
    const provider = new FileSystemResourceProvider(fileMap, forkName);
    onReady(provider, forkName);
  }, [fileMap, forkName, onReady]);

  const handleUseBuiltIn = useCallback(() => {
    const provider = new HttpResourceProvider('', builtInForkName);
    onReady(provider, builtInForkName);
  }, [onReady, builtInForkName]);

  const handleReset = useCallback(() => {
    setPhase('idle');
    setSummary(null);
    setFileMap(null);
    setForkName('');
    setErrorMessage('');
    setScanProgress(0);
    setScanTotal(0);
    // Reset file input so the same folder can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  // --- Space background with floating clown ---
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = bgCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId = 0;
    let dustImg: HTMLImageElement | null = null;
    let starsImg: HTMLImageElement | null = null;
    let clownImg: HTMLImageElement | null = null;

    // Clown state
    let cx = 0, cy = 0, cvx = 0, cvy = 0, crot = 0, cspin = 0, cscale = 1, cage = 0;
    let clownSpawned = false;

    function spawnClown(w: number, h: number) {
      const size = 48 + Math.random() * 32;
      const speed = 40 + Math.random() * 30;
      const perim = 2 * (w + h);
      const p = Math.random() * perim;
      if (p < w) { cx = p; cy = -size; }
      else if (p < w + h) { cx = w + size; cy = p - w; }
      else if (p < 2 * w + h) { cx = p - w - h; cy = h + size; }
      else { cx = -size; cy = p - 2 * w - h; }
      const angle = Math.atan2(h / 2 - cy, w / 2 - cx) + (Math.random() - 0.5) * 0.8;
      cvx = Math.cos(angle) * speed;
      cvy = Math.sin(angle) * speed;
      crot = Math.random() * Math.PI * 2;
      cspin = (Math.random() - 0.5) * 1.2;
      cscale = size / 64;
      cage = 0;
      clownSpawned = true;
    }

    // Load images
    const loadImg = (src: string): Promise<HTMLImageElement> =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(img); // proceed even on error
        img.src = src;
      });

    let running = true;
    let lastT = 0;

    Promise.all([
      loadImg('/images/space-bg.png').then(i => { dustImg = i; }),
      loadImg('/images/space-stars.png').then(i => { starsImg = i; }),
      loadImg('/images/clown.png').then(i => { clownImg = i; }),
    ]).then(() => {
      if (!running) return;
      lastT = performance.now();
      spawnClown(canvas.width / (window.devicePixelRatio || 1), canvas.height / (window.devicePixelRatio || 1));
      draw(lastT);
    });

    function draw(timestamp: number) {
      if (!running) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas!.clientWidth;
      const h = canvas!.clientHeight;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const dt = Math.min((timestamp - lastT) / 1000, 0.1);
      lastT = timestamp;

      // Dark background
      ctx!.fillStyle = '#0a0a1a';
      ctx!.fillRect(0, 0, w, h);

      // Tile dust pattern
      if (dustImg && dustImg.naturalWidth > 0) {
        ctx!.globalAlpha = 0.3;
        const pattern = ctx!.createPattern(dustImg, 'repeat');
        if (pattern) {
          ctx!.fillStyle = pattern;
          ctx!.fillRect(0, 0, w, h);
        }
        ctx!.globalAlpha = 1;
      }

      // Tile stars pattern
      if (starsImg && starsImg.naturalWidth > 0) {
        ctx!.globalAlpha = 0.5;
        const pattern = ctx!.createPattern(starsImg, 'repeat');
        if (pattern) {
          ctx!.fillStyle = pattern;
          ctx!.fillRect(0, 0, w, h);
        }
        ctx!.globalAlpha = 1;
      }

      // Floating clown
      if (clownSpawned && clownImg && clownImg.naturalWidth > 0) {
        cage += dt;
        cx += cvx * dt;
        cy += cvy * dt;
        crot += cspin * dt;

        const drawSize = clownImg.width * cscale;
        const margin = drawSize;

        // Respawn if off-screen
        if (cage > 2 && (cx < -margin || cx > w + margin || cy < -margin || cy > h + margin)) {
          spawnClown(w, h);
        }

        const fadeIn = Math.min(cage / 1.5, 1);
        const edgeDist = Math.min(cx + margin, w + margin - cx, cy + margin, h + margin - cy);
        const fadeOut = Math.min(edgeDist / (margin * 2), 1);

        ctx!.save();
        ctx!.globalAlpha = fadeIn * fadeOut * 0.7;
        ctx!.translate(cx, cy);
        ctx!.rotate(crot);
        ctx!.imageSmoothingEnabled = false;
        ctx!.drawImage(clownImg, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
        ctx!.restore();
      }

      animId = requestAnimationFrame(draw);
    }

    return () => {
      running = false;
      cancelAnimationFrame(animId);
    };
  }, []);

  return (
    <div className="fixed inset-0 flex items-center justify-center font-['Segoe_UI',sans-serif]">
      {/* Space background canvas */}
      <canvas
        ref={bgCanvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ zIndex: 0 }}
      />

      {/* Hidden file input fallback for browsers without showDirectoryPicker */}
      <input
        ref={fileInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is non-standard
        webkitdirectory=""
        className="hidden"
        onChange={handleFileInputChange}
      />

      <div className="relative z-10 w-full max-w-[500px] mx-4 bg-surface/95 backdrop-blur-sm border border-subtle rounded-xl p-8 shadow-2xl">
        {/* Title.always visible */}
        <h1 className="text-2xl font-bold text-accent text-center mb-1">
          SS14 Map Editor
        </h1>
        <p className="text-sm text-muted text-center mb-8">
          Select a fork to get started
        </p>

        {/* ---- IDLE ---- */}
        {phase === 'idle' && (
          <div className="flex flex-col gap-4">
            {canPickFolder ? (
              <>
                <button
                  onClick={handleOpenFolder}
                  className="w-full py-3 px-4 rounded-lg bg-accent text-white font-semibold text-sm
                             hover:brightness-110 active:brightness-90 transition-all cursor-pointer
                             border-none outline-none focus:ring-2 focus:ring-accent/50"
                >
                  Open Fork Folder
                </button>

                {/* Privacy & browser info */}
                <div className="bg-panel rounded-lg p-3 border border-subtle text-xs text-muted leading-relaxed flex flex-col gap-2">
                  <p>
                    <span className="text-primary font-medium">Privacy:</span>{' '}
                    Your browser will ask for permission to read the selected folder.
                    No files are uploaded or sent to any server. All processing happens
                    locally in your browser.
                  </p>
                  <p>
                    <span className="text-primary font-medium">Browser note:</span>{' '}
                    {supportsDirectoryPicker
                      ? 'Chrome and Edge use a native folder picker that reads files on demand. Your browser may ask you to confirm read access. This is standard and safe.'
                      : <>Firefox and Safari do not support the <a href="https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API" target="_blank" rel="noopener noreferrer" className="text-accent underline hover:brightness-125">File System Access API</a>, so the editor uses a <a href="https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/webkitdirectory" target="_blank" rel="noopener noreferrer" className="text-accent underline hover:brightness-125">folder upload input</a> instead. Your browser may show an &quot;upload&quot; prompt. This is misleading; files stay on your machine and are never sent anywhere.</>}
                  </p>
                </div>
              </>
            ) : (
              <div className="text-center text-warning text-sm py-3 px-4 rounded-lg bg-hover border border-subtle">
                Your browser does not support folder selection.
                Please use Chrome, Edge, or Firefox for local fork loading.
              </div>
            )}

            {builtInAvailable && (
              <button
                onClick={handleUseBuiltIn}
                className="w-full py-3 px-4 rounded-lg bg-elevated text-primary font-medium text-sm
                           hover:bg-hover active:brightness-90 transition-all cursor-pointer
                           border border-subtle outline-none focus:ring-2 focus:ring-accent/50"
              >
                Use Built-in Resources ({builtInForkName})
              </button>
            )}
          </div>
        )}

        {/* ---- SCANNING ---- */}
        {phase === 'scanning' && (
          <div className="flex flex-col items-center gap-4 w-full">
            {/* Spinner */}
            <div className="w-8 h-8 border-3 border-subtle border-t-accent rounded-full animate-spin" />
            <div className="text-sm text-primary">
              {scanProgress > 0 ? 'Scanning repository...' : 'Reading folder contents...'}
            </div>
            {scanTotal > 0 && scanProgress > 0 ? (
              <>
                {/* Determinate progress bar */}
                <div className="w-full max-w-[350px] h-2 bg-panel rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent rounded-full transition-all duration-150"
                    style={{ width: `${Math.min(100, (scanProgress / scanTotal) * 100)}%` }}
                  />
                </div>
                <div className="text-xs text-muted">
                  {formatNumber(scanProgress)} / {formatNumber(scanTotal)} files processed
                </div>
              </>
            ) : (
              <>
                {/* Indeterminate progress bar (CSS-only animation, works even when JS thread is blocked) */}
                <div className="w-full max-w-[350px] h-2 bg-panel rounded-full overflow-hidden">
                  <div className="h-full bg-accent rounded-full w-[30%] animate-[scanning-slide_1.2s_ease-in-out_infinite]" />
                </div>
                <div className="text-xs text-muted">
                  {!supportsDirectoryPicker
                    ? 'Your browser is reading all files in the folder. The page may appear unresponsive for up to 30 seconds for large repositories.'
                    : 'This may take a few seconds for large repositories'}
                </div>
              </>
            )}
            <button
              onClick={handleReset}
              className="text-xs text-muted hover:text-primary cursor-pointer bg-transparent border-none mt-1"
            >
              Cancel
            </button>
          </div>
        )}

        {/* CSS animation for indeterminate scanning bar */}
        <style>{`
          @keyframes scanning-slide {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(430%); }
          }
        `}</style>

        {/* ---- SUMMARY ---- */}
        {phase === 'summary' && summary && (
          <div className="flex flex-col gap-5">
            <div className="text-center">
              <div className="text-sm font-semibold text-success mb-1">
                Repository scanned successfully
              </div>
              <div className="text-xs text-muted">
                {forkName}
              </div>
            </div>

            <div className="bg-panel rounded-lg p-4 border border-subtle">
              <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
                <span className="text-muted">Entity files</span>
                <span className="text-primary text-right font-mono">
                  {formatNumber(summary.entityFiles)}
                </span>
                <span className="text-muted">Tile files</span>
                <span className="text-primary text-right font-mono">
                  {formatNumber(summary.tileFiles)}
                </span>
                <span className="text-muted">Decal files</span>
                <span className="text-primary text-right font-mono">
                  {formatNumber(summary.decalFiles)}
                </span>
                <span className="text-muted">Catalog files</span>
                <span className="text-primary text-right font-mono">
                  {formatNumber(summary.catalogFiles)}
                </span>
              </div>

              <div className="border-t border-subtle mt-3 pt-3 flex justify-between text-sm">
                <span className="text-muted">Fork directories</span>
                <span className="text-primary font-mono">
                  {summary.forkDirs.length > 0 ? summary.forkDirs.join(', ') : 'None'}
                </span>
              </div>

              <div className="border-t border-subtle mt-3 pt-3 flex justify-between text-sm font-semibold">
                <span className="text-muted">Total files</span>
                <span className="text-accent font-mono">
                  {formatNumber(summary.totalFiles)}
                </span>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleReset}
                className="flex-1 py-2.5 px-4 rounded-lg bg-elevated text-muted font-medium text-sm
                           hover:bg-hover hover:text-primary transition-all cursor-pointer
                           border border-subtle outline-none"
              >
                Cancel
              </button>
              <button
                onClick={handleLoad}
                className="flex-1 py-2.5 px-4 rounded-lg bg-accent text-white font-semibold text-sm
                           hover:brightness-110 active:brightness-90 transition-all cursor-pointer
                           border-none outline-none focus:ring-2 focus:ring-accent/50"
              >
                Load
              </button>
            </div>

            <p className="text-xs text-muted text-center leading-relaxed">
              All files are processed locally in your browser.
              Nothing is uploaded or sent to any server.
            </p>
          </div>
        )}

        {/* ---- ERROR ---- */}
        {phase === 'error' && (
          <div className="flex flex-col items-center gap-4">
            <div className="text-sm text-danger text-center leading-relaxed px-2">
              {errorMessage}
            </div>
            <button
              onClick={handleReset}
              className="py-2.5 px-6 rounded-lg bg-elevated text-primary font-medium text-sm
                         hover:bg-hover transition-all cursor-pointer
                         border border-subtle outline-none"
            >
              Try Again
            </button>
          </div>
        )}

        <div className="mt-6 border-t border-subtle pt-5">
          <RepositoryLink variant="button" label="View project on GitHub" />
        </div>
      </div>
    </div>
  );
};
