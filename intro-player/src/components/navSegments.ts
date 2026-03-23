export const TOUR_SEGMENTS = [
  { id: 1, label: 'Safe and Easy Personal Computing', color: '#ff3300', tabColor: '#ff6633' },
  { id: 2, label: 'Unlock the World of Digital Media', color: '#009900', tabColor: '#33cc33' },
  { id: 3, label: 'The Connected Home and Office', color: '#0066cc', tabColor: '#3399ff' },
  { id: 4, label: 'Best for Business', color: '#cc9900', tabColor: '#ffcc33' },
  { id: 5, label: 'Windows XP Basics', color: '#666666', tabColor: '#999999' },
] as const;

export type TourSegmentId = (typeof TOUR_SEGMENTS)[number]['id'];
export type TourMode = 'intro' | 'segment';

export function getSegmentById(segmentId: TourSegmentId | null) {
  return TOUR_SEGMENTS.find((segment) => segment.id === segmentId) ?? null;
}

export function getSegmentSwfUrl(segmentId: TourSegmentId) {
  return `/segment${segmentId}.swf`;
}
