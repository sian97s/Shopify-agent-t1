import type { Visibility } from '../../../../shared/types.js';

export interface ArtworkRecord {
  id: string;
  publicRef: string;
  artKeyId: string | null;
  visibility: Visibility;
  title: string | null;
  titleSource: 'creator' | 'suggested' | null;
  status: 'published' | 'withdrawn' | 'removed';
  width: number;
  height: number;
  palette: string[];
  caption: string | null;
  tags: string[];
  mood: string | null;
  style: string | null;
  medium: string | null;
  subject: string | null;
  storageKey: string;
  x: number;
  y: number;
  gravity: number;
  gravityAt: number;
  respondsTo: string | null;
  seeded: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NewArtwork {
  id: string;
  publicRef: string;
  artKeyId: string | null;
  visibility: Visibility;
  title: string | null;
  titleSource: 'creator' | 'suggested' | null;
  width: number;
  height: number;
  palette: string[];
  caption: string | null;
  tags: string[];
  mood: string | null;
  style: string | null;
  medium: string | null;
  subject: string | null;
  storageKey: string;
  x: number;
  y: number;
  respondsTo: string | null;
  seeded?: boolean;
  createdAt: number;
}
