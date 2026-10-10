import { createContext, useContext } from 'react';

// What every alert component needs: the language and its translator, the area index, the schema and the language switch.
export const AlertContext = createContext(null);

export function useAlert() {
  const value = useContext(AlertContext);
  if (!value) throw new Error('useAlert must be used inside the alert page.');
  return value;
}
