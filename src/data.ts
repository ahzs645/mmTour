export type TourScene = {
  swf: string;
  label: string;
  length: number;
};

export const scenes: TourScene[] = [
  { swf: "A-tour.swf", label: "Tour Shell", length: 0.15 },
  { swf: "intro.swf", label: "Intro", length: 39.07 },
  { swf: "nav.swf", label: "Navigation", length: 29.2 },
  { swf: "segment1.swf", label: "Segment 1", length: 6.75 },
  { swf: "segment2.swf", label: "Segment 2", length: 8.8 },
  { swf: "segment3.swf", label: "Segment 3", length: 13.47 },
  { swf: "segment4.swf", label: "Segment 4", length: 9.47 },
  { swf: "segment5.swf", label: "Basics", length: 4.2 },
];
