// The single import() of the administrator page. Nothing on the public site links to it, so it is only ever fetched by /admin itself.
export const loadAdminPage = () => import('./AdminPage.jsx');
