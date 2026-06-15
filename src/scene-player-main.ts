import { GsapScenePlayer } from "./gsap-scene";
import { scenes } from "./data";
import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app root");

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div>
        <h1>GSAP Scene Player</h1>
        <p>Runs converted <code>gsap-scene.json</code> files as real GSAP tween timelines (no SWF, no Ruffle).</p>
      </div>
      <div class="source-mark">640 x 480</div>
    </header>

    <section class="controls" aria-label="Playback controls">
      <label>
        Scene
        <select id="sceneSelect"></select>
      </label>
      <label>
        Frame
        <input id="frameScrubber" type="range" min="0" max="0" value="0" />
      </label>
      <button id="playBtn" type="button">Play</button>
      <button id="restartBtn" type="button">Restart</button>
      <span id="status" class="status">Ready</span>
    </section>

    <section class="comparison-grid">
      <article class="panel">
        <div class="panel-title">
          <h2>GSAP Tween Scene</h2>
          <span id="sceneInfo"></span>
        </div>
        <div class="stage-wrap">
          <div id="sceneStage" class="asset-stage" style="position:relative;width:640px;height:480px;overflow:hidden;">
            <div id="sceneLayer"></div>
          </div>
        </div>
      </article>
    </section>
  </main>
`;

const select = must<HTMLSelectElement>("#sceneSelect");
const scrubber = must<HTMLInputElement>("#frameScrubber");
const playBtn = must<HTMLButtonElement>("#playBtn");
const restartBtn = must<HTMLButtonElement>("#restartBtn");
const status = must<HTMLSpanElement>("#status");
const sceneInfo = must<HTMLSpanElement>("#sceneInfo");
const layer = must<HTMLDivElement>("#sceneLayer");

const player = new GsapScenePlayer(layer);

player.onFrameChange = (frame) => {
  scrubber.value = String(frame);
  status.textContent = `${player.isPlaying ? "Playing" : "Ready at"} frame ${frame + 1} / ${player.totalFrames}`;
};
player.onPlaybackChange = () => updatePlayButton();

select.innerHTML = scenes
  .map((scene, index) => `<option value="${index}">${scene.label} - ${scene.swf}</option>`)
  .join("");

select.addEventListener("change", () => void loadScene());
playBtn.addEventListener("click", () => player.togglePlay());
restartBtn.addEventListener("click", () => player.restart());
scrubber.addEventListener("input", () => {
  player.pause();
  player.seekToFrame(Number(scrubber.value));
});

void loadScene();

async function loadScene() {
  const scene = scenes[Number(select.value)] ?? scenes[0];
  const sceneName = scene.swf.replace(/\.swf$/i, "");
  status.textContent = `Loading ${sceneName}`;
  const loaded = await player.load(`/generated/${sceneName}/gsap-scene.json?v=${Date.now()}`);
  if (!loaded) {
    status.textContent = `No gsap-scene.json for ${sceneName}. Run: npm run build:gsap-scenes`;
    sceneInfo.textContent = "";
    scrubber.max = "0";
    return;
  }
  scrubber.max = String(loaded.frameCount - 1);
  scrubber.value = String(loaded.entryFrame ?? 0);
  sceneInfo.textContent = `${loaded.tracks.length} tracks · ${loaded.frameCount} frames @ ${loaded.fps} fps`;
  status.textContent = `Ready at frame ${(loaded.entryFrame ?? 0) + 1} / ${loaded.frameCount}`;
  updatePlayButton();
}

function updatePlayButton() {
  playBtn.textContent = player.isPlaying ? "Pause" : "Play";
}

function must<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
}
