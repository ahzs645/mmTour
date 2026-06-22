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

setAssetSource("pack");
setPackNetworkFallback(false);

const SAMPLES = ["A-tour", "intro", "nav", "segment1", "segment4", "segment5"];
const THEME_KEY = "mmtour-theme";

type Theme = "light" | "dark";
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

export function SwfStudioApp() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [cards, setCards] = useState<Record<string, CardView>>({});
  const [history, setHistory] = useState<ConvertRecord[]>([]);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState("");
  const [player, setPlayer] = useState<PlayerView>({ visible: false, title: "" });
  const toastTimer = useRef<number | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const playerWrap = useRef<HTMLDivElement | null>(null);
  const playerEl = useRef<HTMLDivElement | null>(null);
  const activePlayer = useRef<TourPlayer | null>(null);
  const compiledScenes = useRef(new Map<string, CompiledScene>());
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
        if (rec.compiled && isCompiledCurrent(rec.compiled)) acceptCompiled(rec.name, reviveCompiled(rec.compiled));
      }
      if (!cancelled) setHistory(rows);
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(toastTimer.current);
      activePlayer.current?.destroy();
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
      .then((compiled) => {
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

  const exportBundle = useCallback((compiled: CompiledScene) => {
    const scenes = collectReachableScenes(compiled, compiledScenes.current);
    const bytes = exportArchiveForScenes(scenes);
    downloadBytes(bytes, `${compiled.scene}.mmtour.pack`);
    const missing = reachableDependencyNames(compiled, compiledScenes.current).filter((name) => !compiledScenes.current.has(canonical(name)));
    showToast(`Exported ${scenes.length} scene${scenes.length === 1 ? "" : "s"}${missing.length ? `; ${missing.length} missing` : ""}`);
  }, [showToast]);

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
      await persistCompiled(name, bytes, compiled);
      await ensureDependencies(compiled);
    } catch (error) {
      showToast(`Convert failed: ${(error as Error).message}`);
    }
  }, [compile, ensureDependencies, persistCompiled, showToast]);

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
        await persistCompiled(full.name, bytes, compiled, { replaceId: recordId });
      }
    } else if (full.compiled) {
      compiled = reviveCompiled(full.compiled);
      acceptCompiled(full.name, compiled);
    } else {
      return;
    }
    void ensureDependencies(compiled);
    await play(compiled.scene, compiled, full.name);
  }, [acceptCompiled, compile, ensureDependencies, persistCompiled, play]);

  const removeScene = useCallback((scene: string) => {
    unregisterPackedScene(scene);
    clearTimelineCache();
    compiledScenes.current.delete(scene);
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
    inFlight.current.clear();
    dependencyLoads.current.clear();
    setCards({});
    await refreshHistory();
    showToast("History cleared");
  }, [closePlayer, refreshHistory, showToast]);

  const tree = useMemo(() => buildTree(cards), [cards]);

  return (
    <div className="studio-shell">
      <header className="studio-header">
        <div className="topbar">
          <div>
            <h1>SWF Studio</h1>
            <p>Convert and play Flash tour files locally in the browser.</p>
          </div>
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
      </header>

      <div className="layout">
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
            {tree.map((node) => (
              <SceneNode key={node.key} node={node} cards={cards} onPlay={play} onExport={exportBundle} />
            ))}
          </div>
        </main>

        <aside>
          <h2>
            <span>History</span>
            <button className="ghost" id="clear-hist" type="button" onClick={() => void clearAll()}>clear</button>
          </h2>
          <div className="hist" id="hist">
            {history.length ? history.map((record) => (
              <HistoryRow
                key={record.id ?? `${record.scene}-${record.createdAt}`}
                record={record}
                onPlay={() => void playHistory(record)}
                onDelete={() => void deleteHistoryItem(record)}
              />
            )) : <div className="empty">No converts yet.</div>}
          </div>
        </aside>
      </div>

      <div id="toast" className={toast ? "on" : ""}>{toast}</div>
    </div>
  );
}

function SceneNode({
  node,
  cards,
  onPlay,
  onExport,
}: {
  node: TreeNode;
  cards: Record<string, CardView>;
  onPlay: (scene: string, compiled: CompiledScene, name: string) => Promise<void>;
  onExport: (compiled: CompiledScene) => void;
}) {
  const card = cards[node.key];
  if (node.reference) {
    return (
      <div className="ref-node">
        <span>{card?.name ?? `${node.key}.swf`}</span>
        <em>shown above</em>
      </div>
    );
  }
  return (
    <div className="node">
      {card && <SceneCard card={card} onPlay={onPlay} onExport={onExport} />}
      {node.children.length > 0 && (
        <div className="children">
          {node.children.map((child) => (
            <SceneNode key={`${node.key}/${child.key}`} node={child} cards={cards} onPlay={onPlay} onExport={onExport} />
          ))}
        </div>
      )}
    </div>
  );
}

function SceneCard({
  card,
  onPlay,
  onExport,
}: {
  card: CardView;
  onPlay: (scene: string, compiled: CompiledScene, name: string) => Promise<void>;
  onExport: (compiled: CompiledScene) => void;
}) {
  if (card.status === "converting") {
    return (
      <section className="card busy">
        <h3>{card.name}</h3>
        <div className="meta">converting</div>
      </section>
    );
  }
  if (card.status === "error") {
    return (
      <section className="card">
        <h3>{card.name}</h3>
        <div className="meta error">convert failed: {card.error}</div>
      </section>
    );
  }

  const { compiled } = card;
  const s = compiled.stats;
  return (
    <section className="card">
      <h3>{card.name} <span className="dim">{compiled.width}x{compiled.height}</span></h3>
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
      <div className="meta">{(s.assetBytes / 1024 / 1024).toFixed(2)} MB assets - compiled in {s.ms} ms</div>
      {compiled.dependencies.length > 0 && <DependencyLine card={card} />}
      <div className="card-actions">
        <button className="play" type="button" onClick={() => void onPlay(compiled.scene, compiled, card.name)}>Play</button>
        <button className="export" type="button" onClick={() => onExport(compiled)}>Export Bundle</button>
      </div>
    </section>
  );
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

function Stat({ value, label }: { value: number; label: string }) {
  return <div><b>{value}</b><span>{label}</span></div>;
}

function HistoryRow({
  record,
  onPlay,
  onDelete,
}: {
  record: ConvertRecord;
  onPlay: () => void;
  onDelete: () => void;
}) {
  const s = record.stats;
  const sourceType = record.sourceType === "pack" ? "pack" : "swf";
  return (
    <div className="hrow">
      <img src={record.thumb ?? transparentPixel()} alt="" />
      <div className="info">
        <b><span>{record.name}</span><em>{sourceType}</em></b>
        <span>{record.width}x{record.height} - {s.shapes}sh {s.images}img {s.frames}fr - {new Date(record.createdAt).toLocaleString()}</span>
      </div>
      <div className="acts">
        <button type="button" onClick={onPlay} aria-label={`Play ${record.name}`}>Play</button>
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
  };
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
