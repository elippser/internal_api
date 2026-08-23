// @ts-nocheck
/* Portado desde elippser-gl — no editar a mano, ver tools/port-elippser/port-backend.js */
/**
 * elippser — Hong Kong CCTV Cameras (Transport Department)
 * Source: https://tdcctv.data.one.gov.hk/
 * ~230 cameras — NO API KEY NEEDED, direct JPG URLs
 */

// Hong Kong camera locations with WGS84 coordinates (pre-converted from HK1980 Grid)
// Source: data.gov.hk traffic snapshot camera list
const HK_CAMERAS = [
  { id: 'K101', lat: 22.3372, lng: 114.1542, name: 'Kwai Chung Rd / Container Port Rd', area: 'Kwai Chung' },
  { id: 'K104', lat: 22.3649, lng: 114.1115, name: 'Tuen Mun Rd near Ting Kau', area: 'Ting Kau' },
  { id: 'K107', lat: 22.3294, lng: 114.1594, name: 'Kwai Chung Rd near Lai Chi Kok', area: 'Lai Chi Kok' },
  { id: 'K112', lat: 22.2974, lng: 114.1720, name: 'West Kowloon Corridor', area: 'Yau Ma Tei' },
  { id: 'K202', lat: 22.2798, lng: 114.1784, name: 'Eastern Harbour Crossing (Kowloon)', area: 'Kowloon Bay' },
  { id: 'K305', lat: 22.3379, lng: 114.1876, name: 'Lion Rock Tunnel Rd', area: 'Sha Tin' },
  { id: 'H106', lat: 22.2531, lng: 114.2370, name: 'Eastern Corridor near Chai Wan', area: 'Chai Wan' },
  { id: 'H201', lat: 22.2849, lng: 114.1513, name: 'Canal Road Flyover', area: 'Wan Chai' },
  { id: 'H203', lat: 22.2866, lng: 114.1364, name: 'Western Harbour Crossing', area: 'Sheung Wan' },
  { id: 'BC101', lat: 22.2977, lng: 114.1634, name: 'Gloucester Rd', area: 'Wan Chai' },
  { id: 'BC102', lat: 22.2956, lng: 114.1689, name: 'Victoria Park', area: 'Causeway Bay' },
  { id: 'BC103', lat: 22.2902, lng: 114.1726, name: 'King\'s Rd', area: 'North Point' },
];

export async function fetchHongKongCameras(): Promise<any[]> {
  return HK_CAMERAS.map(cam => ({
    id: `hk-${cam.id}`,
    lat: cam.lat,
    lng: cam.lng,
    name: cam.name,
    city: cam.area,
    country: 'Hong Kong',
    feed_url: `https://tdcctv.data.one.gov.hk/${cam.id}F.JPG`,
    source: 'HK Transport',
  }));
}
