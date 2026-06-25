import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, MouseEvent } from "react";
import type { CompiledScene } from "./compileScene.ts";
import { compileSceneAsync } from "./compileClient.ts";
import {
  clearPackedScenes,
  registerPackedScene,
  setAssetSource,
  setPackNetworkFallback,
  unregisterPackedScene,
} from "../data/packedAssets.ts";
import { clearTimelineCache } from "../data/TimelineLoader";
import { createTourPlayer, type TourPlayer } from "../index.ts";
import {
  COMPILED_CACHE_VERSION,
  clearHistory,
  deleteConvert,
  getConvert,
  listConverts,
  saveConvert,
  updateConvert,
  type ConvertRecord,
  type StoredCompiledScene,
} from "./historyDb.ts";
import { downloadBytes, exportArchiveForScenes, importArchiveScenes } from "./exportBundle.ts";
import { applyInheritedGlobalDefaults, collectInheritableGlobalDefaults } from "./inheritedDefaults.ts";
import { addExternalRef, type ExternalAssetRef } from "./avm1Control.ts";
import type { ComparableScene, ConversionLabHandle } from "../main";

setAssetSource("pack");
setPackNetworkFallback(false);

const SAMPLES = ["A-tour", "intro", "nav", "segment1", "segment4", "segment5", "bnl"];
const THEME_KEY = "mmtour-theme";

type Theme = "light" | "dark";
type WorkspaceTab = "library" | "compare";
type DepStatus = "pending" | "compiling" | "linking" | "done" | "missing";

type CardView =
  | { scene: string; name: string; status: "converting" }
  | { scene: string; name: string; status: "error"; error: string }
  | { scene: string; name: string; status: "ready"; compiled: CompiledScene; depState: Record<string, DepStatus> };

type TreeNode = { key: string; children: TreeNode[]; reference?: boolean };

type PlayerView = {
  visible: boolean;
  title: string;
};

type EmbedInfo = {
  filename: string;
  sceneSwf: string;
  scenes: number;
  sizeMb: number;
  missing: number;
};

type HistGroup = { key: string; root: ConvertRecord; children: ConvertRecord[] };

export function SwfStudioApp() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("library");
  const [cards, setCards] = useState<Record<string, CardView>>({});
  const [history, setHistory] = useState<ConvertRecord[]>([]);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState("");
  const [player, setPlayer] = useState<PlayerView>({ visible: false, title: "" });
  const [embed, setEmbed] = useState<EmbedInfo | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [openDetail, setOpenDetail] = useState<Set<string>>(() => new Set());
  const [histOpen, setHistOpen] = useState<Set<string>>(() => new Set());
  const toastTimer = useRef<number | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const playerWrap = useRef<HTMLDivElement | null>(null);
  const playerEl = useRef<HTMLDivElement | null>(null);
  const labMount = useRef<HTMLDivElement | null>(null);
  const labHandle = useRef<ConversionLabHandle | null>(null);
  const activePlayer = useRef<TourPlayer | null>(null);
  const compiledScenes = useRef(new Map<string, CompiledScene>());
  const originalSwfUrls = useRef(new Map<string, string>());
  const pendingCompareSwf = useRef<string | undefined>(undefined);
  const inFlight = useRef(new Map<string, Promise<CompiledScene>>());
  const dependencyLoads = useRef(new Map<string, Promise<void>>());

  const showToast = useCallback((message: string) => {
    window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(""), 2200);
  }, []);

  useEffect(() => {
    document.body.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // Every ready card, as a scene the Compare workspace can play side-by-side
  // with Ruffle. The original SWF bytes (when we still have them) drive Ruffle,
  // so any converted SWF gets a reference — not just the bundled tour.
  const comparableScenes = useCallback((): ComparableScene[] => {
    const list: ComparableScene[] = [];
    for (const card of Object.values(cards)) {
      if (card.status !== "ready") continue;
      list.push({
        name: card.name,
        compiled: card.compiled,
        ruffleUrl: originalSwfUrls.current.get(card.compiled.scene),
      });
    }
    return list;
  }, [cards]);

  // Keep the Compare workspace mounted and in lock-step with the converted
  // library: switching to the tab (or finishing a convert while it is open)
  // re-syncs the scene list. pendingCompareSwf focuses a specific scene when
  // the user clicked a "Compare" button; otherwise the current view is kept.
  useEffect(() => {
    if (workspaceTab !== "compare" || !labMount.current) return;
    let cancelled = false;
    void (async () => {
      let mounted = labHandle.current;
      if (!mounted) {
        const { mountConversionLab } = await import("../main");
        if (cancelled || !labMount.current) return;
        mounted = await mountConversionLab(labMount.current, { includeHeader: false, autoLoad: false });
        labHandle.current = mounted;
      }
      if (cancelled) return;
      const focus = pendingCompareSwf.current;
      pendingCompareSwf.current = undefined;
      await mounted.showComparableScenes(comparableScenes(), focus);
    })();
    return () => { cancelled = true; };
  }, [workspaceTab, comparableScenes]);

  const refreshHistory = useCallback(async () => {
    setHistory(await listConverts());
  }, []);

  const acceptCompiled = useCallback((name: string, compiled: CompiledScene) => {
    registerPackedScene(compiled.scene, compiled.files, compiled.timeline);
    clearTimelineCache();
    compiledScenes.current.set(compiled.scene, compiled);
    setCards((prev) => ({
      ...prev,
      [compiled.scene]: {
        scene: compiled.scene,
        name,
        status: "ready",
        compiled,
        depState: readyDepState(compiled, prev[compiled.scene]),
      },
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await listConverts();
      if (cancelled) return;
      for (const rec of [...rows].reverse()) {
        if (rec.compiled && isCompiledCurrent(rec.compiled)) {
          const compiled = reviveCompiled(rec.compiled);
          acceptCompiled(rec.name, compiled);
          if ((rec.sourceType ?? "swf") === "swf" && rec.swf.size) {
            rememberOriginalSwfBlobUrl(originalSwfUrls.current, compiled.scene, rec.swf);
          }
        }
      }
      if (!cancelled) setHistory(rows);
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(toastTimer.current);
      activePlayer.current?.destroy();
      for (const url of originalSwfUrls.current.values()) URL.revokeObjectURL(url);
    };
  }, [acceptCompiled]);

  const setDepStatus = useCallback((scene: string, swf: string, status: DepStatus) => {
    setCards((prev) => {
      const card = prev[scene];
      if (!card || card.status !== "ready") return prev;
      return {
        ...prev,
        [scene]: {
          ...card,
          depState: { ...card.depState, [swf]: status },
        },
      };
    });
  }, []);

  const setAllDepsPending = useCallback((scene: string, compiled: CompiledScene) => {
    setCards((prev) => {
      const card = prev[scene];
      if (!card || card.status !== "ready") return prev;
      const next = { ...card.depState };
      for (const dep of compiled.dependencies) next[dep.swf] ??= "pending";
      return { ...prev, [scene]: { ...card, depState: next } };
    });
  }, []);

  const compile = useCallback(async (bytes: Uint8Array, name: string, options: { force?: boolean } = {}): Promise<CompiledScene> => {
    const scene = canonical(name);
    const done = options.force ? undefined : compiledScenes.current.get(scene);
    if (done) return done;
    const running = inFlight.current.get(scene);
    if (running && !options.force) return running;

    setCards((prev) => ({ ...prev, [scene]: { scene, name, status: "converting" } }));
    const promise = compileSceneAsync(bytes, scene)
      .then(async (compiled) => {
        await enrichExternalAssetWarnings(compiled);
        acceptCompiled(name, compiled);
        return compiled;
      })
      .catch((error: Error) => {
        setCards((prev) => ({
          ...prev,
          [scene]: { scene, name, status: "error", error: error.message || "convert failed" },
        }));
        throw error;
      })
      .finally(() => inFlight.current.delete(scene));
    inFlight.current.set(scene, promise);
    return promise;
  }, [acceptCompiled]);

  const persistCompiled = useCallback(async (name: string, bytes: Uint8Array, compiled: CompiledScene, options: { replaceId?: number } = {}) => {
    const row = {
      scene: compiled.scene,
      name,
      sourceType: "swf" as const,
      swf: new Blob([bytes.slice().buffer], { type: "application/x-shockwave-flash" }),
      stats: compiled.stats,
      width: compiled.width,
      height: compiled.height,
      compiled: storeCompiled(compiled),
    };
    try {
      if (options.replaceId) await updateConvert(options.replaceId, row);
      else await saveConvert({ ...row, createdAt: Date.now() });
      await refreshHistory();
    } catch (error) {
      showToast(`Converted ${name}, but could not save it: ${(error as Error).message}`);
    }
  }, [refreshHistory, showToast]);

  const ensureDependencyCompiled = useCallback(async (dep: { swf: string }): Promise<CompiledScene | null> => {
    const key = canonical(dep.swf);
    const done = compiledScenes.current.get(key);
    if (done) return done;
    const running = inFlight.current.get(key);
    if (running) return running;
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}${dep.swf}`);
      if (!response.ok) throw new Error("not found");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!isSwfBytes(bytes)) throw new Error("not a SWF");
      const compiled = await compile(bytes, dep.swf);
      rememberOriginalSwfUrl(originalSwfUrls.current, compiled.scene, bytes);
      await persistCompiled(dep.swf, bytes, compiled);
      return compiled;
    } catch {
      return null;
    }
  }, [compile, persistCompiled]);

  const resolveDependencies = useCallback(async (
    compiled: CompiledScene,
    visited = new Set<string>(),
    inheritedDefaults: Record<string, string | number | boolean> = {},
  ) => {
    if (!compiled.dependencies.length) return;
    const carriedDefaults = { ...inheritedDefaults, ...collectInheritableGlobalDefaults(compiled) };
    setAllDepsPending(compiled.scene, compiled);
    const startup = new Set(startupSwfs(compiled).map(canonical));
    const ordered = [...compiled.dependencies].sort(
      (a, b) => Number(startup.has(canonical(b.swf))) - Number(startup.has(canonical(a.swf))),
    );

    for (const dep of ordered) {
      const key = canonical(dep.swf);
      if (!compiledScenes.current.has(key)) {
        setDepStatus(compiled.scene, dep.swf, "compiling");
        const loaded = await ensureDependencyCompiled(dep);
        if (!loaded) {
          setDepStatus(compiled.scene, dep.swf, "missing");
          continue;
        }
      }

      if (!visited.has(key)) {
        visited.add(key);
        const depScene = compiledScenes.current.get(key);
        if (depScene && !startup.has(key) && applyInheritedGlobalDefaults(depScene, carriedDefaults)) {
          acceptCompiled(dep.swf, depScene);
        }
        if (depScene?.dependencies.length) {
          setDepStatus(compiled.scene, dep.swf, "linking");
          await resolveDependencies(depScene, visited, carriedDefaults);
        }
      }
      setDepStatus(compiled.scene, dep.swf, "done");
    }
  }, [acceptCompiled, ensureDependencyCompiled, setAllDepsPending, setDepStatus]);

  const ensureDependencies = useCallback((compiled: CompiledScene): Promise<void> => {
    const running = dependencyLoads.current.get(compiled.scene);
    if (running) return running;
    const load = resolveDependencies(compiled, new Set([compiled.scene]))
      .finally(() => dependencyLoads.current.delete(compiled.scene));
    dependencyLoads.current.set(compiled.scene, load);
    return load;
  }, [resolveDependencies]);

  const closePlayer = useCallback(() => {
    activePlayer.current?.destroy();
    activePlayer.current = null;
    if (playerEl.current) {
      playerEl.current.innerHTML = "";
      playerEl.current.removeAttribute("style");
    }
    if (playerWrap.current) playerWrap.current.removeAttribute("style");
    setPlayer({ visible: false, title: "" });
  }, []);

  const play = useCallback(async (scene: string, compiled: CompiledScene, name: string) => {
    closePlayer();
    registerPackedScene(scene, compiled.files, compiled.timeline);
    const dependencyLoad = ensureDependencies(compiled);
    const wrap = playerWrap.current;
    const stage = playerEl.current;
    if (!wrap || !stage) return;

    const availableW = Math.max(1, wrap.parentElement?.clientWidth ?? compiled.width);
    const targetW = Math.min(820, availableW);
    const scale = targetW / compiled.width;
    const stageW = Math.round(compiled.width * scale);
    const stageH = Math.round(compiled.height * scale);

    stage.style.width = `${compiled.width}px`;
    stage.style.height = `${compiled.height}px`;
    stage.style.transform = `scale(${scale})`;
    stage.style.transformOrigin = "top left";
    stage.style.marginBottom = `${stageH - compiled.height}px`;
    stage.style.background = compiled.timeline.backgroundColor || "#ffffff";
    wrap.style.width = `${stageW}px`;
    wrap.style.height = `${stageH + 48}px`;
    setPlayer({ visible: true, title: name });
    wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });

    const startupDeps = startupDependencies(compiled)
      .filter((dep) => !compiledScenes.current.has(canonical(dep.swf)));
    const waits = startupDeps.map((dep) => ensureDependencyCompiled(dep));
    if (waits.length) {
      setPlayer({ visible: true, title: `${name} - preparing ${waits.length} startup level${waits.length > 1 ? "s" : ""}` });
      await Promise.all(waits);
      setPlayer({ visible: true, title: name });
    }
    void dependencyLoad;

    try {
      activePlayer.current = await createTourPlayer(stage, { assetsBaseUrl: import.meta.env.BASE_URL, assetSource: "pack", scene, autoplay: true });
    } catch (error) {
      showToast(`Play failed: ${(error as Error).message}`);
    }
  }, [closePlayer, ensureDependencies, ensureDependencyCompiled, showToast]);

  const exportBundle = useCallback(async (compiled: CompiledScene) => {
    const scenes = collectReachableScenes(compiled, compiledScenes.current);
    // Bake loadVariables() text into the pack so the embedded player needs no extra
    // files — keeps the export a single self-contained, archive-loadable artifact.
    const vars = await collectLoadVariableFiles(scenes);
    const filename = `${compiled.scene}.mmtour.pack`;
    const bytes = exportArchiveForScenes(scenes, vars);
    downloadBytes(bytes, filename);
    const missing = reachableDependencyNames(compiled, compiledScenes.current).filter((name) => !compiledScenes.current.has(canonical(name)));
    setEmbed({
      filename,
      sceneSwf: compiled.timeline.source ?? `${compiled.scene}.swf`,
      scenes: scenes.length,
      sizeMb: bytes.byteLength / 1024 / 1024,
      missing: missing.length,
    });
  }, []);

  const importPack = useCallback(async (name: string, bytes: Uint8Array) => {
    try {
      const imported = await importArchiveScenes(bytes);
      if (!imported.length) throw new Error("No scenes found");
      const createdAt = Date.now();
      const source = new Blob([bytes.slice().buffer], { type: "application/octet-stream" });
      for (const [index, compiled] of imported.entries()) {
        const sceneName = compiled.timeline.source ?? `${compiled.scene}.swf`;
        acceptCompiled(sceneName, compiled);
        await saveConvert({
          scene: compiled.scene,
          name: sceneName,
          sourceType: "pack",
          swf: source,
          stats: compiled.stats,
          width: compiled.width,
          height: compiled.height,
          compiled: storeCompiled(compiled),
          createdAt: createdAt + index,
        });
      }
      await refreshHistory();
      for (const compiled of imported) void ensureDependencies(compiled);
      showToast(`Imported ${imported.length} scene${imported.length === 1 ? "" : "s"} from ${name}`);
    } catch (error) {
      showToast(`Import failed: ${(error as Error).message}`);
    }
  }, [acceptCompiled, ensureDependencies, refreshHistory, showToast]);

  const convertFile = useCallback(async (name: string, bytes: Uint8Array) => {
    try {
      const compiled = await compile(bytes, name, { force: true });
      rememberOriginalSwfUrl(originalSwfUrls.current, compiled.scene, bytes);
      await persistCompiled(name, bytes, compiled);
      await ensureDependencies(compiled);
    } catch (error) {
      showToast(`Convert failed: ${(error as Error).message}`);
    }
  }, [compile, ensureDependencies, persistCompiled, showToast]);

  const compareCompiled = useCallback(async (name: string, compiled: CompiledScene) => {
    if (!originalSwfUrls.current.get(compiled.scene)) {
      showToast("Compare needs the original SWF. Re-convert the SWF file to load it into Ruffle.");
      return;
    }
    // Switching tabs runs the compare effect, which syncs the whole converted
    // library into the lab and focuses this scene. If the tab is already open
    // the dependency on comparableScenes re-runs the effect for us.
    pendingCompareSwf.current = `${compiled.scene}.swf`;
    if (workspaceTab === "compare") {
      const mounted = labHandle.current;
      if (mounted) {
        pendingCompareSwf.current = undefined;
        await mounted.showComparableScenes(comparableScenes(), `${compiled.scene}.swf`);
      }
    } else {
      setWorkspaceTab("compare");
    }
  }, [comparableScenes, showToast, workspaceTab]);

  const handleFiles = useCallback(async (files: Iterable<File>) => {
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (/\.swf$/i.test(file.name)) await convertFile(file.name, bytes);
      else if (/\.mmtour\.pack$/i.test(file.name)) await importPack(file.name, bytes);
    }
  }, [convertFile, importPack]);

  const handleDropClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    fileInput.current?.click();
  }, []);

  const handleDrop = useCallback(async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    await handleFiles(Array.from(event.dataTransfer.files));
  }, [handleFiles]);

  const handleFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    await handleFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }, [handleFiles]);

  const convertSample = useCallback(async (name: string) => {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}${name}.swf`);
      if (!response.ok) throw new Error("not found");
      await convertFile(`${name}.swf`, new Uint8Array(await response.arrayBuffer()));
    } catch {
      showToast(`Could not load ${name}.swf`);
    }
  }, [convertFile, showToast]);

  const playHistory = useCallback(async (record: ConvertRecord) => {
    const recordId = record.id;
    if (recordId === undefined) return;
    const full = await getConvert(recordId);
    if (!full) return;
    let compiled = full.compiled && isCompiledCurrent(full.compiled)
      ? reviveCompiled(full.compiled)
      : compiledScenes.current.get(full.scene ?? canonical(full.name));
    if (compiled) {
      acceptCompiled(full.name, compiled);
    } else if (full.swf.size) {
      const bytes = new Uint8Array(await full.swf.arrayBuffer());
      if (full.sourceType === "pack" || !isSwfBytes(bytes)) {
        const imported = await importArchiveScenes(bytes);
        compiled = imported.find((scene) => scene.scene === (full.scene ?? canonical(full.name))) ?? imported[0];
        if (!compiled) return;
        for (const scene of imported) acceptCompiled(scene.timeline.source ?? `${scene.scene}.swf`, scene);
        await updateConvert(recordId, {
          scene: compiled.scene,
          name: compiled.timeline.source ?? full.name,
          sourceType: "pack",
          stats: compiled.stats,
          width: compiled.width,
          height: compiled.height,
          compiled: storeCompiled(compiled),
        });
        await refreshHistory();
      } else {
        compiled = await compile(bytes, full.name);
        rememberOriginalSwfUrl(originalSwfUrls.current, compiled.scene, bytes);
        await persistCompiled(full.name, bytes, compiled, { replaceId: recordId });
      }
    } else if (full.compiled) {
      compiled = reviveCompiled(full.compiled);
      acceptCompiled(full.name, compiled);
    } else {
      return;
    }
    if (full.swf.size && compiled && full.sourceType !== "pack") {
      rememberOriginalSwfUrl(originalSwfUrls.current, compiled.scene, new Uint8Array(await full.swf.arrayBuffer()));
    }
    void ensureDependencies(compiled);
    await play(compiled.scene, compiled, full.name);
  }, [acceptCompiled, compile, ensureDependencies, persistCompiled, play]);

  const compareHistory = useCallback(async (record: ConvertRecord) => {
    const recordId = record.id;
    if (recordId === undefined) return;
    const full = await getConvert(recordId);
    if (!full) return;
    if ((full.sourceType ?? "swf") !== "swf") {
      showToast("Imported packs do not include an original SWF for Ruffle comparison.");
      return;
    }
    let compiled = full.compiled && isCompiledCurrent(full.compiled)
      ? reviveCompiled(full.compiled)
      : compiledScenes.current.get(full.scene ?? canonical(full.name));
    if (!compiled && full.swf.size) {
      const bytes = new Uint8Array(await full.swf.arrayBuffer());
      if (!isSwfBytes(bytes)) {
        showToast("Compare needs an original SWF source.");
        return;
      }
      compiled = await compile(bytes, full.name);
      await persistCompiled(full.name, bytes, compiled, { replaceId: recordId });
    }
    if (!compiled) return;
    acceptCompiled(full.name, compiled);
    if (full.swf.size) rememberOriginalSwfBlobUrl(originalSwfUrls.current, compiled.scene, full.swf);
    void ensureDependencies(compiled);
    await compareCompiled(full.name, compiled);
  }, [acceptCompiled, compareCompiled, compile, ensureDependencies, persistCompiled, showToast]);

  const removeScene = useCallback((scene: string) => {
    unregisterPackedScene(scene);
    clearTimelineCache();
    compiledScenes.current.delete(scene);
    const originalUrl = originalSwfUrls.current.get(scene);
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    originalSwfUrls.current.delete(scene);
    setCards((prev) => {
      const next = { ...prev };
      delete next[scene];
      return next;
    });
  }, []);

  const deleteHistoryItem = useCallback(async (record: ConvertRecord) => {
    if (!record.id) return;
    const scene = record.scene ?? canonical(record.name);
    await deleteConvert(record.id);
    const rows = await listConverts();
    const replacement = rows.find((row) => (row.scene ?? canonical(row.name)) === scene);
    if (replacement?.compiled && isCompiledCurrent(replacement.compiled)) {
      acceptCompiled(replacement.name, reviveCompiled(replacement.compiled));
    } else if (replacement?.id) {
      const full = await getConvert(replacement.id);
      if (full?.swf.size) {
        const compiled = await compile(new Uint8Array(await full.swf.arrayBuffer()), full.name, { force: true });
        acceptCompiled(full.name, compiled);
      } else {
        removeScene(scene);
      }
    } else {
      removeScene(scene);
    }
    setHistory(rows);
  }, [acceptCompiled, compile, removeScene]);

  const clearAll = useCallback(async () => {
    await clearHistory();
    closePlayer();
    clearPackedScenes();
    clearTimelineCache();
    compiledScenes.current.clear();
    for (const url of originalSwfUrls.current.values()) URL.revokeObjectURL(url);
    originalSwfUrls.current.clear();
    inFlight.current.clear();
    dependencyLoads.current.clear();
    setCards({});
    await refreshHistory();
    showToast("History cleared");
  }, [closePlayer, refreshHistory, showToast]);

  const tree = useMemo(() => buildTree(cards), [cards]);
  const histGroups = useMemo(() => groupHistory(history), [history]);
  const toggleCollapse = useCallback((key: string) => setCollapsed((set) => toggleKey(set, key)), []);
  const toggleDetail = useCallback((key: string) => setOpenDetail((set) => toggleKey(set, key)), []);
  const toggleHist = useCallback((key: string) => setHistOpen((set) => toggleKey(set, key)), []);

  return (
    <div className="studio-shell">
      <header className="studio-header">
        <div className="topbar">
          <div>
            <h1>SWF Studio</h1>
            <p>Convert, inspect, compare, play, and export embeddable Flash tours in one workspace.</p>
          </div>
          <div className="topbar-actions">
            <button
              className="theme-toggle"
              type="button"
              aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
              aria-pressed={theme === "dark"}
              title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
              onClick={() => setTheme((value) => value === "light" ? "dark" : "light")}
            >
              <span className="sun" aria-hidden="true">☼</span>
              <span className="moon" aria-hidden="true">☾</span>
            </button>
          </div>
        </div>
      </header>

      <nav className="workspace-tabs" aria-label="SWF Studio workspaces">
        <button
          type="button"
          className={workspaceTab === "library" ? "active" : ""}
          aria-pressed={workspaceTab === "library"}
          onClick={() => setWorkspaceTab("library")}
        >
          Convert
        </button>
        <button
          type="button"
          className={workspaceTab === "compare" ? "active" : ""}
          aria-pressed={workspaceTab === "compare"}
          onClick={() => setWorkspaceTab("compare")}
        >
          Compare
        </button>
      </nav>

      <section className="compare-workspace" aria-label="Ruffle comparison workspace" hidden={workspaceTab !== "compare"}>
        <div ref={labMount} className="lab-mount" />
      </section>

      <div className="layout" hidden={workspaceTab !== "library"}>
        <main>
          <div
            id="drop"
            className={dragging ? "drag" : ""}
            tabIndex={0}
            onClick={handleDropClick}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <div><strong>Drop .swf or .mmtour.pack files here</strong> or click to choose</div>
            <small>Batch conversion and pack import supported.</small>
            <input ref={fileInput} id="file" type="file" accept=".swf,.mmtour.pack" multiple hidden onChange={handleFileChange} />
            <div className="samples" id="samples">
              <span>Bundled tour:</span>
              {SAMPLES.map((name) => (
                <button key={name} type="button" onClick={() => void convertSample(name)}>{name}</button>
              ))}
            </div>
          </div>

          <div ref={playerWrap} id="player-wrap" className={player.visible ? "on" : ""}>
            <div ref={playerEl} id="player" />
            <div className="player-bar">
              <span className="title" id="player-title">{player.title}</span>
              <button type="button" id="btn-play" onClick={() => activePlayer.current?.toggle()}>Play/Pause</button>
              <button type="button" id="btn-restart" onClick={() => activePlayer.current?.restart()}>Restart</button>
              <button type="button" id="btn-close" onClick={closePlayer}>Close</button>
            </div>
          </div>

          <div className="cards" id="cards">
            {tree.length ? tree.map((node) => (
              <SceneNode
                key={node.key}
                node={node}
                cards={cards}
                collapsed={collapsed}
                openDetail={openDetail}
                onToggleCollapse={toggleCollapse}
                onToggleDetail={toggleDetail}
                onPlay={play}
                onCompare={compareCompiled}
                onExport={exportBundle}
              />
            )) : (
              <p className="cards-empty">
                Converted tours appear here. Drop a <code>.swf</code> or pick a bundled tour above.
              </p>
            )}
          </div>
        </main>

        <aside>
          <h2>
            <span>History</span>
            <button className="ghost" id="clear-hist" type="button" onClick={() => void clearAll()}>clear</button>
          </h2>
          <div className="hist" id="hist">
            {histGroups.length ? histGroups.map((group) => (
              <HistoryGroup
                key={group.key}
                group={group}
                open={histOpen.has(group.key)}
                onToggle={() => toggleHist(group.key)}
                onPlay={(record) => void playHistory(record)}
                onCompare={(record) => void compareHistory(record)}
                onDelete={(record) => void deleteHistoryItem(record)}
              />
            )) : <div className="empty">No converts yet.</div>}
          </div>
        </aside>
      </div>

      <div id="toast" className={toast ? "on" : ""}>{toast}</div>
      {embed && <EmbedDialog info={embed} onClose={() => setEmbed(null)} showToast={showToast} />}
    </div>
  );
}

function EmbedDialog({ info, onClose, showToast }: { info: EmbedInfo; onClose: () => void; showToast: (m: string) => void }) {
  const origin = typeof location !== "undefined" ? location.origin : "";
  const base = `${origin}${import.meta.env.BASE_URL}`.replace(/\/+$/, "/");
  const playerJs = `${base}mmtour-player.js`;
  const playerCss = `${base}mmtour-player.css`;
  const sceneAttr = info.sceneSwf === "A-tour.swf" ? "" : `\n    scene: ${JSON.stringify(info.sceneSwf)},`;
  const snippet = `<link rel="stylesheet" href="${playerCss}" />
<div id="tour" style="width:640px;height:480px;position:relative;overflow:hidden"></div>
<script type="module">
  import { createTourPlayer } from "${playerJs}";
  await createTourPlayer(document.getElementById("tour"), {
    assetSource: "archive",
    archiveUrl: "./${info.filename}",${sceneAttr}
    autoplay: true,
  });
</script>`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      showToast("Embed snippet copied");
    } catch {
      showToast("Copy failed — select the snippet manually");
    }
  };

  return (
    <div className="embed-backdrop" role="dialog" aria-modal="true" aria-label="Embed snippet" onClick={onClose}>
      <div className="embed-dialog" onClick={(event) => event.stopPropagation()}>
        <header>
          <h3>Embed this tour</h3>
          <button className="ghost" type="button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <p>
          Downloaded <strong>{info.filename}</strong> — {info.scenes} scene{info.scenes === 1 ? "" : "s"},{" "}
          {info.sizeMb.toFixed(1)} MB, one self-contained file.
          {info.missing > 0 && <span className="warn"> ({info.missing} dependency missing — convert it too for a complete tour.)</span>}
        </p>
        <ol>
          <li>Host <code>{info.filename}</code> anywhere that serves over HTTP.</li>
          <li>Drop this snippet into your page (the player runtime is served from this site):</li>
        </ol>
        <pre className="embed-snippet"><code>{snippet}</code></pre>
        <div className="embed-actions">
          <button type="button" onClick={() => void copy()}>Copy snippet</button>
          <span className="dim">Point <code>archiveUrl</code> at wherever you host the pack.</span>
        </div>
      </div>
    </div>
  );
}

function SceneNode({
  node,
  cards,
  depth = 0,
  collapsed,
  openDetail,
  onToggleCollapse,
  onToggleDetail,
  onPlay,
  onCompare,
  onExport,
}: {
  node: TreeNode;
  cards: Record<string, CardView>;
  depth?: number;
  collapsed: Set<string>;
  openDetail: Set<string>;
  onToggleCollapse: (key: string) => void;
  onToggleDetail: (key: string) => void;
  onPlay: (scene: string, compiled: CompiledScene, name: string) => Promise<void>;
  onCompare: (name: string, compiled: CompiledScene) => Promise<void>;
  onExport: (compiled: CompiledScene) => void;
}) {
  const card = cards[node.key];
  if (node.reference) {
    return (
      <div className="ref-node">
        <span>↑ {card?.name ?? `${node.key}.swf`}</span>
        <em>shown above</em>
      </div>
    );
  }
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.key);
  return (
    <div className="node">
      {card && (
        <TreeRow
          card={card}
          root={depth === 0}
          hasChildren={hasChildren}
          collapsed={isCollapsed}
          detail={openDetail.has(node.key)}
          onToggleCollapse={() => onToggleCollapse(node.key)}
          onToggleDetail={() => onToggleDetail(node.key)}
          onPlay={onPlay}
          onCompare={onCompare}
          onExport={onExport}
        />
      )}
      {hasChildren && !isCollapsed && (
        <div className="children">
          {node.children.map((child) => (
            <SceneNode
              key={`${node.key}/${child.key}`}
              node={child}
              cards={cards}
              depth={depth + 1}
              collapsed={collapsed}
              openDetail={openDetail}
              onToggleCollapse={onToggleCollapse}
              onToggleDetail={onToggleDetail}
              onPlay={onPlay}
              onCompare={onCompare}
              onExport={onExport}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TreeRow({
  card,
  root,
  hasChildren,
  collapsed,
  detail,
  onToggleCollapse,
  onToggleDetail,
  onPlay,
  onCompare,
  onExport,
}: {
  card: CardView;
  root: boolean;
  hasChildren: boolean;
  collapsed: boolean;
  detail: boolean;
  onToggleCollapse: () => void;
  onToggleDetail: () => void;
  onPlay: (scene: string, compiled: CompiledScene, name: string) => Promise<void>;
  onCompare: (name: string, compiled: CompiledScene) => Promise<void>;
  onExport: (compiled: CompiledScene) => void;
}) {
  const ready = card.status === "ready" ? card : null;
  const compiled = ready?.compiled;
  const s = compiled?.stats;
  const dep = ready ? depSummary(ready) : null;
  return (
    <>
      <div className={`trow${root ? " root" : ""}${card.status === "converting" ? " busy" : ""}`}>
        <button
          className="chev"
          type="button"
          aria-label={collapsed ? "Expand linked SWFs" : "Collapse linked SWFs"}
          aria-expanded={!collapsed}
          disabled={!hasChildren}
          onClick={onToggleCollapse}
        >
          {hasChildren ? (collapsed ? "▸" : "▾") : ""}
        </button>
        <button className="rowmain" type="button" aria-expanded={detail} onClick={onToggleDetail}>
          <span className="name">{card.name}</span>
          {compiled && <span className="dim">{compiled.width}×{compiled.height}</span>}
          {ready && s ? (
            <span className="sum">
              {(s.assetBytes / 1024 / 1024).toFixed(2)} MB · {s.frames} fr
              {dep && <> · <span className={`dep-mini ${dep.cls}`}>{dep.text}</span></>}
            </span>
          ) : card.status === "converting" ? (
            <span className="sum">converting…</span>
          ) : (
            <span className="sum err">failed: {card.status === "error" ? card.error : ""}</span>
          )}
        </button>
        {ready && compiled && (
          <span className="rowacts">
            <button className="play" type="button" onClick={() => void onPlay(compiled.scene, compiled, card.name)}>Play</button>
            <button className="compare" type="button" onClick={() => void onCompare(card.name, compiled)}>Compare</button>
            <button className="export" type="button" onClick={() => onExport(compiled)}>Export</button>
          </span>
        )}
      </div>
      {detail && ready && compiled && s && (
        <div className="trow-detail">
          <div className="statgrid">
            <Stat value={s.shapes} label="shapes" />
            <Stat value={s.images} label="images" />
            <Stat value={s.fonts} label="fonts" />
            <Stat value={s.sounds} label="sounds" />
            <Stat value={s.buttons} label="buttons" />
            <Stat value={s.texts} label="texts" />
            <Stat value={s.frames} label="frames" />
            <Stat value={s.sprites} label="sprites" />
            <Stat value={s.stopFrames} label="stops" />
          </div>
          <div className="meta">{(s.assetBytes / 1024 / 1024).toFixed(2)} MB assets · compiled in {s.ms} ms</div>
          {compiled.dependencies.length > 0 && <DependencyLine card={ready} />}
          {externalMissing(compiled).length > 0 && <ExternalAssetLine compiled={compiled} />}
        </div>
      )}
    </>
  );
}

function depSummary(card: Extract<CardView, { status: "ready" }>): { text: string; cls: string } | null {
  const deps = card.compiled.dependencies;
  if (!deps.length) return null;
  const statuses = deps.map((dep) => card.depState[dep.swf] ?? "pending");
  const settled = statuses.filter((status) => status === "done" || status === "missing").length;
  if (settled < deps.length) return { text: `linking ${settled}/${deps.length}`, cls: "work" };
  const missing = statuses.filter((status) => status === "missing").length;
  if (missing) return { text: `${missing} missing`, cls: "warn" };
  return { text: `links ${deps.length}`, cls: "ok" };
}

function DependencyLine({ card }: { card: Extract<CardView, { status: "ready" }> }) {
  const total = card.compiled.dependencies.length;
  const finished = card.compiled.dependencies.filter((dep) => {
    const status = card.depState[dep.swf];
    return status === "done" || status === "missing";
  }).length;
  const active = card.compiled.dependencies.find((dep) => {
    const status = card.depState[dep.swf];
    return status === "compiling" || status === "linking";
  });
  const activeStatus = active ? card.depState[active.swf] : undefined;
  const prefix = finished < total
    ? `linking ${finished}/${total}${active ? ` - ${activeStatus === "linking" ? "resolving" : "compiling"} ${active.swf}` : ""}`
    : `links ${total} SWF${total > 1 ? "s" : ""}:`;
  const hasMissing = Object.values(card.depState).includes("missing");

  return (
    <div className="meta dep">
      <span>{prefix}</span>{" "}
      {card.compiled.dependencies.map((dep) => (
        <span key={dep.swf} className={`pill ${card.depState[dep.swf] ?? "pending"}`}>{dep.swf}</span>
      ))}
      {finished >= total && (
        <span className={hasMissing ? "dep-tail warn" : "dep-tail ok"}>
          {hasMissing ? " missing assets" : " all compiled"}
        </span>
      )}
    </div>
  );
}

function ExternalAssetLine({ compiled }: { compiled: CompiledScene }) {
  const missing = externalMissing(compiled);
  const visible = missing.slice(0, 8);
  const extra = missing.length - visible.length;
  return (
    <div className="meta dep">
      <span className="dep-tail warn">{missing.length} external asset{missing.length === 1 ? "" : "s"} missing:</span>{" "}
      {visible.map((asset) => (
        <span key={asset.ref} className="pill missing" title={asset.ref}>{asset.ref}</span>
      ))}
      {extra > 0 && <span className="dep-tail warn">+{extra} more</span>}
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return <div><b>{value}</b><span>{label}</span></div>;
}

function HistoryGroup({
  group,
  open,
  onToggle,
  onPlay,
  onCompare,
  onDelete,
}: {
  group: HistGroup;
  open: boolean;
  onToggle: () => void;
  onPlay: (record: ConvertRecord) => void;
  onCompare: (record: ConvertRecord) => void;
  onDelete: (record: ConvertRecord) => void;
}) {
  const { root, children } = group;
  return (
    <div className="hgroup">
      <HistRow
        record={root}
        isRoot
        childCount={children.length}
        open={open}
        onToggle={children.length ? onToggle : undefined}
        onPlay={() => onPlay(root)}
        onCompare={() => onCompare(root)}
        onDelete={() => onDelete(root)}
      />
      {open && children.map((child) => (
        <HistRow
          key={child.id ?? `${child.scene}-${child.createdAt}`}
          record={child}
          onPlay={() => onPlay(child)}
          onCompare={() => onCompare(child)}
          onDelete={() => onDelete(child)}
        />
      ))}
    </div>
  );
}

function HistRow({
  record,
  isRoot = false,
  childCount = 0,
  open = false,
  onToggle,
  onPlay,
  onCompare,
  onDelete,
}: {
  record: ConvertRecord;
  isRoot?: boolean;
  childCount?: number;
  open?: boolean;
  onToggle?: () => void;
  onPlay: () => void;
  onCompare: () => void;
  onDelete: () => void;
}) {
  const s = record.stats;
  const sourceType = record.sourceType === "pack" ? "pack" : "swf";
  const sub = isRoot
    ? (childCount ? `+${childCount} linked` : "standalone")
    : `${s.shapes}sh ${s.images}img ${s.frames}fr`;
  return (
    <div className={`hrow${isRoot ? " root" : " child"}`}>
      {isRoot && (
        <button
          className="chev"
          type="button"
          aria-label={open ? "Collapse linked SWFs" : "Expand linked SWFs"}
          aria-expanded={open}
          disabled={!onToggle}
          onClick={onToggle}
        >
          {childCount ? (open ? "▾" : "▸") : ""}
        </button>
      )}
      <img src={record.thumb ?? transparentPixel()} alt="" />
      <div className="info">
        <b><span>{record.name}</span><em>{sourceType}</em></b>
        <span>{record.width}×{record.height} · {sub} · {new Date(record.createdAt).toLocaleDateString()}</span>
      </div>
      <div className="acts">
        <button type="button" onClick={onPlay} aria-label={`Play ${record.name}`}>Play</button>
        {sourceType === "swf" && <button type="button" onClick={onCompare} aria-label={`Compare ${record.name}`}>Compare</button>}
        <button type="button" onClick={onDelete} aria-label={`Delete ${record.name}`}>Delete</button>
      </div>
    </div>
  );
}

function initialTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "dark" || stored === "light" ? stored : "light";
}

function readyDepState(compiled: CompiledScene, previous: CardView | undefined): Record<string, DepStatus> {
  const existing = previous?.status === "ready" ? previous.depState : {};
  const out = { ...existing };
  for (const dep of compiled.dependencies) out[dep.swf] ??= "pending";
  return out;
}

function buildTree(cards: Record<string, CardView>): TreeNode[] {
  const childOf = new Set<string>();
  for (const card of Object.values(cards)) {
    if (card.status !== "ready") continue;
    for (const dep of card.compiled.dependencies) {
      const key = canonical(dep.swf);
      if (cards[key]) childOf.add(key);
    }
  }

  const roots = Object.keys(cards).filter((key) => !childOf.has(key));
  const placed = new Set<string>();
  const render = (key: string): TreeNode => {
    if (placed.has(key)) return { key, children: [], reference: true };
    placed.add(key);
    const card = cards[key];
    const childKeys = card?.status === "ready"
      ? unique(card.compiled.dependencies.map((dep) => canonical(dep.swf)).filter((child) => Boolean(cards[child])))
      : [];
    return { key, children: childKeys.map(render) };
  };
  const out = roots.map(render);
  for (const key of Object.keys(cards)) if (!placed.has(key)) out.push(render(key));
  return out;
}

function toggleKey(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Group saved converts under their root tour: a record nothing else depends on becomes a
 *  header, its transitively-linked SWFs nest beneath it. Keeps only the latest convert per
 *  scene so re-runs collapse instead of stacking. Mirrors buildTree's root detection. */
function groupHistory(history: ConvertRecord[]): HistGroup[] {
  const keyOf = (record: ConvertRecord) => record.scene ?? canonical(record.name);
  const depsOf = (record: ConvertRecord) =>
    (record.compiled?.dependencies ?? []).map((dep) => canonical(dep.swf));

  // History arrives newest-first; keep the most recent convert per scene.
  const latest = new Map<string, ConvertRecord>();
  for (const record of history) {
    const key = keyOf(record);
    if (!latest.has(key)) latest.set(key, record);
  }
  const records = [...latest.values()];

  const childKeys = new Set<string>();
  for (const record of records) {
    for (const dep of depsOf(record)) if (latest.has(dep)) childKeys.add(dep);
  }

  const collectChildren = (root: ConvertRecord): ConvertRecord[] => {
    const out: ConvertRecord[] = [];
    const seen = new Set<string>([keyOf(root)]);
    const stack = [...depsOf(root)];
    while (stack.length) {
      const key = stack.pop();
      if (key === undefined || seen.has(key)) continue;
      seen.add(key);
      const rec = latest.get(key);
      if (!rec) continue;
      out.push(rec);
      stack.push(...depsOf(rec));
    }
    return out;
  };

  const groups: HistGroup[] = [];
  const placed = new Set<string>();
  for (const record of records) {
    const key = keyOf(record);
    if (childKeys.has(key)) continue; // depended upon by another tour — not a root
    const children = collectChildren(record);
    placed.add(key);
    for (const child of children) placed.add(keyOf(child));
    groups.push({ key, root: record, children });
  }
  // Records unreachable from any root (dependency cycle, or no cached deps) stand alone.
  for (const record of records) {
    const key = keyOf(record);
    if (placed.has(key)) continue;
    placed.add(key);
    groups.push({ key, root: record, children: [] });
  }
  return groups;
}

function storeCompiled(compiled: CompiledScene): StoredCompiledScene {
  return {
    version: COMPILED_CACHE_VERSION,
    scene: compiled.scene,
    timeline: compiled.timeline,
    files: [...compiled.files.entries()].map(([path, file]) => ({
      path,
      type: file.type,
      bytes: file.bytes.slice(),
    })),
    stats: compiled.stats,
    width: compiled.width,
    height: compiled.height,
    dependencies: compiled.dependencies.map((dep) => ({ ...dep })),
    externalAssets: (compiled.externalAssets ?? []).map((asset) => ({ ...asset })),
  };
}

function isCompiledCurrent(stored: StoredCompiledScene): boolean {
  return stored.version === COMPILED_CACHE_VERSION;
}

function reviveCompiled(stored: StoredCompiledScene): CompiledScene {
  const files = new Map<string, { type: string; bytes: Uint8Array }>();
  for (const file of stored.files) files.set(file.path, { type: file.type, bytes: file.bytes });
  return {
    scene: stored.scene,
    timeline: stored.timeline,
    files,
    stats: stored.stats,
    width: stored.width,
    height: stored.height,
    dependencies: stored.dependencies ?? [],
    externalAssets: stored.externalAssets ?? stored.timeline?.control?.externalAssets ?? [],
  };
}

async function enrichExternalAssetWarnings(compiled: CompiledScene) {
  const refs = new Map<string, ExternalAssetRef>();
  for (const asset of compiled.externalAssets ?? []) refs.set(asset.ref.toLowerCase(), { ...asset });

  const xmlCandidates = new Set<string>();
  for (const asset of refs.values()) if (asset.kind === "xml") xmlCandidates.add(asset.ref);
  xmlCandidates.add(`xml/${compiled.scene}_en.xml`);
  xmlCandidates.add(`xml/${compiled.scene}.xml`);

  for (const ref of xmlCandidates) {
    const text = await fetchTextAsset(ref);
    if (text == null) continue;
    addExternalRef(refs, ref, "xml");
    for (const found of externalRefsInText(text)) addExternalRef(refs, found, "xml");
  }

  const assets = await Promise.all([...refs.values()].map(async (asset) => ({
    ...asset,
    present: await assetPresent(asset.ref),
  })));
  compiled.externalAssets = assets
    .filter((asset) => asset.ref !== compiled.scene && asset.ref !== `${compiled.scene}.swf`)
    .sort((a, b) => Number(a.present) - Number(b.present) || a.ref.localeCompare(b.ref));
  compiled.timeline.control ??= {};
  compiled.timeline.control.externalAssets = compiled.externalAssets;
  const timelineFile = compiled.files.get("timeline.json");
  if (timelineFile) {
    timelineFile.bytes = new TextEncoder().encode(JSON.stringify(compiled.timeline));
  }
}

function externalRefsInText(text: string): string[] {
  const refs: string[] = [];
  for (const pattern of [
    /(?:src|href|value|rawValue|arguments)"?\s*[:=]\s*"?([^"'<>\s]+\.(?:swf|xml|png|jpe?g|gif|webp|mp3|wav))/gi,
    /["']([^"']+\.(?:swf|xml|png|jpe?g|gif|webp|mp3|wav))["']/gi,
  ]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) refs.push(match[1]);
  }
  return refs;
}

async function fetchTextAsset(ref: string): Promise<string | null> {
  try {
    const response = await fetch(assetHref(ref), { cache: "no-store" });
    // Ignore an index.html SPA fallback so a missing XML doesn't get parsed for
    // (and falsely register) asset references.
    if (!response.ok || isHtmlResponse(response)) return null;
    return response.text();
  } catch {
    return null;
  }
}

async function assetPresent(ref: string): Promise<boolean> {
  try {
    // A dev/SPA host answers a missing file with its index.html (HTTP 200,
    // text/html) instead of a 404. Every ref we probe here is binary or XML, so
    // an HTML response means the asset is not really there — treat it as missing
    // rather than reporting it present and hiding the gap from the user.
    let response = await fetch(assetHref(ref), { method: "HEAD", cache: "no-store" });
    if (response.status === 405) response = await fetch(assetHref(ref), { cache: "no-store" });
    if (!response.ok) return false;
    return !isHtmlResponse(response);
  } catch {
    return false;
  }
}

function isHtmlResponse(response: Response): boolean {
  return /\btext\/html\b/i.test(response.headers.get("content-type") ?? "");
}

function assetHref(ref: string): string {
  return `${import.meta.env.BASE_URL}${ref.replace(/^\/+/, "")}`;
}

function externalMissing(compiled: CompiledScene): ExternalAssetRef[] {
  return (compiled.externalAssets ?? []).filter((asset) => asset.present === false);
}

function canonical(name: string): string {
  return name.replace(/\.swf$/i, "").replace(/[^\w.-]+/g, "-");
}

function isSwfBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 3) return false;
  const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
  return sig === "FWS" || sig === "CWS" || sig === "ZWS";
}

function startupSwfs(compiled: CompiledScene): string[] {
  return unique((compiled.timeline.control?.frameActions ?? [])
    .flatMap((frame: any) => frame.actions ?? [])
    .filter((action: any) => action.swf && !action.functionName)
    .map((action: any) => String(action.swf)));
}

function startupDependencies(compiled: CompiledScene) {
  const startupKeys = new Set(startupSwfs(compiled).map(canonical));
  return compiled.dependencies.filter((dep) => startupKeys.has(canonical(dep.swf)));
}

function collectReachableScenes(root: CompiledScene, compiled: Map<string, CompiledScene>): CompiledScene[] {
  const out: CompiledScene[] = [];
  const seen = new Set<string>();
  const visit = (scene: CompiledScene) => {
    if (seen.has(scene.scene)) return;
    seen.add(scene.scene);
    out.push(scene);
    for (const dep of scene.dependencies) {
      const child = compiled.get(canonical(dep.swf));
      if (child) visit(child);
    }
  };
  visit(root);
  return out;
}

/** Fetch the loadVariables() text files (`nav.txt`, …) the scenes reference, so the
 *  exported pack can carry them. Resolution mirrors PlayerController.handleLoadVariables. */
async function collectLoadVariableFiles(scenes: CompiledScene[]): Promise<Record<string, string>> {
  const names = new Set<string>();
  const visit = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.command === "loadVariables") {
      const swf = typeof record.swf === "string" && !/\.swf$/i.test(record.swf) ? record.swf : undefined;
      const file = (record.variableSource as string) ?? swf ?? (record.target as string);
      if (typeof file === "string" && file) names.add(file.replace(/^\//, ""));
    }
    for (const item of Object.values(record)) visit(item);
  };
  for (const scene of scenes) visit(scene.timeline?.control);

  const vars: Record<string, string> = {};
  await Promise.all([...names].map(async (name) => {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}${name}`);
      if (res.ok) vars[name] = await res.text();
    } catch {
      /* a missing loadVariables file just leaves those fields blank */
    }
  }));
  return vars;
}

function reachableDependencyNames(root: CompiledScene, compiled: Map<string, CompiledScene>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const visit = (scene: CompiledScene) => {
    if (seen.has(scene.scene)) return;
    seen.add(scene.scene);
    for (const dep of scene.dependencies) {
      names.push(dep.swf);
      const child = compiled.get(canonical(dep.swf));
      if (child) visit(child);
    }
  };
  visit(root);
  return unique(names);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function transparentPixel() {
  return "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
}

function rememberOriginalSwfUrl(urls: Map<string, string>, scene: string, bytes: Uint8Array) {
  const existing = urls.get(scene);
  if (existing) URL.revokeObjectURL(existing);
  urls.set(scene, URL.createObjectURL(new Blob([bytes.slice().buffer], { type: "application/x-shockwave-flash" })));
}

function rememberOriginalSwfBlobUrl(urls: Map<string, string>, scene: string, blob: Blob) {
  const existing = urls.get(scene);
  if (existing) URL.revokeObjectURL(existing);
  urls.set(scene, URL.createObjectURL(blob));
}
