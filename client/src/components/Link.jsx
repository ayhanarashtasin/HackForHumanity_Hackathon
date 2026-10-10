import { navigate } from '../lib/router.js';

// A real <a href>, so middle-click, copy-link and "open in new tab" keep working; plain clicks are routed without a reload.
export function Link({ to, onClick, children, ...rest }) {
  const handleClick = (event) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || rest.target === '_blank') return;
    event.preventDefault();
    navigate(to);
  };

  return <a href={to} onClick={handleClick} {...rest}>{children}</a>;
}
