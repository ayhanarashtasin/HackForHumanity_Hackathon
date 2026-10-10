// The single import() of the alert page: App renders it lazily, and the navbar calls it on hover/focus to warm the chunk.
export const loadAlertPage = () => import('./AlertPage.jsx');
