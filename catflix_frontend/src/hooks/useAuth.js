import { useCallback } from 'react';
import { SESSION_KEY } from '../constants';
import { removeFromStorage } from '../utils/storage';

export function useAuth() {
  const handleLogout = useCallback(() => {
    removeFromStorage(SESSION_KEY);
    fetch('/auth/logout', { method: 'POST', credentials: 'include' })
      .finally(() => {
        window.location.reload();
      });
  }, []);

  return { handleLogout };
}

