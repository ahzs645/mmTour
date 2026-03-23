import { useState, useEffect } from 'react';
import type { TimelineData } from '../types';

export function useTimeline() {
  const [data, setData] = useState<TimelineData | null>(null);
  const [svgCache, setSvgCache] = useState<Record<string, string>>({});
  const [spriteImages, setSpriteImages] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState('Initializing...');
  const [loadingProgress, setLoadingProgress] = useState(0);

  useEffect(() => {
    async function load() {
      try {
        // Load timeline JSON
        setLoadingStatus('Loading timeline data...');
        const response = await fetch('/intro-timeline.json');
        const timelineData: TimelineData = await response.json();
        setData(timelineData);
        setLoadingProgress(10);

        // Load SVG shapes
        setLoadingStatus('Loading shapes...');
        const cache: Record<string, string> = {};
        const shapes = timelineData.assets.shapes;

        for (let i = 0; i < shapes.length; i++) {
          const shapeId = shapes[i];
          try {
            const svgResponse = await fetch(`/intro/shapes/${shapeId}.svg`);
            if (svgResponse.ok) {
              cache[shapeId] = await svgResponse.text();
            }
          } catch (e) {
            // Shape not found
          }
          setLoadingProgress(10 + ((i + 1) / shapes.length) * 50);
        }

        setSvgCache(cache);

        // Load sprite PNG images
        setLoadingStatus('Loading sprites...');
        const sprites: Record<string, string> = {};
        const spriteIds = Object.entries(timelineData.characters)
          .filter(([_, char]) => char.type === 'sprite')
          .map(([id]) => id);

        for (let i = 0; i < spriteIds.length; i++) {
          const spriteId = spriteIds[i];
          try {
            const imgResponse = await fetch(`/intro/sprites/${spriteId}.png`);
            if (imgResponse.ok) {
              // Store as data URL for easy use in img tags
              const blob = await imgResponse.blob();
              sprites[spriteId] = URL.createObjectURL(blob);
            }
          } catch (e) {
            // Sprite image not found
          }
          setLoadingProgress(60 + ((i + 1) / spriteIds.length) * 35);
        }

        setSpriteImages(sprites);
        setLoadingStatus('Ready!');
        setLoadingProgress(100);
        setLoading(false);

      } catch (error) {
        console.error('Error loading timeline:', error);
        setLoadingStatus('Error loading data');
      }
    }

    load();
  }, []);

  return { data, svgCache, spriteImages, loading, loadingStatus, loadingProgress };
}
