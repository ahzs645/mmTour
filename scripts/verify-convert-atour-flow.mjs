#!/usr/bin/env node
// Verify the browser-converted full A-tour flow in the SWF Studio UI:
// convert the shell, let dependencies compile, play it, skip the intro, click a
// nav section, then switch to another section. This exercises the generic
// browser-extracted control data through the real converted-pack player path.

import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://127.0.0.1:4174/mmTour/convert-play.html";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
const pageErrors = [];
const resource404s = [];
page.on("pageerror", (error) => pageErrors.push(String(error.message ?? error).slice(0, 180)));
page.on("console", (message) => {
  if (message.type() === "error" && !/Failed to load resource/i.test(message.text())) {
    pageErrors.push(message.text().slice(0, 180));
  }
});
page.on("response", (response) => {
  if (response.status() === 404) resource404s.push(response.url());
});

try {
  await page.goto(base, { waitUntil: "load", timeout: 30_000 });
  await page.getByRole("button", { name: "A-tour", exact: true }).click();
  await waitForAFullTourCard();

  await page.locator(".card", { has: page.locator("h3", { hasText: "A-tour.swf" }) }).first().locator(".play").click();
  await page.waitForSelector('.player-instance[data-character="109"] img.player-hit', { timeout: 280_000, state: "attached" });
  const beforeSkip = await playerState();
  await page.locator('.player-instance[data-character="109"] img.player-hit').first().click({ timeout: 15_000 });
  await waitForAnyCategoryHit();
  const afterSkip = await playerState();

  const hover = await hoverFirstCategoryHit();
  const firstClick = await clickFirstCategoryHit();
  await page.waitForTimeout(4_500);
  const afterFirstSection = await playerState();

  const secondClick = await clickDifferentCategoryHit(firstClick.character);
  await page.waitForTimeout(4_500);
  const afterSecondSection = await playerState();

  const result = {
    beforeSkip,
    afterSkip,
    hover,
    firstClick,
    afterFirstSection,
    secondClick,
    afterSecondSection,
    pageErrors: pageErrors.slice(0, 8),
    resource404s: resource404s.filter((url) => !/\/favicon\.ico(?:$|\?)/i.test(url)).slice(0, 8),
  };
  console.log(JSON.stringify(result, null, 2));

  if (pageErrors.length) fail(`browser errors: ${pageErrors.slice(0, 3).join(" | ")}`);
  if (result.resource404s.length) fail(`resource 404s: ${result.resource404s.slice(0, 3).join(" | ")}`);
  if (!afterSkip.categoryHits) fail("skip intro did not expose nav/category hit areas");
  if (!hover.changed) fail("hovering a nav/category hit did not change the level-6 visual state");
  if (!hover.ownerArtChanged) fail("hovering a nav/category hit did not change the button owner artwork state");
  if (!afterFirstSection.level4Instances || afterFirstSection.level4Signature === afterSkip.level4Signature) {
    fail("first nav click did not change level 4 content");
  }
  if (!afterSecondSection.level4Instances || !afterSecondSection.level4Hits) fail("second loaded segment did not expose content hit areas");
  if (afterFirstSection.level4Signature === afterSecondSection.level4Signature) fail("second nav click did not switch level 4 content");
  console.log("OK");
} finally {
  await browser.close();
}

async function waitForAFullTourCard() {
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll(".card")].find((node) => /A-tour\.swf/.test(node.querySelector("h3")?.textContent ?? ""));
    if (!card || card.classList.contains("busy")) return false;
    const dep = card.querySelector(".dep")?.textContent ?? "";
    return /all compiled/.test(dep) && !/linking|compiling|pending/.test(dep);
  }, null, { timeout: 420_000 });
}

async function waitForAnyCategoryHit() {
  await page.waitForFunction(() => {
    const player = document.querySelector("#player")?.getBoundingClientRect();
    return [...document.querySelectorAll(".player-instance img.player-hit")].some((node) => {
      const inst = node.closest(".player-instance");
      const level = Number(inst?.closest(".player-level")?.style.zIndex ?? "0");
      const box = node.getBoundingClientRect();
      const centerY = box.y + box.height / 2;
      return level === 6
        && box.width > 2
        && box.height > 2
        && getComputedStyle(node).pointerEvents === "auto"
        && (!player || centerY < player.bottom - 70);
    });
  }, null, { timeout: 120_000 });
}

async function clickFirstCategoryHit() {
  const hit = await firstVisibleCategoryHit();
  await hit.handle.click({ timeout: 15_000 });
  return { character: hit.character, box: roundedBox(hit.box) };
}

async function hoverFirstCategoryHit() {
  const hit = await firstVisibleCategoryHit("", { preferLarge: true });
  const before = await levelSignatureInPage(6);
  const ownerArtBefore = await buttonOwnerArtSignature(hit.handle);
  await page.mouse.move(hit.box.x + hit.box.width / 2, hit.box.y + hit.box.height / 2);
  let after = before;
  let ownerArtAfter = ownerArtBefore;
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(100);
    after = await levelSignatureInPage(6);
    ownerArtAfter = await buttonOwnerArtSignature(hit.handle);
    if (after !== before && ownerArtAfter !== ownerArtBefore) break;
  }
  return {
    character: hit.character,
    box: roundedBox(hit.box),
    changed: after !== before,
    ownerArtChanged: Boolean(ownerArtBefore) && ownerArtAfter !== ownerArtBefore,
    beforeHash: hashString(before),
    afterHash: hashString(after),
    ownerArtBeforeHash: hashString(ownerArtBefore),
    ownerArtAfterHash: hashString(ownerArtAfter),
  };
}

async function clickDifferentCategoryHit(previousCharacter) {
  const hit = await firstVisibleCategoryHit(previousCharacter);
  await hit.handle.click({ timeout: 15_000 });
  return { character: hit.character, box: roundedBox(hit.box) };
}

async function firstVisibleCategoryHit(excludeCharacter, options = {}) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const candidates = await navHitCandidatesInPage(excludeCharacter ?? "");
    const candidate = options.preferLarge
      ? (candidates.find((hit) => hit.area > 2000) ?? (attempt > 20 ? candidates[0] : undefined))
      : candidates[0];
    if (candidate) {
      const handle = await page.locator(".player-instance img.player-hit").nth(candidate.index).elementHandle();
      if (handle) return { handle, character: candidate.character, box: candidate.box };
    }
    await page.waitForTimeout(500);
  }
  fail("no visible category hit found");
}

async function navHitCandidatesInPage(excludeCharacter = "") {
  return page.evaluate((exclude) => {
    const player = document.querySelector("#player")?.getBoundingClientRect();
    return [...document.querySelectorAll(".player-instance img.player-hit")]
      .map((node, index) => {
        const inst = node.closest(".player-instance");
        const level = inst?.closest(".player-level");
        const box = node.getBoundingClientRect();
        const character = inst?.getAttribute("data-character") ?? "";
        const centerY = box.y + box.height / 2;
        return {
          index,
          character,
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          level: Number(level?.style.zIndex ?? "0"),
          visible: box.width > 2 && box.height > 2 && getComputedStyle(node).pointerEvents === "auto",
          inNavArea: !player || centerY < player.bottom - 70,
          area: box.width * box.height,
        };
      })
      .filter((hit) => hit.level === 6 && hit.visible && hit.inNavArea && hit.character !== exclude)
      .sort((a, b) => b.area - a.area || a.box.y - b.box.y || a.box.x - b.box.x);
  }, excludeCharacter);
}

async function levelSignatureInPage(levelNumber) {
  return page.evaluate((targetLevel) => {
    const level = [...document.querySelectorAll(".player-level")]
      .find((node) => Number(node.style.zIndex || "0") === targetLevel);
    if (!level) return "";
    return [...level.querySelectorAll(".player-instance")]
      .map((inst) => {
        const media = inst.querySelector(".player-media");
        const src = media?.getAttribute("src") ?? "";
        return [
          inst.getAttribute("data-character") ?? "",
          inst.getAttribute("data-key") ?? "",
          inst.getAttribute("style") ?? "",
          media?.getAttribute("style") ?? "",
          src.startsWith("blob:") ? "blob" : src.slice(0, 96),
          media?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        ].join("~");
      })
      .join("\n");
  }, levelNumber);
}

async function buttonOwnerArtSignature(handle) {
  return handle.evaluate((node) => {
    const hit = node;
    const key = hit.closest(".player-instance")?.getAttribute("data-key") ?? "";
    const ownerPath = hit.dataset.buttonOwnerPath || key.split("/").slice(0, -1).join("/");
    const groupPath = ownerPath.split("/").slice(0, -1).join("/") || ownerPath;
    if (!groupPath) return "";
    return [...document.querySelectorAll(".player-instance")]
      .filter((inst) => (inst.getAttribute("data-key") ?? "").startsWith(`${groupPath}/`))
      .map((inst) => {
        const media = inst.querySelector(".player-media");
        if (!media || media.classList.contains("player-hit")) return "";
        const src = media.getAttribute("src") ?? "";
        return [
          inst.getAttribute("data-character") ?? "",
          inst.getAttribute("data-key") ?? "",
          inst.getAttribute("style") ?? "",
          media.getAttribute("style") ?? "",
          getComputedStyle(media).filter,
          src.startsWith("blob:") ? "blob" : src.slice(0, 96),
          media.textContent?.replace(/\s+/g, " ").trim() ?? "",
        ].join("~");
      })
      .filter(Boolean)
      .join("\n");
  });
}

async function playerState() {
  return page.evaluate(() => {
    const levels = [...document.querySelectorAll(".player-level")].map((level) => {
      const z = Number(level.style.zIndex || "0");
      const medias = [...level.querySelectorAll(".player-media")];
      const scenes = [...new Set(medias
        .map((node) => node.getAttribute("src")?.match(/generated\/([^/]+)\//)?.[1])
        .filter(Boolean))].sort();
      return {
        z,
        scenes,
        hits: level.querySelectorAll(".player-hit").length,
        instances: level.querySelectorAll(".player-instance").length,
      };
    }).sort((a, b) => a.z - b.z);
    const level4 = levels.find((level) => level.z === 4);
    const level6 = levels.find((level) => level.z === 6);
    return {
      levels,
      categoryHits: [...document.querySelectorAll(".player-level")]
        .filter((level) => Number(level.style.zIndex || "0") === 6)
        .flatMap((level) => [...level.querySelectorAll(".player-instance img.player-hit")])
        .filter((node) => {
          const box = node.getBoundingClientRect();
          const player = document.querySelector("#player")?.getBoundingClientRect();
          return box.width > 2 && box.height > 2 && (!player || box.y + box.height / 2 < player.bottom - 70);
        }).length,
      level4Scenes: level4?.scenes ?? [],
      level4Hits: level4?.hits ?? 0,
      level4Instances: level4?.instances ?? 0,
      level4Signature: `${(level4?.scenes ?? []).join(",")}|${level4?.instances ?? 0}|${level4?.hits ?? 0}`,
      level6Scenes: level6?.scenes ?? [],
      playerText: [...document.querySelectorAll("#player .player-text")].map((node) => node.textContent?.trim()).filter(Boolean).slice(0, 12),
    };
  });
}

function roundedBox(box) {
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}
