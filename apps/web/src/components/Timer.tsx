'use client';

import { useState, useEffect, useRef } from 'react';

interface TimerProps {
  startTime: number | null;
  isRunning: boolean;
  finalTime?: number | null;
  isInspection?: boolean;
  inspectionDuration?: number;
}

export function Timer({
  startTime,
  isRunning,
  finalTime,
  isInspection = false,
  inspectionDuration = 15000,
}: TimerProps) {
  const [displayTime, setDisplayTime] = useState(0);
  const rafRef = useRef<number | null>(null);
  const lastUpdateRef = useRef<number>(0);

  useEffect(() => {
    if (finalTime !== undefined && finalTime !== null) {
      setDisplayTime(finalTime);
      return;
    }

    if (!isRunning || !startTime) {
      if (isInspection && startTime) {
        // Show countdown
        const remaining = Math.max(0, inspectionDuration - (Date.now() - startTime));
        setDisplayTime(remaining);
      }
      return;
    }

    const updateTimer = (timestamp: number) => {
      // Throttle updates to ~60fps (every 16ms) to reduce re-renders
      if (timestamp - lastUpdateRef.current >= 16) {
        if (isInspection) {
          const remaining = Math.max(0, inspectionDuration - (Date.now() - startTime));
          setDisplayTime(remaining);
        } else {
          setDisplayTime(Date.now() - startTime);
        }
        lastUpdateRef.current = timestamp;
      }
      rafRef.current = requestAnimationFrame(updateTimer);
    };

    rafRef.current = requestAnimationFrame(updateTimer);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [startTime, isRunning, finalTime, isInspection, inspectionDuration]);

  const formatTime = (ms: number) => {
    if (isInspection) {
      const seconds = Math.ceil(ms / 1000);
      return seconds.toString();
    }

    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const centiseconds = Math.floor((ms % 1000) / 10);

    if (minutes > 0) {
      return `${minutes}:${seconds.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
    }
    return `${seconds}.${centiseconds.toString().padStart(2, '0')}`;
  };

  const getColor = () => {
    if (isInspection) {
      const seconds = displayTime / 1000;
      if (seconds <= 3) return 'text-red-500';
      if (seconds <= 8) return 'text-yellow-500';
      return 'text-green-500';
    }
    return 'text-white';
  };

  return (
    <div className={`timer text-6xl font-bold ${getColor()}`}>
      {formatTime(displayTime)}
      {isInspection && <span className="text-2xl ml-2">s</span>}
    </div>
  );
}
