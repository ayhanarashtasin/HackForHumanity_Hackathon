// The single import() of the map page: App renders it lazily, and the landing page calls it on hover/focus to warm the chunk
// (MapLibre is large, so the landing page itself never loads it).
export const loadMapPage = () => import('./MapPage.jsx');
