'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

let showToastGlobal: ((msg: string) => void) | null = null;

export function useToast() {
  const show = useCallback((msg: string) => {
    if (showToastGlobal) showToastGlobal(msg);
  }, []);
  return show;
}

export default function Toast() {
  const [message, setMessage] = useState('');
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    showToastGlobal = (msg: string) => {
      setMessage(msg);
      setVisible(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setVisible(false), 2000);
    };
    return () => {
      showToastGlobal = null;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className={`toast${visible ? ' show' : ''}`}>
      {message}
    </div>
  );
}
