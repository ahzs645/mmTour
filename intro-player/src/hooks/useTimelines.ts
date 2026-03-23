import { useState, useEffect } from 'react';
import type { TimelineData } from '../types';

export interface LayerAssets {
  data: TimelineData;
  svgCache: Record<string, string>;
  spriteImages: Record<string, string>;
}

async function loadLayer(
  timelineUrl: string,
  assetsBase: string,
  onProgress: (progress: number, status: string) => void,
  progressOffset: number,
  progressRange: number,
  loadSpritePngs = true,
): Promise<LayerAssets> {
  // Load timeline JSON
  onProgress(progressOffset, `Loading ${assetsBase} timeline...`);
  const response = await fetch(timelineUrl);
  const data: TimelineData = await response.json();

  // Load SVG shapes
  onProgress(progressOffset + progressRange * 0.1, `Loading ${assetsBase} shapes...`);
  const svgCache: Record<string, string> = {};
  const shapes = data.assets.shapes;

  for (let i = 0; i < shapes.length; i++) {
    try {
      const svgResponse = await fetch(`/${assetsBase}/shapes/${shapes[i]}.svg`);
      if (svgResponse.ok) {
        svgCache[shapes[i]] = await svgResponse.text();
      }
    } catch {
      // Shape not found
    }
    onProgress(progressOffset + progressRange * (0.1 + 0.5 * (i + 1) / shapes.length), '');
  }

  // Load sprite PNGs (only for layers that have pre-rendered sprites)
  onProgress(progressOffset + progressRange * 0.5, `Loading ${assetsBase} sprites...`);
  const spriteImages: Record<string, string> = {};

  if (loadSpritePngs) {
    const spriteIds = Object.entries(data.characters)
      .filter(([, char]) => char.type === 'sprite')
      .map(([id]) => id);

    for (let i = 0; i < spriteIds.length; i++) {
      try {
        const imgResponse = await fetch(`/${assetsBase}/sprites/${spriteIds[i]}.png`);
        if (imgResponse.ok) {
          const blob = await imgResponse.blob();
          spriteImages[spriteIds[i]] = URL.createObjectURL(blob);
        }
      } catch {
        // Sprite not found
      }
      onProgress(progressOffset + progressRange * (0.5 + 0.2 * (i + 1) / spriteIds.length), '');
    }
  }

  // Load standalone images - only for layers where image file names match character IDs
  // (Nav image files have FFDec-internal IDs that don't match SWF character IDs, so skip)
  if (loadSpritePngs) {
    onProgress(progressOffset + progressRange * 0.7, `Loading ${assetsBase} images...`);
    const imageList = data.assets.images || [];
    for (let i = 0; i < imageList.length; i++) {
      const img = imageList[i];
      try {
        const imgResponse = await fetch(`/${assetsBase}/images/${img.id}${img.ext}`);
        if (imgResponse.ok) {
          const blob = await imgResponse.blob();
          spriteImages[img.id] = URL.createObjectURL(blob);
        }
      } catch {
        // Image not found
      }
      onProgress(progressOffset + progressRange * (0.7 + 0.25 * (i + 1) / Math.max(imageList.length, 1)), '');
    }
  }

  return { data, svgCache, spriteImages };
}

export function useTimelines() {
  const [navLayer, setNavLayer] = useState<LayerAssets | null>(null);
  const [introLayer, setIntroLayer] = useState<LayerAssets | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState('Initializing...');
  const [loadingProgress, setLoadingProgress] = useState(0);

  useEffect(() => {
    async function load() {
      try {
        const onProgress = (progress: number, status: string) => {
          setLoadingProgress(progress);
          if (status) setLoadingStatus(status);
        };

        // Load nav layer (background, 0-50% progress)
        // Nav sprites are multi-frame animated buttons - skip PNG loading,
        // render via contained shapes instead
        const nav = await loadLayer(
          '/nav-timeline.json', 'nav', onProgress, 0, 50, false
        );
        setNavLayer(nav);

        // Load intro layer (foreground, 50-100% progress)
        const intro = await loadLayer(
          '/intro-timeline.json', 'intro', onProgress, 50, 50, true
        );
        setIntroLayer(intro);

        setLoadingStatus('Ready!');
        setLoadingProgress(100);
        setLoading(false);
      } catch (error) {
        console.error('Error loading timelines:', error);
        setLoadingStatus('Error loading data');
      }
    }

    load();
  }, []);

  return { navLayer, introLayer, loading, loadingStatus, loadingProgress };
}
