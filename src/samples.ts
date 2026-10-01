// Sample images are imported with `?url` so Vite fingerprints them and emits
// relative URLs that resolve correctly under any deployment subpath.
import logoUrl from '../samples/logo.png?url';
import photoUrl from '../samples/photo.jpg?url';
import stickerUrl from '../samples/sticker.png?url';

export interface Sample {
  id: string;
  label: string;
  url: string;
  colors: number;
  blur: number;
}

export const SAMPLES: Sample[] = [
  { id: 'logo', label: 'Flat-color logo', url: logoUrl, colors: 5, blur: 0 },
  { id: 'photo', label: 'Photo (sunset)', url: photoUrl, colors: 6, blur: 1.5 },
  { id: 'sticker', label: 'Sticker with transparency', url: stickerUrl, colors: 4, blur: 0 },
];
